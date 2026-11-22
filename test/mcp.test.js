import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DashboardServer } from '../src/dashboard.js';
import { TOOLS, createMcpHandler } from '../src/mcp/server.js';
import { createBotSession } from '../src/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Memory } from '../src/memory.js';
import { TaskCoordinator } from '../src/tasks.js';
import { CommandRouter } from '../src/commands.js';

const require = createRequire(import.meta.url);
const mineflayerPkgPath = require.resolve('mineflayer/package.json');
const mineflayerRequire = createRequire(mineflayerPkgPath);
const prismarineRegistry = mineflayerRequire('prismarine-registry');
const realRegistry = prismarineRegistry('1.21.1');

const SERVER_PATH = fileURLToPath(new URL('../src/mcp/server.js', import.meta.url));

test('createMcpHandler handles MCP protocol handshake, notifications, errors, and wait events', async () => {
  let stateCalls = 0;
  let inboxSeq = 2;
  const mockFetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/state') {
      stateCalls += 1;
      return new Response(JSON.stringify({
        connected: true,
        health: 20,
        food: 20,
        position: { x: 1, y: 64, z: 2 },
        task: stateCalls >= 3 ? 'rảnh' : 'lay_go',
        taskQueue: { active: stateCalls >= 3 ? null : { name: 'lay_go' } },
        aiPaused: false,
        logs: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'],
      }), { status: 200 });
    }
    if (u.pathname === '/api/inbox') {
      const sinceId = Number(u.searchParams.get('sinceId') || 0);
      const all = [
        { id: 1, kind: 'spawn', message: 'joined' },
        { id: 2, kind: 'chat', username: 'araslime', message: 'hi' },
        ...(inboxSeq >= 3 ? [{ id: 3, kind: 'chat', username: 'araslime', message: 'ping' }] : []),
      ];
      return new Response(JSON.stringify({
        latestId: inboxSeq,
        messages: all.filter(m => m.id > sinceId),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };

  const handle = createMcpHandler({
    baseUrl: 'http://127.0.0.1:3000/',
    fetchImpl: mockFetch,
    pollIntervalMs: 15,
  });

  const init = await handle({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });
  assert.equal(init.id, 0);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'minecraft-bot');

  const initFallback = await handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  });
  assert.equal(initFallback.result.protocolVersion, '2025-03-26');

  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'custom/notice' }), null);
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).result, {});

  const list = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(list.result.tools.length, TOOLS.length);
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).result, { resources: [] });
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 5, method: 'prompts/list' })).result, { prompts: [] });

  const unknownMethod = await handle({ jsonrpc: '2.0', id: 6, method: 'no/such' });
  assert.equal(unknownMethod.error.code, -32601);

  const unknownTool = await handle({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'no_tool', arguments: {} },
  });
  assert.equal(unknownTool.error.code, -32602);

  // mc_get_state logLimit + includeLogs=false
  const stateSmall = await handle({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'mc_get_state', arguments: { logLimit: 2 } },
  });
  const parsedStateSmall = JSON.parse(stateSmall.result.content[0].text);
  assert.deepEqual(parsedStateSmall.logs, ['l5', 'l6']);

  const stateNoLogs = await handle({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'mc_get_state', arguments: { includeLogs: false } },
  });
  assert.equal(JSON.parse(stateNoLogs.result.content[0].text).logs, undefined);

  // mc_wait_event resolves on task_done after transitioning from active -> idle
  stateCalls = 0;
  const waitDone = await handle({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'mc_wait_event', arguments: { waitFor: 'task_done', timeoutSec: 2 } },
  });
  const waitDonePayload = JSON.parse(waitDone.result.content[0].text);
  assert.equal(waitDonePayload.reason, 'task_done');
  assert.equal(waitDonePayload.state.task, 'rảnh');

  // mc_wait_event resolves immediately when sinceInboxId is behind latestId
  inboxSeq = 3;
  const waitInbox = await handle({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'mc_wait_event', arguments: { waitFor: 'inbox', sinceInboxId: 2, timeoutSec: 2 } },
  });
  const waitInboxPayload = JSON.parse(waitInbox.result.content[0].text);
  assert.equal(waitInboxPayload.reason, 'new_inbox');
  assert.equal(waitInboxPayload.newMessages.length, 1);
  assert.equal(waitInboxPayload.newMessages[0].id, 3);
});

test('createMcpHandler mc_wait_event handles low_health, idle timeout on any, and offline errors', async () => {
  let healthVal = 20;
  let taskName = 'rảnh';
  const handle = createMcpHandler({
    baseUrl: 'http://127.0.0.1:3000',
    pollIntervalMs: 15,
    fetchImpl: async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/state') {
        return new Response(JSON.stringify({
          connected: true,
          health: healthVal,
          food: 18,
          task: taskName,
          taskQueue: { active: taskName === 'rảnh' ? null : { name: taskName } },
          logs: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ latestId: 1, messages: [] }), { status: 200 });
    },
  });

  // Bot is already idle with waitFor='any': must wait and timeout instead of returning task_done at 0ms
  const idleWait = await handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'mc_wait_event', arguments: { waitFor: 'any', timeoutSec: 0.06 } },
  });
  // timeoutSec clamps to >= 1s; to verify low_health quickly let's test low_health transition
  const idleParsed = JSON.parse(idleWait.result.content[0].text);
  assert.equal(idleParsed.reason, 'timeout');

  // Drop health after 30ms -> resolves with low_health well before timeout
  setTimeout(() => { healthVal = 6; }, 35);
  const hpWait = await handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'mc_wait_event', arguments: { waitFor: 'any', timeoutSec: 3 } },
  });
  const hpParsed = JSON.parse(hpWait.result.content[0].text);
  assert.equal(hpParsed.reason, 'low_health');
  assert.equal(hpParsed.state.health, 6);

  // Offline error returns actionable hint
  const offlineHandle = createMcpHandler({
    baseUrl: 'http://127.0.0.1:3999',
    fetchImpl: async () => {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    },
  });
  const offlineRes = await offlineHandle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'mc_get_state', arguments: {} },
  });
  assert.equal(offlineRes.result.isError, true);
  assert.match(offlineRes.result.content[0].text, /ECONNREFUSED/);
});

test('MCP Stdio subprocess communicates end-to-end with live DashboardServer', async () => {
  const actions = {
    commands: [],
    says: [],
    controls: [],
    inv: [],
    connects: [],
    plans: [],
    smelts: [],
  };
  let inboxSeq = 1;
  const inboxMsgs = [{ id: 1, kind: 'chat', username: 'araslime', isOwner: true, message: 'đào gỗ đi' }];

  const dash = new DashboardServer({
    host: '127.0.0.1',
    port: 0,
    authToken: 'test-mcp-token',
    getState: () => ({
      connected: true,
      health: 19,
      food: 20,
      position: { x: 5, y: 64, z: -2 },
      task: 'rảnh',
      taskQueue: { active: null },
      aiPaused: false,
      logs: ['line1', 'line2'],
    }),
    onCommand: async (cmd) => {
      actions.commands.push(cmd);
      return { parsedType: 'follow', tier: 'exact', activeTask: 'theo_chu' };
    },
    onConnect: async (cfg) => { actions.connects.push(cfg); },
    onControl: async (payload) => {
      actions.controls.push(payload.action);
      return { aiPaused: payload.action === 'pause_ai' };
    },
    onInventoryAction: async (payload) => {
      actions.inv.push(payload);
      return { ok: true, ...payload };
    },
    onGetNearby: async ({ radius }) => ({
      connected: true,
      radius,
      position: { x: 5, y: 64, z: -2 },
      ownerPosition: { x: 7, y: 64, z: -2 },
      players: [{ username: 'araslime', position: { x: 7, y: 64, z: -2 }, distance: 2 }],
      mobs: [],
      items: [],
      blocks: { oak_log: { count: 4, nearest: { x: 8, y: 64, z: -2, distance: 3 } } },
    }),
    getInbox: async ({ sinceId, limit }) => ({
      latestId: inboxSeq,
      messages: inboxMsgs.filter(m => m.id > sinceId).slice(-limit),
    }),
    onSay: async ({ message, whisperTo }) => {
      actions.says.push({ message, whisperTo });
      return { ok: true, sent: [message], whisperTo };
    },
    onPlanExecute: async (payload) => {
      actions.plans.push(payload);
      return { ok: true, goal: payload.goal, completedSteps: payload.steps?.length ?? 0 };
    },
    onSmelt: async (payload) => {
      actions.smelts.push(payload);
      return { ok: true, action: payload.action || 'status', activeJobs: [] };
    },
    log: () => {},
  });

  const addr = await dash.start();
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      BOT_API_URL: `http://${addr.host}:${addr.port}`,
      BOT_API_TOKEN: 'test-mcp-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stderrChunks = [];
  child.stderr.on('data', chunk => stderrChunks.push(chunk.toString('utf8')));

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const waiters = new Map();
  const strayLines = [];

  rl.on('line', (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      strayLines.push(line);
      return;
    }
    const key = parsed.id === null ? 'parse-error' : parsed.id;
    const resolve = waiters.get(key);
    if (resolve) {
      waiters.delete(key);
      resolve(parsed);
    }
  });

  const sendReq = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method} (${id})`)), 5000);
    waiters.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    const initRes = await sendReq(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    assert.equal(initRes.result.protocolVersion, '2025-03-26');

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const parseErrPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for parse error')), 5000);
      waiters.set('parse-error', (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
    child.stdin.write('{bad json\n');
    const parseErr = await parseErrPromise;
    assert.equal(parseErr.error.code, -32700);

    const toolsRes = await sendReq(2, 'tools/list');
    assert.equal(toolsRes.result.tools.length, TOOLS.length);

    const call = async (id, name, args) => {
      const res = await sendReq(id, 'tools/call', { name, arguments: args });
      assert.equal(res.error, undefined);
      assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
      return JSON.parse(res.result.content[0].text);
    };

    const state = await call(3, 'mc_get_state', { logLimit: 1 });
    assert.equal(state.health, 19);
    assert.deepEqual(state.logs, ['line2']);

    const nearby = await call(4, 'mc_get_nearby', { radius: 16 });
    assert.equal(nearby.blocks.oak_log.count, 4);

    const inbox = await call(5, 'mc_get_inbox', { sinceId: 0, limit: 10 });
    assert.equal(inbox.latestId, 1);
    assert.equal(inbox.messages[0].message, 'đào gỗ đi');

    const cmd = await call(6, 'mc_command', { command: 'theo tôi' });
    assert.equal(cmd.result.parsedType, 'follow');
    assert.deepEqual(actions.commands, ['theo tôi']);

    const say = await call(7, 'mc_say', { message: 'Ok đang đi', whisperTo: 'araslime' });
    assert.equal(say.ok, true);
    assert.deepEqual(actions.says, [{ message: 'Ok đang đi', whisperTo: 'araslime' }]);

    const ctrl = await call(8, 'mc_control', { action: 'pause_ai' });
    assert.equal(ctrl.result.aiPaused, true);
    assert.deepEqual(actions.controls, ['pause_ai']);

    const inv = await call(9, 'mc_inventory', { action: 'equip', itemName: 'iron_sword', slot: 36 });
    assert.equal(inv.result.itemName, 'iron_sword');
    assert.deepEqual(actions.inv, [{ action: 'equip', itemName: 'iron_sword', slot: 36 }]);

    const conn = await call(10, 'mc_connect', { port: 25565, host: '127.0.0.1', owner: 'araslime' });
    assert.equal(conn.port, 25565);
    assert.deepEqual(actions.connects, [{ host: '127.0.0.1', port: 25565, owner: 'araslime' }]);

    const waitRes = await call(11, 'mc_wait_event', { waitFor: 'task_done', timeoutSec: 2 });
    assert.equal(waitRes.reason, 'task_done');

    const planRes = await call(12, 'mc_plan_execute', {
      goal: 'Lấy gỗ rồi về',
      steps: [{ type: 'command', command: 'đứng đây' }],
      wait: true,
    });
    assert.equal(planRes.ok, true);
    assert.equal(actions.plans.length, 1);

    const smeltRes = await call(13, 'mc_smelt', { action: 'status' });
    assert.equal(smeltRes.ok, true);
    assert.equal(actions.smelts.length, 1);

    child.stdin.end();
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(exitCode, 0);
    assert.deepEqual(strayLines, []);
    const filteredStderr = stderrChunks.join('').replace(/^\(node:\d+\) ExperimentalWarning:.*\r?\n?/gm, '').trim();
    assert.equal(filteredStderr, '');
  } finally {
    rl.close();
    if (child.exitCode === null) child.kill();
    await dash.stop();
  }
});

test('createBotSession records spawn, chat, whisper, death, and kicked events into shared inboxState', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-inbox-'));
  const mem = new Memory({ dbPath: path.join(dir, 'mem.db') });
  await mem.load();
  const tasks = new TaskCoordinator({ log: () => {} });
  const router = new CommandRouter();
  const inboxState = { seq: 0, items: [] };

  let fakeBot;
  const dash = new DashboardServer({
    host: '127.0.0.1',
    port: 0,
    log: () => {},
  });
  const addr = await dash.start();

  const session = createBotSession(
    DEFAULT_CONFIG,
    {
      llm: {},
      memory: mem,
      tasks,
      router,
      externalDashboard: dash,
      inboxState,
      loadPlugins: false,
      createBotFn: () => {
        const bot = new EventEmitter();
        bot.username = 'bot_dong_hanh';
        bot.version = '1.21.1';
        bot.health = 20;
        bot.food = 20;
        bot.isAlive = true;
        bot.isSleeping = false;
        bot.game = { dimension: 'overworld' };
        bot.registry = realRegistry;
        bot.entity = { position: { x: 10, y: 64, z: 20 }, yaw: 0 };
        bot.entities = {};
        bot.players = {};
        bot.inventory = { slots: new Array(46).fill(null), items: () => [], emptySlotCount: () => 20 };
        bot.pathfinder = { setMovements: () => {}, setGoal: () => {} };
        bot.chat = () => {};
        bot.whisper = () => {};
        fakeBot = bot;
        return bot;
      },
    }
  );

  try {
    fakeBot.emit('spawn');
    fakeBot.emit('chat', 'bot_dong_hanh', 'ignored self message');
    fakeBot.emit('chat', 'araslime', 'trạng thái');
    fakeBot.emit('whisper', 'other_player', 'hello');
    fakeBot.emit('death');
    fakeBot.emit('kicked', 'Server closed');

    const res = await fetch(`http://${addr.host}:${addr.port}/api/inbox`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.latestId, 5);
    assert.deepEqual(
      data.messages.map(m => ({ kind: m.kind, username: m.username, isOwner: m.isOwner, viaWhisper: m.viaWhisper })),
      [
        { kind: 'spawn', username: 'bot_dong_hanh', isOwner: undefined, viaWhisper: undefined },
        { kind: 'chat', username: 'araslime', isOwner: true, viaWhisper: false },
        { kind: 'whisper', username: 'other_player', isOwner: false, viaWhisper: true },
        { kind: 'death', username: 'bot_dong_hanh', isOwner: undefined, viaWhisper: undefined },
        { kind: 'kicked', username: 'bot_dong_hanh', isOwner: undefined, viaWhisper: undefined },
      ]
    );
  } finally {
    await session.cleanup();
    await dash.stop();
    await mem.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mc_wait_event filters non-owner spam by default and supports unhandledOnly', async () => {
  let seq = 1;
  const msgs = [
    { id: 1, kind: 'spawn', message: 'joined' },
  ];
  const handle = createMcpHandler({
    baseUrl: 'http://127.0.0.1:3000',
    pollIntervalMs: 15,
    fetchImpl: async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/state') {
        return new Response(JSON.stringify({
          connected: true,
          health: 20,
          food: 20,
          task: 'rảnh',
          taskQueue: { active: null },
          logs: [],
        }), { status: 200 });
      }
      const sinceId = Number(u.searchParams.get('sinceId') || 0);
      return new Response(JSON.stringify({
        latestId: seq,
        messages: msgs.filter(m => m.id > sinceId),
      }), { status: 200 });
    },
  });

  // Non-owner chat arrives first (ignored by ownerOnly:true), then handled owner command (ignored if unhandledOnly), then unhandled owner chat
  setTimeout(() => {
    seq = 2;
    msgs.push({ id: 2, kind: 'chat', username: 'stranger', isOwner: false, handledByBot: false, message: 'spam' });
  }, 20);
  setTimeout(() => {
    seq = 3;
    msgs.push({ id: 3, kind: 'chat', username: 'araslime', isOwner: true, handledByBot: true, message: '!stop' });
  }, 50);
  setTimeout(() => {
    seq = 4;
    msgs.push({ id: 4, kind: 'chat', username: 'araslime', isOwner: true, handledByBot: false, message: 'ê đào hộ ít sắt' });
  }, 85);

  const waitRes = await handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'mc_wait_event',
      arguments: { waitFor: 'inbox', sinceInboxId: 1, unhandledOnly: true, timeoutSec: 2 },
    },
  });
  const payload = JSON.parse(waitRes.result.content[0].text);
  assert.equal(payload.reason, 'new_inbox');
  assert.equal(payload.newMessages.length, 1);
  assert.equal(payload.newMessages[0].id, 4);

  const allInbox = await handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'mc_get_inbox', arguments: { sinceId: 1, ownerOnly: true } },
  });
  const ownerOnlyPayload = JSON.parse(allInbox.result.content[0].text);
  assert.deepEqual(ownerOnlyPayload.messages.map(m => m.id), [3, 4]);
});

test('createBotSession with chat.mcpChat defers greet/ack/unknown to Antigravity without duplicate replies and flags handledByBot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-mcp-chat-'));
  const mem = new Memory({ dbPath: path.join(dir, 'mem.db') });
  await mem.load();
  const tasks = new TaskCoordinator({ log: () => {} });
  const router = new CommandRouter();
  const inboxState = { seq: 0, items: [] };
  const chats = [];
  let fakeBot;
  let jevCalled = false;

  const session = createBotSession(
    DEFAULT_CONFIG,
    {
      llm: {
        apiKey: 'dummy-key',
        isAvailable: () => true,
        chooseCombat: async () => {
          jevCalled = true;
          return { action: 'attack_melee', confidence: 0.9, danger: 1, urgentRetreat: 0 };
        },
      },
      memory: mem,
      tasks,
      router,
      inboxState,
      loadPlugins: false,
      createBotFn: () => {
        const bot = new EventEmitter();
        bot.username = 'bot_dong_hanh';
        bot.version = '1.21.1';
        bot.health = 20;
        bot.food = 20;
        bot.isAlive = true;
        bot.isSleeping = false;
        bot.game = { dimension: 'overworld' };
        bot.registry = realRegistry;
        bot.entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0 };
        bot.entities = {};
        bot.players = {};
        bot.inventory = { slots: new Array(46).fill(null), items: () => [], emptySlotCount: () => 20 };
        bot.pathfinder = { setMovements: () => {}, setGoal: () => {} };
        bot.chat = (m) => chats.push(m);
        bot.whisper = () => {};
        fakeBot = bot;
        return bot;
      },
    }
  );

  try {
    fakeBot.emit('spawn');
    fakeBot.emit('chat', 'araslime', 'hi');
    fakeBot.emit('chat', 'araslime', 'ok cảm ơn');
    fakeBot.emit('chat', 'araslime', 'ê xem rương còn gì để làm giáp không');
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(chats, []);
    assert.equal(jevCalled, false);

    fakeBot.emit('chat', 'araslime', '!stop');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(chats.some(c => c.includes('đứng yên')));

    const chatEntries = inboxState.items.filter(i => i.kind === 'chat');
    assert.deepEqual(
      chatEntries.map(e => ({ message: e.message, parsedType: e.parsedType, handledByBot: e.handledByBot })),
      [
        { message: 'hi', parsedType: 'greet', handledByBot: false },
        { message: 'ok cảm ơn', parsedType: 'ack', handledByBot: false },
        { message: 'ê xem rương còn gì để làm giáp không', parsedType: 'unknown', handledByBot: false },
        { message: '!stop', parsedType: 'stay', handledByBot: true },
      ]
    );
  } finally {
    await session.cleanup();
    await mem.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MCP Antigravity planner executes mc_plan_execute, mc_smelt, tags inbox roles, wakes mc_wait_event on alert, and preserves emergency commands', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-planner-'));
  const mem = new Memory({ dbPath: path.join(dir, 'mem.db') });
  await mem.load();
  const tasks = new TaskCoordinator({ log: () => {} });
  const router = new CommandRouter();
  const inboxState = { seq: 0, items: [] };
  const chats = [];
  let jevCalls = 0;
  let fakeBot;

  const dash = new DashboardServer({
    host: '127.0.0.1',
    port: 0,
    getState: () => ({}),
    onCommand: async () => ({}),
    log: () => {},
  });
  const addr = await dash.start();

  const session = createBotSession(
    DEFAULT_CONFIG,
    {
      llm: {
        apiKey: 'dummy-key',
        isAvailable: () => true,
        chooseCombat: async () => {
          jevCalls += 1;
          return { action: 'attack_melee', confidence: 0.9, danger: 1, urgentRetreat: 0 };
        },
        chooseSurvivalAction: async () => {
          jevCalls += 1;
          return { action: 'continue', confidence: 0.8, urgency: 0.2, abortTask: 0 };
        },
      },
      memory: mem,
      tasks,
      router,
      externalDashboard: dash,
      inboxState,
      loadPlugins: false,
      createBotFn: () => {
        const bot = new EventEmitter();
        bot.username = 'bot_dong_hanh';
        bot.version = '1.21.1';
        bot.health = 20;
        bot.food = 20;
        bot.isAlive = true;
        bot.isSleeping = false;
        bot.game = { dimension: 'overworld' };
        bot.registry = realRegistry;
        bot.entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0 };
        bot.entities = {};
        bot.players = {};
        bot.inventory = {
          slots: new Array(46).fill(null),
          items: () => [
            { name: 'stick', count: 8 },
            { name: 'torch', count: 32 },
            { name: 'stone_pickaxe', count: 1 },
            { name: 'bread', count: 10 },
          ],
          emptySlotCount: () => 20,
        };
        bot.pathfinder = { setMovements: () => {}, setGoal: () => {} };
        bot.equip = async () => {};
        bot.chat = (m) => chats.push(m);
        bot.whisper = () => {};
        fakeBot = bot;
        return bot;
      },
    }
  );

  const handle = createMcpHandler({
    baseUrl: `http://${addr.host}:${addr.port}`,
    pollIntervalMs: 15,
  });

  try {
    fakeBot.emit('spawn');
    fakeBot.emit('chat', 'stranger', 'hello bot');
    fakeBot.emit('chat', 'araslime', 'hãy nghĩ xem nên xây nhà kiểu gì');
    fakeBot.emit('chat', 'araslime', '!stop');
    await new Promise(r => setTimeout(r, 25));

    // Zero internal Jev calls on natural chat; !stop executes immediately
    assert.equal(jevCalls, 0);
    assert.ok(chats.some(c => c.includes('đứng yên')));

    // Inbox tags UNTRUSTED_PUBLIC_PLAYER / OWNER_TRUSTED / SYSTEM
    const inboxRes = await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'mc_get_inbox', arguments: { sinceId: 0, limit: 20 } },
    });
    const inboxData = JSON.parse(inboxRes.result.content[0].text);
    const strangerMsg = inboxData.messages.find(m => m.username === 'stranger');
    const ownerMsg = inboxData.messages.find(m => m.username === 'araslime' && m.handledByBot === false);
    const spawnMsg = inboxData.messages.find(m => m.kind === 'spawn');
    assert.equal(strangerMsg.role, 'UNTRUSTED_PUBLIC_PLAYER');
    assert.equal(ownerMsg.role, 'OWNER_TRUSTED');
    assert.equal(spawnMsg.role, 'SYSTEM');

    const stateData = dash.getState();
    assert.equal(stateData.brains.planner, 'Antigravity (MCP)');

    // mc_run_macro executes prepare_caving_kit end-to-end
    const macroRes = await handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'mc_run_macro', arguments: { macro: 'prepare_caving_kit', wait: true } },
    });
    const macroData = JSON.parse(macroRes.result.content[0].text);
    assert.equal(macroData.ok, true);
    assert.equal(macroData.macro, 'prepare_caving_kit');
    assert.equal(macroData.completedSteps.length, 5);

    // mc_smelt status works over HTTP -> DashboardBridge -> SmeltingManager
    const smeltRes = await handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'mc_smelt', arguments: { action: 'status' } },
    });
    const smeltData = JSON.parse(smeltRes.result.content[0].text);
    assert.equal(smeltData.ok, true);
    assert.equal(Array.isArray(smeltData.jobs), true);

    // mc_plan_execute runs multi-step plan and posts plan_completed to inbox
    chats.length = 0;
    const planRes = await handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'mc_plan_execute',
        arguments: {
          goal: 'Chuẩn bị và đứng chờ',
          steps: [
            { type: 'say', message: 'Đang chạy kế hoạch của Antigravity!' },
            { type: 'command', command: 'đứng đây' },
            { type: 'macro', macro: 'prepare_caving_kit' },
          ],
          onDanger: 'pause_and_resume',
          wait: true,
        },
      },
    });
    const planData = JSON.parse(planRes.result.content[0].text);
    assert.equal(planData.ok, true);
    assert.ok(chats.some(c => c.includes('Đang chạy kế hoạch của Antigravity!')));
    assert.ok(inboxState.items.some(i => i.kind === 'plan_completed'));

    // mc_wait_event with waitFor='alert' wakes immediately on critical danger alerts
    const sinceBeforeAlert = inboxState.seq;
    setTimeout(() => {
      inboxState.items.push({
        id: ++inboxState.seq,
        ts: new Date().toISOString(),
        kind: 'alert',
        role: 'SYSTEM',
        severity: 'critical',
        username: 'bot_dong_hanh',
        isOwner: false,
        message: 'Creeper quá gần!',
      });
    }, 25);
    const alertRes = await handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'mc_wait_event',
        arguments: { waitFor: 'alert', sinceInboxId: sinceBeforeAlert, timeoutSec: 2 },
      },
    });
    const alertData = JSON.parse(alertRes.result.content[0].text);
    assert.equal(alertData.reason, 'alert');
    assert.match(JSON.stringify(alertData), /Creeper quá gần!/);
  } finally {
    await session.cleanup();
    await dash.stop();
    await mem.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
