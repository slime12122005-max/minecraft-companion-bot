import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createBotSession } from '../src/session.js';
import { Memory } from '../src/memory.js';
import { TaskCoordinator } from '../src/tasks.js';
import { CommandRouter } from '../src/commands.js';

const require = createRequire(import.meta.url);
const mineflayerPkgPath = require.resolve('mineflayer/package.json');
const mineflayerRequire = createRequire(mineflayerPkgPath);
const prismarineRegistry = mineflayerRequire('prismarine-registry');
const realRegistry = prismarineRegistry('1.21.1');

function makeFakeCompanionBot() {
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
  bot._goals = [];
  bot.chat = (msg) => bot._chats.push(msg);
  bot.whisper = (user, msg) => bot._whispers.push({ user, msg });
  bot.inventory = {
    items: () => [],
    slots: new Array(46).fill(null),
    emptySlotCount: () => 20,
  };
  bot.pathfinder = {
    setMovements: () => {},
    setGoal: (goal, dynamic) => { bot._goals.push({ goal, dynamic: Boolean(dynamic) }); },
    goto: async () => {},
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
    companion: {
      naturalChat: true,
      chatFallbackDelayMs: 25,
      mcpGraceMs: 120,
      idleLife: false,
      idleFollowRange: 6.5,
      idleWanderIntervalMs: 14000,
      ambientChatter: true,
      preserveInTests: true,
      ...overrides,
    },
  };
}

test('CompanionManager replies naturally to greetings, status, surroundings, suggestions, and triggers natural gather request', async () => {
  const fakeBot = makeFakeCompanionBot();
  fakeBot.entities[1] = { id: 1, name: 'pig', type: 'passive', position: new Vec3(4, 64, 2) };
  fakeBot.entities[2] = { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(12, 64, 0) };

  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const inboxState = { seq: 0, items: [] };

  const session = createBotSession(
    {
      ...makeTestConfig(),
      combat: { ...DEFAULT_CONFIG.combat, enabled: false },
    },
    {
      llm: {},
      memory,
      tasks,
      inboxState,
      router: new CommandRouter(),
      createBotFn: () => fakeBot,
      loadPlugins: false,
    }
  );

  try {
    fakeBot.emit('spawn');

    // 1) Greeting
    fakeBot.emit('chat', 'araslime', 'hi');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(fakeBot._chats.length, 1);
    assert.match(fakeBot._chats[0], /araslime/);
    assert.doesNotMatch(fakeBot._chats[0], /\(20\/20 máu/);

    // 2) Health / status question
    fakeBot.emit('chat', 'araslime', 'bạn khỏe ko');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(fakeBot._chats.length, 2);
    assert.match(fakeBot._chats[1], /20\/20 máu/);

    // 3) Surroundings question
    fakeBot.emit('chat', 'araslime', 'quanh đây có gì không');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(fakeBot._chats.length, 3);
    assert.match(fakeBot._chats[2], /zombie/);
    assert.match(fakeBot._chats[2], /pig/);

    // 4) Suggestion question + context follow-up confirmation
    fakeBot.emit('chat', 'araslime', 'giờ nên làm gì tiếp');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(fakeBot._chats.length, 4);
    assert.match(fakeBot._chats[3], /gỗ/i);

    let gatherCalled = null;
    session.survival.gather = async (target, count) => {
      gatherCalled = { target, count };
      return 16;
    };
    fakeBot.inventory.items = () => [{ name: 'bread', count: 16 }];
    fakeBot.emit('chat', 'araslime', 'ok triển luôn');
    await new Promise(r => setTimeout(r, 60));
    assert.deepEqual(gatherCalled, { target: 'gỗ', count: 16 });
    assert.ok(fakeBot._chats.some(c => /triển luôn/i.test(c)));

    // 5) Natural action request ("đi chặt ít gỗ giúp mình") -> replies warmly AND runs gather task
    gatherCalled = null;
    fakeBot.emit('chat', 'araslime', 'đi chặt ít gỗ giúp mình');
    await new Promise(r => setTimeout(r, 60));
    assert.deepEqual(gatherCalled, { target: 'gỗ', count: 16 });
    assert.ok(fakeBot._chats.some(c => /chặt ít gỗ/i.test(c)));
    assert.ok(fakeBot._chats.some(c => /Đã lấy xong 16 gỗ/i.test(c)));
  } finally {
    await session.cleanup();
  }
});

test('MCP grace window prevents duplicate local reply when Antigravity calls onSay or newer chat arrives', async () => {
  const fakeBot = makeFakeCompanionBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const fakeDashboard = {
    getState: null,
    onCommand: null,
    onControl: null,
    onInventoryAction: null,
    onGetNearby: null,
    getInbox: null,
    onSay: null,
    onMacro: null,
    onPlanExecute: null,
    onSmelt: null,
  };

  const session = createBotSession(makeTestConfig({ chatFallbackDelayMs: 25, mcpGraceMs: 90 }), {
    llm: {},
    memory,
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    externalDashboard: fakeDashboard,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('spawn');
    // Simulate active Antigravity polling /api/inbox
    fakeDashboard.getInbox({ sinceId: 0 });

    fakeBot.emit('chat', 'araslime', 'chào bot');
    await new Promise(r => setTimeout(r, 35));
    // Still inside 90ms MCP grace window -> local fallback hasn't fired yet
    assert.equal(fakeBot._chats.length, 0);

    // Antigravity replies via mc_say (/api/say)
    await fakeDashboard.onSay({ message: 'Chào sếp araslime!', instant: true });
    assert.equal(fakeBot._chats.length, 1);

    // Wait well past mcpGraceMs -> local fallback remains cancelled (no double reply!)
    await new Promise(r => setTimeout(r, 110));
    assert.equal(fakeBot._chats.length, 1);
    assert.equal(fakeBot._chats[0], 'Chào sếp araslime!');
  } finally {
    await session.cleanup();
  }
});

test('non-owner LAN player receives friendly greeting once per 60s cooldown', async () => {
  const fakeBot = makeFakeCompanionBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });

  const session = createBotSession(makeTestConfig(), {
    llm: {},
    memory,
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('chat', 'ban_moi', 'hi');
    fakeBot.emit('chat', 'ban_moi', 'alo');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(fakeBot._chats.length, 1);
    assert.match(fakeBot._chats[0], /ban_moi/);
    assert.doesNotMatch(fakeBot._chats[0], /tôi chỉ nghe lệnh/);
  } finally {
    await session.cleanup();
  }
});

test('idle life escorts distant owner, steps back when crowding, picks up nearby items, and honors stayPut', async () => {
  const fakeBot = makeFakeCompanionBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });

  const session = createBotSession(makeTestConfig({ idleLife: true }), {
    llm: {},
    memory,
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('spawn');
    const now0 = Date.now();

    // 1) Owner walks > 6.5 blocks away -> bot escorts using GoalFollow
    fakeBot.players.araslime.entity.position = new Vec3(12, 64, 0);
    await session.companion.tickIdle(now0);
    assert.ok(fakeBot._goals.some(g => g.dynamic === true && g.goal.entity === fakeBot.players.araslime.entity));

    // Owner is close again (<= 4.0) -> escort goal released
    fakeBot.players.araslime.entity.position = new Vec3(3, 64, 0);
    await session.companion.tickIdle(now0 + 1000);

    // 2) Owner crowds bot (< 1.7 blocks) -> polite step back
    fakeBot._goals.length = 0;
    fakeBot.players.araslime.entity.position = new Vec3(1.0, 64, 0);
    await session.companion.tickIdle(now0 + 2000);
    assert.equal(fakeBot._goals.length, 1);
    assert.ok(Math.hypot(fakeBot._goals[0].goal.x - 1.0, fakeBot._goals[0].goal.z) >= 2.0);

    // 3) Nearby loose item dropped away from owner -> bot moves to pick it up
    fakeBot._goals.length = 0;
    fakeBot.players.araslime.entity.position = new Vec3(-4, 64, 0);
    fakeBot.entities[77] = { id: 77, name: 'item', objectType: 'Item', position: new Vec3(4, 64, 0) };
    await session.companion.tickIdle(now0 + 7000);
    assert.equal(fakeBot._goals.length, 1);
    assert.equal(fakeBot._goals[0].goal.x, 4);

    // 4) "đứng đây" sets stayPut = true -> idle movement pauses until "tự do đi" or "theo tôi"
    delete fakeBot.entities[77];
    fakeBot.emit('chat', 'araslime', 'đứng đây');
    await new Promise(r => setTimeout(r, 20));
    fakeBot._goals.length = 0;
    fakeBot.players.araslime.entity.position = new Vec3(15, 64, 0);
    assert.equal(await session.companion.tickIdle(now0 + 9000), false);
    assert.equal(fakeBot._goals.length, 0);

    // "tự do đi" resumes idle autonomy
    fakeBot.emit('chat', 'araslime', 'tự do đi');
    await new Promise(r => setTimeout(r, 45));
    assert.equal(await session.companion.tickIdle(now0 + 11000), true);
    assert.ok(fakeBot._goals.length >= 1);
  } finally {
    await session.cleanup();
  }
});

test('CompanionManager mirrors player tui/ong pronouns and handles urgent rescue calls naturally', async () => {
  const fakeBot = makeFakeCompanionBot();
  const gotos = [];
  fakeBot.pathfinder.goto = async (goal) => { gotos.push(goal); };

  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const inboxState = { seq: 0, items: [] };

  const session = createBotSession(
    {
      ...makeTestConfig(),
      combat: { ...DEFAULT_CONFIG.combat, enabled: false },
    },
    {
      llm: {},
      memory,
      tasks,
      inboxState,
      router: new CommandRouter(),
      createBotFn: () => fakeBot,
      loadPlugins: false,
    }
  );

  try {
    fakeBot.emit('spawn');

    // 1) Pronoun mirroring on conversational activity question
    fakeBot.emit('chat', 'araslime', 'ê ông đang làm gì đó');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(fakeBot._chats.length, 1);
    assert.match(fakeBot._chats[0], /\btui\b/i);
    assert.match(fakeBot._chats[0], /(?:^|\s)ông(?=$|[\s,!?.])/i);

    // 2) Urgent rescue call replies naturally with tui/ông and moves to owner
    fakeBot.emit('chat', 'araslime', 'cứu tui với');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(fakeBot._chats.length, 2);
    assert.match(fakeBot._chats[1], /\btui\b/i);
    assert.match(fakeBot._chats[1], /(?:^|\s)ông(?=$|[\s,!?.])/i);
    assert.ok(gotos.length >= 1);
    assert.equal(gotos[0].x, 3);
    assert.equal(gotos[0].z, 0);
  } finally {
    await session.cleanup();
  }
});
