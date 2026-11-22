import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { BUILTIN_MACROS, MacroRunner, createSessionMacroHandlers } from '../src/skills/macro_runner.js';

test('MacroRunner runs steps sequentially, supports abort, and reports exact failed step', async () => {
  assert.ok(BUILTIN_MACROS.prepare_caving_kit);
  assert.ok(BUILTIN_MACROS.deposit_mining_loot);

  const calls = [];
  const runner = new MacroRunner({
    return_home: async () => { calls.push('return_home'); return { ok: true, detail: 'home' }; },
    collect_ready_furnaces: async () => { calls.push('collect_ready_furnaces'); return { ok: false, reason: 'FURNACE_LOCKED' }; },
    deposit_excess_items: async () => { calls.push('deposit_excess_items'); return { ok: true }; },
  });

  const failRes = await runner.run('deposit_mining_loot');
  assert.equal(failRes.ok, false);
  assert.equal(failRes.failedStep, 1);
  assert.equal(failRes.stepAction, 'collect_ready_furnaces');
  assert.equal(failRes.reason, 'FURNACE_LOCKED');
  assert.deepEqual(calls, ['return_home', 'collect_ready_furnaces']);

  const unknownRes = await runner.run('no_such_macro');
  assert.equal(unknownRes.ok, false);
  assert.match(unknownRes.error, /UNKNOWN_MACRO/);

  const ac = new AbortController();
  ac.abort();
  const abortedRes = await runner.run('prepare_caving_kit', ac.signal);
  assert.equal(abortedRes.ok, false);
  assert.equal(abortedRes.reason, 'ABORTED');
  assert.equal(abortedRes.abortedAtStep, 0);
});

test('createSessionMacroHandlers executes prepare_caving_kit and deposit_mining_loot end-to-end', async () => {
  const inv = [
    { name: 'stick', count: 8 },
    { name: 'torch', count: 20 },
    { name: 'stone_pickaxe', count: 1 },
    { name: 'bread', count: 10 }, // 50 food points >= 40
  ];
  const actions = [];
  const chestBlock = { name: 'chest', position: new Vec3(2, 64, 0) };

  const ctx = {
    bot: {
      inventory: { items: () => inv },
      findBlock: () => chestBlock,
      blockAt: () => chestBlock,
    },
    crafting: {
      craftItem: async (target, count) => {
        actions.push(['craft', target, count]);
        inv.push({ name: target, count });
      },
    },
    survival: {
      ensurePickaxe: async (tier) => {
        actions.push(['pickaxe', tier]);
        return true;
      },
    },
    equipment: {
      maintain: async () => {
        actions.push(['equip_maintain']);
        return { equipped: true };
      },
    },
    home: {
      get: () => ({ x: 0, y: 64, z: 0 }),
      getStorageChest: () => ({ x: 2, y: 64, z: 0 }),
      storeSurplus: async () => {
        actions.push(['store_surplus']);
        return true;
      },
    },
    smelting: {
      collectReadyOutputs: async () => {
        actions.push(['collect_furnaces']);
        return { collected: [{ name: 'iron_ingot', count: 4 }], pendingCount: 0 };
      },
    },
    gotoSafe: async (goal) => {
      actions.push(['goto', Math.round(goal.x), Math.round(goal.y), Math.round(goal.z)]);
    },
  };

  const runner = new MacroRunner(createSessionMacroHandlers(ctx));
  const kitRes = await runner.run('prepare_caving_kit');
  assert.equal(kitRes.ok, true);
  assert.equal(kitRes.completedSteps.length, 5);
  assert.ok(actions.some(a => a[0] === 'craft' && a[1] === 'torch' && a[2] === 12));
  assert.ok(actions.some(a => a[0] === 'pickaxe' && a[1] === 'stone'));
  assert.ok(actions.some(a => a[0] === 'equip_maintain'));

  const lootRes = await runner.run('deposit_mining_loot');
  assert.equal(lootRes.ok, true);
  assert.equal(lootRes.completedSteps.length, 3);
  assert.ok(actions.some(a => a[0] === 'goto' && a[1] === 0));
  assert.ok(actions.some(a => a[0] === 'collect_furnaces'));
  assert.ok(actions.some(a => a[0] === 'store_surplus'));
});
