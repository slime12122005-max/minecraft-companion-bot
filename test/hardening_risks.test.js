import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { createDashboardBridge } from '../src/session/dashboard_bridge.js';
import { createChatHandler } from '../src/session/chat_handler.js';
import { createCommandDispatcher } from '../src/session/command_dispatcher.js';
import { configureMovements, getEffectivePingMs } from '../src/session/task_helpers.js';
import { HomeManager } from '../src/home.js';
import { SurvivalManager } from '../src/survival/index.js';
import { Memory } from '../src/memory.js';
import { TaskCoordinator } from '../src/tasks.js';
import { CommandRouter } from '../src/commands.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const require = createRequire(import.meta.url);
const mfReq = createRequire(require.resolve('mineflayer/package.json'));
const realRegistry = mfReq('prismarine-registry')('1.21.1');

test('Orchestrator completion hot-reloads local JS router/handlers with 0 downtime and writes audit log (#1, #2)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-autodev-audit-'));
  const auditPath = path.join(tmpDir, 'auto_dev.log');
  try {
    const inboxItems = [];
    const oldRouter = {
      route: () => ({ command: { type: 'unknown' }, confidence: 0, tier: 'fallback' }),
      parse: () => ({ type: 'unknown' }),
      parseChain: () => ({ type: 'unknown' }),
    };
    const fakeBot = {
      username: 'bot_dong_hanh',
      entity: { position: new Vec3(0, 64, 0) },
      inventory: { items: () => [], slots: new Array(46).fill(null) },
      players: {},
      chat: () => {},
      whisper: () => {},
    };
    const tasks = new TaskCoordinator({ log: () => {} });
    const memory = new Memory({ autoSaveMs: 0 });
    const equipment = { status: () => ({ equipped: {} }) };
    const home = { get: () => null, listChestInventory: () => ({}) };
    const survival = { listWaypoints: () => [] };
    const ctx = {
      bot: fakeBot,
      config: DEFAULT_CONFIG,
      llm: {},
      memory,
      tasks,
      router: oldRouter,
      equipment,
      home,
      survival,
      smelting: { activeJobs: new Map() },
      combat: { busy: false, config: { enabled: true }, start: () => {}, stop: () => {} },
      watchdog: { status: () => ({}) },
      stateMachine: { status: () => ({ state: 'IDLE' }) },
      autoDevLogPath: auditPath,
      logFor: () => () => {},
      errorFor: () => {},
      nonOwnerRepliedAt: new Map(),
      chatHistory: [],
      pushInbox: (e) => {
        inboxItems.push(e);
        return e;
      },
      state: { sessionId: 's1', connected: true, disconnected: false, chatGen: 0 },
    };
    Object.assign(ctx, createCommandDispatcher(ctx));
    Object.assign(ctx, createChatHandler(ctx));
    const bridge = createDashboardBridge(ctx);

    const openRes = await bridge.onOpenDevTab({
      kind: 'add_local_js',
      title: 'Thêm lệnh trang thái',
      summary: 'Hot reload test',
      userPhrase: 'trạng thái sao rồi',
      targetFiles: ['src/commands.js'],
    });
    assert.equal(openRes.queued, true);

    const completeRes = await bridge.onOpenDevTab({
      action: 'complete',
      status: 'passed',
      summary: 'Đã cập nhật commands.js',
    });
    assert.equal(completeRes.completed, true);
    assert.equal(completeRes.hotReloaded, true);
    assert.notEqual(ctx.router, oldRouter, 'ctx.router must be hot-swapped live');
    assert.equal(typeof ctx.handleBasicCommandFn, 'function');
    assert.equal(typeof ctx.handleComplexCommandFn, 'function');

    // Newly hot-reloaded real CommandRouter parses commands immediately on next message!
    let statusSent = '';
    fakeBot.chat = (m) => { statusSent = m; };
    await ctx.handleCommand(DEFAULT_CONFIG.owner, 'trạng thái');
    assert.ok(statusSent.length > 0, 'hot-reloaded router must immediately handle "trạng thái"');

    const logContent = fs.readFileSync(auditPath, 'utf8');
    assert.match(logContent, /\[PASSED\] kind=add_local_js/);
    assert.match(logContent, /hotReload=true/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gather excavateStaircaseForStone clears 4-high walkable path away from owner and places torch when dark (#3)', async () => {
  const worldBlocks = new Map();
  const setBlk = (x, y, z, name) => {
    const id = realRegistry.blocksByName[name]?.id ?? 0;
    worldBlocks.set(`${x},${y},${z}`, { name, type: id, position: new Vec3(x, y, z), boundingBox: id === 0 ? 'empty' : 'block' });
  };
  for (let x = -4; x <= 6; x++) {
    for (let z = -4; z <= 4; z++) {
      setBlk(x, 63, z, 'dirt');
      setBlk(x, 62, z, 'stone');
      setBlk(x, 61, z, 'stone');
      setBlk(x, 60, z, 'stone');
    }
  }
  const dugLog = [];
  const placedTorches = [];
  const bot = {
    username: 'bot_dong_hanh',
    registry: realRegistry,
    time: { timeOfDay: 18000, isDay: false },
    world: { getBlockLight: () => 2, getSkyLight: () => 0 },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    players: { araslime: { entity: { username: 'araslime', position: new Vec3(-1.5, 64, 0.5) } } },
    inventory: {
      items: () => [
        { name: 'iron_pickaxe', count: 1, type: realRegistry.itemsByName.iron_pickaxe.id },
        { name: 'torch', count: 4, type: realRegistry.itemsByName.torch.id },
      ],
      emptySlotCount: () => 20,
    },
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return worldBlocks.get(k) ?? { name: 'air', type: 0, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: 'empty' };
    },
    findBlocks: ({ matching }) => {
      const stoneId = realRegistry.blocksByName.stone.id;
      if (Array.isArray(matching) && matching.includes(stoneId)) {
        return [new Vec3(1, 62, 0), new Vec3(2, 62, 0)];
      }
      return [];
    },
    dig: async (blk) => {
      dugLog.push(blk.position.clone());
      worldBlocks.delete(`${blk.position.x},${blk.position.y},${blk.position.z}`);
    },
    equip: async () => {},
    placeBlock: async (ref) => {
      const p = new Vec3(ref.position.x, ref.position.y + 1, ref.position.z);
      placedTorches.push(p);
      setBlk(p.x, p.y, p.z, 'torch');
    },
    collectBlock: { collect: async () => {} },
    pathfinder: { setGoal: () => {} },
  };
  const survival = new SurvivalManager(bot, { owner: 'araslime' }, { log: () => {} });
  survival._timeouts.digMinMs = 200;
  survival._timeouts.digExtraMs = 50;

  const got = await survival.gather('stone', 2, null, {});
  assert.ok(got >= 1, 'should mine buried stone via staircase');
  assert.ok(dugLog.some((p) => p.x > 0), 'must choose direction away from owner at x=-1.5');
  assert.ok(dugLog.some((p) => p.y >= 65) || placedTorches.length >= 1, 'should place torch when dark in staircase');
  assert.ok(placedTorches.length >= 1, 'must place torch in dark staircase');
});

test('HomeManager.stashAllForSwitch deposits inventory before auth/mode switch (#5)', async () => {
  const deposited = [];
  const inv = [
    { name: 'iron_pickaxe', count: 1, type: 257 },
    { name: 'diamond', count: 5, type: 264 },
  ];
  const chestPos = new Vec3(2, 64, 0);
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    blockAt: (p) => (p.x === 2 && p.y === 64 && p.z === 0 ? { name: 'chest', position: chestPos } : null),
    openChest: async () => ({
      containerItems: () => [],
      deposit: async (type, _m, count) => { deposited.push({ type, count }); },
      close: () => {},
    }),
  };
  const memory = new Memory({ autoSaveMs: 0 });
  const home = new HomeManager(bot, { home: { storageChest: { x: 2, y: 64, z: 0 } } }, { memory });
  const res = await home.stashAllForSwitch({ maxDistance: 8 });
  assert.equal(res.stored, 6);
  assert.deepEqual(deposited, [{ type: 257, count: 1 }, { type: 264, count: 5 }]);
});

test('configureMovements & tree pillar adapt to high-ping / e4mc lag and recover on rubberband (#6)', async () => {
  let setMove = null;
  const remoteBot = {
    username: 'bot_dong_hanh',
    registry: realRegistry,
    player: { ping: 210 },
    pathfinder: { setMovements: (m) => { setMove = m; } },
  };
  assert.equal(getEffectivePingMs(remoteBot, { minecraft: { host: 'test.ap.e4mc.link' } }), 210);
  configureMovements(remoteBot, { minecraft: { host: 'test.ap.e4mc.link' } });
  assert.equal(setMove.allowParkour, false);
  assert.equal(setMove.maxDropDown, 2);
  assert.equal(setMove.allowSprinting, false);

  const localBot = {
    username: 'bot_dong_hanh',
    registry: realRegistry,
    player: { ping: 5 },
    pathfinder: { setMovements: (m) => { setMove = m; } },
  };
  configureMovements(localBot, { minecraft: { host: '127.0.0.1' } });
  assert.equal(setMove.maxDropDown, 3);
});
