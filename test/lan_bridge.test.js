import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import {
  DEFAULT_CONFIG,
  loadConfig,
  resolveMineflayerVersion,
} from '../src/config.js';
import { createBotSession } from '../src/session.js';
import { Memory } from '../src/memory.js';
import { TaskCoordinator } from '../src/tasks.js';
import { CommandRouter } from '../src/commands.js';
import {
  LanDiscovery,
  isSameHost,
  parseLanAnnouncement,
  resolveWorldDbPath,
} from '../src/session/lan_discovery.js';
import {
  AntigravityBridge,
  DEFAULT_BOT_AGENT_MODEL,
  buildWakePrompt,
  extractConversationId,
  shouldWakeAntigravity,
} from '../src/mcp/antigravity_bridge.js';

function makeMinimalFakeBot() {
  const bot = new EventEmitter();
  bot.username = 'bot_dong_hanh';
  bot.version = '1.20.4';
  bot.health = 20;
  bot.food = 20;
  bot.saturation = 5;
  bot.isAlive = true;
  bot.isSleeping = false;
  bot.heldItem = null;
  bot.game = { dimension: 'overworld' };
  bot.entity = { position: new Vec3(0, 64, 0), onGround: true, velocity: { y: 0 }, yaw: 0, metadata: { 0: 0 } };
  bot.entities = {};
  bot.players = {};
  bot.inventory = { items: () => [], slots: new Array(46).fill(null), emptySlotCount: () => 20 };
  bot.chat = () => {};
  bot.whisper = () => {};
  bot.pathfinder = { setMovements: () => {}, setGoal: () => {}, goto: async () => {}, isMoving: () => false };
  bot.isABed = () => false;
  bot.parseBedMetadata = () => ({ occupied: false });
  bot.findBlocks = () => [];
  bot.blockAt = () => null;
  bot.lookAt = async () => {};
  bot.look = async () => {};
  bot.setControlState = () => {};
  bot.clearControlStates = () => {};
  bot.stopDigging = () => {};
  bot.quit = () => {};
  return bot;
}

test('parseLanAnnouncement parses owner, Vietnamese world name, strips § codes, normalizes local IPs, and rejects malformed packets', () => {
  const localIps = new Set(['127.0.0.1', '192.168.1.42']);

  const basic = parseLanAnnouncement('[MOTD]araslime - Survival Base[/MOTD][AD]55916[/AD]', '127.0.0.1', localIps);
  assert.deepEqual(basic, {
    host: '127.0.0.1',
    port: 55916,
    motd: 'araslime - Survival Base',
    ownerHint: 'araslime',
    worldName: 'Survival Base',
  });

  const coloredVn = parseLanAnnouncement(
    Buffer.from('[MOTD]§aaraslime§r - §6Thế Giới Sinh Tồn 1.20.4[/MOTD][AD]61234[/AD]', 'utf8'),
    '::ffff:192.168.1.42',
    localIps
  );
  assert.deepEqual(coloredVn, {
    host: '127.0.0.1',
    port: 61234,
    motd: 'araslime - Thế Giới Sinh Tồn 1.20.4',
    ownerHint: 'araslime',
    worldName: 'Thế Giới Sinh Tồn 1.20.4',
  });

  const remoteWorld = parseLanAnnouncement('[MOTD]Server Test[/MOTD][AD]25565[/AD]', '::ffff:192.168.1.99', localIps);
  assert.deepEqual(remoteWorld, {
    host: '192.168.1.99',
    port: 25565,
    motd: 'Server Test',
    ownerHint: null,
    worldName: 'Server Test',
  });

  assert.equal(parseLanAnnouncement('[MOTD]bad[/MOTD][AD]99999[/AD]'), null);
  assert.equal(parseLanAnnouncement('[MOTD]no ad tag[/MOTD]'), null);
  assert.equal(parseLanAnnouncement('random garbage'), null);

  assert.equal(isSameHost('localhost', '127.0.0.1'), true);
  assert.equal(isSameHost('::1', 'localhost'), true);
  assert.equal(isSameHost('192.168.1.5', '127.0.0.1'), false);
});

test('resolveWorldDbPath falls back to default db and isolates distinct Vietnamese worlds', () => {
  assert.equal(resolveWorldDbPath(null), path.join('data', 'bot_memory.db'));
  assert.equal(resolveWorldDbPath('   '), path.join('data', 'bot_memory.db'));

  const worldA = resolveWorldDbPath('Thế Giới Đỏ 1.20');
  const worldB = resolveWorldDbPath('Thế Giới Xanh 1.21');
  assert.match(worldA, /^data[\\/]worlds[\\/]the-gioi-do-1-20-[0-9a-f]{6}\.db$/);
  assert.match(worldB, /^data[\\/]worlds[\\/]the-gioi-xanh-1-21-[0-9a-f]{6}\.db$/);
  assert.notEqual(worldA, worldB);
});

test('resolveMineflayerVersion, loadConfig, and createBotSession pass version=false for auto version', async () => {
  assert.equal(resolveMineflayerVersion('auto'), false);
  assert.equal(resolveMineflayerVersion('AUTO'), false);
  assert.equal(resolveMineflayerVersion(false), false);
  assert.equal(resolveMineflayerVersion(''), false);
  assert.equal(resolveMineflayerVersion('1.20.4'), '1.20.4');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-auto-cfg-'));
  const file = path.join(dir, 'config.json');
  try {
    await fs.writeFile(file, JSON.stringify({
      minecraft: { version: 'auto', autoDiscoverLan: true },
    }));
    const cfg = loadConfig(file, { env: {} });
    assert.equal(cfg.minecraft.version, 'auto');
    assert.equal(cfg.minecraft.autoDiscoverLan, true);

    const cfgEnv = loadConfig(file, {
      env: { MINECRAFT_VERSION: 'auto', MINECRAFT_AUTO_DISCOVER_LAN: 'false' },
    });
    assert.equal(cfgEnv.minecraft.version, 'auto');
    assert.equal(cfgEnv.minecraft.autoDiscoverLan, false);

    let capturedOpts = null;
    const memory = new Memory({ path: ':memory:' });
    await memory.load();
    const session = createBotSession(
      { ...DEFAULT_CONFIG, minecraft: { ...DEFAULT_CONFIG.minecraft, version: 'auto' }, dashboard: { enabled: false, host: '127.0.0.1', port: 3000 } },
      {
        memory,
        tasks: new TaskCoordinator(),
        router: new CommandRouter(),
        loadPlugins: false,
        createBotFn: (opts) => {
          capturedOpts = opts;
          return makeMinimalFakeBot();
        },
      }
    );
    assert.equal(capturedOpts.version, false);
    await session.cleanup();
    memory.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('LanDiscovery tracks active worlds, signals isNew, joins multicast, and prunes stale entries', () => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.joined = [];
      this.boundPort = null;
      this.closed = false;
    }
    bind(port) {
      this.boundPort = port;
      this.emit('listening');
    }
    addMembership(addr, iface) {
      this.joined.push({ addr, iface: iface ?? null });
    }
    close() {
      this.closed = true;
    }
  }

  let fakeSock = null;
  const seenEvents = [];
  const discovery = new LanDiscovery({
    staleMs: 5000,
    createSocketFn: () => {
      fakeSock = new FakeSocket();
      return fakeSock;
    },
    onWorld: (entry, active) => {
      seenEvents.push({ port: entry.port, isNew: entry.isNew, activeCount: active.length });
    },
  });

  discovery.start();
  assert.equal(fakeSock.boundPort, 4445);
  assert.ok(fakeSock.joined.some((j) => j.addr === '224.0.2.60' && j.iface === '127.0.0.1'));

  discovery.handleMessage('[MOTD]araslime - Map 1[/MOTD][AD]10001[/AD]', '127.0.0.1', 1000);
  discovery.handleMessage('[MOTD]araslime - Map 1[/MOTD][AD]10001[/AD]', '127.0.0.1', 2500);
  discovery.handleMessage('[MOTD]araslime - Map 2[/MOTD][AD]10002[/AD]', '127.0.0.1', 3000);

  assert.deepEqual(seenEvents, [
    { port: 10001, isNew: true, activeCount: 1 },
    { port: 10001, isNew: false, activeCount: 1 },
    { port: 10002, isNew: true, activeCount: 2 },
  ]);

  assert.equal(discovery.listActive(8000).length, 1);
  assert.equal(discovery.listActive(8000)[0].port, 10002);

  discovery.stop();
  assert.equal(fakeSock.closed, true);
});

test('shouldWakeAntigravity, extractConversationId, and buildWakePrompt filter and format events accurately', async () => {
  assert.equal(shouldWakeAntigravity({ kind: 'spawn', username: 'bot' }), false);
  assert.equal(shouldWakeAntigravity({ kind: 'chat', isOwner: true, handledByBot: true, message: 'theo tôi' }), false);
  assert.equal(shouldWakeAntigravity({ kind: 'chat', isOwner: false, handledByBot: false, message: 'hi' }), false);
  assert.equal(shouldWakeAntigravity({ kind: 'chat', isOwner: true, handledByBot: false, message: 'chao bot' }), true);
  assert.equal(shouldWakeAntigravity({ kind: 'whisper', isOwner: true, handledByBot: false, message: 'làm gì đó' }), true);
  assert.equal(shouldWakeAntigravity({ kind: 'alert', alertType: 'stuck', message: 'kẹt' }), true);
  assert.equal(shouldWakeAntigravity({ kind: 'alert', alertType: 'low_food', message: 'đói' }), false);

  const uuid = '11111111-2222-3333-4444-555555555555';
  assert.equal(extractConversationId({ stdout: `{"conversation_id":"${uuid}"}` }), uuid);
  assert.equal(extractConversationId({ stderr: `Created conversation ${uuid}` }), uuid);

  const eventsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-agy-events-'));
  try {
    const now = Date.now();
    await fs.writeFile(path.join(eventsDir, 'conv.json'), JSON.stringify({ conversationId: uuid }));
    assert.equal(extractConversationId({ eventsDir, sinceMs: now - 500 }), uuid);
  } finally {
    await fs.rm(eventsDir, { recursive: true, force: true });
  }

  assert.equal(DEFAULT_BOT_AGENT_MODEL, 'gemini-4-hydrogen-low');

  const prompt = buildWakePrompt(
    [{ kind: 'chat', username: 'araslime', viaWhisper: false, message: 'chao bot' }],
    {
      lan: { owner: 'araslime', version: '1.20.4', port: 51111, worldName: 'Sinh Tồn' },
      health: 18,
      food: 16,
      isDay: true,
      position: { x: 12, y: 64, z: -8 },
      task: 'rảnh',
      inventory: [{ name: 'oak_log', count: 16 }],
    },
    { isNewConversation: true }
  );
  assert.match(prompt, /Sinh Tồn/);
  assert.match(prompt, /1\.20\.4/);
  assert.match(prompt, /chao bot/);
  assert.match(prompt, /18\/20/);
  assert.match(prompt, /oak_logx16/);
  assert.match(prompt, /instant=true/);
  assert.match(prompt, /tui\/ông/);
  assert.match(prompt, /mc_say/);
});

test('AntigravityBridge handles offline sleep, skips handled commands, wakes/reuses conversation, retries on error, and resets on restart', async () => {
  let online = false;
  let now = 100_000;
  let sessionId = 'game_1';
  let inbox = { latestId: 0, messages: [] };
  const apiCalls = [];
  let failSendMessageOnce = false;

  const fetchFn = async (url) => {
    if (!online) {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:3000');
      err.code = 'ECONNREFUSED';
      throw err;
    }
    if (url.includes('/api/state')) {
      return {
        ok: true,
        json: async () => ({
          sessionId,
          connected: true,
          lan: { host: '127.0.0.1', port: 55000, owner: 'araslime', version: '1.21.1', worldName: 'Test' },
        }),
      };
    }
    if (url.includes('/api/inbox')) {
      const u = new URL(url);
      const sinceId = Number(u.searchParams.get('sinceId') || 0);
      return {
        ok: true,
        json: async () => ({
          sessionId,
          latestId: inbox.latestId,
          messages: inbox.messages.filter((m) => m.id > sinceId),
        }),
      };
    }
    throw new Error(`Unexpected url ${url}`);
  };

  const conv1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const conv2 = '99999999-8888-7777-6666-555555555555';

  const bridge = new AntigravityBridge({
    debounceMs: 10,
    nowFn: () => now,
    fetchFn,
    log: () => {},
    warn: () => {},
    runAgentApi: async ({ conversationId, model, prompt }) => {
      apiCalls.push({ conversationId, model, prompt });
      if (conversationId && failSendMessageOnce) {
        failSendMessageOnce = false;
        throw new Error('conversation closed');
      }
      return { conversationId: conversationId || (apiCalls.length <= 2 ? conv1 : conv2) };
    },
  });

  // 1. Offline poll sleeps cleanly
  assert.equal(await bridge.pollOnce(), false);
  assert.equal(apiCalls.length, 0);

  // 2. Initial connect skips spawn, handled commands, and stale old chats
  online = true;
  inbox = {
    latestId: 3,
    messages: [
      { id: 1, time: now - 5000, kind: 'spawn', username: 'bot_dong_hanh', message: 'entered' },
      { id: 2, time: now - 4000, kind: 'chat', isOwner: true, handledByBot: true, username: 'araslime', message: 'theo tôi' },
      { id: 3, time: now - 120_000, kind: 'chat', isOwner: true, handledByBot: false, username: 'araslime', message: 'old chat' },
    ],
  };
  assert.equal(await bridge.pollOnce(), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(apiCalls.length, 0);
  assert.equal(bridge.lastSeenId, 3);

  // 3. New unhandled owner chat wakes with new-conversation and captures conv1
  inbox = {
    latestId: 4,
    messages: [
      ...inbox.messages,
      { id: 4, time: now, kind: 'chat', isOwner: true, handledByBot: false, username: 'araslime', message: 'chao bot' },
    ],
  };
  await bridge.pollOnce();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].conversationId, null);
  assert.equal(apiCalls[0].model, 'gemini-4-hydrogen-low');
  assert.match(apiCalls[0].prompt, /chao bot/);
  assert.equal(bridge.conversationId, conv1);

  // 4. Follow-up message uses send-message with conv1
  inbox = {
    latestId: 5,
    messages: [
      ...inbox.messages,
      { id: 5, time: now + 1000, kind: 'chat', isOwner: true, handledByBot: false, username: 'araslime', message: 'di dao go giup minh' },
    ],
  };
  await bridge.pollOnce();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(apiCalls.length, 2);
  assert.equal(apiCalls[1].conversationId, conv1);
  assert.match(apiCalls[1].prompt, /di dao go giup minh/);

  // 5. send-message failure resets conversationId and retries once with new-conversation
  failSendMessageOnce = true;
  inbox = {
    latestId: 6,
    messages: [
      ...inbox.messages,
      { id: 6, time: now + 2000, kind: 'alert', alertType: 'stuck', message: 'Bot bị kẹt lâu' },
    ],
  };
  await bridge.pollOnce();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(apiCalls.length, 4);
  assert.equal(apiCalls[2].conversationId, conv1);
  assert.equal(apiCalls[3].conversationId, null);
  assert.equal(bridge.conversationId, conv2);

  // 6. Bot restart (latestId drops below lastSeenId) resets lastSeenId & conversationId and processes fresh chat
  inbox = {
    latestId: 2,
    messages: [
      { id: 1, time: now + 3000, kind: 'spawn', username: 'bot_dong_hanh', message: 'entered' },
      { id: 2, time: now + 4000, kind: 'chat', isOwner: true, handledByBot: false, username: 'araslime', message: 'chao ban moi' },
    ],
  };
  await bridge.pollOnce();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.lastSeenId, 2);
  assert.equal(apiCalls.length, 5);
  assert.equal(apiCalls[4].conversationId, null);
  assert.match(apiCalls[4].prompt, /chao ban moi/);

  // 7. New game sessionId while bot keeps running triggers fresh AI conversation (conversationId = null)
  sessionId = 'game_2';
  inbox = {
    latestId: 3,
    messages: [
      { id: 3, time: now + 5000, kind: 'chat', isOwner: true, handledByBot: false, username: 'araslime', message: 'game mới nè' },
    ],
  };
  await bridge.pollOnce();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(apiCalls.length, 6);
  assert.equal(apiCalls[5].conversationId, null);
  assert.match(apiCalls[5].prompt, /game mới nè/);

  assert.deepEqual(bridge.status(), {
    online: true,
    apiUrl: 'http://127.0.0.1:3000',
    model: 'gemini-4-hydrogen-low',
    gameSessionId: 'game_2',
    turnCount: 1,
    initialized: true,
    lastSeenId: 3,
    conversationId: conv2,
    pendingCount: 0,
  });

  bridge.stop();
});
