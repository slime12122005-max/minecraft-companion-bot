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

function keyOf(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

function makeFakeGatherSessionBot({ worldMap = new Map(), initialItems = [], onDigAddInv = null } = {}) {
  const bot = new EventEmitter();
  bot.username = 'bot_dong_hanh';
  bot.version = '1.21.1';
  bot.health = 20;
  bot.food = 20;
  bot.isAlive = true;
  bot.isSleeping = false;
  bot.heldItem = null;
  bot.time = { timeOfDay: 6000, age: 6000 };
  bot.game = { dimension: 'overworld' };
  bot.registry = realRegistry;
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true, velocity: { y: 0 }, yaw: 0, eyeHeight: 1.62, metadata: { 0: 0 } };
  bot.entities = {};
  bot.players = { araslime: { entity: { id: 99, username: 'araslime', position: new Vec3(1.5, 64, 0.5), health: 20 } } };
  bot._chats = [];
  bot._tossed = [];
  const inv = initialItems.map(i => ({ ...i }));

  bot.chat = (m) => bot._chats.push(m);
  bot.whisper = () => {};
  bot.inventory = {
    items: () => inv,
    slots: new Array(46).fill(null),
    emptySlotCount: () => 20,
  };
  bot.findBlocks = ({ matching }) => {
    const idSet = new Set(Array.isArray(matching) ? matching : [matching]);
    return [...worldMap.entries()]
      .filter(([, b]) => idSet.has(b.type))
      .map(([k]) => {
        const [x, y, z] = k.split(',').map(Number);
        return new Vec3(x, y, z);
      })
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
  };
  bot.findBlock = () => null;
  bot.blockAt = (p) => {
    const k = keyOf(p);
    const b = worldMap.get(k);
    if (b) return { position: new Vec3(...k.split(',').map(Number)), boundingBox: 'block', ...b };
    const y = Math.floor(p.y);
    if (y < 64) return { position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), name: 'grass_block', type: 2, boundingBox: 'block' };
    return { position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), name: 'air', type: 0, boundingBox: 'empty' };
  };
  bot.pathfinder = {
    setMovements: () => {},
    setGoal: () => {},
    stop: () => {},
    isMoving: () => false,
    goto: async (goal) => {
      if (goal?.x != null && goal?.z != null) {
        bot.entity.position = new Vec3(Math.floor(goal.x) + 0.5, 64, Math.floor(goal.z) + 0.5);
      }
    },
  };
  bot.dig = async (block) => {
    const k = keyOf(block.position);
    const b = worldMap.get(k);
    if (!b) return;
    worldMap.delete(k);
    const shouldAdd = onDigAddInv ? onDigAddInv(k, b) : true;
    if (shouldAdd) {
      const existing = inv.find(i => i.name === b.name);
      if (existing) existing.count += 1;
      else inv.push({ name: b.name, type: b.type, count: 1, stackSize: 64 });
    }
  };
  bot.toss = async (type, _meta, count) => {
    bot._tossed.push({ type, count });
    let rem = count;
    for (let idx = inv.length - 1; idx >= 0 && rem > 0; idx--) {
      if (inv[idx].type !== type) continue;
      const take = Math.min(rem, inv[idx].count);
      inv[idx].count -= take;
      rem -= take;
      if (inv[idx].count <= 0) inv.splice(idx, 1);
    }
  };
  bot.collectBlock = { collect: async () => {} };
  bot.isABed = () => false;
  bot.parseBedMetadata = () => ({ occupied: false });
  bot.lookAt = async () => {};
  bot.look = async () => {};
  bot.setControlState = () => {};
  bot.clearControlStates = () => {};
  bot.stopDigging = () => {};
  bot.equip = async () => {};
  bot.quit = () => {};
  return { bot, inv };
}

test('indefinite quantifier "chặt 1 ít gỗ đi" asks how many and delivers all >= N whole-tree logs', async () => {
  const birchId = realRegistry.blocksByName.birch_log.id;
  const worldMap = new Map();
  // Two 6-log birch trees -> chopping 2 whole trees yields 12 logs (>= 10 asked)
  for (let y = 64; y <= 69; y++) {
    worldMap.set(`2,${y},0`, { type: birchId, name: 'birch_log' });
    worldMap.set(`10,${y},0`, { type: birchId, name: 'birch_log' });
  }

  const { bot, inv } = makeFakeGatherSessionBot({ worldMap });
  const tasks = new TaskCoordinator({ log: () => {} });
  const session = createBotSession(
    {
      ...DEFAULT_CONFIG,
      dashboard: { enabled: false, host: '127.0.0.1', port: 3000 },
      combat: { ...DEFAULT_CONFIG.combat, enabled: false },
    },
    { llm: {}, memory: new Memory({ autoSaveMs: 0 }), tasks, router: new CommandRouter(), createBotFn: () => bot, loadPlugins: false }
  );
  session.survival._timeouts = { ...session.survival._timeouts, verifyDelayMs: 0, dropWaitMs: 0 };

  try {
    bot.emit('spawn');
    bot.emit('chat', 'araslime', 'chặt 1 ít gỗ đi');
    await new Promise(r => setTimeout(r, 30));

    assert.ok(session.state.pendingQuantity, 'pendingQuantity must be set waiting for answer');
    assert.ok(bot._chats.some(c => /bao nhiêu gỗ/i.test(c)), 'bot must ask how much wood');
    assert.equal(worldMap.size, 12, 'must not start chopping before user specifies count');

    bot.emit('chat', 'araslime', '10');
    await new Promise(r => setTimeout(r, 120));

    assert.equal(session.state.pendingQuantity, null);
    assert.equal(worldMap.size, 0, 'both whole birch trees must be felled');
    const totalDelivered = bot._tossed.reduce((s, t) => s + t.count, 0);
    assert.equal(totalDelivered, 12, 'bot must deliver all 12 logs (>= 10 requested)');
    assert.equal(inv.filter(i => i.name === 'birch_log').length, 0);
    assert.ok(bot._chats.some(c => /Đã lấy và đưa bạn 12 birch_log/.test(c)));
  } finally {
    await session.cleanup();
  }
});

test('survival.gather compensates when some tree drops fail to enter bag until invGained >= requested count', async () => {
  const oakId = realRegistry.blocksByName.oak_log.id;
  const worldMap = new Map();
  // Tree 1: 6 logs (2 drops lost -> 4 enter bag)
  for (let y = 64; y <= 69; y++) worldMap.set(`2,${y},0`, { type: oakId, name: 'oak_log' });
  // Tree 2: 5 logs (all 5 enter bag -> 9 < 10 even though 11 blocks broken)
  for (let y = 64; y <= 68; y++) worldMap.set(`10,${y},0`, { type: oakId, name: 'oak_log' });
  // Tree 3: 4 logs (all 4 enter bag -> 13 >= 10)
  for (let y = 64; y <= 67; y++) worldMap.set(`18,${y},0`, { type: oakId, name: 'oak_log' });

  const { bot, inv } = makeFakeGatherSessionBot({
    worldMap,
    onDigAddInv: (k) => k !== '2,68,0' && k !== '2,69,0', // simulate 2 lost drops on Tree 1
  });
  const session = createBotSession(
    {
      ...DEFAULT_CONFIG,
      dashboard: { enabled: false, host: '127.0.0.1', port: 3000 },
      combat: { ...DEFAULT_CONFIG.combat, enabled: false },
    },
    { llm: {}, memory: new Memory({ autoSaveMs: 0 }), tasks: new TaskCoordinator({ log: () => {} }), router: new CommandRouter(), createBotFn: () => bot, loadPlugins: false }
  );
  session.survival._timeouts = { ...session.survival._timeouts, verifyDelayMs: 0, dropWaitMs: 0 };

  try {
    const got = await session.survival.gather('gỗ', 10);
    assert.equal(got, 13);
    assert.equal(worldMap.size, 0, 'must continue to Tree 3 because only 9 logs actually entered inventory after 2 trees');
    assert.equal(inv.find(i => i.name === 'oak_log')?.count, 13);
  } finally {
    await session.cleanup();
  }
});

test('"đưa tui 1 ít gỗ" -> "tầm 10 cục" tops up inventory shortfall from 3 logs and delivers >= 10', async () => {
  const oakId = realRegistry.blocksByName.oak_log.id;
  const worldMap = new Map();
  // Two 5-log oak trees -> 10 logs available; bag starts with 3 oak_log
  for (let y = 64; y <= 68; y++) {
    worldMap.set(`2,${y},0`, { type: oakId, name: 'oak_log' });
    worldMap.set(`10,${y},0`, { type: oakId, name: 'oak_log' });
  }

  const { bot } = makeFakeGatherSessionBot({
    worldMap,
    initialItems: [{ name: 'oak_log', type: oakId, count: 3, stackSize: 64 }],
  });
  const session = createBotSession(
    {
      ...DEFAULT_CONFIG,
      dashboard: { enabled: false, host: '127.0.0.1', port: 3000 },
      combat: { ...DEFAULT_CONFIG.combat, enabled: false },
    },
    { llm: {}, memory: new Memory({ autoSaveMs: 0 }), tasks: new TaskCoordinator({ log: () => {} }), router: new CommandRouter(), createBotFn: () => bot, loadPlugins: false }
  );
  session.survival._timeouts = { ...session.survival._timeouts, verifyDelayMs: 0, dropWaitMs: 0 };

  try {
    bot.emit('spawn');
    bot.emit('chat', 'araslime', 'đưa tui 1 ít gỗ');
    await new Promise(r => setTimeout(r, 30));
    assert.ok(bot._chats.some(c => /bao nhiêu gỗ/i.test(c)));
    assert.ok(session.state.pendingQuantity);

    bot.emit('chat', 'araslime', 'tầm 10 cục');
    await new Promise(r => setTimeout(r, 120));

    assert.equal(session.state.pendingQuantity, null);
    const totalDelivered = bot._tossed.reduce((s, t) => s + t.count, 0);
    assert.ok(totalDelivered >= 10, `expected >= 10 logs delivered, got ${totalDelivered}`);
    assert.equal(totalDelivered, 13, 'should gather shortfall and deliver all 13 logs (>= 10)');
  } finally {
    await session.cleanup();
  }
});

test('cancelling pendingQuantity with "hủy" or "thôi" clears prompt without chopping blocks', async () => {
  const oakId = realRegistry.blocksByName.oak_log.id;
  const worldMap = new Map([['2,64,0', { type: oakId, name: 'oak_log' }]]);
  const { bot } = makeFakeGatherSessionBot({ worldMap });
  const session = createBotSession(
    {
      ...DEFAULT_CONFIG,
      dashboard: { enabled: false, host: '127.0.0.1', port: 3000 },
      combat: { ...DEFAULT_CONFIG.combat, enabled: false },
    },
    { llm: {}, memory: new Memory({ autoSaveMs: 0 }), tasks: new TaskCoordinator({ log: () => {} }), router: new CommandRouter(), createBotFn: () => bot, loadPlugins: false }
  );

  try {
    bot.emit('spawn');
    bot.emit('chat', 'araslime', 'chặt 1 ít gỗ đi');
    await new Promise(r => setTimeout(r, 25));
    assert.ok(session.state.pendingQuantity);

    bot.emit('chat', 'araslime', 'hủy');
    await new Promise(r => setTimeout(r, 25));
    assert.equal(session.state.pendingQuantity, null);
    assert.equal(worldMap.size, 1);

    bot.emit('chat', 'araslime', 'chặt 1 ít gỗ đi');
    await new Promise(r => setTimeout(r, 25));
    assert.ok(session.state.pendingQuantity);

    bot.emit('chat', 'araslime', 'thôi');
    await new Promise(r => setTimeout(r, 25));
    assert.equal(session.state.pendingQuantity, null);
    assert.equal(worldMap.size, 1);
    assert.ok(bot._chats.some(c => /Đã hủy yêu cầu/.test(c)));
  } finally {
    await session.cleanup();
  }
});

test('"chặt in ít gỗ" pauses active autoFarm, blocks idle autonomy while waiting, asks count, and delivers >= 8 logs', async () => {
  const oakId = realRegistry.blocksByName.oak_log.id;
  const worldMap = new Map();
  // Two 5-log oak trees -> 10 logs total
  for (let y = 64; y <= 68; y++) {
    worldMap.set(`2,${y},0`, { type: oakId, name: 'oak_log' });
    worldMap.set(`10,${y},0`, { type: oakId, name: 'oak_log' });
  }

  const { bot } = makeFakeGatherSessionBot({ worldMap });
  const tasks = new TaskCoordinator({ log: () => {} });
  const session = createBotSession(
    {
      ...DEFAULT_CONFIG,
      dashboard: { enabled: false, host: '127.0.0.1', port: 3000 },
      combat: { ...DEFAULT_CONFIG.combat, enabled: false },
    },
    { llm: {}, memory: new Memory({ autoSaveMs: 0 }), tasks, router: new CommandRouter(), createBotFn: () => bot, loadPlugins: false }
  );
  session.survival._timeouts = { ...session.survival._timeouts, verifyDelayMs: 0, dropWaitMs: 0 };

  try {
    bot.emit('spawn');
    let autoFarmAborted = false;
    tasks.run(
      { name: 'tu_farm_go', autoFarm: true },
      (sig) => new Promise((resolve) => {
        if (sig.aborted) { autoFarmAborted = true; return resolve(); }
        sig.addEventListener('abort', () => { autoFarmAborted = true; resolve(); }, { once: true });
      })
    );

    bot.emit('chat', 'araslime', 'chặt in ít gỗ');
    await new Promise(r => setTimeout(r, 30));

    assert.equal(autoFarmAborted, true, 'background autoFarm must be aborted when waiting for quantity');
    assert.ok(session.state.pendingQuantity, 'pendingQuantity must be set');
    assert.ok(bot._chats.some(c => /bao nhiêu gỗ/i.test(c)));
    assert.equal(await session.companion.tickSurvivalAutonomy(Date.now(), { force: true }), null);
    assert.equal(worldMap.size, 10);

    bot.emit('chat', 'araslime', '8');
    await new Promise(r => setTimeout(r, 120));

    assert.equal(session.state.pendingQuantity, null);
    assert.equal(worldMap.size, 0, 'both whole trees chopped');
    const totalDelivered = bot._tossed.reduce((s, t) => s + t.count, 0);
    assert.ok(totalDelivered >= 8, `expected >= 8 logs delivered, got ${totalDelivered}`);
    assert.equal(totalDelivered, 10);
  } finally {
    await session.cleanup();
  }
});
