import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import {
  buildWakePrompt,
  formatCompactStateSnapshot,
  shouldWakeAntigravity,
} from '../src/mcp/antigravity_bridge.js';
import { EquipmentManager } from '../src/equipment.js';
import { CompanionManager } from '../src/companion.js';
import { TaskCoordinator } from '../src/tasks.js';
import { CommandRouter } from '../src/commands.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createBotSession } from '../src/session.js';
import { Memory } from '../src/memory.js';

const require = createRequire(import.meta.url);
const mfReq = createRequire(require.resolve('mineflayer/package.json'));
const prismarineRegistry = mfReq('prismarine-registry');
const realRegistry = prismarineRegistry('1.21.1');

function makeSessionFakeBot() {
  const bot = new EventEmitter();
  bot.username = 'bot_dong_hanh';
  bot.version = '1.21.1';
  bot.health = 20;
  bot.food = 20;
  bot.isAlive = true;
  bot.isSleeping = false;
  bot.heldItem = null;
  bot.time = { timeOfDay: 6000, age: 6000, isDay: true };
  bot.game = { dimension: 'overworld' };
  bot.registry = realRegistry;
  bot.entity = {
    position: new Vec3(0, 64, 0),
    yaw: 0,
    pitch: 0,
    onGround: true,
    velocity: { x: 0, y: 0, z: 0 },
    metadata: { 0: 0 },
  };
  bot.entities = {
    10: { id: 10, name: 'cow', type: 'animal', position: new Vec3(4, 64, 2) },
  };
  bot.players = {
    araslime: {
      entity: { id: 99, username: 'araslime', position: new Vec3(2, 64, 0), health: 20, yaw: 0, velocity: { x: 0, y: 0, z: 0 } },
    },
  };
  bot._chats = [];
  bot.chat = (m) => bot._chats.push(m);
  bot.whisper = () => {};
  bot.inventory = {
    items: () => [{ name: 'wooden_pickaxe', count: 1 }, { name: 'apple', count: 4 }],
    slots: new Array(46).fill(null),
    emptySlotCount: () => 20,
  };
  bot.pathfinder = {
    setMovements: () => {},
    setGoal: () => {},
    goto: async () => {},
    isMoving: () => false,
  };
  const craftingTableId = realRegistry.blocksByName.crafting_table.id;
  bot.blockAt = (p) => {
    if (Math.floor(p.x) === 3 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0) {
      return { name: 'crafting_table', type: craftingTableId, position: p, boundingBox: 'block' };
    }
    return { name: p.y < 64 ? 'grass_block' : 'air', type: p.y < 64 ? 2 : 0, position: p, boundingBox: p.y < 64 ? 'block' : 'empty' };
  };
  bot.findBlocks = ({ matching }) => {
    const idSet = new Set(Array.isArray(matching) ? matching : [matching]);
    return idSet.has(craftingTableId) ? [new Vec3(3, 64, 0)] : [];
  };
  bot.findBlock = () => null;
  bot.isABed = () => false;
  bot.parseBedMetadata = () => ({ occupied: false });
  bot.lookAt = async () => {};
  bot.look = async () => {};
  bot.setControlState = () => {};
  bot.clearControlStates = () => {};
  bot.stopDigging = () => {};
  bot.equip = async () => {};
  bot.quit = () => {};
  return bot;
}

test('Upgraded hybrid routing & task_failed escalation wake Antigravity with rich context when local command fails', async () => {
  assert.equal(shouldWakeAntigravity({ kind: 'alert', alertType: 'task_failed', message: 'thiếu sắt' }), true);
  assert.equal(shouldWakeAntigravity({ kind: 'alert', alertType: 'jev_abort', message: 'nguy hiểm' }), true);
  assert.equal(shouldWakeAntigravity({ kind: 'alert', alertType: 'low_food', message: 'đói' }), false);

  const bot = makeSessionFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const inboxState = { seq: 0, items: [] };

  const session = createBotSession(
    {
      ...DEFAULT_CONFIG,
      dashboard: { enabled: false, host: '127.0.0.1', port: 3000 },
      combat: { ...DEFAULT_CONFIG.combat, enabled: false },
      companion: { ...DEFAULT_CONFIG.companion, mcpGraceMs: 5000 },
    },
    { llm: {}, memory, tasks, inboxState, router: new CommandRouter(), createBotFn: () => bot, loadPlugins: false }
  );

  try {
    bot.emit('spawn');
    // Simulate Antigravity Bridge sidecar polling /api/inbox?source=sidecar
    session.dashboard.getInbox({ sinceId: 0, source: 'sidecar' });

    // 1) Exact command ("đứng đây") still executes locally and fast
    bot.emit('chat', 'araslime', 'đứng đây');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(session.state.stayPut, true);
    assert.ok(bot._chats.some((c) => c.includes('đứng yên')));

    // 2) Fuzzy / natural capability question ("bạn làm đc j") defers to Antigravity when sidecar is online
    bot._chats.length = 0;
    bot.emit('chat', 'araslime', 'bạn làm đc j');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bot._chats.length, 0, 'should defer natural capability chat to Antigravity instead of dumping manual');
    const deferredChat = inboxState.items.find((i) => i.message === 'bạn làm đc j');
    assert.equal(deferredChat?.handledByBot, false);
    assert.equal(shouldWakeAntigravity(deferredChat), true);

    // 3) Failing player command ("lấy 8 sắt" with only wooden_pickaxe) escalates task_failed alert to Antigravity and suppresses raw error
    bot._chats.length = 0;
    bot.emit('chat', 'araslime', 'lấy 8 sắt');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(bot._chats.length, 0, 'raw tool error should be suppressed while Antigravity is online to solve it');
    const failAlert = inboxState.items.find((i) => i.kind === 'alert' && i.alertType === 'task_failed');
    assert.ok(failAlert, 'must emit task_failed escalation alert');
    assert.equal(failAlert.commandType, 'gather');
    assert.equal(failAlert.userMessage, 'lấy 8 sắt');
    assert.equal(shouldWakeAntigravity(failAlert), true);

    // 4) API-originated mc_command (fromApi: true) does NOT emit recursive task_failed alerts
    const beforeCount = inboxState.items.filter((i) => i.alertType === 'task_failed').length;
    await session.onCommand('lấy 8 kim cương');
    await new Promise((r) => setTimeout(r, 30));
    const afterCount = inboxState.items.filter((i) => i.alertType === 'task_failed').length;
    assert.equal(afterCount, beforeCount, 'API commands from Antigravity must never trigger recursive task_failed wakes');

    // 5) Dashboard state & compact wake prompt include readiness, chest summary, nearby summary, and recent chat
    const stateSnap = session.dashboard.getState();
    stateSnap.chests = { iron_ingot: 5, bread: 12 };
    const compact = formatCompactStateSnapshot(stateSnap);
    assert.match(compact, /sẵn sàng\(cúp:wood, dự trữ ăn:16đ\)/);
    assert.match(compact, /rương nhà: iron_ingotx5, breadx12/);
    assert.match(compact, /quanh đây\(chủ cách 2m; block: crafting_table; sinh vật: cowx1\)/);
    assert.match(compact, /chat gần đây:/);

    const wakePrompt = buildWakePrompt([failAlert], stateSnap, { isNewConversation: true });
    assert.match(wakePrompt, /\[Cảnh báo task_failed\]/);
    assert.match(wakePrompt, /mc_plan_execute/);
  } finally {
    await session.cleanup();
  }
});

test('EquipmentManager.planNextGearUpgrade guards raw_iron smelt behind furnace availability, and CompanionManager unblocks escort/prospecting', async () => {
  const items = [
    { name: 'stone_pickaxe', count: 1 },
    { name: 'raw_iron', count: 4 },
    { name: 'oak_planks', count: 8 },
    { name: 'cobblestone', count: 3 }, // < 8 cobble and no furnace!
  ];
  const bot = {
    registry: realRegistry,
    game: { dimension: 'overworld' },
    heldItem: null,
    time: { timeOfDay: 6000, age: 6000 },
    food: 20,
    entity: { position: new Vec3(20, 64, 0), onGround: true, yaw: 0 },
    entities: {},
    players: { araslime: { entity: { id: 1, username: 'araslime', position: new Vec3(15.5, 64, 0), yaw: 0 } } },
    inventory: {
      items: () => items,
      slots: new Array(46).fill(null),
      emptySlotCount: () => 20,
    },
    findBlock: () => null,
    findBlocks: () => [],
    blockAt: () => ({ name: 'air', type: 0, boundingBox: 'empty' }),
    pathfinder: { setGoal: () => {}, isMoving: () => false },
  };

  const eq = new EquipmentManager(bot, {});
  // Without furnace or >= 8 cobble, must NOT plan smelt('iron_ingot') — crafts stone_sword instead!
  assert.equal(eq.planNextGearUpgrade()?.item, 'stone_sword');

  // Once >= 8 cobble is available and stone_sword is owned, smelt('iron_ingot') unlocks cleanly!
  items.push({ name: 'stone_sword', count: 1 }, { name: 'cobblestone', count: 8 });
  const smeltPlan = eq.planNextGearUpgrade();
  assert.equal(smeltPlan?.action, 'smelt');
  assert.equal(smeltPlan?.input, 'raw_iron');

  // Verify CompanionManager releases _escortingOwner when stopped at 4.5m (<= 6.5m) and launches exploratory prospecting tunnel
  let tunnelLength = 0;
  const tasks = new TaskCoordinator({ log: () => {} });
  const ctx = {
    bot,
    config: { owner: 'araslime', companion: { idleLife: true, idleFollowRange: 6.5, autoUpgrade: false, autoFarm: true, ambientChatter: false } },
    state: { stayPut: false, idleGoalActive: true, autoFarmEnabled: true },
    combat: { busy: false },
    survival: { busy: false, lastGaveItemAt: 0, gather: async () => 0 },
    equipment: eq,
    tasks,
    crafting: {},
    mining: {
      digTunnel: async (len) => {
        tunnelLength = len;
        return { steps: len };
      },
    },
    home: { get: () => new Vec3(0, 64, 0), getStorageChest: () => null },
    log: () => {},
  };

  const companion = new CompanionManager(ctx, { enabledChat: false, enabledIdle: true });
  companion._escortingOwner = true; // Stuck at 4.5m with isMoving() === false

  const acted = await companion.tickIdle(50_000);
  await tasks.active?.promise;
  assert.equal(acted, true);
  assert.equal(companion._escortingOwner, false, 'must release escort state once pathfinder stops inside follow range');
  assert.equal(tunnelLength, 8, 'must proceed to exploratory ore prospecting tunnel when no surface tasks remain');
});
