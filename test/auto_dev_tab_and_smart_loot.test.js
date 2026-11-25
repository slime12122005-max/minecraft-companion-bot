import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import {
  AntigravityBridge,
  DEFAULT_DEV_AGENT_MODEL,
  DEFAULT_DEV_AGENT_PROFILE,
  DEFAULT_DEV_GLOBAL_COOLDOWN_MS,
  buildDevTabPrompt,
  shouldOpenDevTab,
} from '../src/mcp/antigravity_bridge.js';
import { createMcpHandler } from '../src/mcp/server.js';
import { EquipmentManager } from '../src/equipment.js';
import { CompanionManager } from '../src/companion.js';
import { HomeManager } from '../src/home.js';
import { MiningFarmingManager } from '../src/mining_farming.js';
import { TaskCoordinator } from '../src/tasks.js';
import { CommandRouter } from '../src/commands.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createBotSession } from '../src/session.js';
import { Memory } from '../src/memory.js';

const require = createRequire(import.meta.url);
const mfReq = createRequire(require.resolve('mineflayer/package.json'));
const prismarineRegistry = mfReq('prismarine-registry');
const realRegistry = prismarineRegistry('1.21.1');

test('mc_open_dev_tab -> /api/dev-tab -> AntigravityBridge uses 1 sequential Orchestrator tab, self-deletes when done, and enforces cooldown', async () => {
  assert.equal(DEFAULT_DEV_AGENT_MODEL, 'gemini-4-carbon-high');
  assert.equal(DEFAULT_DEV_AGENT_PROFILE, 'orchestrator');
  assert.equal(DEFAULT_DEV_GLOBAL_COOLDOWN_MS, 180000);
  assert.equal(shouldOpenDevTab({ kind: 'dev_task', devKind: 'add_local_js' }), true);
  assert.equal(shouldOpenDevTab({ kind: 'chat', message: 'hi' }), false);

  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const inboxState = { seq: 0, items: [] };
  const fakeBot = new EventEmitter();
  Object.assign(fakeBot, {
    username: 'bot_dong_hanh',
    version: '1.21.1',
    health: 20,
    food: 20,
    isAlive: true,
    isSleeping: false,
    registry: realRegistry,
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, onGround: true, velocity: { x: 0, y: 0, z: 0 }, metadata: { 0: 0 } },
    entities: {},
    players: {},
    inventory: { items: () => [], slots: new Array(46).fill(null), emptySlotCount: () => 20 },
    pathfinder: { setMovements: () => {}, setGoal: () => {}, goto: async () => {}, isMoving: () => false },
    blockAt: () => ({ name: 'air', type: 0, boundingBox: 'empty' }),
    findBlocks: () => [],
    findBlock: () => null,
    chat: () => {},
    whisper: () => {},
    quit: () => {},
  });

  const session = createBotSession(
    { ...DEFAULT_CONFIG, dashboard: { enabled: true, host: '127.0.0.1', port: 0 }, combat: { ...DEFAULT_CONFIG.combat, enabled: false } },
    { llm: {}, memory, tasks, inboxState, router: new CommandRouter(), createBotFn: () => fakeBot, loadPlugins: false }
  );

  try {
    const addr = await session.dashboard.start();
    const baseUrl = `http://${addr.host}:${addr.port}`;
    const mcpHandle = createMcpHandler({ baseUrl, pollIntervalMs: 15 });

    // Queue Task 1 via MCP
    const mcpRes = await mcpHandle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'mc_open_dev_tab',
        arguments: {
          kind: 'add_local_js',
          title: 'Thêm lệnh hỏi giờ trong game',
          summary: 'Khi người chơi hỏi mấy giờ rồi trong game thì trả lời local bằng bot.time.timeOfDay',
          userPhrase: 'mấy giờ rồi bot',
          targetFiles: ['src/commands.js', 'src/session/command_handlers_basic.js'],
        },
      },
    });
    assert.notEqual(mcpRes.result.isError, true);
    const queuedRes = JSON.parse(mcpRes.result.content[0].text);
    assert.equal(queuedRes.queued, true);
    assert.equal(queuedRes.model, 'gemini-4-carbon-high');
    assert.equal(queuedRes.profile, 'orchestrator');

    // Duplicate call with same title should deduplicate
    const dupRes = await mcpHandle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'mc_open_dev_tab',
        arguments: {
          kind: 'add_local_js',
          title: 'Thêm lệnh hỏi giờ trong game',
          summary: 'Trùng lặp',
        },
      },
    });
    assert.equal(JSON.parse(dupRes.result.content[0].text).deduplicated, true);

    const apiCalls = [];
    const deletedConvIds = [];
    const bridge = new AntigravityBridge({
      apiUrl: baseUrl,
      devGlobalCooldownMs: 350,
      deleteDelayMs: 20,
      runAgentApi: async (opts) => {
        apiCalls.push(opts);
        const convId = opts.conversationId || `conv-${apiCalls.length}`;
        return { conversationId: convId, model: opts.model, profile: opts.profile ?? null };
      },
      deleteConversationFn: async (convId) => {
        deletedConvIds.push(convId);
        return true;
      },
      log: () => {},
      warn: () => {},
    });
    bridge.conversationId = 'existing-chat-conv-uuid';
    bridge.turnCount = 3;

    try {
      await bridge.pollOnce();
      // Queue Task 2 while Task 1 hasn't even finished yet
      await session.dashboard.onOpenDevTab({
        kind: 'fix_bug',
        title: 'Fix lỗi NullPointer ở gather',
        summary: 'Sửa lỗi crash khi blockAt trả về null',
        errorDetail: 'TypeError: Cannot read properties of null',
        targetFiles: ['src/survival/gather.js'],
      });
      await bridge.pollOnce();

      const waitUntil = async (pred, timeoutMs = 2500) => {
        const dl = Date.now() + timeoutMs;
        while (!pred() && Date.now() < dl) {
          await new Promise((r) => setTimeout(r, 20));
        }
      };

      await waitUntil(() => apiCalls.length >= 1);
      await new Promise((r) => setTimeout(r, 80));

      // STRICT SINGLE-TAB SEQUENTIAL RULE: Task 2 MUST wait while Task 1 is still running!
      assert.equal(apiCalls.length, 1, 'must NOT open a second tab while Orchestrator is still busy');
      assert.equal(bridge.devBusy, true);
      assert.equal(apiCalls[0].conversationId, null);
      assert.equal(apiCalls[0].model, 'gemini-4-carbon-high');
      assert.equal(apiCalls[0].profile, 'orchestrator');
      assert.match(apiCalls[0].prompt, /MỞ RỘNG JS LOCAL/);
      assert.match(apiCalls[0].prompt, /cleanup_dev_conv\.js --detach/);

      // Complete Task 1 -> shouldSelfDelete is FALSE because Task 2 is still waiting in queue
      const comp1 = await mcpHandle({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'mc_open_dev_tab',
          arguments: { action: 'complete', status: 'passed', summary: 'Xong việc 1' },
        },
      });
      const comp1Body = JSON.parse(comp1.result.content[0].text);
      assert.equal(comp1Body.shouldSelfDelete, false);
      assert.equal(comp1Body.remainingTasks, 1);

      await bridge.pollOnce();
      await waitUntil(() => apiCalls.length >= 2);

      // Task 2 MUST be dispatched sequentially into the EXACT SAME conversation ('conv-1')
      assert.equal(apiCalls.length, 2);
      assert.equal(apiCalls[1].conversationId, 'conv-1', 'must reuse the same Orchestrator tab for queued work');
      assert.equal(apiCalls[1].profile, null);
      assert.match(apiCalls[1].prompt, /Tiếp nối chung tab/);
      assert.match(apiCalls[1].prompt, /SỬA LỖI BOT/);
      assert.match(apiCalls[1].prompt, /KHÔNG dùng npm/);

      // Complete Task 2 -> queue is now empty, so shouldSelfDelete is TRUE & bridge deletes 'conv-1'
      const comp2 = await mcpHandle({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'mc_open_dev_tab',
          arguments: { action: 'complete', status: 'passed', summary: 'Xong việc 2' },
        },
      });
      const comp2Body = JSON.parse(comp2.result.content[0].text);
      assert.equal(comp2Body.shouldSelfDelete, true);
      assert.equal(comp2Body.remainingTasks, 0);

      await bridge.pollOnce();
      await waitUntil(() => deletedConvIds.length >= 1);

      assert.deepEqual(deletedConvIds, ['conv-1']);
      assert.equal(bridge.devTabsDeleted, 1);
      assert.equal(bridge.devTabsOpened, 1);
      assert.equal(bridge.conversationId, 'existing-chat-conv-uuid', 'active game chat conversation must stay untouched');

      // Cooldown check: a 3rd task queued right away must wait out devGlobalCooldownMs before opening a new tab
      await session.dashboard.onOpenDevTab({
        kind: 'add_local_js',
        title: 'Thêm lệnh hỏi tọa độ',
        summary: 'Trả lời tọa độ bot local',
      });
      await bridge.pollOnce();
      await new Promise((r) => setTimeout(r, 90));
      assert.equal(apiCalls.length, 2, 'must wait for devGlobalCooldownMs before opening another Orchestrator tab');

      await waitUntil(() => apiCalls.length >= 3, 1500);
      assert.equal(apiCalls.length, 3);
      assert.equal(apiCalls[2].conversationId, null);

      const devPromptSample = buildDevTabPrompt({
        devKind: 'add_local_js',
        title: 'Thêm alias',
        summary: 'Xử lý nhanh câu hỏi đơn giản',
        userPhrase: 'trời tối chưa',
      });
      assert.match(devPromptSample, /MỞ RỘNG JS LOCAL/);
      assert.match(devPromptSample, /trời tối chưa/);
    } finally {
      bridge.stop();
    }
  } finally {
    await session.dashboard.stop();
    await session.cleanup();
  }
});

test('EquipmentManager smart loot triage: always picks up iron, stops picking diamond at >= 64 without dropping it, and respects mob deaths', async () => {
  const slots = new Array(46).fill(null);
  const ironPick = { name: 'iron_pickaxe', count: 1, slot: 36 };
  const rottenFlesh = { name: 'rotten_flesh', count: 5, slot: 10, type: 367 };
  const poppy = { name: 'poppy', count: 2, slot: 11, type: 38 };
  const oldWoodPick = { name: 'wooden_pickaxe', count: 1, slot: 12, type: 270 };
  const diamondStack = { name: 'diamond', count: 64, slot: 13, type: 264 };
  const inv = [ironPick, rottenFlesh, poppy, oldWoodPick, diamondStack];

  const tossed = [];
  const lookCalls = [];
  const bot = {
    username: 'bot_dong_hanh',
    registry: realRegistry,
    heldItem: ironPick,
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    players: {
      araslime: { entity: { id: 99, username: 'araslime', position: new Vec3(4, 64, 0) } },
    },
    inventory: {
      slots,
      items: () => inv,
      emptySlotCount: () => 25,
    },
    look: async (yaw) => { lookCalls.push(yaw); },
    tossStack: async (item) => {
      tossed.push(item.name);
      const idx = inv.indexOf(item);
      if (idx >= 0) inv.splice(idx, 1);
    },
  };

  let protectedSeedMode = false;
  const eq = new EquipmentManager(
    bot,
    { inventory: { discardObsolete: true, blockStacks: 2, keepFood: 16, maxDiamonds: 64 } },
    { isTemporarilyNeeded: (n) => protectedSeedMode && n === 'wheat_seeds' }
  );

  // 1) Junk/obsolete vs iron (always keep) vs diamond (stop picking up when >= 64, never drop!)
  assert.equal(eq.evaluateItemNeed('rotten_flesh').action, 'drop');
  assert.equal(eq.evaluateItemNeed('wheat_seeds').action, 'drop');
  assert.equal(eq.evaluateItemNeed('iron_ingot', { count: 8 }).alwaysPickup, true);
  const fullDiamondEval = eq.evaluateItemNeed('diamond', { count: 1, hasChestAvailable: true });
  assert.equal(fullDiamondEval.skipPickup, true);

  // 2) Dropped diamond is skipped once bag already has 64 diamonds, while iron near owner is still picked up!
  const extraDiamondDrop = { id: 205, name: 'item', position: new Vec3(1, 64, 0), getDroppedItem: () => ({ name: 'diamond', count: 2 }) };
  assert.equal(eq.shouldPickupDroppedEntity(extraDiamondDrop), false, 'stop chasing diamonds when already >= 64');

  eq.ignoreDroppedEntity(206, { fromOwner: true, now: 100_000 });
  const ironNearOwner = { id: 206, name: 'item', position: new Vec3(2, 64, 0), getDroppedItem: () => ({ name: 'raw_iron', count: 4 }) };
  assert.equal(
    eq.shouldPickupDroppedEntity(ironNearOwner, { ownerEntity: bot.players.araslime.entity, now: 101_000 }),
    true,
    'iron dropped near owner at 2m MUST still be picked up'
  );

  // When farming is active, wheat_seeds are temporarily protected!
  protectedSeedMode = true;
  assert.equal(eq.evaluateItemNeed('wheat_seeds').action, 'keep');
  const seedDrop = { id: 207, name: 'item', position: new Vec3(2, 64, 0), getDroppedItem: () => ({ name: 'wheat_seeds', count: 1 }) };
  assert.equal(eq.shouldPickupDroppedEntity(seedDrop), true);
  protectedSeedMode = false;

  // 3) Trash purge removes trash + obsolete gear, NEVER touches the 64 diamond stack!
  assert.equal(eq.hasInventoryTrash({ blockStacks: 2 }), true);
  const droppedObs = await eq.discardObsoleteItems({ ownerEntity: bot.players.araslime.entity });
  const droppedJunk = await eq.discardJunkItems({ blockStacks: 2, ownerEntity: bot.players.araslime.entity });
  assert.deepEqual(droppedObs, ['wooden_pickaxe']);
  assert.deepEqual(droppedJunk, ['rotten_flesh', 'poppy']);
  assert.ok(lookCalls.length >= 1, 'should turn away from owner before tossing junk');
  assert.ok(inv.some((i) => i.name === 'diamond' && i.count === 64), '64 diamonds in bag must never be thrown away');
  assert.equal(eq.hasInventoryTrash({ blockStacks: 2 }), false);
});

test('MiningFarmingManager.farmCrops only forages seeds from grass when farmland needs seeds and forageSeeds is enabled', async () => {
  const farmlandBlock = { name: 'farmland', type: realRegistry.blocksByName.farmland.id, position: new Vec3(2, 64, 0) };
  const grassId = realRegistry.blocksByName.short_grass?.id ?? realRegistry.blocksByName.grass?.id;
  const grassName = realRegistry.blocksByName.short_grass ? 'short_grass' : 'grass';
  const grassBlock = { name: grassName, type: grassId, position: new Vec3(5, 65, 0) };

  const blocks = new Map([
    ['2,64,0', farmlandBlock],
    ['5,65,0', grassBlock],
  ]);
  const inv = [];
  const placed = [];

  const bot = {
    registry: realRegistry,
    entity: { position: new Vec3(0, 65, 0) },
    entities: {},
    inventory: { items: () => inv },
    blockAt: (p) => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'air', type: 0 },
    findBlocks: ({ matching }) => {
      if (Array.isArray(matching) && matching.includes(farmlandBlock.type)) return [farmlandBlock.position];
      if (Array.isArray(matching) && matching.includes(grassId)) return [grassBlock.position];
      return [];
    },
    dig: async (blk) => {
      if (blk.name === grassName) {
        blocks.delete('5,65,0');
        inv.push({ name: 'wheat_seeds', count: 1, type: realRegistry.itemsByName.wheat_seeds.id });
      }
    },
    equip: async () => {},
    placeBlock: async (soil) => {
      placed.push(soil.position);
      const idx = inv.findIndex((i) => i.name === 'wheat_seeds');
      if (idx >= 0) inv.splice(idx, 1);
      blocks.set('2,65,0', { name: 'wheat', type: realRegistry.blocksByName.wheat.id, position: new Vec3(2, 65, 0) });
    },
    pathfinder: { goto: async () => {}, isMoving: () => false },
  };

  const mining = new MiningFarmingManager(bot, {}, { seedWaitMs: 0, log: () => {} });
  const passiveRes = await mining.farmCrops(null, { forageSeeds: false });
  assert.equal(passiveRes.foragedSeeds ?? 0, 0, 'passive farmCrops must NOT break grass for seeds');

  const orderedRes = await mining.farmCrops(null, { forageSeeds: true });
  assert.equal(orderedRes.foragedSeeds, 1, 'ordered farmCrops should break grass to get seed');
  assert.equal(orderedRes.replanted, 1, 'should plant collected seed on empty farmland');
  assert.equal(placed.length, 1);
});

test('CompanionManager purges trash first, stores valuable surplus, and cools down when chest is full', async () => {
  const chestDeposits = [];
  const inv = [
    { name: 'iron_pickaxe', count: 1, slot: 36, type: 257 },
    { name: 'iron_sword', count: 1, slot: 37, type: 267 },
    { name: 'bread', count: 8, slot: 14, type: 297 },
    { name: 'rotten_flesh', count: 4, slot: 9, type: 367 },
    { name: 'iron_ingot', count: 12, slot: 10, type: 265 },
    { name: 'diamond', count: 4, slot: 11, type: 264 },
    { name: 'redstone', count: 32, slot: 12, type: 331 },
    { name: 'oak_log', count: 32, slot: 13, type: 17 },
  ];
  const tossed = [];
  let chestFull = false;
  const bot = {
    username: 'bot_dong_hanh',
    registry: realRegistry,
    heldItem: inv[0],
    time: { timeOfDay: 6000, age: 6000 },
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(0, 64, 0), onGround: true, yaw: 0 },
    entities: {},
    players: {},
    inventory: {
      slots: new Array(46).fill(null),
      items: () => inv,
      emptySlotCount: () => 30,
    },
    findBlock: ({ matching }) => {
      const chest = { name: 'chest', position: new Vec3(2, 64, 0) };
      return matching(chest) ? chest : null;
    },
    findBlocks: () => [],
    openChest: async () => ({
      containerItems: () => [],
      deposit: async (type, _meta, count) => {
        if (chestFull) throw new Error('Chest is full');
        chestDeposits.push({ type, count });
      },
      close: () => {},
    }),
    tossStack: async (item) => {
      tossed.push(item.name);
      const idx = inv.indexOf(item);
      if (idx >= 0) inv.splice(idx, 1);
    },
    pathfinder: { goto: async () => {}, setGoal: () => {}, isMoving: () => false },
    chat: () => {},
  };

  const memory = new Memory({ autoSaveMs: 0 });
  const eq = new EquipmentManager(bot, { inventory: { discardObsolete: true, blockStacks: 2, keepFood: 16 } });
  const home = new HomeManager(bot, { inventory: { keepFood: 16, blockStacks: 1 }, home: { storageChest: { x: 2, y: 64, z: 0 } } }, { memory });
  const tasks = new TaskCoordinator({ log: () => {} });

  const companion = new CompanionManager({
    bot,
    config: { owner: 'araslime', companion: { idleLife: true, autoFarm: true, ambientChatter: false, preserveInTests: true } },
    state: { stayPut: false, autoFarmEnabled: true },
    combat: { busy: false },
    survival: { busy: false },
    equipment: eq,
    tasks,
    crafting: {},
    mining: {},
    home,
    log: () => {},
  }, { enabledChat: false, enabledIdle: true });

  const run1 = await companion.tickSurvivalAutonomy(100_000, { force: true });
  await run1?.promise;

  assert.equal(run1?.kind, 'auto_store');
  assert.deepEqual(tossed, ['rotten_flesh'], 'must purge junk BEFORE depositing to chest');
  assert.ok(chestDeposits.some((d) => d.type === 265), 'must store iron_ingot surplus in chest');
  assert.ok(!chestDeposits.some((d) => d.type === 367), 'must never deposit purged rotten_flesh');

  // When chest is full (storeSurplus returns false), auto_store enters 60s cooldown instead of looping!
  chestFull = true;
  const runFull = await companion.tickSurvivalAutonomy(200_000, { force: true });
  await runFull?.promise;
  assert.equal(runFull?.kind, 'auto_store');
  const immediateRetry = await companion.tickSurvivalAutonomy(202_000, { force: false });
  assert.notEqual(immediateRetry?.kind, 'auto_store', 'must respect cooldown after full chest instead of ping-ponging');
});
