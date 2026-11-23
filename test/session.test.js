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

test('session defers unknown natural chat to Antigravity inbox while executing direct commands and remote storageChest', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tossed = [];
  const deposited = [];
  const inboxState = { seq: 0, items: [] };
  let jevCalls = 0;
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
      isAvailable: () => true,
      ask: async () => {
        jevCalls++;
        return { answers: {} };
      },
    },
    memory,
    inboxState,
    tasks: new TaskCoordinator({ log: () => {} }),
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('chat', 'araslime', 'ê đói quá vứt cho tao 3 ổ bánh mì');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(jevCalls, 0);
    assert.deepEqual(tossed, []);
    const deferred = inboxState.items.find(i => i.message.includes('vứt cho tao'));
    assert.equal(deferred?.handledByBot, false);

    fakeBot.emit('chat', 'araslime', 'đưa tôi 3 bánh mì');
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

test('session implements 3-tier Human Brain routing (Tier 0 direct commands, Tier 1 Jev danger alert, Tier 2 Antigravity inbox)', async () => {
  const fakeBot = makeFakeBot();
  fakeBot.findBlocks = () => [];
  fakeBot.dig = async () => {};
  fakeBot.attack = () => {};
  fakeBot.lookAt = async () => {};
  fakeBot.setControlState = () => {};
  fakeBot.clearControlStates = () => {};
  const memory = new Memory({ autoSaveMs: 0 });
  memory.set('home', { x: 0, y: 64, z: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const inboxState = { seq: 0, items: [] };

  let combatCalls = 0;
  let survivalCalls = 0;
  const jevSystem1 = {
    apiKey: 'jev-key',
    isAvailable: () => true,
    chooseCombat: async () => {
      combatCalls++;
      return {
        action: 'retreat',
        confidence: 0.92,
        probabilities: { retreat: 0.92 },
        focus: 'closest_mob',
        danger: 4,
        urgentRetreat: 0.9,
      };
    },
    chooseSurvivalAction: async () => {
      survivalCalls++;
      return {
        action: 'escalate_antigravity',
        confidence: 0.95,
        urgency: 0.95,
        abortTask: 0.9,
      };
    },
  };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: jevSystem1,
    memory,
    tasks,
    inboxState,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('spawn');
    fakeBot.inventory.items = () => [{ name: 'oak_log', count: 6 }];

    // 1) Tier 2: natural language & greetings defer to Antigravity inbox with zero Jev calls and zero spam
    fakeBot.emit('chat', 'araslime', 'chào bot');
    fakeBot.emit('chat', 'araslime', 'bạn thấy sao rồi còn ổn không?');
    fakeBot.emit('chat', 'araslime', 'giúp tôi dọn ruộng xong về nhà nghỉ nhé');
    await new Promise(r => setTimeout(r, 25));
    assert.equal(combatCalls, 0);
    assert.equal(survivalCalls, 0);
    assert.equal(fakeBot._chats.length, 0);
    const deferredMsgs = inboxState.items.filter(i => i.kind === 'chat' && i.handledByBot === false);
    assert.equal(deferredMsgs.length, 3);
    assert.equal(deferredMsgs[0].role, 'OWNER_TRUSTED');

    // 2) Tier 0: direct commands run locally and immediately without calling Jev
    fakeBot.emit('chat', 'araslime', 'đứng đây');
    fakeBot.emit('chat', 'araslime', 'trong túi có gì?');
    await new Promise(r => setTimeout(r, 25));
    assert.ok(fakeBot._chats.some(c => c.includes('đứng yên')));
    assert.ok(fakeBot._chats.some(c => c.includes('oak_log:6')));
    assert.ok(inboxState.items.some(i => i.message === 'đứng đây' && i.handledByBot === true));

    // 3) Tier 1: critical combat danger triggers Jev chooseCombat/chooseSurvivalAction, aborts task, and alerts Antigravity inbox
    tasks.run({ name: 'dao_sat' }, () => new Promise(() => {}));
    fakeBot.health = 10;
    fakeBot.entities = {
      99: { id: 99, type: 'hostile', name: 'zombie', displayName: 'Zombie', position: pos(2, 64, 0), isValid: true },
    };
    await new Promise(r => setTimeout(r, 650));
    assert.ok(combatCalls >= 1);
    assert.ok(survivalCalls >= 1);
    assert.ok(inboxState.items.some(i => i.kind === 'alert'));
    assert.equal(tasks.active, null);
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

test('session handles undefined health status, offline reply logging guard, and defers natural chat to Antigravity inbox', async () => {
  const fakeBot = makeFakeBot();
  fakeBot.health = undefined;
  fakeBot.entity = null;

  const botLogs = [];
  const antigravityLogs = [];
  const mockLogger = {
    scoped: (tag) => (...args) => {
      if (tag === 'bot') botLogs.push(args.join(' '));
      if (tag === 'antigravity') antigravityLogs.push(args.join(' '));
    },
    warn: () => {},
    error: () => {},
    recent: () => [],
  };
  const inboxState = { seq: 0, items: [] };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    logger: mockLogger,
    inboxState,
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

    // 2) Spawned bot defers natural chat to Antigravity inbox without spamming bot.chat()
    fakeBot.entity = { position: pos(0, 64, 0), isValid: true };
    fakeBot.emit('spawn');
    fakeBot.emit('chat', 'araslime', 'hôm nay bạn sao rồi');
    fakeBot.emit('chat', 'araslime', 'vừa nãy mình mới hỏi gì ấy nhỉ?');
    await new Promise(r => setTimeout(r, 20));

    assert.equal(fakeBot._chats.length, 0);
    assert.equal(antigravityLogs.length, 2);
    assert.equal(inboxState.items.filter(i => i.kind === 'chat' && i.handledByBot === false).length, 2);

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
    await new Promise(r => setTimeout(r, 1100));

    assert.equal(attempts, 3);
    assert.equal(tasks.active, null);
    assert.ok(memory.get('lastDeath'));
    assert.ok(fakeBot._chats.some(c => c.includes('quái nguy hiểm')));
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
  const inboxState = { seq: 0, items: [] };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    inboxState,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });
  session.survival._timeouts = { ...session.survival._timeouts, verifyDelayMs: 0, dropWaitMs: 0 };

  try {
    fakeBot.emit('spawn');

    // 1) Natural request defers cleanly to Antigravity inbox without starting heavy work
    fakeBot.emit('chat', 'araslime', 'đề xuất cho tôi đi');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(tasks.active, null);
    assert.equal(fakeBot._chats.length, 0);
    assert.ok(inboxState.items.some(i => i.message === 'đề xuất cho tôi đi' && i.handledByBot === false));

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

test('session cleanup detaches bot listeners, loop guards equipment/emergencyHeal races, and nearby chest commands guard combat/open window', async () => {
  const fakeBot = makeFakeBot();
  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  let openChestCalls = 0;
  let maintainCalls = 0;
  let consumeCalls = 0;
  const chestBlock = { name: 'chest', position: pos(2, 64, 0) };

  fakeBot.health = 6;
  fakeBot.inventory.items = () => [
    { name: 'golden_apple', type: 322, count: 2 },
    { name: 'cobblestone', type: 4, count: 8 },
  ];
  fakeBot.consume = async () => { consumeCalls += 1; };
  fakeBot.findBlock = ({ matching }) => (matching({ name: 'chest' }) ? chestBlock : null);
  fakeBot.openChest = async () => {
    openChestCalls += 1;
    return {
      containerItems: () => [{ name: 'iron_ingot', type: 265, count: 4 }],
      deposit: async () => {},
      withdraw: async () => {},
      close: () => {},
    };
  };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  session.equipment.maintainArmorAndShield = async () => {
    maintainCalls += 1;
  };

  try {
    fakeBot.emit('spawn');

    // 1) Nearby store / take_from_chest refuse while combat.busy or bot.currentWindow is active
    session.combat.busy = true;
    await session.onCommand('cất đồ');
    await session.onCommand('lấy từ rương 2 sắt');
    assert.equal(openChestCalls, 0);
    assert.ok(fakeBot._chats.some(c => c.includes('Đang chiến đấu nên tạm chưa mở rương được')));

    session.combat.busy = false;
    fakeBot._chats.length = 0;
    fakeBot.currentWindow = { id: 1 };
    await session.onCommand('cất đồ');
    await session.onCommand('lấy từ rương 2 sắt');
    assert.equal(openChestCalls, 0);
    assert.ok(fakeBot._chats.some(c => c.includes('Đang mở một cửa sổ khác')));
    fakeBot.currentWindow = null;

    // 2) Loop skips emergencyHeal and maintainArmorAndShield during bowCharging / combat.busy / hazardBusy
    session.combat.config.enabled = false;
    session.combat.busy = true;
    session.combat.bowCharging = true;
    session.survival.hazardBusy = true;
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(maintainCalls, 0);
    assert.equal(consumeCalls, 0);

    // Also direct emergencyHeal skips when hazardBusy is true
    assert.equal(await session.survival.emergencyHeal(), false);
    assert.equal(consumeCalls, 0);

    // Clear guards -> maintenance runs cleanly
    session.combat.busy = false;
    session.combat.bowCharging = false;
    session.survival.hazardBusy = false;
    await new Promise(r => setTimeout(r, 1100));
    assert.ok(maintainCalls >= 1);
    assert.ok(consumeCalls >= 1);

    // 3) cleanup() detaches all bot event listeners and late chat does not trigger commands
    await session.cleanup();
    for (const ev of ['spawn', 'end', 'death', 'entitySleep', 'chat', 'whisper', 'error', 'kicked']) {
      assert.equal(fakeBot.listenerCount(ev), 0, `expected 0 listeners for ${ev}`);
    }
    const chatCountBefore = fakeBot._chats.length;
    fakeBot.emit('chat', 'araslime', 'trạng thái');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(fakeBot._chats.length, chatCountBefore);
  } finally {
    await session.cleanup();
  }
});

test('session honors home.setOnCommand false and building.confirmTerrainChange false config flags', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-cfg-flags-'));
  const bpFile = path.join(dir, 'tiny.json');
  try {
    await fs.writeFile(bpFile, JSON.stringify({
      size: [1, 1, 1],
      blocks: [{ x: 0, y: 0, z: 0, name: 'oak_planks' }],
    }));

    const world = new Map([
      ['2,63,2', { name: 'stone', position: pos(2, 63, 2) }],
      ['2,64,2', { name: 'short_grass', position: pos(2, 64, 2) }],
    ]);

    const fakeBot = makeFakeBot();
    fakeBot.entity.position = pos(0, 64, 0);
    fakeBot.inventory.items = () => [{ name: 'oak_planks', count: 4 }];
    fakeBot.blockAt = (p) => {
      const f = typeof p.floored === 'function' ? p.floored() : pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return world.get(`${f.x},${f.y},${f.z}`) ?? { name: 'air', position: f };
    };
    fakeBot.dig = async (b) => {
      const p = b.position;
      world.delete(`${p.x},${p.y},${p.z}`);
    };
    fakeBot.placeBlock = async (refBlock, face) => {
      const placedPos = refBlock.position.plus(face);
      world.set(`${placedPos.x},${placedPos.y},${placedPos.z}`, { name: 'oak_planks', position: placedPos });
    };

    const memory = new Memory({ autoSaveMs: 0 });
    const existingHome = { x: 100, y: 64, z: -50, dimension: 'overworld', setAt: 1 };
    memory.set('home', existingHome);

    const session = createBotSession({
      ...DEFAULT_CONFIG,
      home: { ...DEFAULT_CONFIG.home, setOnCommand: false },
      building: { ...DEFAULT_CONFIG.building, confirmTerrainChange: false },
    }, {
      llm: {},
      memory,
      tasks: new TaskCoordinator({ log: () => {} }),
      router: new CommandRouter(),
      createBotFn: () => fakeBot,
      loadPlugins: false,
    });

    try {
      // 1) home.setOnCommand === false refuses overwriting saved home
      await session.onCommand('đây là nhà');
      assert.deepEqual(memory.get('home'), existingHome);
      assert.ok(fakeBot._chats.some(c => c.includes('không cho phép đặt nhà bằng lệnh')));

      // 2) building.confirmTerrainChange === false prepares immediately without needing "xác nhận"
      fakeBot._chats.length = 0;
      await session.onCommand(`dọn mặt bằng ${bpFile}`);
      await new Promise(r => setTimeout(r, 40));
      assert.equal(world.get('2,64,2'), undefined);
      assert.equal(session.builder.config.confirmTerrainChange, false);
      assert.ok(fakeBot._chats.some(c => c.includes('Đã dọn mặt bằng xong')));
      assert.ok(!fakeBot._chats.some(c => c.includes('Gõ "xác nhận"')));

      // 3) building.confirmTerrainChange === false builds immediately without needing "xác nhận"
      fakeBot._chats.length = 0;
      await session.onCommand(`xây ${bpFile}`);
      await new Promise(r => setTimeout(r, 40));
      assert.equal(world.get('2,64,2')?.name, 'oak_planks');
      assert.ok(fakeBot._chats.some(c => c.includes('Đã xây xong 1/1 block')));
      assert.ok(!fakeBot._chats.some(c => c.includes('Gõ "xác nhận"')));
    } finally {
      await session.cleanup();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session runs 3-stage watchdog auto-unstuck recovery while sparing stationary follow', async () => {
  const fakeBot = makeFakeBot();
  const controls = [];
  const goalsHistory = [];
  let movingFlag = false;

  fakeBot.setControlState = (k, v) => controls.push([k, v]);
  fakeBot.pathfinder.isMoving = () => movingFlag;
  fakeBot.pathfinder.goal = { tag: 'mine_goal' };
  const origSetGoal = fakeBot.pathfinder.setGoal;

  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const inboxState = { seq: 0, items: [] };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    inboxState,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  let sawBusyDuringRepath = false;
  fakeBot.pathfinder.setGoal = (g, dyn) => {
    if (g === null && session.survival.busy) sawBusyDuringRepath = true;
    goalsHistory.push(g);
    fakeBot.pathfinder.goal = g;
    origSetGoal(g, dyn);
  };

  session.watchdog.stuckThresholdMs = 120;
  session.watchdog.repathThresholdMs = 380;
  session.watchdog.abortThresholdMs = 650;

  try {
    fakeBot.emit('spawn');

    // 1) Stationary follow ("theo_chu") should NOT trigger stuck recovery
    tasks.start({ name: 'theo_chu', owner: 'araslime' }, { onAbort: () => {}, onResume: () => {} });
    await new Promise(r => setTimeout(r, 320));
    assert.equal(session.watchdog.stuck, false);
    assert.equal(tasks.active?.task?.name, 'theo_chu');
    assert.equal(inboxState.items.some(i => i.alertType === 'stuck'), false);
    tasks.abort('switch test');

    // 2) Active moving task stuck at fixed position escalates through stages 1 -> 2 -> 3
    movingFlag = true;
    tasks.run({ name: 'dao_sat' }, () => new Promise(() => {}));

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !inboxState.items.some(i => i.alertType === 'stuck')) {
      await new Promise(r => setTimeout(r, 50));
    }

    assert.ok(controls.some(([k, v]) => k === 'jump' && v === true));
    assert.ok(controls.some(([k, v]) => (k === 'left' || k === 'right') && v === true));
    assert.ok(controls.some(([k, v]) => k === 'back' && v === true));
    assert.equal(sawBusyDuringRepath, true);
    assert.ok(goalsHistory.includes(null));
    assert.equal(tasks.active, null);
    assert.equal(session.watchdog.stuck, false);

    const stuckAlert = inboxState.items.find(i => i.alertType === 'stuck');
    assert.ok(stuckAlert);
    assert.equal(stuckAlert.kind, 'alert');
    assert.equal(stuckAlert.severity, 'high');
    assert.equal(stuckAlert.task, 'dao_sat');
    assert.deepEqual(stuckAlert.position, { x: 0, y: 64, z: 0 });
    assert.ok(memory.recentEvents({ eventType: 'stuck', limit: 5 }).length >= 1);
  } finally {
    await session.cleanup();
  }
});

test('session emits proactive MCP alerts for rare_ore, low_durability, low_food, and low_health with cooldowns', async () => {
  const fakeBot = makeFakeBot();
  fakeBot.health = 5;
  fakeBot.food = 8;
  fakeBot.inventory.items = () => [
    { name: 'iron_pickaxe', slot: 36, maxDurability: 250, durabilityUsed: 240 },
  ];
  fakeBot.findBlocks = () => [pos(5, 12, -3)];
  fakeBot.blockAt = () => ({ name: 'diamond_ore', position: pos(5, 12, -3) });

  const memory = new Memory({ autoSaveMs: 0 });
  const tasks = new TaskCoordinator({ log: () => {} });
  const inboxState = { seq: 0, items: [] };

  const session = createBotSession(DEFAULT_CONFIG, {
    llm: {},
    memory,
    tasks,
    inboxState,
    router: new CommandRouter(),
    createBotFn: () => fakeBot,
    loadPlugins: false,
  });

  try {
    fakeBot.emit('spawn');
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && inboxState.items.filter(i => i.kind === 'alert').length < 4) {
      await new Promise(r => setTimeout(r, 50));
    }

    const alerts = inboxState.items.filter(i => i.kind === 'alert');
    const types = new Set(alerts.map(a => a.alertType));
    assert.ok(types.has('low_health'));
    assert.ok(types.has('rare_ore'));
    assert.ok(types.has('low_durability'));
    assert.ok(types.has('low_food'));

    const oreAlert = alerts.find(a => a.alertType === 'rare_ore');
    assert.equal(oreAlert.ore, 'diamond_ore');
    assert.deepEqual(oreAlert.position, { x: 5, y: 12, z: -3 });

    const pois = memory.queryPois({ category: 'ore_vein' });
    assert.ok(pois.some(p => p.label === 'diamond_ore@5,12,-3'));

    // Next 1s maintenance cycle must NOT spam duplicate low_durability or low_food alerts
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(inboxState.items.filter(i => i.alertType === 'low_durability').length, 1);
    assert.equal(inboxState.items.filter(i => i.alertType === 'low_food').length, 1);
  } finally {
    await session.cleanup();
  }
});
