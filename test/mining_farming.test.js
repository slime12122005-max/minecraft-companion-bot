import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { MiningFarmingManager } from '../src/mining_farming.js';

test('digTunnel stops immediately when encountering lava ahead', async () => {
  const dug = [];
  const world = new Map([
    ['0,64,-1', { name: 'stone', position: new Vec3(0, 64, -1), diggable: true }],
    ['0,65,-1', { name: 'stone', position: new Vec3(0, 65, -1), diggable: true }],
    ['0,64,-3', { name: 'lava', position: new Vec3(0, 64, -3) }],
  ]);

  const bot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0 }, // yaw 0 -> north (-z)
    inventory: { items: () => [] },
    blockAt: (p) => world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'stone', position: p, diggable: true },
    dig: async (b) => {
      dug.push(`${b.position.x},${b.position.y},${b.position.z}`);
      world.set(`${b.position.x},${b.position.y},${b.position.z}`, { name: 'air', position: b.position });
    },
    pathfinder: { goto: async () => {} },
  };

  const mgr = new MiningFarmingManager(bot);
  const res = await mgr.digTunnel(10);
  assert.equal(res.steps, 1);
  assert.match(res.stoppedReason, /lava/);
});

test('scanValuableOres detects diamond_ore once per coordinate', () => {
  const orePos = new Vec3(5, 12, -3);
  const bot = {
    registry: { blocksByName: { diamond_ore: { id: 56 } } },
    findBlocks: () => [orePos],
    blockAt: () => ({ name: 'diamond_ore', position: orePos }),
  };

  const mgr = new MiningFarmingManager(bot);
  const first = mgr.scanValuableOres();
  assert.equal(first.length, 1);
  assert.match(first[0], /diamond_ore tại 5, 12, -3/);

  mgr.lastOreScanAt = 0;
  const second = mgr.scanValuableOres();
  assert.equal(second.length, 0);
});

test('farmCrops harvests mature wheat and replants wheat_seeds onto farmland', async () => {
  const dug = [];
  const placed = [];
  const world = new Map([
    ['1,64,0', { name: 'wheat', position: new Vec3(1, 64, 0), properties: { age: 7 } }],
    ['1,63,0', { name: 'farmland', position: new Vec3(1, 63, 0) }],
    ['2,64,0', { name: 'wheat', position: new Vec3(2, 64, 0), properties: { age: 3 } }],
  ]);

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { wheat: { id: 183 } } },
    inventory: { items: () => [{ name: 'wheat_seeds', count: 5 }] },
    findBlocks: () => [new Vec3(1, 64, 0), new Vec3(2, 64, 0)],
    blockAt: (p) => world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'air', position: p },
    dig: async (b) => { dug.push(b.position.x); },
    equip: async () => {},
    placeBlock: async (soil) => { placed.push(soil.position.x); },
  };

  const mgr = new MiningFarmingManager(bot);
  const res = await mgr.farmCrops();
  assert.deepEqual(res, { harvested: 1, replanted: 1 });
  assert.deepEqual(dug, [1]);
  assert.deepEqual(placed, [1]);
});

test('digTunnel stops when encountering a 2-block deep ravine/cave drop ahead', async () => {
  const world = new Map([
    ['0,64,-1', { name: 'stone', position: new Vec3(0, 64, -1), diggable: true }],
    ['0,65,-1', { name: 'stone', position: new Vec3(0, 65, -1), diggable: true }],
    ['0,63,-3', { name: 'cave_air', position: new Vec3(0, 63, -3) }],
    ['0,62,-3', { name: 'air', position: new Vec3(0, 62, -3) }],
  ]);

  const bot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    inventory: { items: () => [] },
    blockAt: (p) => world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'stone', position: p, diggable: true },
    dig: async (b) => {
      world.set(`${b.position.x},${b.position.y},${b.position.z}`, { name: 'air', position: b.position });
    },
    pathfinder: { goto: async () => {} },
  };

  const mgr = new MiningFarmingManager(bot);
  const res = await mgr.digTunnel(10);
  assert.equal(res.steps, 1);
  assert.match(res.stoppedReason, /vực|hang sâu/);
});

test('digTunnel retries pathfinder GoalChanged when interrupted by combat pause', async () => {
  let paused = false;
  let gotoCalls = 0;
  const world = new Map();

  const bot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    inventory: { items: () => [] },
    blockAt: (p) => world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'stone', position: p, diggable: true },
    dig: async (b) => {
      world.set(`${b.position.x},${b.position.y},${b.position.z}`, { name: 'air', position: b.position });
    },
    pathfinder: {
      goto: async () => {
        gotoCalls++;
        if (gotoCalls === 1) {
          paused = true;
          setTimeout(() => { paused = false; }, 30);
          throw Object.assign(new Error('GoalChanged'), { name: 'GoalChanged' });
        }
      },
    },
  };

  const mgr = new MiningFarmingManager(bot, {}, { isPaused: () => paused });
  const res = await mgr.digTunnel(1);
  assert.equal(res.steps, 1);
  assert.equal(res.stoppedReason, null);
  assert.equal(gotoCalls, 2);
});

test('digTunnel stops when encountering lava or water on side walls', async () => {
  const world = new Map([
    ['0,64,-1', { name: 'stone', position: new Vec3(0, 64, -1), diggable: true }],
    ['0,65,-1', { name: 'stone', position: new Vec3(0, 65, -1), diggable: true }],
    ['1,65,-2', { name: 'flowing_lava', position: new Vec3(1, 65, -2) }],
  ]);

  const bot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0 }, // north (-z), side wall is +/-x
    inventory: { items: () => [] },
    blockAt: (p) => world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'stone', position: p, diggable: true },
    dig: async (b) => {
      world.set(`${b.position.x},${b.position.y},${b.position.z}`, { name: 'air', position: b.position });
    },
    pathfinder: { goto: async () => {} },
  };

  const mgr = new MiningFarmingManager(bot);
  const res = await mgr.digTunnel(5);
  assert.equal(res.steps, 1);
  assert.match(res.stoppedReason, /flowing_lava/);
});

test('digTunnel detects mid-tunnel pickaxe breakage and invokes ensurePickaxe', async () => {
  const world = new Map();
  let inv = [{ name: 'wooden_pickaxe', count: 1 }];
  let ensureCalls = 0;

  const bot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    inventory: { items: () => inv },
    blockAt: (p) => world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'stone', position: p, diggable: true },
    dig: async (b) => {
      world.set(`${b.position.x},${b.position.y},${b.position.z}`, { name: 'air', position: b.position });
      if (b.position.z === -1 && b.position.y === 64) {
        inv = []; // pickaxe breaks after step 1
      }
    },
    pathfinder: { goto: async () => {} },
  };

  const mgrReplace = new MiningFarmingManager(bot, {}, {
    ensurePickaxe: async (tier) => {
      ensureCalls++;
      if (tier === 'wood' && ensureCalls === 1) {
        inv = [{ name: 'wooden_pickaxe', count: 1 }];
        return true;
      }
      return false;
    },
  });

  const okRes = await mgrReplace.digTunnel(2);
  assert.equal(okRes.steps, 2);
  assert.equal(okRes.stoppedReason, null);
  assert.equal(ensureCalls, 1);

  inv = [];
  world.clear();
  const stopMgr = new MiningFarmingManager(bot, {}, {
    ensurePickaxe: async () => false,
  });
  const stoppedRes = await stopMgr.digTunnel(2);
  assert.equal(stoppedRes.steps, 0);
  assert.match(stoppedRes.stoppedReason, /cuốc/);
});

test('digTunnel times out cleanly via digTimeoutMs when bot.dig hangs', async () => {
  let stopDiggingCalls = 0;
  const bot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    inventory: { items: () => [] },
    blockAt: (p) => ({ name: 'stone', position: p, diggable: true }),
    dig: () => new Promise(() => {}),
    stopDigging: () => { stopDiggingCalls++; },
    pathfinder: { goto: async () => {} },
  };

  const mgr = new MiningFarmingManager(bot, {}, { digTimeoutMs: 40 });
  await assert.rejects(mgr.digTunnel(1), (err) => err?.name === 'Timeout');
  assert.equal(stopDiggingCalls, 1);
});

test('farmCrops waits and collects dropped seeds when starting with empty inventory', async () => {
  const inv = [];
  const placed = [];
  const world = new Map([
    ['1,64,0', { name: 'wheat', position: new Vec3(1, 64, 0), properties: { age: 7 } }],
    ['1,63,0', { name: 'farmland', position: new Vec3(1, 63, 0) }],
  ]);

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    registry: { blocksByName: { wheat: { id: 183 } } },
    inventory: { items: () => inv },
    findBlocks: () => [new Vec3(1, 64, 0)],
    blockAt: (p) => world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'air', position: p },
    dig: async () => {
      bot.entities[99] = { name: 'item', position: new Vec3(1, 64, 0) };
    },
    pathfinder: {
      goto: async () => {
        inv.push({ name: 'wheat_seeds', count: 2 });
        delete bot.entities[99];
      },
    },
    equip: async () => {},
    placeBlock: async (soil) => { placed.push(soil.position.x); },
  };

  const mgr = new MiningFarmingManager(bot, {}, { seedWaitMs: 10 });
  const res = await mgr.farmCrops();
  assert.deepEqual(res, { harvested: 1, replanted: 1 });
  assert.deepEqual(placed, [1]);
});

test('digTunnel checks canHarvest after equipForBlock (including null heldItem) and places torches using blockLight + skyLight', async () => {
  // 1) canHarvest blocks mining obsidian with wrong/missing held item after equipForBlock
  let dugCalled = false;
  let equipForBlockCalled = false;
  let canHarvestArg = 'unset';
  const obsBot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    heldItem: null,
    inventory: { items: () => [] },
    tool: { equipForBlock: async () => { equipForBlockCalled = true; } },
    blockAt: (p) => {
      if (p.z === -1 && p.y === 65) {
        return {
          name: 'obsidian',
          position: p,
          diggable: true,
          canHarvest: (heldType) => {
            canHarvestArg = heldType;
            return false;
          },
        };
      }
      return { name: 'stone', position: p, diggable: true };
    },
    dig: async () => { dugCalled = true; },
    pathfinder: { goto: async () => {} },
  };
  const obsMgr = new MiningFarmingManager(obsBot);
  const stopObs = await obsMgr.digTunnel(2);
  assert.equal(equipForBlockCalled, true);
  assert.equal(canHarvestArg, null);
  assert.equal(dugCalled, false);
  assert.match(stopObs.stoppedReason, /không đủ cấp.*obsidian/);

  // 2) _shouldPlaceTorch skips sunny outdoor (blockLight=0, skyLight=15, isDay=true)
  //    and places in dark tunnel (skyLight=0) or outdoor night (isDay=false)
  let torchPlacements = 0;
  let curSkyLight = 15;
  let curIsDay = true;
  const torchBot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    time: { get isDay() { return curIsDay; } },
    world: {
      getBlockLight: () => 0,
      getSkyLight: () => curSkyLight,
    },
    inventory: { items: () => [{ name: 'torch', count: 10 }] },
    blockAt: (p) => (p.y < 64
      ? { name: 'stone', boundingBox: 'block', position: p }
      : { name: 'air', position: p }),
    equip: async () => {},
    placeBlock: async () => { torchPlacements += 1; },
    dig: async () => {},
    pathfinder: { goto: async () => {} },
  };
  const torchMgr = new MiningFarmingManager(torchBot);
  await torchMgr.digTunnel(2);
  assert.equal(torchPlacements, 0);

  curSkyLight = 0;
  await torchMgr.digTunnel(1);
  assert.equal(torchPlacements, 1);

  curSkyLight = 15;
  curIsDay = false;
  await torchMgr.digTunnel(1);
  assert.equal(torchPlacements, 2);
});
