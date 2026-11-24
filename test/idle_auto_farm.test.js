import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { CommandRouter } from '../src/commands.js';
import { CompanionManager, findSafeIdleTreeTarget, findSafeIdleMineralTarget } from '../src/companion.js';
import { EquipmentManager } from '../src/equipment.js';
import { TaskCoordinator } from '../src/tasks.js';
import { createBotSession } from '../src/session.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Memory } from '../src/memory.js';

const require = createRequire(import.meta.url);
const mineflayerPkgPath = require.resolve('mineflayer/package.json');
const mineflayerRequire = createRequire(mineflayerPkgPath);
const prismarineRegistry = mineflayerRequire('prismarine-registry');
const realRegistry = prismarineRegistry('1.21.1');

function keyOf(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

function makeWorldBot({ blocks = [], startPos = new Vec3(8, 64, 0), items = [], emptySlots = 20 } = {}) {
  const world = new Map();
  for (const [k, name] of blocks) {
    const [x, y, z] = k.split(',').map(Number);
    const id = realRegistry.blocksByName[name]?.id ?? 1;
    world.set(k, { name, type: id, position: new Vec3(x, y, z), boundingBox: 'block' });
  }

  let currentItems = [...items];
  let curEmpty = emptySlots;

  const bot = {
    username: 'bot_dong_hanh',
    registry: realRegistry,
    time: { timeOfDay: 6000, age: 6000 },
    game: { dimension: 'overworld' },
    heldItem: null,
    entity: { position: startPos, onGround: true, yaw: 0 },
    entities: {},
    players: { araslime: { entity: { username: 'araslime', position: startPos.offset(-2, 0, 0) } } },
    inventory: {
      items: () => currentItems,
      slots: new Array(46).fill(null),
      emptySlotCount: () => curEmpty,
    },
    blockAt: (p) => world.get(keyOf(p)) ?? { name: 'air', type: 0, position: p, boundingBox: 'empty' },
    findBlocks: ({ matching, maxDistance = 24 }) => {
      const idSet = new Set(Array.isArray(matching) ? matching : [matching]);
      return [...world.values()]
        .filter((b) => idSet.has(b.type) && bot.entity.position.distanceTo(b.position) <= maxDistance)
        .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
        .map((b) => b.position);
    },
    findBlock: ({ matching, maxDistance = 24 }) => {
      for (const b of world.values()) {
        if (bot.entity.position.distanceTo(b.position) > maxDistance) continue;
        if (typeof matching === 'function' ? matching(b) : b.type === matching) return b;
      }
      return null;
    },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    chat: () => {},
    openChest: async () => ({ close: () => {} }),
    _setItems: (next) => { currentItems = next; },
    _setEmptySlots: (n) => { curEmpty = n; },
  };
  return { bot, world };
}

test('zero-to-geared idle auto-farming protects player builds & hazards, progresses tools, mines ores/stone, and auto-deposits', async () => {
  const { bot } = makeWorldBot({
    startPos: new Vec3(8, 64, 0),
    blocks: [
      // House wooden log pillar next to oak_planks (must NEVER chop)
      ['7,64,1', 'oak_log'],
      ['7,65,1', 'oak_log'],
      ['7,64,2', 'oak_planks'],
      ['7,66,1', 'oak_leaves'],
      ['8,66,1', 'oak_leaves'],
      // Natural oak tree too close (< 7m) to home at (0, 64, 0) (must NEVER chop)
      ['5,64,0', 'oak_log'],
      ['5,65,0', 'oak_log'],
      ['5,66,0', 'oak_leaves'],
      ['4,66,0', 'oak_leaves'],
      // Valid natural oak tree away from home and builds
      ['12,64,0', 'oak_log'],
      ['12,65,0', 'oak_log'],
      ['12,66,0', 'oak_leaves'],
      ['11,66,0', 'oak_leaves'],
      ['13,66,0', 'oak_leaves'],
      // Stone block adjacent to cobblestone house wall (must NEVER mine)
      ['9,64,-2', 'stone'],
      ['9,64,-3', 'cobblestone'],
      // Safe natural stone away from home & structures
      ['12,64,-4', 'stone'],
      // Coal ore
      ['13,64,2', 'coal_ore'],
      // Iron ore next to lava (must NEVER mine) vs safe iron ore
      ['10,64,2', 'iron_ore'],
      ['10,64,3', 'lava'],
      ['14,64,2', 'iron_ore'],
      // Diamond ore
      ['15,64,2', 'diamond_ore'],
      // Home storage chest
      ['0,64,1', 'chest'],
    ],
  });

  const homePos = new Vec3(0, 64, 0);
  const chestPos = new Vec3(0, 64, 1);

  // Direct anti-griefing target finder verification
  const safeTree = findSafeIdleTreeTarget(bot, { maxDistance: 28, homePos, chestPos });
  assert.equal(keyOf(safeTree.position), '12,64,0', 'must pick valid natural tree away from planks & home');

  const safeIron = findSafeIdleMineralTarget(bot, ['iron_ore'], { maxDistance: 24, homePos, chestPos });
  assert.equal(keyOf(safeIron.position), '14,64,2', 'must skip lava-adjacent iron_ore');

  const safeStone = findSafeIdleMineralTarget(bot, ['stone'], {
    maxDistance: 20,
    homePos,
    chestPos,
    protectHomeRadius: 8,
    checkStructureNeighbors: true,
  });
  assert.equal(keyOf(safeStone.position), '12,64,-4', 'must skip stone touching cobblestone structure');

  const gatherCalls = [];
  let storedCount = 0;
  const equipment = new EquipmentManager(bot, {});
  const tasks = new TaskCoordinator({ log: () => {} });
  const ctx = {
    bot,
    config: { owner: 'araslime', companion: { idleLife: true, autoFarm: true, ambientChatter: false, preserveInTests: true } },
    state: { stayPut: false, autoFarmEnabled: true },
    combat: { busy: false },
    survival: {
      busy: false,
      gather: async (target, count) => {
        gatherCalls.push({ target, count });
        return count;
      },
    },
    equipment,
    tasks,
    crafting: {},
    mining: {},
    home: {
      get: () => homePos,
      getStorageChest: () => chestPos,
      storeSurplus: async () => { storedCount += 1; return true; },
    },
    log: () => {},
  };
  const companion = new CompanionManager(ctx, { enabledChat: true, enabledIdle: true });

  // 1) Naked bot chops natural tree when idle
  const woodRun = await companion.tickSurvivalAutonomy(100_000, { force: true });
  await woodRun?.promise;
  assert.equal(woodRun?.kind, 'auto_farm_wood');
  assert.deepEqual(gatherCalls.at(-1), { target: 'oak_log', count: 8 });

  // 2) After chopping wood (4 logs -> 16 woodUnits), EquipmentManager plans wooden_pickaxe
  bot._setItems([{ name: 'oak_log', count: 4 }]);
  assert.equal(equipment.planNextGearUpgrade()?.item, 'wooden_pickaxe');

  // 3) With wooden_pickaxe, bot mines coal first, then natural stone when coal reserve >= 32
  bot._setItems([{ name: 'wooden_pickaxe', count: 1 }, { name: 'oak_log', count: 24 }]);
  const coalRun = await companion.tickSurvivalAutonomy(130_000, { force: true });
  await coalRun?.promise;
  assert.equal(coalRun?.kind, 'auto_farm_coal');

  bot._setItems([{ name: 'wooden_pickaxe', count: 1 }, { name: 'oak_log', count: 24 }, { name: 'coal', count: 32 }]);
  const stoneRun = await companion.tickSurvivalAutonomy(160_000, { force: true });
  await stoneRun?.promise;
  assert.equal(stoneRun?.kind, 'auto_farm_stone');

  // 4) With cobblestone, EquipmentManager plans stone_pickaxe -> stone_sword -> stone_axe
  bot._setItems([{ name: 'wooden_pickaxe', count: 1 }, { name: 'cobblestone', count: 8 }, { name: 'stick', count: 4 }]);
  assert.equal(equipment.planNextGearUpgrade()?.item, 'stone_pickaxe');
  bot._setItems([{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 8 }, { name: 'stick', count: 4 }]);
  assert.equal(equipment.planNextGearUpgrade()?.item, 'stone_sword');
  bot._setItems([
    { name: 'stone_pickaxe', count: 1 },
    { name: 'stone_sword', count: 1 },
    { name: 'cobblestone', count: 8 },
    { name: 'stick', count: 4 },
  ]);
  assert.equal(equipment.planNextGearUpgrade()?.item, 'stone_axe');

  // 5) With stone_pickaxe, bot mines exposed iron_ore (away from lava)
  bot._setItems([{ name: 'stone_pickaxe', count: 1 }, { name: 'oak_log', count: 24 }, { name: 'coal', count: 32 }, { name: 'cobblestone', count: 32 }]);
  const ironRun = await companion.tickSurvivalAutonomy(190_000, { force: true });
  await ironRun?.promise;
  assert.equal(ironRun?.kind, 'auto_farm_iron');
  assert.deepEqual(gatherCalls.at(-1), { target: 'iron_ore', count: 8 });

  // 6) With iron_pickaxe, bot prioritizes diamond_ore
  bot._setItems([{ name: 'iron_pickaxe', count: 1 }]);
  const diamondRun = await companion.tickSurvivalAutonomy(220_000, { force: true });
  await diamondRun?.promise;
  assert.equal(diamondRun?.kind, 'auto_farm_rare_ore');
  assert.deepEqual(gatherCalls.at(-1), { target: 'diamond_ore', count: 6 });

  // 7) Tight inventory triggers auto_store to deposit surplus at chest
  bot._setEmptySlots(5);
  const storeRun = await companion.tickSurvivalAutonomy(250_000, { force: true });
  await storeRun?.promise;
  assert.equal(storeRun?.kind, 'auto_store');
  assert.equal(storedCount, 1);

  // 8) Night safety limits range when unarmored/without iron gear
  bot._setEmptySlots(20);
  bot._setItems([]);
  bot.entity.position = new Vec3(-6, 64, 0); // 18m from tree at (12,64,0)
  bot.players.araslime.entity.position = new Vec3(-6, 64, 0);
  bot.time.timeOfDay = 16000;
  assert.equal(await companion.tickSurvivalAutonomy(280_000, { force: true }), null, 'un-geared bot should not wander 18m at night');

  // 9) Owner distance > 18m defers auto-farming so companion escorts first
  bot.time.timeOfDay = 6000;
  bot.entity.position = new Vec3(8, 64, 0);
  bot.players.araslime.entity.position = new Vec3(40, 64, 0);
  assert.equal(await companion.tickSurvivalAutonomy(310_000, { force: true }), null);
});

test('auto_farm_on / auto_farm_off commands and owner leash > 28m control background farming cleanly', async () => {
  const router = new CommandRouter();
  assert.deepEqual(router.parse('tắt tự farm'), { type: 'auto_farm_off' });
  assert.deepEqual(router.parse('không tự farm'), { type: 'auto_farm_off' });
  assert.deepEqual(router.parse('tắt tự động farm'), { type: 'auto_farm_off' });
  assert.deepEqual(router.parse('tự farm'), { type: 'auto_farm_on' });
  assert.deepEqual(router.parse('tự fram đồ'), { type: 'auto_farm_on' });
  assert.deepEqual(router.parse('bật tự farm'), { type: 'auto_farm_on' });

  const fakeBot = new EventEmitter();
  fakeBot.username = 'bot_dong_hanh';
  fakeBot.version = '1.21.1';
  fakeBot.health = 20;
  fakeBot.food = 20;
  fakeBot.isAlive = true;
  fakeBot.isSleeping = false;
  fakeBot.heldItem = null;
  fakeBot.time = { timeOfDay: 6000, age: 6000 };
  fakeBot.game = { dimension: 'overworld' };
  fakeBot.registry = realRegistry;
  fakeBot.entity = { position: new Vec3(0, 64, 0), onGround: true, velocity: { y: 0 }, yaw: 0, metadata: { 0: 0 } };
  fakeBot.entities = {};
  fakeBot.players = { araslime: { entity: { id: 99, username: 'araslime', position: new Vec3(3, 64, 0), health: 20 } } };
  fakeBot._chats = [];
  fakeBot.chat = (m) => fakeBot._chats.push(m);
  fakeBot.whisper = () => {};
  fakeBot.inventory = { items: () => [], slots: new Array(46).fill(null), emptySlotCount: () => 20 };
  fakeBot.pathfinder = { setMovements: () => {}, setGoal: () => {}, goto: async () => {}, isMoving: () => false };
  fakeBot.blockAt = (p) => ({ name: p.y < 64 ? 'grass_block' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p, type: p.y < 64 ? 2 : 0 });
  fakeBot.findBlocks = () => [];
  fakeBot.findBlock = () => null;
  fakeBot.isABed = () => false;
  fakeBot.parseBedMetadata = () => ({ occupied: false });
  fakeBot.lookAt = async () => {};
  fakeBot.look = async () => {};
  fakeBot.setControlState = () => {};
  fakeBot.clearControlStates = () => {};
  fakeBot.stopDigging = () => {};
  fakeBot.equip = async () => {};
  fakeBot.quit = () => {};

  const tasks = new TaskCoordinator({ log: () => {} });
  const memory = new Memory({ autoSaveMs: 0 });
  const session = createBotSession(
    {
      ...DEFAULT_CONFIG,
      dashboard: { enabled: false, host: '127.0.0.1', port: 3000 },
      combat: { ...DEFAULT_CONFIG.combat, enabled: false },
      companion: { ...DEFAULT_CONFIG.companion, idleLife: true, autoFarm: true, preserveInTests: true },
    },
    { llm: {}, memory, tasks, router, createBotFn: () => fakeBot, loadPlugins: false }
  );

  try {
    fakeBot.emit('spawn');
    assert.equal(session.state.autoFarmEnabled, true);

    // Start an active background autoFarm task and verify "tắt tự farm" aborts it and disables autoFarm
    let aborted = false;
    tasks.run(
      { name: 'tu_farm_go', autoFarm: true },
      () => new Promise(() => {}),
      { onAbort: () => { aborted = true; }, priority: 0 }
    );
    assert.ok(tasks.active);

    await session.onCommand('tắt tự farm');
    assert.equal(session.state.autoFarmEnabled, false);
    assert.equal(aborted, true);
    assert.equal(tasks.active, null);
    assert.ok(fakeBot._chats.some(c => c.includes('Đã tắt chế độ tự farm')));

    await session.onCommand('bật tự farm');
    assert.equal(session.state.autoFarmEnabled, true);
    assert.ok(fakeBot._chats.some(c => c.includes('Đã bật chế độ tự farm')));

    // Owner walks > 28m away -> slow loop stops active autoFarm task so bot follows owner
    let abortedByLeash = false;
    tasks.run(
      { name: 'tu_farm_go', autoFarm: true },
      () => new Promise(() => {}),
      { onAbort: () => { abortedByLeash = true; }, priority: 0 }
    );
    fakeBot.players.araslime.entity.position = new Vec3(40, 64, 0);
    await new Promise(r => setTimeout(r, 1150));
    assert.equal(abortedByLeash, true);
    assert.equal(tasks.active, null);
  } finally {
    await session.cleanup();
  }
});
