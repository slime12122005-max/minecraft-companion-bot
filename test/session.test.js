import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
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
  bot._goals = [];
  bot._movements = null;
  bot.chat = (msg) => bot._chats.push(msg);
  bot.whisper = (user, msg) => bot._whispers.push({ user, msg });
  bot.pathfinder = {
    setMovements: (m) => { bot._movements = m; },
    setGoal: (goal, dynamic) => bot._goals.push({ goal, dynamic }),
    goto: async () => {},
    isMoving: () => false,
  };
  bot.isABed = (b) => b?.name?.endsWith('_bed');
  bot.parseBedMetadata = (b) => ({ occupied: !!b?.occupied });
  bot.findBlock = () => null;
  bot.sleep = async () => { bot.isSleeping = true; };
  bot.equip = async () => {};
  bot.lookAt = async () => {};
  bot.attack = async () => {};
  bot.toss = async () => {};
  bot.quit = () => {};
  return bot;
}

test('session handles whisper, non-owner cooldown, and follow -> combat pause -> follow resume', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const router = new CommandRouter();

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    router,
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('chat', 'stranger', 'hi');
    fakeBot.emit('chat', 'stranger', 'hi again');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(fakeBot._chats.length, 1);

    fakeBot.emit('whisper', 'araslime', 'trạng thái');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(fakeBot._whispers.length, 1);
    assert.match(fakeBot._whispers[0].msg, /Máu 20\/20/);

    fakeBot.emit('chat', 'araslime', 'theo tôi');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(tasks.active?.task?.name, 'theo_chu');
    const initialGoals = fakeBot._goals.length;

    fakeBot.entities[1] = { id: 1, name: 'zombie', type: 'mob', health: 20, position: pos(8, 64, 0) };
    await session.combat.tick({ owner: 'araslime' });
    assert.equal(session.combat.busy, true);
    assert.equal(tasks.paused, true);

    delete fakeBot.entities[1];
    await session.combat.tick({ owner: 'araslime' });
    assert.equal(session.combat.busy, false);
    assert.equal(tasks.paused, false);
    assert.ok(fakeBot._goals.length > initialGoals);
    assert.equal(fakeBot._goals.at(-1).dynamic, true);
  } finally {
    await session.cleanup();
  }
});

test('session configures 1.21.1 safe Movements, records death, and runs recovery on spawn', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const router = new CommandRouter();

  const gotos = [];
  fakeBot.pathfinder.goto = async (g) => { gotos.push({ x: g.x, y: g.y, z: g.z }); };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    router,
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.entity.position = pos(42, 64, -18);
    fakeBot.emit('death');
    assert.deepEqual(memory.get('lastDeath'), {
      x: 42,
      y: 64,
      z: -18,
      dimension: 'overworld',
      diedAt: memory.get('lastDeath').diedAt,
    });

    fakeBot.entity.position = pos(0, 64, 0);
    fakeBot.emit('spawn');
    await new Promise(r => setTimeout(r, 30));

    assert.ok(fakeBot._movements);
    assert.equal(fakeBot._movements.maxDropDown, 3);
    assert.ok(fakeBot._movements.blocksToAvoid.has(realRegistry.blocksByName.magma_block.id));
    assert.ok(fakeBot._movements.blocksToAvoid.has(realRegistry.blocksByName.campfire.id));
    assert.deepEqual(gotos, [{ x: 42, y: 64, z: -18 }]);
    assert.equal(tasks.active?.task?.name, 'nhat_do_chet');
  } finally {
    await session.cleanup();
  }
});

test('session sleeps in unoccupied 1.21 colored bed when owner sleeps', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const router = new CommandRouter();

  let sleptBed = null;
  fakeBot.findBlock = ({ matching }) => {
    const occupiedBed = { name: 'white_bed', occupied: true, position: pos(2, 64, 0) };
    const freeBed = { name: 'red_bed', occupied: false, position: pos(3, 64, 0) };
    return [occupiedBed, freeBed].find(matching) ?? null;
  };
  fakeBot.sleep = async (b) => { sleptBed = b; fakeBot.isSleeping = true; };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    router,
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('entitySleep', { username: 'araslime' });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(sleptBed?.name, 'red_bed');
    assert.equal(fakeBot.isSleeping, true);
  } finally {
    await session.cleanup();
  }
});

test('gotoSafe retries automatically if interrupted by combat GoalChanged', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const router = new CommandRouter();

  let attempts = 0;
  fakeBot.pathfinder.goto = async () => {
    attempts++;
    if (attempts === 1) {
      tasks.pause();
      setTimeout(() => tasks.resume(), 20);
      const err = new Error('Goal changed');
      err.name = 'GoalChanged';
      throw err;
    }
  };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    router,
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('chat', 'araslime', 'đi tới 50 64 50');
    await new Promise(r => setTimeout(r, 260));
    assert.equal(attempts, 2);
    assert.ok(fakeBot._chats.some(c => c.includes('Đã tới gần 50, 64, 50')));
  } finally {
    await session.cleanup();
  }
});

test('set home + go home runs as task and give resumes follow', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const router = new CommandRouter();

  fakeBot.inventory.items = () => [{ name: 'bread', type: 297, count: 5 }];

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    router,
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('chat', 'araslime', 'theo tôi');
    await new Promise(r => setTimeout(r, 10));
    const goalsBeforeGive = fakeBot._goals.length;

    fakeBot.emit('chat', 'araslime', 'đưa tôi 2 bánh mì');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(fakeBot._chats.some(c => c.includes('Đã đưa bạn 2 bread')));
    assert.ok(fakeBot._goals.length > goalsBeforeGive);
    assert.equal(fakeBot._goals.at(-1).dynamic, true);

    fakeBot.emit('chat', 'araslime', 'đây là nhà');
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(memory.get('home')?.x, 0);

    let arrivedHome = false;
    fakeBot.pathfinder.goto = async (g) => {
      assert.equal(tasks.active?.task?.name, 've_nha');
      assert.equal(g.x, 0);
      arrivedHome = true;
    };
    fakeBot.emit('chat', 'araslime', 'về nhà');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(arrivedHome, true);
    assert.ok(fakeBot._chats.some(c => c.includes('Đã về tới nhà')));
  } finally {
    await session.cleanup();
  }
});

test('Builder end-to-end places blocks with Vec3 on a real schematic object', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-build-'));
  const schemFile = path.join(dir, 'tiny.schem');
  try {
    await fs.writeFile(schemFile, Buffer.from('dummy'));
    const world = new Map([['2,63,2', { name: 'stone', position: pos(2, 63, 2) }]]);
    const fakeBot = makeFakeBot();
    fakeBot.entity.position = pos(0, 64, 0);
    fakeBot.inventory.items = () => [{ name: 'oak_planks', count: 10 }];
    fakeBot.blockAt = (p) => {
      const f = p.floored();
      return world.get(`${f.x},${f.y},${f.z}`) ?? { name: 'air', position: f };
    };
    fakeBot.placeBlock = async (refBlock, face) => {
      const placedPos = refBlock.position.plus(face);
      world.set(`${placedPos.x},${placedPos.y},${placedPos.z}`, { name: 'oak_planks', position: placedPos });
    };

    const memory = new Memory({ autoSaveMs: 0 });
    const session = createBotSession(DEFAULT_CONFIG, {
      llm: {},
      memory,
      tasks: new TaskCoordinator({ log: () => {} }),
      router: new CommandRouter(),
      createBotFn: () => fakeBot,
      loadPlugins: false,
    });

    try {
      session.builder.loadedFile = path.resolve(schemFile);
      session.builder.blueprint = {
        size: { x: 1, y: 1, z: 1 },
        blocks: [{ x: 0, y: 0, z: 0, name: 'oak_planks', properties: {} }],
        materials: { oak_planks: 1 },
      };

      fakeBot.emit('chat', 'araslime', `xây ${schemFile}`);
      await new Promise(r => setTimeout(r, 20));
      assert.ok(fakeBot._chats.some(c => c.includes('xác nhận')));

      fakeBot.emit('chat', 'araslime', 'xác nhận');
      await new Promise(r => setTimeout(r, 30));
      assert.equal(world.get('2,64,2')?.name, 'oak_planks');
      assert.ok(fakeBot._chats.some(c => c.includes('Đã xây xong 1/1 block')));
    } finally {
      await session.cleanup();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session aborts gather cleanly via stop/stay and handles missing chest/bed gracefully', async () => {
  const fakeBot = makeFakeBot();
  let cancelledCollect = false;
  let stoppedDigging = false;
  fakeBot.collectBlock = {
    collect: () => new Promise(() => {}),
    cancelTask: async () => { cancelledCollect = true; },
  };
  fakeBot.stopDigging = () => { stoppedDigging = true; };
  fakeBot.findBlocks = () => [pos(1, 64, 0)];
  fakeBot.blockAt = () => ({ position: pos(1, 64, 0), type: 17, name: 'oak_log' });

  const tasks = new TaskCoordinator({ log: () => {} });
  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory: new Memory({ autoSaveMs: 0 }),
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('chat', 'araslime', 'cất đồ');
    fakeBot.emit('chat', 'araslime', 'ngủ');
    await new Promise(r => setTimeout(r, 15));
    assert.ok(fakeBot._chats.some(c => c.includes('Không thấy rương')));
    assert.ok(fakeBot._chats.some(c => c.includes('Không thấy giường')));

    fakeBot.emit('chat', 'araslime', 'lấy 5 gỗ');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(tasks.active?.task?.name, 'lay_tai_nguyen');

    fakeBot.emit('chat', 'araslime', 'đứng đây');
    await new Promise(r => setTimeout(r, 15));
    assert.equal(cancelledCollect, true);
    assert.equal(stoppedDigging, true);
    assert.equal(tasks.active, null);
    assert.ok(fakeBot._chats.some(c => c.includes('đứng yên đây')));
  } finally {
    await session.cleanup();
  }
});

test('session routes unknown natural chat through Jev intent classifier and supports remote storageChest', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tossed = [];
  const deposited = [];
  fakeBot.toss = async (type, _meta, count) => tossed.push({ type, count });
  fakeBot.inventory.items = () => [
    { name: 'bread', type: 297, count: 10 },
    { name: 'diamond', type: 264, count: 4 },
  ];

  // Saved storage chest far away (at x=20, y=64, z=0)
  const chestBlock = { name: 'chest', position: pos(20, 64, 0) };
  fakeBot.findBlock = () => null; // not within 6 blocks right now
  fakeBot.blockAt = (p) => (p.x === 20 && p.y === 64 && p.z === 0 ? chestBlock : { name: 'air', position: p });
  fakeBot.openChest = async () => ({
    deposit: async (type, _meta, count) => deposited.push({ type, count }),
    close: () => {},
  });

  const cfg = {
    ...DEFAULT_CONFIG,
    home: { ...DEFAULT_CONFIG.home, storageChest: { x: 20, y: 64, z: 0 } },
  };
  const session = createBotSession(cfg, {
    llm: {
      apiKey: 'fake-key',
      ask: async () => ({
        answers: {
          intent: { choice: 'give', confidence: 0.96 },
          resource: { choice: 'banh_mi', confidence: 1 },
        },
      }),
    },
    memory,
    tasks: new TaskCoordinator({ log: () => {} }),
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('chat', 'araslime', 'ê đói quá vứt cho tao 3 ổ bánh mì');
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(tossed, [{ type: 297, count: 3 }]);
    assert.ok(fakeBot._chats.some(c => c.includes('Đã đưa bạn 3 bread')));

    fakeBot.emit('chat', 'araslime', 'cất đồ');
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(deposited, [{ type: 264, count: 4 }]);
    assert.ok(fakeBot._chats.some(c => c.includes('Đã cất đồ dư vào rương nhà')));
  } finally {
    await session.cleanup();
  }
});

test('session handles chest lookup, list_chests, farm, and dashboard toggle', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const chestBlock = { name: 'chest', position: pos(2, 64, 0) };
  const container = [{ name: 'iron_ingot', type: 265, count: 12 }];

  fakeBot.findBlock = ({ matching }) => (matching({ name: 'chest' }) ? chestBlock : null);
  fakeBot.openChest = async () => ({
    containerItems: () => container,
    withdraw: async (_t, _m, amt) => { container[0].count -= amt; },
    close: () => {},
  });
  fakeBot.findBlocks = () => [];
  fakeBot.dig = async () => {};

  const cfg = {
    ...DEFAULT_CONFIG,
    dashboard: { enabled: false, host: '127.0.0.1', port: 0 },
  };
  const session = createBotSession(cfg, {
    llm: {},
    memory,
    tasks: new TaskCoordinator({ log: () => {} }),
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    memory.set('chestIndex', { '2,64,0': { x: 2, y: 64, z: 0, items: { iron_ingot: 12 }, updatedAt: Date.now() } });
    fakeBot.emit('chat', 'araslime', 'xem rương');
    await new Promise(r => setTimeout(r, 15));
    assert.ok(fakeBot._chats.some(c => c.includes('iron_ingot:12')));

    fakeBot.emit('chat', 'araslime', 'lấy từ rương 5 sắt');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(fakeBot._chats.some(c => c.includes('Đã lấy 5 iron_ingot từ rương')));

    fakeBot.emit('chat', 'araslime', 'làm ruộng');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(fakeBot._chats.some(c => c.includes('Đã thu hoạch 0 cây')));

    fakeBot.emit('chat', 'araslime', 'bật web');
    await new Promise(r => setTimeout(r, 30));
    assert.ok(fakeBot._chats.some(c => c.includes('http://127.0.0.1:')));
  } finally {
    await session.cleanup();
  }
});

test('session executes multi-step chain, prepares terrain, and restocks materials from nearby chest before build', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-v04-'));
  const schemFile = path.join(dir, 'hut.schem');
  try {
    await fs.writeFile(schemFile, Buffer.from('dummy'));
    const world = new Map([
      ['2,63,2', { name: 'stone', position: pos(2, 63, 2) }],
      ['2,64,2', { name: 'short_grass', position: pos(2, 64, 2) }],
      ['4,64,0', { name: 'chest', position: pos(4, 64, 0) }],
    ]);
    const container = [{ name: 'oak_planks', type: 5, count: 8 }];
    const botInventory = [];

    const fakeBot = makeFakeBot();
    fakeBot.entity.position = pos(0, 64, 0);
    fakeBot.inventory.items = () => botInventory;
    fakeBot.blockAt = (p) => {
      const f = typeof p.floored === 'function' ? p.floored() : pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return world.get(`${f.x},${f.y},${f.z}`) ?? { name: 'air', position: f };
    };
    fakeBot.findBlocks = () => [];
    fakeBot.dig = async (b) => {
      const p = b.position;
      world.delete(`${p.x},${p.y},${p.z}`);
    };
    fakeBot.placeBlock = async (refBlock, face) => {
      const placedPos = refBlock.position.plus(face);
      world.set(`${placedPos.x},${placedPos.y},${placedPos.z}`, { name: 'oak_planks', position: placedPos });
    };
    fakeBot.openChest = async () => ({
      containerItems: () => container,
      withdraw: async (_type, _meta, amt) => {
        container[0].count -= amt;
        botInventory.push({ name: 'oak_planks', type: 5, count: amt });
      },
      close: () => {},
    });

    const memory = new Memory({ autoSaveMs: 0 });
    memory.set('home', { x: 0, y: 64, z: 0 });
    memory.set('chestIndex', {
      '4,64,0': { x: 4, y: 64, z: 0, items: { oak_planks: 8 }, updatedAt: Date.now() },
    });

    const tasks = new TaskCoordinator({ log: () => {} });
    const session = createBotSession(DEFAULT_CONFIG, {
      llm: {},
      memory,
      tasks,
      router: new CommandRouter(),
      createBotFn: () => fakeBot,
      loadPlugins: false,
    });

    try {
      session.builder.loadedFile = path.resolve(schemFile);
      session.builder.blueprint = {
        size: { x: 1, y: 1, z: 1 },
        blocks: [{ x: 0, y: 0, z: 0, name: 'oak_planks', properties: {} }],
        materials: { oak_planks: 1 },
      };

      // 1. Multi-step chain execution
      fakeBot.emit('chat', 'araslime', 'làm ruộng rồi về nhà');
      await new Promise(r => setTimeout(r, 30));
      assert.ok(fakeBot._chats.some(c => c.includes('Bắt đầu chuỗi 2 bước')));
      assert.ok(fakeBot._chats.some(c => c.includes('Đã thu hoạch 0 cây')));
      assert.ok(fakeBot._chats.some(c => c.includes('Đã về tới nhà')));
      assert.ok(fakeBot._chats.some(c => c.includes('Đã hoàn thành chuỗi nhiệm vụ')));

      // 2. Terrain preparation workflow
      fakeBot.emit('chat', 'araslime', `dọn mặt bằng ${schemFile}`);
      await new Promise(r => setTimeout(r, 20));
      assert.ok(fakeBot._chats.some(c => c.includes('Chuẩn bị dọn mặt bằng')));

      fakeBot.emit('chat', 'araslime', 'xác nhận');
      await new Promise(r => setTimeout(r, 30));
      assert.equal(world.get('2,64,2'), undefined);
      assert.ok(fakeBot._chats.some(c => c.includes('Đã dọn mặt bằng xong')));

      // 3. Auto-restock missing oak_planks from chest within 16 blocks before building
      fakeBot.emit('chat', 'araslime', `xây ${schemFile}`);
      await new Promise(r => setTimeout(r, 20));
      assert.ok(fakeBot._chats.some(c => c.includes('oak_planks:1')));

      fakeBot.emit('chat', 'araslime', 'xác nhận');
      await new Promise(r => setTimeout(r, 40));
      assert.ok(fakeBot._chats.some(c => c.includes('Đã tự lấy thêm 1 vật liệu từ rương gần đây')));
      assert.equal(world.get('2,64,2')?.name, 'oak_planks');
      assert.ok(fakeBot._chats.some(c => c.includes('Đã xây xong 1/1 block')));
    } finally {
      await session.cleanup();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session routes natural chat through System 2 chatLlm while reserving System 1 llm for Jev combat', async () => {
  const fakeBot = makeFakeBot();
  fakeBot.findBlocks = () => [];
  fakeBot.dig = async () => {};
  const memory = new Memory({ autoSaveMs: 0 });
  memory.set('home', { x: 0, y: 64, z: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });

  let jevIntentCalls = 0;
  const jevSystem1 = {
    apiKey: 'jev-key',
    ask: async () => {
      jevIntentCalls++;
      return { model: 'jev-latest', answers: {} };
    },
  };

  const chatPrompts = [];
  const chatSystem2 = {
    provider: 'deepseek',
    isAvailable: () => true,
    interpretChat: async ({ message, botState }) => {
      chatPrompts.push({ message, botState });
      if (message.includes('ổn không')) {
        return { model: 'deepseek-chat', reply: 'Mình vẫn ổn, máu đang 20/20!', commands: [] };
      }
      return {
        model: 'deepseek-chat',
        reply: 'Ok để mình làm ruộng rồi về nhà ngay.',
        commands: ['làm ruộng', 'về nhà'],
      };
    },
  };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: jevSystem1,
    chatLlm: chatSystem2,
    memory,
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('chat', 'araslime', 'bạn thấy sao rồi còn ổn không?');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(jevIntentCalls, 0);
    assert.equal(chatPrompts.length, 1);
    assert.equal(chatPrompts[0].botState.health, 20);
    assert.ok(fakeBot._chats.some(c => c.includes('Mình vẫn ổn, máu đang 20/20!')));

    fakeBot.emit('chat', 'araslime', 'giúp tôi dọn ruộng xong về nhà nghỉ nhé');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(jevIntentCalls, 0);
    assert.ok(fakeBot._chats.some(c => c.includes('Ok để mình làm ruộng rồi về nhà ngay.')));
    assert.ok(fakeBot._chats.some(c => c.includes('Bắt đầu chuỗi 2 bước')));
    assert.ok(fakeBot._chats.some(c => c.includes('Đã về tới nhà')));
    assert.ok(fakeBot._chats.some(c => c.includes('Đã hoàn thành chuỗi nhiệm vụ')));

    fakeBot._chats.length = 0;
    fakeBot.emit('chat', 'araslime', 'làm ruộng ; còn ổn không bạn?');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(jevIntentCalls, 0);
    assert.ok(fakeBot._chats.some(c => c.includes('Mình vẫn ổn, máu đang 20/20!')));
    assert.ok(fakeBot._chats.some(c => c.includes('Đã hoàn thành chuỗi nhiệm vụ')));

    fakeBot._chats.length = 0;
    fakeBot.inventory.items = () => [{ name: 'oak_log', count: 6 }];
    fakeBot.emit('chat', 'araslime', 'chào bot');
    fakeBot.emit('chat', 'araslime', 'trong túi có gì?');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(fakeBot._chats.some(c => c.includes('Chào araslime! Mình đang sẵn sàng')));
    assert.ok(fakeBot._chats.some(c => c.includes('oak_log:6')));
  } finally {
    await session.cleanup();
  }
});

test('createBotSession loads function plugins for pathfinder, collectblock, and tool when loadPlugins is true', async () => {
  const fakeBot = makeFakeBot();
  const loaded = [];
  fakeBot.loadPlugin = (fn) => {
    assert.equal(typeof fn, 'function');
    loaded.push(fn);
  };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory: new Memory({ autoSaveMs: 0 }),
    tasks: new TaskCoordinator({ log: () => {} }),
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: true,
  });

  try {
    assert.equal(loaded.length, 3);
  } finally {
    await session.cleanup();
  }
});

test('session handles combat_off/combat_on, eat, drop_junk, AggregateError logging, and schematic extension guard', async () => {
  const fakeBot = makeFakeBot();
  fakeBot.food = 16;
  const tossed = [];
  const items = [
    { name: 'bread', count: 3, type: 297 },
    { name: 'iron_sword', count: 1, type: 267 },
    { name: 'wooden_sword', count: 1, type: 268 },
  ];
  fakeBot.inventory.items = () => items;
  fakeBot.consume = async () => { fakeBot.food = 20; };
  fakeBot.tossStack = async (item) => { tossed.push(item.name); };

  const loggedErrors = [];
  const mockLogger = {
    scoped: () => () => {},
    warn: () => {},
    error: (tag, ...args) => loggedErrors.push(`[${tag}] ${args.join(' ')}`),
    recent: () => [],
  };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    logger: mockLogger,
    memory: new Memory({ autoSaveMs: 0 }),
    tasks: new TaskCoordinator({ log: () => {} }),
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('chat', 'araslime', 'tắt đánh');
    await new Promise(r => setTimeout(r, 15));
    assert.equal(session.combat.config.enabled, false);
    assert.equal(session.combat.running, false);

    fakeBot.emit('chat', 'araslime', 'bật đánh');
    await new Promise(r => setTimeout(r, 15));
    assert.equal(session.combat.config.enabled, true);
    assert.equal(session.combat.running, true);

    fakeBot.emit('chat', 'araslime', 'ăn');
    await new Promise(r => setTimeout(r, 15));
    assert.equal(fakeBot.food, 20);
    assert.ok(fakeBot._chats.some(c => c.includes('Đã ăn hồi đói')));

    fakeBot.emit('chat', 'araslime', 'dọn túi');
    await new Promise(r => setTimeout(r, 15));
    assert.deepEqual(tossed, ['wooden_sword']);
    assert.ok(fakeBot._chats.some(c => c.includes('wooden_sword')));

    fakeBot.emit('chat', 'araslime', 'tải mẫu https://www.minecraft-schematics.com/a.schem .env');
    await new Promise(r => setTimeout(r, 15));
    assert.ok(fakeBot._chats.some(c => c.includes('.schem')));

    fakeBot.emit('error', new AggregateError([Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })], ''));
    assert.ok(loggedErrors.some(e => e.includes('ECONNREFUSED')));
  } finally {
    await session.cleanup();
  }
});

test('session handles undefined health status, offline reply logging guard, and rolling chatHistory', async () => {
  const fakeBot = makeFakeBot();
  fakeBot.health = undefined;
  fakeBot.entity = null;

  const botLogs = [];
  const mockLogger = {
    scoped: (tag) => (...args) => {
      if (tag === 'bot') botLogs.push(args.join(' '));
    },
    warn: () => {},
    error: () => {},
    recent: () => [],
  };

  const chatCalls = [];
  const fakeChatLlm = {
    provider: 'openrouter',
    model: 'openrouter/free',
    isAvailable: () => true,
    interpretChat: async ({ message, history }) => {
      chatCalls.push({ message, history: history.map(h => ({ ...h })) });
      return { reply: `Đã nghe: ${message}`, commands: [] };
    },
  };

  const session = createBotSession({
    ...DEFAULT_CONFIG,
    chat: { ...DEFAULT_CONFIG.chat, enabled: true, provider: 'openrouter', model: 'openrouter/free' },
  }, {
    llm: {},
    chatLlm: fakeChatLlm,
    logger: mockLogger,
    memory: new Memory({ autoSaveMs: 0 }),
    tasks: new TaskCoordinator({ log: () => {} }),
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    // 1) Pre-spawn / entity=null reply goes to CMD logger instead of bot.chat()
    await session.onCommand('trạng thái');
    assert.equal(fakeBot._chats.length, 0);
    assert.ok(botLogs.some(l => l.includes('Máu 20/20')));
    assert.ok(!botLogs.some(l => l.includes('NaN')));

    // 2) Spawned bot sends in-game chat and passes rolling history to follow-up System 2 turns
    fakeBot.entity = { position: pos(0, 64, 0), isValid: true };
    fakeBot.emit('spawn');
    await session.onCommand('hôm nay bạn sao rồi');
    await session.onCommand('vừa nãy mình mới hỏi gì ấy nhỉ?');

    assert.equal(chatCalls.length, 2);
    assert.deepEqual(chatCalls[0].history, [{ role: 'user', text: 'trạng thái' }]);
    assert.deepEqual(chatCalls[1].history, [
      { role: 'user', text: 'trạng thái' },
      { role: 'user', text: 'hôm nay bạn sao rồi' },
      { role: 'assistant', text: 'Đã nghe: hôm nay bạn sao rồi' },
    ]);

    // 3) After disconnect ('end'), even if entity is still truthy, reply logs via logger instead of bot.chat()
    fakeBot.emit('end');
    const chatCountBeforeEnd = fakeBot._chats.length;
    await session.onCommand('trạng thái');
    assert.equal(fakeBot._chats.length, chatCountBeforeEnd);
    assert.ok(botLogs.filter(l => l.includes('Máu 20/20')).length >= 2);
  } finally {
    await session.cleanup();
  }
});

test('session executes "bạn chặt cây cho tôi" as gather + give chain and tosses chopped wood to owner', async () => {
  const fakeBot = makeFakeBot();
  const oakId = fakeBot.registry.blocksByName.oak_log.id;
  const world = new Map([
    ['1,64,0', { type: oakId, name: 'oak_log' }],
    ['1,65,0', { type: oakId, name: 'oak_log' }],
    ['1,66,0', { type: oakId, name: 'oak_log' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const inv = [];
  const tossed = [];

  fakeBot.findBlocks = () => [...world.keys()].map(k => {
    const [x, y, z] = k.split(',').map(Number);
    return pos(x, y, z);
  });
  fakeBot.blockAt = (p) => {
    const k = keyOf(p);
    const b = world.get(k);
    const [x, y, z] = k.split(',').map(Number);
    return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
  };
  fakeBot.dig = async (block) => {
    world.delete(keyOf(block.position));
    const stack = inv.find(i => i.name === 'oak_log');
    if (stack) stack.count += 1;
    else inv.push({ name: 'oak_log', type: oakId, count: 1 });
  };
  fakeBot.inventory.items = () => inv;
  fakeBot.toss = async (type, _meta, count) => {
    tossed.push({ type, count });
  };
  fakeBot.collectBlock = { collect: async () => {} };

  const tasks = new TaskCoordinator({ log: () => {} });
  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory: new Memory({ autoSaveMs: 0 }),
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });
  session.survival._timeouts = { ...session.survival._timeouts, verifyDelayMs: 0, dropWaitMs: 0 };

  try {
    fakeBot.emit('spawn');
    fakeBot.emit('chat', 'araslime', 'bạn chặt cây cho tôi');
    await new Promise(r => setTimeout(r, 150));

    assert.equal(world.size, 0);
    assert.deepEqual(tossed, [{ type: oakId, count: 3 }]);
    assert.ok(fakeBot._chats.some(c => c.includes('Đã đưa bạn 3 oak_log')));
  } finally {
    await session.cleanup();
  }
});

test('session uses System 2 humanizeReply and interpretChat for greet/ack/chain without robotic boilerplate and falls back on error', async () => {
  const fakeBot = makeFakeBot();
  const oakId = fakeBot.registry.blocksByName.oak_log.id;
  const world = new Map([
    ['1,64,0', { type: oakId, name: 'oak_log' }],
    ['1,65,0', { type: oakId, name: 'oak_log' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const inv = [];
  const tossed = [];

  fakeBot.findBlocks = () => [...world.keys()].map(k => {
    const [x, y, z] = k.split(',').map(Number);
    return pos(x, y, z);
  });
  fakeBot.blockAt = (p) => {
    const k = keyOf(p);
    const b = world.get(k);
    const [x, y, z] = k.split(',').map(Number);
    return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
  };
  fakeBot.dig = async (block) => {
    world.delete(keyOf(block.position));
    const stack = inv.find(i => i.name === 'oak_log');
    if (stack) stack.count += 1;
    else inv.push({ name: 'oak_log', type: oakId, count: 1 });
  };
  fakeBot.inventory.items = () => inv;
  fakeBot.toss = async (type, _meta, count) => { tossed.push({ type, count }); };
  fakeBot.collectBlock = { collect: async () => {} };

  let failHumanize = false;
  const humanCalls = [];
  const chatLlm = {
    provider: 'openrouter',
    isAvailable: () => true,
    interpretChat: async ({ message }) => {
      if (message === 'hi') return { reply: 'Ê chào ông nha, nay chơi gì nè?', commands: [] };
      if (message === 'ok cảm ơn') return { reply: 'Có gì đâu, cần gì cứ ới mình!', commands: [] };
      return { reply: 'Ok nha.', commands: [] };
    },
    humanizeReply: async ({ userMessage, rawEvent }) => {
      humanCalls.push({ userMessage, rawEvent });
      if (failHumanize) throw new Error('rate limited');
      if (rawEvent.includes('Đang bắt đầu')) {
        return { reply: 'Đợi xíu mình ra chặt cây rồi mang gỗ qua liền nha.' };
      }
      if (rawEvent.includes('2 oak_log')) {
        return { reply: 'Xong rồi nè, mình chặt hết với đưa bạn 2 oak_log luôn rồi đó!' };
      }
      return { reply: `Tự nhiên: ${rawEvent}` };
    },
  };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    chatLlm,
    memory: new Memory({ autoSaveMs: 0 }),
    tasks: new TaskCoordinator({ log: () => {} }),
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });
  session.survival._timeouts = { ...session.survival._timeouts, verifyDelayMs: 0, dropWaitMs: 0 };

  try {
    fakeBot.emit('spawn');

    // 1) greet and ack go through chatLlm instead of robotic templates
    fakeBot.emit('chat', 'araslime', 'hi');
    fakeBot.emit('chat', 'araslime', 'ok cảm ơn');
    await new Promise(r => setTimeout(r, 25));
    assert.ok(fakeBot._chats.includes('Ê chào ông nha, nay chơi gì nè?'));
    assert.ok(fakeBot._chats.includes('Có gì đâu, cần gì cứ ới mình!'));
    assert.ok(!fakeBot._chats.some(c => c.includes('Mình đang sẵn sàng')));
    assert.ok(!fakeBot._chats.some(c => c.includes('Không có gì!')));

    // 2) chain suppresses "Bắt đầu chuỗi X bước" & "Đã hoàn thành chuỗi nhiệm vụ", replies naturally
    fakeBot._chats.length = 0;
    fakeBot.emit('chat', 'araslime', 'bạn chặt cây cho tôi');
    await new Promise(r => setTimeout(r, 150));
    assert.equal(world.size, 0);
    assert.deepEqual(tossed, [{ type: oakId, count: 2 }]);
    assert.ok(!fakeBot._chats.some(c => c.includes('Bắt đầu chuỗi')));
    assert.ok(!fakeBot._chats.some(c => c.includes('Đã hoàn thành chuỗi nhiệm vụ')));
    assert.ok(fakeBot._chats.some(c => c.includes('2 oak_log') && c.includes('Xong rồi nè')));

    // 3) error in humanizeReply cleanly falls back to local Vietnamese reply
    fakeBot._chats.length = 0;
    failHumanize = true;
    fakeBot.emit('chat', 'araslime', 'đứng đây');
    await new Promise(r => setTimeout(r, 25));
    assert.ok(fakeBot._chats.some(c => c.includes('Được, tôi đứng yên đây.')));
  } finally {
    await session.cleanup();
  }
});

test('nhat_do_chet stops cleanly after repeated combat interruptions and keeps lastDeath', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  memory.set('lastDeath', { x: 18, y: 75, z: -8, dimension: 'overworld', diedAt: Date.now() });
  const tasks = new TaskCoordinator({ log: () => {} });

  let attempts = 0;
  fakeBot.pathfinder.goto = async () => {
    attempts++;
    tasks.pause();
    setTimeout(() => tasks.resume(), 10);
    const err = new Error('Goal changed');
    err.name = 'GoalChanged';
    throw err;
  };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('spawn');
    await new Promise(r => setTimeout(r, 750));

    assert.equal(attempts, 3);
    assert.equal(tasks.active, null);
    assert.ok(memory.get('lastDeath'));
    assert.ok(fakeBot._chats.some(c => c.includes('quái nguy hiểm')));
  } finally {
    await session.cleanup();
  }
});

test('session exposes home in botState, filters hallucinated waypoints/home from LLM, and drops stale superseded commands', async () => {
  const fakeBot = makeFakeBot();
  let farmed = 0;
  fakeBot.findBlock = () => null;
  fakeBot.findBlocks = () => [];
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });

  const botStates = [];
  let releaseSlowChat = null;
  const slowChatPromise = new Promise(resolve => { releaseSlowChat = resolve; });

  const fakeChatLlm = {
    provider: 'openrouter',
    isAvailable: () => true,
    interpretChat: async ({ message, botState }) => {
      botStates.push({ message, home: botState.home, waypoints: botState.waypoints });
      if (message === 'đề xuất cho tôi đi') {
        return {
          reply: 'Chưa lưu điểm mỏ hay nhà đâu nhé.',
          commands: ['đi tới mỏ', 'về nhà'],
        };
      }
      if (message === 'lệnh chậm bị đè') {
        await slowChatPromise;
        return {
          reply: 'Giờ mới xong nè.',
          commands: ['làm ruộng'],
        };
      }
      return { reply: 'Ok.', commands: [] };
    },
  };

  fakeBot.findBlocks = () => {
    farmed++;
    return [];
  };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    chatLlm: fakeChatLlm,
    memory,
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('spawn');

    // 1) home is null in botState and hallucinated goto_waypoint/go_home are filtered out
    await session.onCommand('đề xuất cho tôi đi');
    assert.equal(botStates[0].home, null);
    assert.deepEqual(botStates[0].waypoints, []);
    assert.equal(tasks.active, null);
    assert.ok(!fakeBot._chats.some(c => c.includes('Chưa có nhà nào được đặt') || c.includes('Không tìm thấy điểm')));

    // Direct user command "về nhà" still preserves clear error when home is unset
    await session.onCommand('về nhà');
    assert.ok(fakeBot._chats.some(c => c.includes('Chưa có nhà nào được đặt')));

    // 2) Slow LLM call superseded by newer chat command drops stale commands
    farmed = 0;
    const p1 = session.onCommand('lệnh chậm bị đè');
    await new Promise(r => setTimeout(r, 10));
    await session.onCommand('đứng đây');
    releaseSlowChat();
    await p1;
    await new Promise(r => setTimeout(r, 20));
    assert.equal(farmed, 0);
    assert.equal(tasks.active, null);
  } finally {
    await session.cleanup();
  }
});

test('session Phase 1 readiness blocks low-food heavy work with confirm/cancel, hard-blocks missing pickaxe, and preserves wood gather', async () => {
  const fakeBot = makeFakeBot();
  const inv = [];
  const world = new Map([
    ['2,64,0', { type: 1, name: 'stone' }],
    ['3,64,0', { type: 1, name: 'stone' }],
    ['4,64,0', { type: 1, name: 'oak_log' }],
    ['4,65,0', { type: 1, name: 'oak_log' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const stoneId = fakeBot.registry.blocksByName.stone.id;
  const oakId = fakeBot.registry.blocksByName.oak_log.id;
  world.get('2,64,0').type = stoneId;
  world.get('3,64,0').type = stoneId;
  world.get('4,64,0').type = oakId;
  world.get('4,65,0').type = oakId;

  fakeBot.inventory.items = () => inv;
  fakeBot.findBlocks = ({ matching }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    return [...world.entries()]
      .filter(([, b]) => ids.includes(b.type))
      .map(([k]) => {
        const [x, y, z] = k.split(',').map(Number);
        return pos(x, y, z);
      });
  };
  fakeBot.findBlock = () => null;
  fakeBot.blockAt = (p) => {
    const k = keyOf(p);
    const b = world.get(k);
    const [x, y, z] = k.split(',').map(Number);
    return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
  };
  fakeBot.dig = async (block) => { world.delete(keyOf(block.position)); };
  fakeBot.collectBlock = {
    collect: async (block) => {
      world.delete(keyOf(block.position));
    },
  };

  const memory = new Memory({ autoSaveMs: 0 });
  memory.set('home', { x: 0, y: 64, z: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const botStates = [];
  const fakeChatLlm = {
    provider: 'openrouter',
    isAvailable: () => true,
    interpretChat: async ({ message, botState }) => {
      botStates.push({ message, readiness: botState.readiness });
      return { reply: 'Mình thấy túi hơi trống.', commands: [] };
    },
  };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    chatLlm: fakeChatLlm,
    memory,
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });
  session.survival._timeouts = { ...session.survival._timeouts, verifyDelayMs: 0, dropWaitMs: 0 };

  try {
    fakeBot.emit('spawn');

    // 1) "đề xuất" passes readiness to LLM snapshot
    await session.onCommand('đề xuất cho tôi đi');
    assert.deepEqual(botStates[0].readiness, {
      foodPoints: 0,
      minFoodPoints: 20,
      foodOk: false,
      pickaxe: 'none',
    });

    // 2) "đào hầm 8" with no pickaxe is hard-blocked; follow-up "xác nhận" has no pending action
    fakeBot._chats.length = 0;
    await session.onCommand('đào hầm 8');
    assert.ok(fakeBot._chats.some(c => c.includes('Chưa có công cụ đủ cấp để đào hầm')));
    fakeBot._chats.length = 0;
    await session.onCommand('xác nhận');
    assert.ok(fakeBot._chats.some(c => c.includes('Không có yêu cầu nào đang chờ xác nhận')));

    // 3) "lấy 5 gỗ" (non-pickaxe target) is NOT blocked even when food=0 and no pickaxe
    fakeBot._chats.length = 0;
    await session.onCommand('lấy 5 gỗ');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(world.has('4,64,0'), false);

    // 4) Give wooden_pickaxe, still 0 food -> "lấy 1 đá" blocks & prompts xác nhận, "hủy" clears it
    inv.push({ name: 'wooden_pickaxe', count: 1 });
    fakeBot._chats.length = 0;
    await session.onCommand('lấy 1 đá');
    assert.equal(tasks.active, null);
    assert.ok(world.has('2,64,0'));
    assert.ok(fakeBot._chats.some(c => c.includes('xác nhận') && c.includes('0/20')));
    await session.onCommand('hủy');
    assert.ok(fakeBot._chats.some(c => c.includes('Đã hủy yêu cầu đang chờ xác nhận')));

    // 5) Re-run "lấy 1 đá" -> confirm -> mines stone
    fakeBot._chats.length = 0;
    await session.onCommand('lấy 1 đá');
    await session.onCommand('xác nhận');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(world.has('2,64,0'), false);

    // 6) Chain "làm ruộng ; lấy 1 đá ; về nhà" pauses at step 2 with remaining steps, then "xác nhận" completes both
    fakeBot._chats.length = 0;
    await session.onCommand('làm ruộng ; lấy 1 đá ; về nhà');
    await new Promise(r => setTimeout(r, 40));
    assert.ok(world.has('3,64,0'));
    assert.ok(fakeBot._chats.some(c => c.includes('xác nhận')));
    assert.ok(!fakeBot._chats.some(c => c.includes('Đã hoàn thành chuỗi nhiệm vụ')));

    await session.onCommand('xác nhận');
    await new Promise(r => setTimeout(r, 60));
    assert.equal(world.has('3,64,0'), false);
    assert.ok(fakeBot._chats.some(c => c.includes('Đã về tới nhà')));
    assert.ok(fakeBot._chats.some(c => c.includes('Đã hoàn thành chuỗi nhiệm vụ')));
  } finally {
    await session.cleanup();
  }
});

test('session survival.requireFood false bypasses food confirmation for pickaxe gather', async () => {
  const fakeBot = makeFakeBot();
  const stoneId = fakeBot.registry.blocksByName.stone.id;
  const world = new Map([['2,64,0', { type: stoneId, name: 'stone' }]]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

  fakeBot.inventory.items = () => [{ name: 'wooden_pickaxe', count: 1 }];
  fakeBot.findBlocks = () => [pos(2, 64, 0)];
  fakeBot.blockAt = (p) => {
    const k = keyOf(p);
    const b = world.get(k);
    const [x, y, z] = k.split(',').map(Number);
    return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
  };
  fakeBot.collectBlock = { collect: async (b) => { world.delete(keyOf(b.position)); } };

  const session = createBotSession({
    ...DEFAULT_CONFIG,
    survival: { requireFood: false, minFoodPoints: 20 },
  }, {
    llm: {},
    memory: new Memory({ autoSaveMs: 0 }),
    tasks: new TaskCoordinator({ log: () => {} }),
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('spawn');
    await session.onCommand('lấy 1 đá');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(world.has('2,64,0'), false);
    assert.ok(!fakeBot._chats.some(c => c.includes('xác nhận')));
  } finally {
    await session.cleanup();
  }
});

test('session cleanup clears queued tasks, survival.busy pauses work, and slow loop skips non-urgent autoEat while digging', async () => {
  const fakeBot = makeFakeBot();
  const tasks = new TaskCoordinator({ log: () => {} });
  const memory = new Memory({ autoSaveMs: 0 });
  const consumed = [];
  fakeBot.inventory.items = () => [{ name: 'bread', count: 5 }];
  fakeBot.consume = async () => consumed.push('eat');
  fakeBot.food = 12; // hungry (<14), non-urgent (>6)
  fakeBot.health = 20;
  fakeBot.targetDigBlock = { name: 'stone' };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('spawn');

    // 1) survival.busy reflects eating & hazardBusy -> mining.isPaused() becomes true
    assert.equal(session.mining.isPaused(), false);
    session.survival.eating = true;
    assert.equal(session.mining.isPaused(), true);
    session.survival.eating = false;
    session.survival.hazardBusy = true;
    assert.equal(session.mining.isPaused(), true);
    session.survival.hazardBusy = false;

    // 2) Non-urgent autoEat does not interrupt active targetDigBlock in 1s maintenance loop
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(consumed.length, 0);

    // Urgent food (<=6) DOES trigger autoEat even while targetDigBlock is set
    fakeBot.food = 6;
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(consumed.length, 1);

    // 3) cleanup() purges queued tasks from shared TaskCoordinator
    tasks.run({ name: 'active_work' }, () => new Promise(() => {}));
    const queued = tasks.schedule({ name: 'queued_work' }, async () => {});
    assert.equal(queued.status, 'queued');
    queued.promise.catch(() => {});
    assert.equal(tasks.status().queued.length, 1);

    await session.cleanup();
    assert.equal(tasks.active, null);
    assert.equal(tasks.status().queued.length, 0);
    await assert.rejects(queued.promise, /Ngắt kết nối/);
  } finally {
    await session.cleanup();
  }
});

test('session classifyIntent fallback drops stale command when a newer chat message arrives', async () => {
  const fakeBot = makeFakeBot();
  const tasks = new TaskCoordinator({ log: () => {} });
  const memory = new Memory({ autoSaveMs: 0 });
  let releaseIntent;
  let farmed = 0;

  const slowJevLlm = {
    apiKey: 'test-key',
    ask: () => new Promise((resolve) => {
      releaseIntent = () => resolve({
        answers: {
          intent: { choice: 'farm', confidence: 0.95 },
          resource: { choice: 'none', confidence: 0.9 },
        },
      });
    }),
  };

  const session = createBotSession({
    ...DEFAULT_CONFIG,
    chat: { ...DEFAULT_CONFIG.chat, enabled: false },
  }, {
    llm: slowJevLlm,
    chatLlm: null,
    memory,
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });
  session.mining.farmCrops = async () => {
    farmed++;
    return { harvested: 0, replanted: 0 };
  };

  try {
    fakeBot.emit('spawn');
    const p1 = session.onCommand('đi kiểm tra ruộng lúa giùm nha');
    await new Promise(r => setTimeout(r, 15));
    await session.onCommand('đứng đây');
    releaseIntent();
    await p1;
    await new Promise(r => setTimeout(r, 20));
    assert.equal(farmed, 0);
    assert.equal(tasks.active, null);
  } finally {
    await session.cleanup();
  }
});
