import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { SmeltingManager } from '../src/smelting.js';
import { Memory } from '../src/memory.js';

test('SmeltingManager selects optimal fuel without burning wooden tools', () => {
  let inv = [
    { name: 'wooden_pickaxe', type: 270, count: 1 },
    { name: 'wooden_sword', type: 268, count: 1 },
    { name: 'oak_planks', type: 5, count: 4 },
    { name: 'coal', type: 263, count: 8 },
  ];
  const bot = { inventory: { items: () => inv } };
  const smelting = new SmeltingManager(bot);

  // Small batch (<= 2 items) prefers planks over wasting coal
  const smallPlan = smelting.selectOptimalFuel(2);
  assert.equal(smallPlan.item.name, 'oak_planks');
  assert.equal(smallPlan.count, 2);

  // Large batch (>= 3 items) prefers coal
  const largePlan = smelting.selectOptimalFuel(8);
  assert.equal(largePlan.item.name, 'coal');
  assert.equal(largePlan.count, 1);

  // Only wooden tools in inventory -> returns null (never burns tools)
  inv = [
    { name: 'wooden_pickaxe', type: 270, count: 1 },
    { name: 'wooden_axe', type: 271, count: 1 },
  ];
  assert.equal(smelting.selectOptimalFuel(1), null);
});

test('SmeltingManager persists activeJobs in SQLite and handles chunk-unloaded remaining furnace input', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-smelt-'));
  const mem = new Memory({ dbPath: path.join(dir, 'smelt.db') });
  await mem.load();

  try {
    const furnacePos = new Vec3(10, 64, 10);
    let fuelLoaded = null;
    let inputLoaded = null;
    let liveInput = { name: 'raw_iron', count: 6 };
    let liveOutput = null;

    const bot = {
      entity: { position: new Vec3(9, 64, 10) },
      inventory: {
        items: () => [
          { name: 'raw_iron', type: 700, count: 6 },
          { name: 'coal', type: 263, count: 2 },
        ],
      },
      findBlock: () => ({ name: 'furnace', position: furnacePos }),
      blockAt: (p) => (Math.floor(p.x) === 10 && Math.floor(p.z) === 10 ? { name: 'lit_furnace', position: furnacePos } : { name: 'air' }),
      pathfinder: { goto: async () => {} },
      openFurnace: async () => ({
        outputItem: () => liveOutput,
        inputItem: () => liveInput,
        putFuel: async (t, _m, c) => { fuelLoaded = { t, c }; },
        putInput: async (t, _m, c) => { inputLoaded = { t, c }; },
        takeOutput: async () => {
          const got = liveOutput;
          liveOutput = null;
          return got;
        },
        close: () => {},
      }),
    };

    const s1 = new SmeltingManager(bot, {}, { memory: mem });
    const started = await s1.startSmelting('sắt', 6);
    assert.equal(started.ok, true);
    assert.deepEqual(fuelLoaded, { t: 263, c: 1 });
    assert.deepEqual(inputLoaded, { t: 700, c: 6 });

    // Simulate restart: load new SmeltingManager from same SQLite memory
    const s2 = new SmeltingManager(bot, {}, { memory: mem });
    assert.equal(s2.activeJobs.size, 1);
    const key = '10,64,10';

    // Simulate chunk unload pause: timer expired, 2 smelted, 4 still in inputItem()
    s2.activeJobs.get(key).readyAt = Date.now() - 1000;
    liveOutput = { name: 'iron_ingot', count: 2 };
    liveInput = { name: 'raw_iron', count: 4 };

    const partial = await s2.collectReadyOutputs();
    assert.deepEqual(partial.collected, [{ name: 'iron_ingot', count: 2, posKey: key }]);
    assert.equal(partial.pendingCount, 1);
    assert.equal(s2.activeJobs.get(key).remainingCount, 4);
    assert.ok(s2.activeJobs.get(key).readyAt > Date.now() + 30000);

    // Remaining 4 finish -> inputItem() is null -> job clears cleanly
    s2.activeJobs.get(key).readyAt = Date.now() - 1000;
    liveOutput = { name: 'iron_ingot', count: 4 };
    liveInput = null;

    const done = await s2.collectReadyOutputs();
    assert.deepEqual(done.collected, [{ name: 'iron_ingot', count: 4, posKey: key }]);
    assert.equal(done.pendingCount, 0);
    assert.deepEqual(mem.get('smeltingJobs'), {});
  } finally {
    mem.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
