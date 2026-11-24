import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';

import { createBotSession } from '../src/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Memory } from '../src/memory.js';
import { TaskCoordinator } from '../src/tasks.js';
import { CommandRouter } from '../src/commands.js';
import {
  SurvivalManager,
  evaluateDeathRecovery,
} from '../src/survival/index.js';
import { ITEM_DESPAWN_MS } from '../src/survival/shelter_routine.js';

const require = createRequire(import.meta.url);
const mineflayerPkgPath = require.resolve('mineflayer/package.json');
const mineflayerRequire = createRequire(mineflayerPkgPath);
const prismarineRegistry = mineflayerRequire('prismarine-registry');
const realRegistry = prismarineRegistry('1.21.1');

function pos(x, y, z) {
  return new Vec3(x, y, z);
}

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
  bot.game = { dimension: 'overworld' };
  bot.entity = { position: pos(0, 64, 0), onGround: true, velocity: { y: 0 }, yaw: 0, metadata: { 0: 0 } };
  bot.entities = {};
  bot.players = {
    araslime: { entity: { id: 100, username: 'araslime', position: pos(5, 64, 0), health: 20 } },
  };
  bot.registry = realRegistry;
  bot.inventory = {
    items: () => [],
    slots: new Array(46).fill(null),
    emptySlotCount: () => 20,
  };
  bot._chats = [];
  bot._whispers = [];
  bot._gotos = [];
  bot.chat = (msg) => bot._chats.push(msg);
  bot.whisper = (user, msg) => bot._whispers.push({ user, msg });
  bot.pathfinder = {
    setMovements: () => {},
    setGoal: () => {},
    goto: async (g) => { bot._gotos.push(g); },
    isMoving: () => false,
  };
  bot.blockAt = (p) => (Math.floor(p.y) < 64
    ? { name: 'grass_block', boundingBox: 'block', position: p }
    : { name: 'air', boundingBox: 'empty', position: p });
  bot.findBlock = () => null;
  bot.findBlocks = () => [];
  bot.equip = async () => {};
  bot.lookAt = async () => {};
  bot.attack = async () => {};
  return bot;
}

test('evaluateDeathRecovery & getPendingDeathRecovery enforce distance, travel-vs-despawn, expiry, and dimension', () => {
  const now = 1_000_000;

  // 1. Nearby fresh death (45m away, died right now) -> ok: true
  const nearby = { x: 45, y: 64, z: 0, dimension: 'overworld', diedAt: now - 1000 };
  const okRes = evaluateDeathRecovery(nearby, {
    fromPos: pos(0, 64, 0),
    currentDimension: 'overworld',
    now,
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.reason, null);
  assert.equal(okRes.shouldClear, false);

  // 2. Too-far death (500m > 350m, even if fresh) -> too_far + shouldClear
  const memoryTooFar = new Memory({ autoSaveMs: 0 });
  const survivalTooFar = new SurvivalManager(
    { entity: { position: pos(0, 64, 0) }, blockAt: () => ({ name: 'air' }) },
    { survival: { maxDeathRecoverDistance: 350, itemDespawnMs: ITEM_DESPAWN_MS } },
    { memory: memoryTooFar }
  );
  survivalTooFar.recordDeath({ position: pos(500, 64, 0) }, 'overworld');
  const farRes = survivalTooFar.evaluateDeathRecovery(memoryTooFar.get('lastDeath'));
  assert.equal(farRes.ok, false);
  assert.equal(farRes.reason, 'too_far');
  assert.equal(farRes.shouldClear, true);
  assert.equal(survivalTooFar.getPendingDeathRecovery({ currentDimension: 'overworld' }), null);
  assert.equal(memoryTooFar.get('lastDeath'), undefined);

  // 3. Moderate distance (200m) with 240s elapsed (~60s remaining < ~77s travel + 20s margin) -> will_despawn_on_way
  const memoryRace = new Memory({ autoSaveMs: 0 });
  const survivalRace = new SurvivalManager(
    { entity: { position: pos(0, 64, 0) } },
    {},
    { memory: memoryRace }
  );
  memoryRace.set('lastDeath', { x: 200, y: 64, z: 0, dimension: 'overworld', diedAt: Date.now() - 240_000 });
  const raceEval = evaluateDeathRecovery(memoryRace.get('lastDeath'), {
    fromPos: pos(0, 64, 0),
    currentDimension: 'overworld',
    maxAgeMs: ITEM_DESPAWN_MS,
  });
  assert.equal(raceEval.ok, false);
  assert.equal(raceEval.reason, 'will_despawn_on_way');
  assert.equal(raceEval.shouldClear, true);
  assert.equal(survivalRace.getPendingDeathRecovery({ maxAgeMs: ITEM_DESPAWN_MS }), null);
  assert.equal(memoryRace.get('lastDeath'), undefined);

  // 4. Expired past 5-minute despawn (305s > 300s) -> despawned_time + shouldClear
  const memoryExpired = new Memory({ autoSaveMs: 0 });
  const survivalExpired = new SurvivalManager(
    { entity: { position: pos(10, 64, 0) } },
    {},
    { memory: memoryExpired }
  );
  memoryExpired.set('lastDeath', { x: 10, y: 64, z: 0, dimension: 'overworld', diedAt: Date.now() - 305_000 });
  assert.equal(survivalExpired.getPendingDeathRecovery({ maxAgeMs: ITEM_DESPAWN_MS }), null);
  assert.equal(memoryExpired.get('lastDeath'), undefined);

  // 5. Wrong dimension within 5 minutes -> wrong_dimension but keeps lastDeath (shouldClear: false)
  const memoryDim = new Memory({ autoSaveMs: 0 });
  const survivalDim = new SurvivalManager(
    { entity: { position: pos(0, 64, 0) } },
    {},
    { memory: memoryDim }
  );
  memoryDim.set('lastDeath', { x: 20, y: 64, z: 0, dimension: 'the_nether', diedAt: Date.now() - 10_000 });
  const dimEval = evaluateDeathRecovery(memoryDim.get('lastDeath'), {
    fromPos: pos(0, 64, 0),
    currentDimension: 'overworld',
  });
  assert.equal(dimEval.ok, false);
  assert.equal(dimEval.reason, 'wrong_dimension');
  assert.equal(dimEval.shouldClear, false);
  assert.equal(survivalDim.getPendingDeathRecovery({ currentDimension: 'overworld' }), null);
  assert.ok(memoryDim.get('lastDeath'));
});

test('createBotSession skips too-far death recovery on spawn, clears lastDeath, and rejects late manual recover', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const router = new CommandRouter();
  const testConfig = {
    ...DEFAULT_CONFIG,
    humanizer: { ...DEFAULT_CONFIG.humanizer, enabled: false },
  };

  const session = createBotSession(testConfig, {
    llm: {},
    memory,
    tasks,
    router,
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    // 1. Die far away (500m), respawn at (0, 64, 0)
    fakeBot.entity.position = pos(500, 64, 0);
    fakeBot.emit('death');
    assert.ok(memory.get('lastDeath'));

    fakeBot.entity.position = pos(0, 64, 0);
    fakeBot.emit('spawn');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(fakeBot._gotos.length, 0);
    assert.equal(tasks.active, null);
    assert.equal(memory.get('lastDeath'), undefined);
    assert.ok(
      fakeBot._chats.some(c => c.includes('quá xa') && c.includes('5 phút')),
      `Expected natural 5-minute despawn chat, got: ${JSON.stringify(fakeBot._chats)}`
    );

    // 2. Subsequent manual "nhặt đồ chết" does not pathfind
    fakeBot._chats.length = 0;
    fakeBot.emit('chat', 'araslime', 'nhặt đồ chết');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(fakeBot._gotos.length, 0);
    assert.ok(
      fakeBot._chats.some(c => c.includes('Không có vị trí chết')),
      `Expected no-death reply, got: ${JSON.stringify(fakeBot._chats)}`
    );

    // 3. Manual "nhặt đồ chết" when lastDeath is 6 minutes old rejects & clears lastDeath
    fakeBot._chats.length = 0;
    memory.set('lastDeath', { x: 25, y: 64, z: 0, dimension: 'overworld', diedAt: Date.now() - 360_000 });
    fakeBot.emit('chat', 'araslime', 'nhặt đồ chết');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(fakeBot._gotos.length, 0);
    assert.equal(tasks.active, null);
    assert.equal(memory.get('lastDeath'), undefined);
    assert.ok(
      fakeBot._chats.some(c => c.includes('5 phút') && c.includes('biến mất')),
      `Expected despawned message, got: ${JSON.stringify(fakeBot._chats)}`
    );
  } finally {
    await session.cleanup();
  }
});
