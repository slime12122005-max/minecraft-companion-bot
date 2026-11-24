import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createBotSession } from '../src/session.js';
import { Memory } from '../src/memory.js';
import { TaskCoordinator } from '../src/tasks.js';
import { CommandRouter } from '../src/commands.js';
import { DashboardServer } from '../src/dashboard.js';
import { createMcpHandler } from '../src/mcp/server.js';
import { SCRATCHPAD_KEY, WorkScratchpad } from '../src/scratchpad.js';

const require = createRequire(import.meta.url);
const mineflayerPkgPath = require.resolve('mineflayer/package.json');
const mineflayerRequire = createRequire(mineflayerPkgPath);
const prismarineRegistry = mineflayerRequire('prismarine-registry');
const realRegistry = prismarineRegistry('1.21.1');

function makeFakeBot() {
  const bot = new EventEmitter();
  bot.username = 'bot_dong_hanh';
  bot.version = '1.21.1';
  bot.health = 20;
  bot.food = 20;
  bot.saturation = 5;
  bot.isAlive = true;
  bot.isSleeping = false;
  bot.heldItem = null;
  bot.time = { timeOfDay: 6000, age: 6000 };
  bot.game = { dimension: 'overworld' };
  bot.registry = realRegistry;
  bot.entity = { position: new Vec3(0, 64, 0), onGround: true, velocity: { y: 0 }, yaw: 0, metadata: { 0: 0 } };
  bot.entities = {};
  bot.players = {
    araslime: { entity: { id: 99, username: 'araslime', position: new Vec3(3, 64, 0), health: 20 } },
  };
  bot._chats = [];
  bot._whispers = [];
  bot._gotos = [];
  bot.chat = (msg) => bot._chats.push(msg);
  bot.whisper = (user, msg) => bot._whispers.push({ user, msg });
  bot.inventory = {
    items: () => [{ name: 'bread', count: 16 }],
    slots: new Array(46).fill(null),
    emptySlotCount: () => 20,
  };
  bot.pathfinder = {
    setMovements: () => {},
    setGoal: () => {},
    goto: async (goal) => { bot._gotos.push(goal); },
    isMoving: () => false,
  };
  bot.blockAt = (p) => {
    const by = Math.floor(p.y);
    if (by < 64) return { name: 'grass_block', boundingBox: 'block', position: p };
    return { name: 'air', boundingBox: 'empty', position: p };
  };
  bot.findBlocks = () => [];
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

function makeTestConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    dashboard: { enabled: false, host: '127.0.0.1', port: 3000 },
    combat: { ...DEFAULT_CONFIG.combat, enabled: false },
    companion: {
      naturalChat: true,
      chatFallbackDelayMs: 25,
      mcpGraceMs: 120,
      idleLife: false,
      idleFollowRange: 6.5,
      idleWanderIntervalMs: 14000,
      ambientChatter: false,
      preserveInTests: true,
      ...overrides,
    },
  };
}

test('WorkScratchpad survives sudden shutdown mid-chain, announces remaining steps on reopen, resumes only remaining steps, and auto-clears SQLite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-scratch-resume-'));
  const dbPath = path.join(dir, 'world.db');

  let mem1 = null;
  let mem2 = null;
  let mem3 = null;
  let session1 = null;
  let session2 = null;

  try {
    // Session 1: bot starts a 3-step chain, finishes step 1, then crashes abruptly mid-step 2
    mem1 = new Memory({ dbPath });
    await mem1.load();
    const fakeBot1 = makeFakeBot();
    let releaseCraftHang;
    session1 = createBotSession(makeTestConfig(), {
      llm: {},
      memory: mem1,
      tasks: new TaskCoordinator({ log: () => {} }),
      router: new CommandRouter(),
      createBotFn: () => fakeBot1,
      loadPlugins: false,
      sessionId: 'game_1',
    });
    session1.home.set({ position: new Vec3(20, 64, 20) }, 'overworld');
    session1.survival.gather = async () => 16;
    session1.crafting.craftItem = () => new Promise((resolve) => { releaseCraftHang = resolve; });

    fakeBot1.emit('spawn');
    fakeBot1.emit('chat', 'araslime', 'lấy 16 gỗ ; chế tạo 1 bàn chế tạo ; về nhà');
    await new Promise(r => setTimeout(r, 40));

    // Verify step 1 completion was persisted durably to SQLite BEFORE crash
    const rawSaved1 = mem1.get(SCRATCHPAD_KEY);
    assert.ok(rawSaved1?.active);
    assert.deepEqual(rawSaved1.active.completedSteps, ['Lấy 16 gỗ']);
    assert.deepEqual(rawSaved1.active.remainingSteps, ['Chế tạo 1 bàn chế tạo', 'Về nhà']);

    // Simulate sudden PC shutdown cleanly releasing test DB handle after stopping listeners
    releaseCraftHang?.({ name: 'crafting_table', count: 0 });
    await session1.cleanup();
    session1 = null;
    mem1.close();
    mem1 = null;

    // Session 2: reopen the same world DB with a new game sessionId
    mem2 = new Memory({ dbPath });
    await mem2.load();
    const fakeBot2 = makeFakeBot();
    const inbox2 = { seq: 0, items: [] };
    let gatherCalledInSession2 = 0;
    let craftedInSession2 = null;

    session2 = createBotSession(makeTestConfig(), {
      llm: {},
      memory: mem2,
      tasks: new TaskCoordinator({ log: () => {} }),
      inboxState: inbox2,
      router: new CommandRouter(),
      createBotFn: () => fakeBot2,
      loadPlugins: false,
      sessionId: 'game_2',
    });
    session2.home.set({ position: new Vec3(20, 64, 20) }, 'overworld');
    session2.survival.gather = async () => { gatherCalledInSession2 += 1; return 16; };
    session2.crafting.craftItem = async (target, count) => {
      craftedInSession2 = { target, count };
      return { name: 'crafting_table', count: 1 };
    };

    fakeBot2.emit('spawn');
    // On spawn, bot announces concise Vietnamese recovery summary + pushes crash_recovery alert
    const announce = fakeBot2._chats.find(c => /tắt đột xuất/i.test(c));
    assert.ok(announce, `Expected crash recovery announcement, got: ${JSON.stringify(fakeBot2._chats)}`);
    assert.match(announce, /đã xong: Lấy 16 gỗ/i);
    assert.match(announce, /cần làm lại: Chế tạo 1 bàn chế tạo -> Về nhà/i);
    assert.ok(inbox2.items.some(i => i.alertType === 'crash_recovery'));

    // Player replies "làm tiếp" -> runs ONLY remaining steps (craft + go_home), never repeats gather
    fakeBot2.emit('chat', 'araslime', 'làm tiếp');
    await new Promise(r => setTimeout(r, 80));

    assert.equal(gatherCalledInSession2, 0);
    assert.deepEqual(craftedInSession2, { target: 'ban che tao', count: 1 });
    assert.ok(fakeBot2._gotos.some(g => g.x === 20 && g.z === 20));
    assert.equal(session2.scratchpad.hasPending(), false);
    assert.equal(mem2.get(SCRATCHPAD_KEY), undefined);

    await session2.cleanup();
    session2 = null;
    mem2.close();
    mem2 = null;

    // Reopen a 3rd time to verify SQLite itself no longer has the temp_work_scratchpad key
    mem3 = new Memory({ dbPath });
    await mem3.load();
    assert.equal(mem3.get(SCRATCHPAD_KEY), undefined);
    mem3.close();
    mem3 = null;
  } finally {
    await session1?.cleanup().catch(() => {});
    await session2?.cleanup().catch(() => {});
    mem1?.close();
    mem2?.close();
    mem3?.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('WorkScratchpad deletes crashed task permanently when owner says "bỏ việc cũ" or casual "thôi bỏ đi"', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-scratch-clear-'));
  const dbPath = path.join(dir, 'world.db');

  let memInit = null;
  let mem2 = null;
  let memCasual = null;
  let mem3 = null;
  let session2 = null;
  let session3 = null;

  try {
    // Prepare DB with an abandoned crashed task from game_1
    memInit = new Memory({ dbPath });
    await memInit.load();
    const spInit = new WorkScratchpad(memInit, { sessionId: 'game_1' });
    spInit.startSingleCommand({ type: 'gather', count: 32, target: 'sắt' });
    memInit.close();
    memInit = null;

    // Reopen in game_2 and test "bỏ việc cũ"
    mem2 = new Memory({ dbPath });
    await mem2.load();
    const fakeBot2 = makeFakeBot();
    let gatherCalled = false;
    session2 = createBotSession(makeTestConfig(), {
      llm: {},
      memory: mem2,
      tasks: new TaskCoordinator({ log: () => {} }),
      router: new CommandRouter(),
      createBotFn: () => fakeBot2,
      loadPlugins: false,
      sessionId: 'game_2',
    });
    session2.survival.gather = async () => { gatherCalled = true; return 32; };

    fakeBot2.emit('spawn');
    assert.equal(session2.scratchpad.hasRecovery(), true);
    fakeBot2.emit('chat', 'araslime', 'bỏ việc cũ');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(gatherCalled, false);
    assert.equal(session2.scratchpad.hasPending(), false);
    assert.equal(mem2.get(SCRATCHPAD_KEY), undefined);
    await session2.cleanup();
    session2 = null;
    mem2.close();
    mem2 = null;

    // Test casual CompanionManager dismissal ("thôi bỏ đi") on a manual note
    memCasual = new Memory({ dbPath });
    await memCasual.load();
    const spCasual = new WorkScratchpad(memCasual, { sessionId: 'game_2' });
    spCasual.setManualTask({ goal: 'Đào thêm than sau', note: 'Đào thêm than sau' });
    memCasual.close();
    memCasual = null;

    mem3 = new Memory({ dbPath });
    await mem3.load();
    const fakeBot3 = makeFakeBot();
    session3 = createBotSession(makeTestConfig(), {
      llm: {},
      memory: mem3,
      tasks: new TaskCoordinator({ log: () => {} }),
      router: new CommandRouter(),
      createBotFn: () => fakeBot3,
      loadPlugins: false,
      sessionId: 'game_3',
    });

    fakeBot3.emit('spawn');
    assert.equal(session3.scratchpad.hasRecovery(), true);
    fakeBot3.emit('chat', 'araslime', 'thôi bỏ đi');
    await new Promise(r => setTimeout(r, 60));

    assert.equal(session3.scratchpad.hasPending(), false);
    assert.equal(mem3.get(SCRATCHPAD_KEY), undefined);
    assert.ok(fakeBot3._chats.some(c => /bỏ qua việc dở/i.test(c)));
  } finally {
    await session2?.cleanup().catch(() => {});
    await session3?.cleanup().catch(() => {});
    memInit?.close();
    mem2?.close();
    memCasual?.close();
    mem3?.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('mc_scratchpad MCP tool supports set, get, resume, and clear end-to-end', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-scratch-mcp-'));
  const mem = new Memory({ dbPath: path.join(dir, 'mem.db') });
  await mem.load();
  const dash = new DashboardServer({ host: '127.0.0.1', port: 0, log: () => {} });
  const addr = await dash.start();
  const fakeBot = makeFakeBot();

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory: mem,
    tasks: new TaskCoordinator({ log: () => {} }),
    router: new CommandRouter(),
    externalDashboard: dash,
    loadPlugins: false,
    createBotFn: () => fakeBot,
    sessionId: 'game_mcp_1',
  });

  const handle = createMcpHandler({
    baseUrl: `http://${addr.host}:${addr.port}`,
    pollIntervalMs: 15,
  });

  const call = async (id, name, args) => {
    const res = await handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(res.error, undefined);
    assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
    return JSON.parse(res.result.content[0].text);
  };

  try {
    fakeBot.emit('spawn');
    const setRes = await call(1, 'mc_scratchpad', {
      action: 'set',
      goal: 'Xây chuồng bò',
      steps: ['Lấy gỗ', 'Làm hàng rào'],
      note: 'Ưu tiên gần nhà',
    });
    assert.equal(setRes.ok, true);
    assert.equal(setRes.scratchpad.recovery.goal, 'Xây chuồng bò');
    assert.equal(setRes.scratchpad.manualNote, 'Ưu tiên gần nhà');

    const getRes = await call(2, 'mc_scratchpad', { action: 'get' });
    assert.equal(getRes.scratchpad.recovery.goal, 'Xây chuồng bò');
    assert.match(getRes.summary, /Xây chuồng bò/);

    const clearRes = await call(3, 'mc_scratchpad', { action: 'clear' });
    assert.equal(clearRes.ok, true);
    assert.equal(clearRes.scratchpad.recovery, null);
    assert.equal(clearRes.scratchpad.manualNote, null);
    assert.equal(mem.get(SCRATCHPAD_KEY), undefined);
  } finally {
    await session.cleanup();
    await dash.stop();
    mem.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
