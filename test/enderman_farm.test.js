import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';

import { CommandRouter } from '../src/commands.js';
import { MiningFarmingManager } from '../src/mining_farming.js';
import { CombatController } from '../src/combat/index.js';
import { resolveJevDecision } from '../src/combat/threat_assessment.js';
import { EquipmentManager } from '../src/equipment.js';

function pos(x, y, z) {
  return new Vec3(x, y, z);
}

function key(x, y, z) {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

function makeWorldBot({ blocks = new Map(), inv = [], startPos = pos(0.5, 64, 0.5) } = {}) {
  const bot = new EventEmitter();
  bot.username = 'bot_dong_hanh';
  bot.health = 20;
  bot.food = 20;
  bot.isAlive = true;
  bot.isSleeping = false;
  bot.heldItem = null;
  bot.entity = { position: startPos.clone(), onGround: true, velocity: { y: 0 }, yaw: 0 };
  bot.entities = {};
  bot.players = {};
  bot._gotos = [];
  bot._looks = [];
  bot._attacks = [];
  bot._jumps = [];

  bot.inventory = {
    slots: new Array(46).fill(null),
    items: () => inv,
    emptySlotCount: () => 20,
  };
  bot.pathfinder = {
    setMovements: () => {},
    setGoal: (g) => { bot._gotos.push(g); },
    goto: async (g) => {
      bot._gotos.push(g);
      if (g && Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.z)) {
        bot.entity.position = pos(g.x, g.y, g.z);
      }
    },
    isMoving: () => false,
  };
  bot.blockAt = (p) => blocks.get(key(p.x, p.y, p.z)) ?? { name: 'air', boundingBox: 'empty', position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) };
  bot.equip = async (item, dest) => {
    if (dest === 'hand') bot.heldItem = item;
  };
  bot.lookAt = async (p, force) => {
    bot._looks.push({ pos: p, force: Boolean(force) });
  };
  bot.setControlState = (k, v) => {
    if (k === 'jump' && v) bot._jumps.push(k);
  };
  bot.activateItem = () => {};
  bot.deactivateItem = () => {};
  bot.placeBlock = async (refBlock, faceVec) => {
    const np = pos(
      Math.floor(refBlock.position.x + faceVec.x),
      Math.floor(refBlock.position.y + faceVec.y),
      Math.floor(refBlock.position.z + faceVec.z)
    );
    const heldName = bot.heldItem?.name ?? 'cobblestone';
    blocks.set(key(np.x, np.y, np.z), { name: heldName, boundingBox: 'block', diggable: true, position: np });
    if (bot.heldItem) {
      bot.heldItem.count = Math.max(0, (bot.heldItem.count ?? 1) - 1);
    }
  };
  bot.dig = async (blk) => {
    const existing = blocks.get(key(blk.position.x, blk.position.y, blk.position.z));
    blocks.delete(key(blk.position.x, blk.position.y, blk.position.z));
    if (existing?.name) {
      const stack = inv.find((i) => i.name === existing.name);
      if (stack) stack.count = (stack.count ?? 0) + 1;
      else inv.push({ name: existing.name, count: 1 });
    }
  };
  return bot;
}

test('CommandRouter parses fram/farm enderman and pearl commands with delivery chain', () => {
  const router = new CommandRouter();

  assert.deepEqual(router.parse('fram endeman'), { type: 'farm_enderman', count: 8, countMode: 'kills' });
  assert.deepEqual(router.parse('farm 10 enderman'), { type: 'farm_enderman', count: 10, countMode: 'kills' });
  assert.deepEqual(router.parse('săn enderman'), { type: 'farm_enderman', count: 8, countMode: 'kills' });
  assert.deepEqual(router.parse('kiếm 12 ngọc ender'), { type: 'farm_enderman', count: 12, countMode: 'pearls', target: 'ender_pearl' });
  assert.deepEqual(router.parse('đừng farm enderman nữa').type, 'unknown');

  const chained = router.parseChain('lấy 8 ender pearl cho tôi');
  assert.deepEqual(chained, {
    type: 'chain',
    steps: [
      { type: 'farm_enderman', count: 8, countMode: 'pearls', target: 'ender_pearl' },
      { type: 'give', count: 'all', target: 'ender_pearl' },
    ],
  });
});

test('buildEndermanShelter erects 3x3 roof at y+2, cleans temporary pillar, rejects gravity blocks, and reuses existing roof', async () => {
  const blocks = new Map();
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      blocks.set(key(x, 63, z), { name: 'end_stone', boundingBox: 'block', position: pos(x, 63, z) });
    }
  }

  // Only gravity blocks (sand) -> rejected!
  const sandBot = makeWorldBot({ blocks, inv: [{ name: 'sand', count: 32 }] });
  const sandMining = new MiningFarmingManager(sandBot, {}, { seedWaitMs: 0 });
  await assert.rejects(() => sandMining.buildEndermanShelter(), /khối rắn/);

  // Cobblestone -> builds 3x3 at y=66 (y+2) via temp pillar and removes pillar afterward
  const inv = [{ name: 'cobblestone', count: 16 }];
  const bot = makeWorldBot({ blocks, inv, startPos: pos(0.5, 64, 0.5) });
  const mining = new MiningFarmingManager(bot, {}, { seedWaitMs: 0 });
  const built = await mining.buildEndermanShelter();
  assert.equal(built.placed, 9);

  for (let rx = -1; rx <= 1; rx++) {
    for (let rz = -1; rz <= 1; rz++) {
      const top = blocks.get(key(built.center.x + rx, built.center.y + 2, built.center.z + rz));
      assert.equal(top?.name, 'cobblestone', `missing roof block at (${rx}, ${rz})`);
    }
  }
  assert.equal(blocks.get(key(built.center.x + 1, built.center.y, built.center.z)), undefined);
  assert.equal(blocks.get(key(built.center.x + 1, built.center.y + 1, built.center.z)), undefined);

  // Reuses already-built 3x3 shelter even when inventory has 0 blocks left
  inv[0].count = 0;
  const reused = await mining.buildEndermanShelter();
  assert.equal(reused.placed, 0);
  assert.deepEqual(reused.center, built.center);
});

test('farmEndermen & CombatController anchor bot under canopy, stare at Enderman eyes, kill without arrows or leaving roof, and collect pearls', async () => {
  const blocks = new Map();
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      blocks.set(key(x, 63, z), { name: 'end_stone', boundingBox: 'block', position: pos(x, 63, z) });
    }
  }

  const inv = [
    { name: 'cobblestone', count: 16 },
    { name: 'diamond_sword', count: 1 },
    { name: 'bow', count: 1 },
    { name: 'arrow', count: 32 },
  ];
  const bot = makeWorldBot({ blocks, inv, startPos: pos(0.5, 64, 0.5) });

  // Enderman starts 12m away: staring at eye level (y+2.52) lures it onto the shelter lip (x=2.6, dist=2.1)
  const enderman1 = { id: 51, name: 'enderman', type: 'mob', health: 20, position: pos(12.5, 64, 0.5), target: null };
  bot.entities[51] = enderman1;

  let stareLured = false;
  const origLookAt = bot.lookAt;
  bot.lookAt = async (p, force) => {
    await origLookAt(p, force);
    if (force && p && Math.abs(p.y - (64 + 2.52)) < 0.15 && enderman1.health > 0) {
      stareLured = true;
      enderman1.target = bot.entity;
      enderman1.position = pos(2.6, 64, 0.5);
    }
  };

  bot.attack = async (ent) => {
    bot._attacks.push(ent.id);
    ent.health = 0;
    delete bot.entities[ent.id];
    bot.entities[90] = { id: 90, name: 'item', objectType: 'Item', position: pos(2.6, 64, 0.5) };
  };

  const origGoto = bot.pathfinder.goto;
  bot.pathfinder.goto = async (g) => {
    await origGoto(g);
    if (bot.entities[90] && Math.hypot(g.x - 2.6, g.z - 0.5) < 1.2) {
      delete bot.entities[90];
      inv.push({ name: 'ender_pearl', count: 1 });
    }
  };

  const eq = new EquipmentManager(bot, {});
  const combat = new CombatController(bot, { combat: { enabled: true, bow: true, crit: true, retreatHealth: 8 } }, { equipment: eq });
  const mining = new MiningFarmingManager(bot, {}, {
    seedWaitMs: 0,
    setShelterHold: (p) => { combat.shelterHoldPos = p; },
  });

  // CombatController must never choose bow for Enderman even with bow + arrows
  const enderThreat = { id: 51, name: 'enderman', distance: 10, position: pos(10.5, 64, 0.5), entity: enderman1 };
  assert.equal(combat._localReflexDecision(enderThreat, [enderThreat], 20, { posture: 'aggressive' }).action, 'melee');
  assert.equal(resolveJevDecision({
    config: { retreatHealth: 8, minConfidence: 0.3 },
    equipment: eq,
    _canUseBow: () => true,
  }, { action: 'bow', confidence: 0.9 }, [enderThreat], enderThreat, null, 20).action, 'melee');

  // Even at low health (4 <= 8), CombatController under shelterHoldPos stays and swings grounded instead of retreating outside
  bot.health = 4;
  combat.shelterHoldPos = pos(0.5, 64, 0.5);
  enderman1.position = pos(2.6, 64, 0.5);
  enderman1.target = bot.entity;
  combat.start();
  await combat._runTick({});
  assert.equal(bot._attacks.includes(51), true);
  assert.equal(bot._jumps.length, 0, 'must not jump-crit into y+2 shelter ceiling');
  combat.stop();

  // Re-spawn Enderman at 12m and run full farmEndermen workflow
  bot.health = 20;
  bot._attacks.length = 0;
  bot._looks.length = 0;
  enderman1.health = 20;
  enderman1.target = null;
  enderman1.position = pos(12.5, 64, 0.5);
  bot.entities[51] = enderman1;

  const res = await mining.farmEndermen(1, { countMode: 'kills', maxIdleChecks: 3 });
  assert.equal(stareLured, true);
  assert.equal(res.kills, 1);
  assert.equal(res.pearlsGained, 1);
  assert.equal(combat.shelterHoldPos, null, 'shelterHoldPos must clear on exit');
});

test('Under-tree canopy hides bot with 0 building blocks, preserves tree trunk, and farms Enderman', async () => {
  const blocks = new Map();
  for (let x = -4; x <= 8; x++) {
    for (let z = -4; z <= 12; z++) {
      blocks.set(key(x, 63, z), { name: 'grass_block', boundingBox: 'block', position: pos(x, 63, z) });
    }
  }
  // Oak tree trunk at (4, 64..66, 0) + rounded oak_leaves canopy at y=66 covering (3, 64, 0) (7/9 columns blocked)
  for (const ty of [64, 65, 66]) {
    blocks.set(key(4, ty, 0), { name: 'oak_log', boundingBox: 'block', diggable: true, position: pos(4, ty, 0) });
  }
  for (const [lx, lz] of [[3, 0], [2, 0], [3, 1], [3, -1], [4, 1], [4, -1]]) {
    blocks.set(key(lx, 66, lz), { name: 'oak_leaves', boundingBox: 'block', diggable: true, position: pos(lx, 66, lz) });
  }

  const inv = [{ name: 'iron_sword', count: 1 }]; // 0 building blocks
  const bot = makeWorldBot({ blocks, inv, startPos: pos(0.5, 64, 0.5) });
  const enderman = { id: 61, name: 'enderman', type: 'mob', health: 20, position: pos(3.5, 64, 10.5), target: null };
  bot.entities[61] = enderman;

  const origLookAt = bot.lookAt;
  bot.lookAt = async (p, force) => {
    await origLookAt(p, force);
    if (force && p && Math.abs(p.y - (64 + 2.52)) < 0.15 && enderman.health > 0) {
      enderman.target = bot.entity;
      enderman.position = pos(3.5, 64, 2.2);
    }
  };
  bot.attack = async (ent) => {
    bot._attacks.push(ent.id);
    ent.health = 0;
    delete bot.entities[ent.id];
    bot.entities[91] = { id: 91, name: 'item', objectType: 'Item', position: pos(3.5, 64, 2.2) };
  };
  const origGoto = bot.pathfinder.goto;
  bot.pathfinder.goto = async (g) => {
    await origGoto(g);
    if (bot.entities[91] && Math.hypot(g.x - 3.5, g.z - 2.2) < 1.2) {
      delete bot.entities[91];
      inv.push({ name: 'ender_pearl', count: 1 });
    }
  };

  const mining = new MiningFarmingManager(bot, {}, { seedWaitMs: 0 });
  const res = await mining.farmEndermen(1, { countMode: 'kills', maxIdleChecks: 3 });

  assert.equal(res.shelterKind, 'tree');
  assert.deepEqual(res.shelter, { x: 3, y: 64, z: 0 });
  assert.equal(res.roofPlaced, 0);
  assert.equal(res.kills, 1);
  assert.equal(res.pearlsGained, 1);
  // Trunk blocks untouched
  assert.equal(blocks.get(key(4, 64, 0))?.name, 'oak_log');
  assert.equal(blocks.get(key(4, 65, 0))?.name, 'oak_log');
});

test('Open-ground 3x3 overhead canopy builds cleanly with exact 9 cobblestone by reclaiming temp step', async () => {
  const blocks = new Map();
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      blocks.set(key(x, 63, z), { name: 'end_stone', boundingBox: 'block', position: pos(x, 63, z) });
    }
  }
  const inv = [{ name: 'cobblestone', count: 9 }];
  const bot = makeWorldBot({ blocks, inv, startPos: pos(0.5, 64, 0.5) });
  const mining = new MiningFarmingManager(bot, {}, { seedWaitMs: 0 });

  const built = await mining.buildEndermanShelter();
  assert.equal(built.placed, 9);
  for (let rx = -1; rx <= 1; rx++) {
    for (let rz = -1; rz <= 1; rz++) {
      assert.equal(blocks.get(key(built.center.x + rx, built.center.y + 2, built.center.z + rz))?.name, 'cobblestone');
    }
  }
  assert.equal(blocks.get(key(built.center.x + 1, built.center.y, built.center.z)), undefined);
  assert.equal(blocks.get(key(built.center.x + 1, built.center.y + 1, built.center.z)), undefined);
});
