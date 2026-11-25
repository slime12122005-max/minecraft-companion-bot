import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { CompanionManager } from '../src/companion.js';
import { SurvivalManager } from '../src/survival/index.js';
import { MotorHumanizer } from '../src/humanizer.js';
import { configureMovements } from '../src/session/task_helpers.js';
import { TaskCoordinator } from '../src/tasks.js';
import { CommandRouter } from '../src/commands.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createBotSession } from '../src/session.js';
import { Memory } from '../src/memory.js';

const require = createRequire(import.meta.url);
const mfReq = createRequire(require.resolve('mineflayer/package.json'));
const prismarineRegistry = mfReq('prismarine-registry');
const realRegistry = prismarineRegistry('1.21.1');

function keyOf(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

test('CompanionManager.tickSurvivalAutonomy skips cook_food without furnace or 8 cobble and launches tu_farm_da', async () => {
  const world = new Map();
  // Sealed stone at y=60 beneath dirt/grass layers (y=61..63)
  for (let x = 6; x <= 14; x++) {
    for (let z = -3; z <= 3; z++) {
      world.set(`${x},63,${z}`, 'grass_block');
      world.set(`${x},62,${z}`, 'dirt');
      world.set(`${x},61,${z}`, 'dirt');
      world.set(`${x},60,${z}`, 'stone');
      world.set(`${x},59,${z}`, 'stone');
    }
  }

  let gatherCall = null;
  let smeltCalls = 0;
  const bot = {
    username: 'bot_dong_hanh',
    registry: realRegistry,
    time: { timeOfDay: 6000, age: 6000 },
    game: { dimension: 'overworld' },
    heldItem: null,
    entity: { position: new Vec3(10, 64, 0), onGround: true, yaw: 0 },
    entities: {},
    players: { araslime: { entity: { username: 'araslime', position: new Vec3(8, 64, 0) } } },
    inventory: {
      items: () => [
        { name: 'wooden_pickaxe', count: 1 },
        { name: 'mutton', count: 3 },
        { name: 'oak_planks', count: 6 },
      ],
      emptySlotCount: () => 20,
    },
    blockAt: (p) => {
      const name = world.get(keyOf(p)) ?? 'air';
      const id = realRegistry.blocksByName[name]?.id ?? 0;
      return { name, type: id, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: id ? 'block' : 'empty' };
    },
    findBlocks: ({ matching, maxDistance = 24 }) => {
      const idSet = new Set(Array.isArray(matching) ? matching : [matching]);
      const hits = [];
      for (const [k, name] of world.entries()) {
        const id = realRegistry.blocksByName[name]?.id ?? 0;
        if (!idSet.has(id)) continue;
        const [x, y, z] = k.split(',').map(Number);
        const p = new Vec3(x, y, z);
        if (bot.entity.position.distanceTo(p) <= maxDistance) hits.push(p);
      }
      return hits.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
    },
    findBlock: () => null,
    pathfinder: { setGoal: () => {}, goto: async () => {}, isMoving: () => false },
    chat: () => {},
  };

  const tasks = new TaskCoordinator({ log: () => {} });
  const ctx = {
    bot,
    config: { owner: 'araslime', companion: { idleLife: true, autoFarm: true, ambientChatter: false, preserveInTests: true } },
    state: { stayPut: false, autoFarmEnabled: true },
    combat: { busy: false },
    survival: {
      busy: false,
      gather: async (target, count) => {
        gatherCall = { target, count };
        return count;
      },
    },
    equipment: { maintain: async () => {} },
    tasks,
    crafting: {
      smeltItem: async () => {
        smeltCalls += 1;
        throw new Error('Không thể chế tạo hoặc đặt lò nung.');
      },
    },
    mining: {},
    home: { get: () => new Vec3(0, 64, 0), getStorageChest: () => null },
    log: () => {},
  };

  const companion = new CompanionManager(ctx, { enabledChat: true, enabledIdle: true });
  const run = await companion.tickSurvivalAutonomy(100_000, { force: true });
  await run?.promise;

  assert.equal(smeltCalls, 0, 'must NOT attempt cook_food when no furnace or >= 8 cobble is owned');
  assert.equal(run?.kind, 'auto_farm_stone', 'must advance directly to auto_farm_stone');
  assert.deepEqual(gatherCall, { target: 'stone', count: 12 });
});

test('survival.gather("đá", 6) excavates a safe staircase under grass/dirt, preserves pickaxe on dirt, and avoids lava', async () => {
  const world = new Map();
  // Create a 3D flat plains volume from y=57..63 with stone sealed beneath y=60 and dirt above
  for (let x = -4; x <= 14; x++) {
    for (let z = -4; z <= 4; z++) {
      world.set(`${x},63,${z}`, { name: 'grass_block', type: realRegistry.blocksByName.grass_block.id });
      world.set(`${x},62,${z}`, { name: 'dirt', type: realRegistry.blocksByName.dirt.id });
      world.set(`${x},61,${z}`, { name: 'dirt', type: realRegistry.blocksByName.dirt.id });
      for (let y = 57; y <= 60; y++) {
        world.set(`${x},${y},${z}`, { name: 'stone', type: realRegistry.blocksByName.stone.id });
      }
    }
  }
  // Put lava immediately on the -X, +Z, -Z sides at (0±1, 63, 0±1) so only +X is safe!
  world.set('-1,63,0', { name: 'lava', type: realRegistry.blocksByName.lava.id });
  world.set('0,63,1', { name: 'lava', type: realRegistry.blocksByName.lava.id });
  world.set('0,63,-1', { name: 'lava', type: realRegistry.blocksByName.lava.id });

  let held = { name: 'wooden_pickaxe', count: 1 };
  const inv = [
    held,
    { name: 'oak_planks', count: 8 },
  ];
  const equippedOnBlock = [];
  let collectBlockCalls = 0;

  const bot = {
    registry: realRegistry,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 },
    entities: {},
    heldItem: held,
    inventory: {
      items: () => inv,
      emptySlotCount: () => 20,
    },
    equip: async (item) => {
      held = item;
      bot.heldItem = item;
    },
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const bx = Math.floor(p.x);
      const by = Math.floor(p.y);
      const bz = Math.floor(p.z);
      if (!b) {
        if (by <= 63) {
          return {
            name: 'bedrock',
            type: realRegistry.blocksByName.bedrock.id,
            position: new Vec3(bx, by, bz),
            boundingBox: 'block',
            diggable: false,
          };
        }
        return { name: 'air', type: 0, position: new Vec3(bx, by, bz), boundingBox: 'empty', diggable: false };
      }
      if (b.type === 0 || b.name === 'air') {
        return { name: 'air', type: 0, position: new Vec3(bx, by, bz), boundingBox: 'empty', diggable: false };
      }
      return {
        name: b.name,
        type: b.type,
        position: new Vec3(bx, by, bz),
        boundingBox: b.name === 'lava' ? 'empty' : 'block',
        diggable: b.name !== 'lava',
      };
    },
    findBlocks: ({ matching, maxDistance = 48 }) => {
      const idSet = new Set(Array.isArray(matching) ? matching : [matching]);
      const hits = [];
      for (const [k, b] of world.entries()) {
        if (!idSet.has(b.type)) continue;
        const [x, y, z] = k.split(',').map(Number);
        const p = new Vec3(x, y, z);
        if (bot.entity.position.distanceTo(p) <= maxDistance) hits.push(p);
      }
      return hits.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
    },
    digTime: () => 10,
    dig: async (block) => {
      equippedOnBlock.push({ block: block.name, held: bot.heldItem?.name ?? null, x: block.position.x, y: block.position.y, z: block.position.z });
      world.set(keyOf(block.position), { name: 'air', type: 0 });
    },
    pathfinder: {
      goto: async (goal) => {
        bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
      },
      setGoal: () => {},
      stop: () => {},
    },
    collectBlock: {
      collect: async () => {
        collectBlockCalls += 1;
      },
    },
  };

  const survival = new SurvivalManager(bot, {}, { home: { get: () => new Vec3(-2, 64, 0) } });
  survival._timeouts = { ...survival._timeouts, dropWaitMs: 0, verifyDelayMs: 0 };

  const got = await survival.gather('đá', 6);
  assert.ok(got >= 6, `expected at least 6 mined stone, got ${got}`);
  assert.equal(collectBlockCalls, 0, 'should skip buried stone collectBlock calls instead of timing out');

  // Verify safe +X staircase direction chosen (never dug -1,63,0 or Z!=0 initially)
  assert.ok(equippedOnBlock.some((e) => e.x >= 1), 'should descend toward safe +X direction');

  // Verify pickaxe was unequipped/swapped to planks when breaking dirt/grass and equipped when breaking stone!
  const dirtDigs = equippedOnBlock.filter((e) => e.block === 'dirt' || e.block === 'grass_block');
  const stoneDigs = equippedOnBlock.filter((e) => e.block === 'stone');
  assert.ok(dirtDigs.length > 0, 'should dig through dirt/grass overburden');
  assert.ok(stoneDigs.length >= 6, 'should dig at least 6 stone blocks');
  assert.ok(dirtDigs.every((d) => d.held !== 'wooden_pickaxe'), 'must not waste pickaxe on dirt/grass');
  assert.ok(stoneDigs.every((s) => s.held === 'wooden_pickaxe'), 'must equip pickaxe for stone');
});

test('configureMovements disables parkour & clears collectBlock.movements, and MotorHumanizer yields while moving', async () => {
  let activeMovements = null;
  const fakeBot = {
    registry: realRegistry,
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    version: '1.21.1',
    pathfinder: {
      setMovements: (mv) => { activeMovements = mv; },
      isMoving: () => true,
    },
    collectBlock: {
      movements: { allowParkour: true },
    },
    look: async () => {
      throw new Error('smoothLookAt must NOT call bot.look while pathfinder.isMoving() is true');
    },
  };

  configureMovements(fakeBot);
  assert.equal(activeMovements.allowParkour, false);
  assert.equal(activeMovements.canOpenDoors, true);
  assert.equal(activeMovements.dontCreateFlow, true);
  assert.equal(activeMovements.dontMineUnderFallingBlock, true);
  assert.equal(fakeBot.collectBlock.movements, null);

  const humanizer = new MotorHumanizer(fakeBot);
  await humanizer.smoothLookAt(new Vec3(5, 65, 5), { steps: 5, stepMs: 0 });

  // Also test aborting mid-sweep if movement starts after step 1
  let looks = 0;
  let moving = false;
  const sweepBot = {
    registry: realRegistry,
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    pathfinder: { isMoving: () => moving },
    look: async () => {
      looks += 1;
      moving = true; // start walking right after first step
    },
  };
  const h2 = new MotorHumanizer(sweepBot);
  await h2.smoothLookAt(new Vec3(5, 65, 5), { steps: 5, stepMs: 0 });
  assert.equal(looks, 1, 'smoothLookAt should yield immediately once pathfinder starts moving');
});

test('CompanionManager.tickIdle preserves GoalFollow steadily across 3.8..6.5 band without thrashing setGoal', async () => {
  const goalCalls = [];
  const ownerEntity = { id: 1, username: 'araslime', position: new Vec3(10, 64, 0), yaw: 0, velocity: new Vec3(0, 0, 0) };
  const bot = {
    username: 'bot_dong_hanh',
    registry: realRegistry,
    time: { timeOfDay: 6000, age: 6000 },
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(0, 64, 0), onGround: true, yaw: 0 },
    entities: {},
    players: { araslime: { entity: ownerEntity } },
    inventory: { items: () => [], emptySlotCount: () => 20 },
    pathfinder: {
      setGoal: (g, dyn) => { goalCalls.push({ g, dyn }); },
      isMoving: () => true,
    },
    blockAt: () => ({ name: 'air', type: 0, boundingBox: 'empty' }),
    findBlock: () => null,
    findBlocks: () => [],
  };

  const ctx = {
    bot,
    config: { owner: 'araslime', companion: { idleLife: true, idleFollowRange: 6.5, ambientChatter: false } },
    state: { stayPut: false, idleGoalActive: false },
    combat: { busy: false },
    survival: { busy: false, lastGaveItemAt: 0 },
    tasks: { active: null },
    equipment: {},
  };
  const c = new CompanionManager(ctx, { enabledChat: false, enabledIdle: true });

  // Owner > 6.5 blocks -> sets GoalFollow once
  await c.tickIdle(10_000);
  assert.equal(goalCalls.length, 1);

  // Owner walks slightly closer to 5.0m (inside 3.8..6.5 hysteresis band) -> must NOT drop or overwrite GoalFollow
  ownerEntity.position = new Vec3(5, 64, 0);
  await c.tickIdle(11_000);
  assert.equal(goalCalls.length, 1);
  assert.equal(c._escortingOwner, true);

  // Owner stops next to bot (3.0m <= 3.8m) -> releases escort goal cleanly
  ownerEntity.position = new Vec3(3, 64, 0);
  await c.tickIdle(12_000);
  assert.equal(c._escortingOwner, false);
  assert.equal(goalCalls.at(-1).g, null);
});

test('natural confirm ("ok") approves pending readiness action cleanly', async () => {
  const world = new Map([['2,64,0', { type: realRegistry.blocksByName.stone.id, name: 'stone' }]]);
  const fakeBot = {
    username: 'bot_dong_hanh',
    version: '1.21.1',
    health: 20,
    food: 20,
    isAlive: true,
    isSleeping: false,
    heldItem: null,
    time: { timeOfDay: 6000, age: 6000 },
    game: { dimension: 'overworld' },
    registry: realRegistry,
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, onGround: true, velocity: { y: 0 }, metadata: { 0: 0 } },
    entities: {},
    players: { araslime: { entity: { id: 99, username: 'araslime', position: new Vec3(2, 64, 0), health: 20 } } },
    inventory: { items: () => [{ name: 'wooden_pickaxe', count: 1 }], slots: new Array(46).fill(null), emptySlotCount: () => 20 },
    pathfinder: { setMovements: () => {}, setGoal: () => {}, goto: async () => {}, isMoving: () => false },
    blockAt: (p) => {
      const b = world.get(keyOf(p));
      return b ? { ...b, position: p, boundingBox: 'block' } : { name: 'air', type: 0, position: p, boundingBox: 'empty' };
    },
    findBlocks: () => [...world.keys()].map((k) => {
      const [x, y, z] = k.split(',').map(Number);
      return new Vec3(x, y, z);
    }),
    findBlock: () => null,
    collectBlock: { collect: async (b) => { world.delete(keyOf(b.position)); } },
    look: async () => {},
    lookAt: async () => {},
    setControlState: () => {},
    clearControlStates: () => {},
    stopDigging: () => {},
    chat: () => {},
    whisper: () => {},
    on: () => {},
    once: () => {},
    removeListener: () => {},
    quit: () => {},
  };

  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const session = createBotSession(
    { ...DEFAULT_CONFIG, dashboard: { enabled: false, host: '127.0.0.1', port: 3000 }, combat: { ...DEFAULT_CONFIG.combat, enabled: false } },
    { llm: {}, memory, tasks, router: new CommandRouter(), createBotFn: () => fakeBot, loadPlugins: false }
  );

  try {
    await session.onCommand('lấy 1 đá');
    assert.ok(session.state.pendingAction, 'low food prompts readiness confirmation');
    await session.onCommand('ok');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(session.state.pendingAction, null);
    assert.equal(world.has('2,64,0'), false, 'natural "ok" should confirm and mine the stone');
  } finally {
    await session.cleanup();
  }
});
