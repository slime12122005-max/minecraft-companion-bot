import test from 'node:test';
import assert from 'node:assert/strict';
import { SurvivalManager } from '../src/survival.js';
import { Memory } from '../src/memory.js';

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); },
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

test('autoEat equips best food when hungry and consumes it', async () => {
  const calls = [];
  const bread = { name: 'bread', count: 4 };
  const steak = { name: 'cooked_beef', count: 2 };
  const bot = {
    food: 10,
    health: 20,
    inventory: { items: () => [bread, steak] },
    equip: async (item, dest) => calls.push(['equip', item.name, dest]),
    consume: async () => calls.push(['consume']),
  };
  const survival = new SurvivalManager(bot);
  const ate = await survival.autoEat();
  assert.equal(ate, true);
  assert.deepEqual(calls, [['equip', 'cooked_beef', 'hand'], ['consume']]);
});

test('gather finds blocks and collects up to requested count while respecting abort signal', async () => {
  const controller = new AbortController();
  const collected = [];
  const broken = new Set();
  const bot = {
    registry: { blocksByName: { oak_log: { id: 17 } } },
    findBlocks: () => [pos(1, 64, 0), pos(2, 64, 0), pos(3, 64, 0)],
    blockAt: (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (y === 64 && z === 0 && x >= 1 && x <= 3 && !broken.has(x)) {
        return { position: pos(x, y, z), type: 17, name: 'oak_log' };
      }
      return { position: pos(x, y, z), type: 0, name: 'air' };
    },
    collectBlock: {
      collect: async (b) => {
        broken.add(b.position.x);
        collected.push(b.position.x);
        if (collected.length === 2) controller.abort();
      },
    },
  };
  const survival = new SurvivalManager(bot);
  await assert.rejects(survival.gather('gỗ', 5, controller.signal), /hủy/i);
  assert.deepEqual(collected, [1, 2]);
});

test('gather skips blocks with NoPath and collects reachable ones', async () => {
  const broken = new Set();
  const bot = {
    registry: { blocksByName: { oak_log: { id: 17 } } },
    findBlocks: () => [pos(1, 64, 0), pos(2, 64, 0), pos(3, 64, 0)],
    blockAt: (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (y === 64 && z === 0 && x >= 1 && x <= 3 && !broken.has(x)) {
        return { position: pos(x, y, z), type: 17, name: 'oak_log' };
      }
      return { position: pos(x, y, z), type: 0, name: 'air' };
    },
    collectBlock: {
      collect: async (b) => {
        if (b.position.x === 1) {
          const err = new Error('No path');
          err.name = 'NoPath';
          throw err;
        }
        broken.add(b.position.x);
      },
    },
  };
  const survival = new SurvivalManager(bot);
  const got = await survival.gather('gỗ', 2);
  assert.equal(got, 2);
  assert.deepEqual([...broken], [2, 3]);
});

test('giveToOwner tosses across multiple stacks toward owner', async () => {
  const tossed = [];
  const bot = {
    entity: { position: pos(0, 64, 0) },
    players: { araslime: { entity: { position: pos(1, 64, 0) } } },
    inventory: {
      items: () => [
        { name: 'bread', type: 297, count: 6 },
        { name: 'bread', type: 297, count: 6 },
      ],
    },
    lookAt: async () => {},
    toss: async (type, _meta, count) => tossed.push({ type, count }),
  };
  const survival = new SurvivalManager(bot);
  const res = await survival.giveToOwner('araslime', 'bánh mì', 10);
  assert.deepEqual(res, { name: 'bread', count: 10 });
  assert.deepEqual(tossed, [{ type: 297, count: 6 }, { type: 297, count: 4 }]);
});

test('checkAutoReturn returns home at night when idle', async () => {
  let returned = false;
  const bot = {
    time: { timeOfDay: 14000 },
    inventory: { emptySlotCount: () => 10 },
  };
  const home = {
    get: () => ({ x: 0, y: 64, z: 0 }),
    returnHome: async () => { returned = true; return true; },
  };
  const survival = new SurvivalManager(bot, { home: { autoReturn: true } }, { home });
  const res = await survival.checkAutoReturn({ busy: false });
  assert.equal(returned, true);
  assert.equal(res?.triggered, true);
});

test('waypoints save and load from Memory', () => {
  const memory = new Memory({ autoSaveMs: 0 });
  const survival = new SurvivalManager({}, {}, { memory });
  survival.saveWaypoint('Mỏ Sắt', pos(100.2, 12, -45.7));
  assert.deepEqual(survival.getWaypoint('mỏ sắt'), { x: 100, y: 12, z: -46, savedAt: survival.getWaypoint('mỏ sắt').savedAt });
  assert.deepEqual(survival.listWaypoints(), ['mo sat']);
});

test('emergencyHeal uses golden_apple at critical health and handles BigInt NBT safely', async () => {
  const consumed = [];
  const gapple = { name: 'golden_apple', count: 1 };
  const badPotion = { name: 'potion', count: 1, nbt: { id: 1n, Potion: 'minecraft:poison' } };
  const bot = {
    health: 6,
    food: 20,
    entity: { position: pos(0, 64, 0), metadata: { 0: 0 } },
    inventory: { items: () => [badPotion, gapple] },
    equip: async (item) => consumed.push(['equip', item.name]),
    consume: async () => consumed.push(['consume']),
  };
  const survival = new SurvivalManager(bot);
  const ok = await survival.emergencyHeal();
  assert.equal(ok, true);
  assert.deepEqual(consumed, [['equip', 'golden_apple'], ['consume']]);
});

test('handleHazards swims up when drowning and extinguishes fire with water bucket outside Nether', async () => {
  const actions = [];
  const bucket = { name: 'water_bucket', count: 1 };
  const bot = {
    oxygenLevel: 6,
    game: { dimension: 'overworld' },
    entity: { position: pos(0, 64, 0), metadata: { 0: 0x01 }, yaw: 0, isInLava: false },
    inventory: { items: () => [bucket] },
    blockAt: () => ({ name: 'air' }),
    setControlState: (k, v) => actions.push(['ctrl', k, v]),
    equip: async (item, dest) => actions.push(['equip', item.name, dest]),
    look: async () => actions.push(['look']),
    activateItem: (offHand) => actions.push(['activate', offHand]),
  };
  const survival = new SurvivalManager(bot);
  const acted = await survival.handleHazards();
  assert.equal(acted, true);
  assert.deepEqual(actions, [
    ['ctrl', 'jump', true],
    ['equip', 'water_bucket', 'hand'],
    ['look'],
    ['activate', false],
  ]);

  actions.length = 0;
  bot.oxygenLevel = 20;
  bot.entity.metadata[0] = 0;
  await survival.handleHazards();
  assert.deepEqual(actions, [['ctrl', 'jump', false]]);
});

test('recordDeath and getPendingDeathRecovery enforce dimension and expiry window', () => {
  const memory = new Memory({ autoSaveMs: 0 });
  const survival = new SurvivalManager({}, {}, { memory });
  const death = survival.recordDeath({ position: pos(12.4, 64, -8.6) }, 'overworld');
  assert.equal(death.x, 12);
  assert.equal(death.z, -9);

  assert.ok(survival.getPendingDeathRecovery({ currentDimension: 'overworld' }));
  assert.equal(survival.getPendingDeathRecovery({ currentDimension: 'the_nether' }), null);

  memory.set('lastDeath', { ...death, diedAt: Date.now() - 300000 });
  assert.equal(survival.getPendingDeathRecovery({ maxAgeMs: 240000 }), null);
});

test('checkHealthAlerts warns with cooldown for critical bot and owner health', () => {
  const bot = {
    health: 5,
    players: { araslime: { entity: { health: 4 } } },
  };
  const survival = new SurvivalManager(bot);
  const first = survival.checkHealthAlerts({ ownerName: 'araslime' });
  assert.equal(first.length, 2);
  const second = survival.checkHealthAlerts({ ownerName: 'araslime' });
  assert.equal(second.length, 0);
});

test('handleHazards skips water bucket in Nether, digs cobweb, and skips autoEat while sleeping', async () => {
  const actions = [];
  const bot = {
    isSleeping: true,
    food: 5,
    health: 20,
    game: { dimension: 'the_nether' },
    entity: { position: pos(0, 64, 0), metadata: { 0: 0x01 }, isInLava: true, isInWeb: true, isInWater: false },
    inventory: { items: () => [{ name: 'water_bucket', count: 1 }, { name: 'bread', count: 5 }] },
    blockAt: () => ({ name: 'cobweb', position: pos(0, 64, 0) }),
    setControlState: (k, v) => actions.push(['ctrl', k, v]),
    equip: async (item) => actions.push(['equip', item.name]),
    dig: async (b) => actions.push(['dig', b.name]),
    activateItem: () => actions.push(['activate']),
    consume: async () => actions.push(['consume']),
  };

  const survival = new SurvivalManager(bot);
  assert.equal(await survival.autoEat(), false);
  await survival.handleHazards();

  assert.equal(actions.some(a => a[0] === 'equip' && a[1] === 'water_bucket'), false);
  assert.ok(actions.some(a => a[0] === 'dig' && a[1] === 'cobweb'));
  assert.ok(actions.some(a => a[0] === 'ctrl' && a[1] === 'jump' && a[2] === true));
});

test('gather translates NoChests tool error into clear Vietnamese message', async () => {
  const err = Object.assign(new Error('There are no defined chest locations!'), { name: 'NoChests' });
  const bot = {
    registry: { blocksByName: { iron_ore: { id: 15 } } },
    inventory: { items: () => [] },
    findBlocks: () => [pos(2, 64, 0)],
    blockAt: () => ({ name: 'iron_ore', type: 15, position: pos(2, 64, 0) }),
    collectBlock: { collect: async () => { throw err; } },
  };
  const survival = new SurvivalManager(bot);
  await assert.rejects(survival.gather('sắt', 1), /Chưa có công cụ đủ cấp để đào sắt/);
});

test('gather chops an entire connected tree even when logs exceed requested count', async () => {
  // 6-block oak tree (trunk + diagonal top), while a 2nd tree stands 10 blocks away.
  const world = new Map([
    ['2,64,0', { type: 17, name: 'oak_log' }],
    ['2,65,0', { type: 17, name: 'oak_log' }],
    ['2,66,0', { type: 17, name: 'oak_log' }],
    ['2,67,0', { type: 17, name: 'oak_log' }],
    ['3,68,0', { type: 17, name: 'oak_log' }],
    ['3,69,1', { type: 17, name: 'oak_log' }],
    ['15,64,0', { type: 17, name: 'oak_log' }],
    ['15,65,0', { type: 17, name: 'oak_log' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const bot = {
    registry: { blocksByName: { oak_log: { id: 17 } } },
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    collectBlock: {
      collect: async (b) => {
        world.delete(keyOf(b.position));
      },
    },
  };
  const survival = new SurvivalManager(bot);
  const got = await survival.gather('gỗ', 2);
  assert.equal(got, 6);
  // First tree is completely gone; second tree remains untouched.
  assert.deepEqual([...world.keys()], ['15,64,0', '15,65,0']);
});

test('gather chops multiple whole trees until count is met without leaving partial tree', async () => {
  const world = new Map([
    ['2,64,0', { type: 17, name: 'oak_log' }],
    ['2,65,0', { type: 17, name: 'oak_log' }],
    ['2,66,0', { type: 17, name: 'oak_log' }],
    ['10,64,0', { type: 17, name: 'oak_log' }],
    ['10,65,0', { type: 17, name: 'oak_log' }],
    ['10,66,0', { type: 17, name: 'oak_log' }],
    ['10,67,0', { type: 17, name: 'oak_log' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const bot = {
    registry: { blocksByName: { oak_log: { id: 17 } } },
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    collectBlock: {
      collect: async (b) => {
        world.delete(keyOf(b.position));
      },
    },
  };
  const survival = new SurvivalManager(bot);
  const got = await survival.gather('gỗ', 5);
  assert.equal(got, 7);
  assert.equal(world.size, 0);
});

test('gather clears obstructing leaves and directly digs elevated acacia branches when collectBlock cannot reach dy>=3', async () => {
  // Simulates an acacia tree with bottom trunk, diagonal upper branches (dy=3..5), and leaves underneath.
  const world = new Map([
    ['5,64,0', { type: 162, name: 'acacia_log' }],
    ['5,65,0', { type: 162, name: 'acacia_log' }],
    ['6,66,0', { type: 162, name: 'acacia_log' }],
    ['6,67,0', { type: 162, name: 'acacia_log' }],
    ['7,68,1', { type: 162, name: 'acacia_log' }],
    ['7,69,1', { type: 162, name: 'acacia_log' }],
    ['7,68,0', { type: 161, name: 'acacia_leaves' }],
    ['7,67,1', { type: 161, name: 'acacia_leaves' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const dug = [];
  const collectBlockCalls = [];

  const bot = {
    entity: { position: pos(0, 64, 0), eyeHeight: 1.62 },
    registry: { blocksByName: { acacia_log: { id: 162 } } },
    inventory: { emptySlotCount: () => 10, items: () => [] },
    entities: {},
    world: {
      raycast: (origin, dir, maxDist) => {
        // Simple step raycast to detect leaf obstruction before target log
        for (let t = 0.25; t <= maxDist; t += 0.25) {
          const rx = Math.floor(origin.x + dir.x * t);
          const ry = Math.floor(origin.y + dir.y * t);
          const rz = Math.floor(origin.z + dir.z * t);
          const hit = world.get(`${rx},${ry},${rz}`);
          if (hit) return { position: pos(rx, ry, rz) };
        }
        return null;
      },
    },
    findBlocks: () => [...world.entries()]
      .filter(([, b]) => b.type === 162)
      .map(([k]) => {
        const [x, y, z] = k.split(',').map(Number);
        return pos(x, y, z);
      }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    pathfinder: {
      goto: async (goal) => {
        if (goal.x != null && goal.z != null) {
          bot.entity.position = pos(goal.x + 0.5, 64, goal.z + 0.5);
        }
      },
    },
    dig: async (block) => {
      dug.push(block.name);
      world.delete(keyOf(block.position));
    },
    collectBlock: {
      collect: async (b) => {
        collectBlockCalls.push(keyOf(b.position));
        // Simulate mineflayer-pathfinder GoalLookAtBlock bug: fails for y >= ground + 3
        if (b.position.y >= 67) {
          const err = new Error('No path');
          err.name = 'NoPath';
          throw err;
        }
        bot.entity.position = pos(b.position.x + 0.5, 64, b.position.z + 0.5);
        world.delete(keyOf(b.position));
      },
    },
  };

  const survival = new SurvivalManager(bot);
  const got = await survival.gather('gỗ', 2);
  assert.equal(got, 6);
  // All 6 acacia logs chopped (none left floating)
  const remainingLogs = [...world.values()].filter(b => b.type === 162);
  assert.equal(remainingLogs.length, 0);
  // Obstructing acacia_leaves were cleared via dig before digging upper branch
  assert.ok(dug.includes('acacia_leaves'));
});

test('gather pauses mid-tree on combat GoalChanged and finishes the remaining logs after resume', async () => {
  const world = new Map([
    ['2,64,0', { type: 17, name: 'oak_log' }],
    ['2,65,0', { type: 17, name: 'oak_log' }],
    ['2,66,0', { type: 17, name: 'oak_log' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  let paused = false;
  let triggeredPause = false;
  const bot = {
    registry: { blocksByName: { oak_log: { id: 17 } } },
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    collectBlock: {
      collect: async (b) => {
        if (!triggeredPause && b.position.y === 65) {
          triggeredPause = true;
          paused = true;
          setTimeout(() => { paused = false; }, 30);
          const err = new Error('Goal changed');
          err.name = 'GoalChanged';
          throw err;
        }
        world.delete(keyOf(b.position));
      },
    },
  };
  const survival = new SurvivalManager(bot);
  const got = await survival.gather('gỗ', 1, null, { isPaused: () => paused });
  assert.equal(got, 3);
  assert.equal(world.size, 0);
});

test('gather for non-tree stone still stops at requested count', async () => {
  const world = new Map([
    ['2,64,0', { type: 1, name: 'stone' }],
    ['3,64,0', { type: 1, name: 'stone' }],
    ['4,64,0', { type: 1, name: 'stone' }],
    ['5,64,0', { type: 1, name: 'stone' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const bot = {
    registry: { blocksByName: { stone: { id: 1 } } },
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    collectBlock: {
      collect: async (b) => {
        world.delete(keyOf(b.position));
      },
    },
  };
  const survival = new SurvivalManager(bot);
  const got = await survival.gather('đá', 2);
  assert.equal(got, 2);
  assert.equal(world.size, 2);
});

test('gather recovers when pathfinder.goto hangs/stalls on unreachable tree and moves to next tree', async () => {
  const world = new Map([
    ['20,64,0', { type: 17, name: 'oak_log' }], // far stuck tree
    ['2,64,0', { type: 17, name: 'oak_log' }],  // already within dig reach
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  let stoppedCount = 0;

  const bot = {
    entity: { position: pos(0, 64, 0), eyeHeight: 1.62 },
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { emptySlotCount: () => 10, items: () => [] },
    entities: {},
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    pathfinder: {
      setGoal: () => {},
      stop: () => { stoppedCount++; },
      goto: () => new Promise(() => {}), // hangs forever while bot stays still
    },
    dig: async (block) => {
      world.delete(keyOf(block.position));
    },
    collectBlock: {
      collect: async () => { throw new Error('collectBlock should not be called'); },
    },
  };

  const survival = new SurvivalManager(bot);
  survival._timeouts = { ...survival._timeouts, gotoMs: 80, stuckMs: 40 };
  const got = await survival.gather('gỗ', 1);
  assert.equal(got, 1);
  assert.ok(stoppedCount >= 1);
  assert.equal(world.has('2,64,0'), false);
});

test('gather recovers when bot.dig hangs on a block without unhandled rejection', async () => {
  const world = new Map([
    ['2,64,0', { type: 17, name: 'oak_log' }],
    ['2,65,0', { type: 17, name: 'oak_log' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  let stopDiggingCalls = 0;

  const bot = {
    entity: { position: pos(0, 64, 0), eyeHeight: 1.62 },
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { emptySlotCount: () => 10, items: () => [] },
    entities: {},
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    pathfinder: {
      setGoal: () => {},
      stop: () => {},
      goto: async () => {},
    },
    digTime: () => 50,
    stopDigging: () => { stopDiggingCalls++; },
    dig: async (block) => {
      if (block.position.y === 64) {
        return new Promise(() => {}); // hangs indefinitely on first log
      }
      world.delete(keyOf(block.position));
    },
    collectBlock: {
      collect: async () => {},
    },
  };

  const survival = new SurvivalManager(bot);
  survival._timeouts = { ...survival._timeouts, digExtraMs: 30, digMinMs: 40, digMaxMs: 80 };
  const got = await survival.gather('gỗ', 1);
  assert.equal(got, 1);
  assert.ok(stopDiggingCalls >= 1);
  assert.equal(world.has('2,65,0'), false);
});

test('gather recovers when collectBlock.collect hangs on non-tree target (waitForPickup hang)', async () => {
  const world = new Map([
    ['2,64,0', { type: 1, name: 'stone' }],
    ['3,64,0', { type: 1, name: 'stone' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  let clearedTargets = false;
  let cancelledTask = false;

  const bot = {
    registry: { blocksByName: { stone: { id: 1 } } },
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    collectBlock: {
      targets: { clear: () => { clearedTargets = true; } },
      cancelTask: async () => { cancelledTask = true; },
      collect: async (b) => {
        if (b.position.x === 2) {
          return new Promise(() => {}); // simulates waitForPickup never resolving
        }
        world.delete(keyOf(b.position));
      },
    },
  };

  const survival = new SurvivalManager(bot);
  survival._timeouts = { ...survival._timeouts, collectMs: 40 };
  const got = await survival.gather('đá', 1);
  assert.equal(got, 1);
  assert.equal(clearedTargets, true);
  assert.equal(cancelledTask, true);
  assert.equal(world.has('3,64,0'), false);
});

test('direct tree chopping bypasses collectBlock.collect and uses bottom digFace for overhead logs', async () => {
  const world = new Map([
    ['2,64,0', { type: 17, name: 'oak_log' }],
    ['2,68,0', { type: 17, name: 'oak_log' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  let collectBlockCalls = 0;
  const digCalls = [];

  const bot = {
    entity: { position: pos(2.5, 64, 0.5), eyeHeight: 1.62 },
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { emptySlotCount: () => 10, items: () => [] },
    entities: {},
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    pathfinder: {
      setGoal: () => {},
      stop: () => {},
      goto: async () => {},
    },
    dig: async (block, forceLook, digFace) => {
      digCalls.push({ y: block.position.y, forceLook, digFace });
      world.delete(keyOf(block.position));
    },
    collectBlock: {
      collect: async () => { collectBlockCalls++; },
    },
  };

  // Connect the two logs vertically via intermediate trunk logs
  world.set('2,65,0', { type: 17, name: 'oak_log' });
  world.set('2,66,0', { type: 17, name: 'oak_log' });
  world.set('2,67,0', { type: 17, name: 'oak_log' });

  const survival = new SurvivalManager(bot);
  const got = await survival.gather('gỗ', 2);
  assert.equal(got, 5);
  assert.equal(collectBlockCalls, 0);
  const overheadCall = digCalls.find(c => c.y === 68);
  assert.ok(overheadCall);
  assert.equal(overheadCall.forceLook, true);
  assert.equal(overheadCall.digFace.y, -1);
});

test('gather re-scans locked tree when an upper log ghost-breaks before touching second tree', async () => {
  const world = new Map([
    ['2,64,0', { type: 17, name: 'oak_log' }],
    ['2,65,0', { type: 17, name: 'oak_log' }],
    ['2,66,0', { type: 17, name: 'oak_log' }],
    ['15,64,0', { type: 17, name: 'oak_log' }],
    ['15,65,0', { type: 17, name: 'oak_log' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  let topGhostRejected = false;
  const order = [];

  const bot = {
    entity: { position: pos(2.5, 64, 0.5), eyeHeight: 1.62 },
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { emptySlotCount: () => 10, items: () => [] },
    entities: {},
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    pathfinder: { setGoal: () => {}, stop: () => {}, goto: async () => {} },
    dig: async (block) => {
      const k = keyOf(block.position);
      order.push(k);
      if (k === '2,66,0' && !topGhostRejected) {
        // Simulates server reject / block snap-back before verifyDelayMs expires
        topGhostRejected = true;
        return;
      }
      world.delete(k);
    },
    collectBlock: { collect: async () => {} },
  };

  const survival = new SurvivalManager(bot);
  survival._timeouts = { ...survival._timeouts, verifyDelayMs: 5, dropWaitMs: 0 };
  const got = await survival.gather('gỗ', 2);
  assert.equal(got, 3);
  assert.deepEqual(order, ['2,64,0', '2,65,0', '2,66,0', '2,66,0']);
  assert.deepEqual([...world.keys()], ['15,64,0', '15,65,0']);
});

test('gather re-scans detached upper branch within same tree bounds before moving to next tree', async () => {
  const world = new Map([
    ['2,64,0', { type: 17, name: 'oak_log' }],
    ['2,65,0', { type: 17, name: 'oak_log' }],
    // Upper branch 2 blocks higher (gap at y=66) within same tree bounds
    ['3,67,0', { type: 17, name: 'oak_log' }],
    ['15,64,0', { type: 17, name: 'oak_log' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

  const bot = {
    entity: { position: pos(2.5, 64, 0.5), eyeHeight: 1.62 },
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { emptySlotCount: () => 10, items: () => [] },
    entities: {},
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    pathfinder: { setGoal: () => {}, stop: () => {}, goto: async () => {} },
    dig: async (block) => { world.delete(keyOf(block.position)); },
    collectBlock: { collect: async () => {} },
  };

  const survival = new SurvivalManager(bot);
  survival._timeouts = { ...survival._timeouts, verifyDelayMs: 0, dropWaitMs: 0 };
  const got = await survival.gather('gỗ', 1);
  assert.equal(got, 3);
  assert.deepEqual([...world.keys()], ['15,64,0']);
});

test('giveToOwner with count all tosses all matching wood stacks across log species', async () => {
  const tossed = [];
  const bot = {
    entity: { position: pos(0, 64, 0) },
    players: { araslime: { entity: { position: pos(1, 64, 0) } } },
    inventory: {
      items: () => [
        { name: 'oak_log', type: 17, count: 5 },
        { name: 'acacia_log', type: 162, count: 7 },
      ],
    },
    lookAt: async () => {},
    toss: async (type, _meta, count) => tossed.push({ type, count }),
  };
  const survival = new SurvivalManager(bot);
  const res = await survival.giveToOwner('araslime', 'gỗ', 'all');
  assert.deepEqual(res, { name: 'oak_log', count: 12 });
  assert.deepEqual(tossed, [{ type: 17, count: 5 }, { type: 162, count: 7 }]);
});

test('gather fast-fails without calling collectBlock when required pickaxe tier is missing', async () => {
  let collectCalls = 0;
  const bot = {
    registry: { blocksByName: { iron_ore: { id: 15 } } },
    inventory: { items: () => [{ name: 'wooden_pickaxe', count: 1 }] },
    findBlocks: () => [pos(2, 64, 0)],
    blockAt: () => ({ name: 'iron_ore', type: 15, position: pos(2, 64, 0) }),
    collectBlock: { collect: async () => { collectCalls++; } },
  };
  const survival = new SurvivalManager(bot);
  await assert.rejects(survival.gather('sắt', 8), /Chưa có công cụ đủ cấp để đào sắt.*cuốc đá/);
  assert.equal(collectCalls, 0);
});

test('gather stops cleanly after 2 consecutive Timeouts on unreachable ore blocks', async () => {
  const world = new Map([
    ['2,64,0', { type: 1, name: 'stone' }],
    ['3,64,0', { type: 1, name: 'stone' }],
    ['4,64,0', { type: 1, name: 'stone' }],
    ['5,64,0', { type: 1, name: 'stone' }],
  ]);
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  let collectAttempts = 0;

  const bot = {
    registry: { blocksByName: { stone: { id: 1 } } },
    findBlocks: () => [...world.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = world.get(k);
      const [x, y, z] = k.split(',').map(Number);
      return b ? { position: pos(x, y, z), ...b } : { position: pos(x, y, z), type: 0, name: 'air' };
    },
    collectBlock: {
      collect: async () => {
        collectAttempts++;
        const err = new Error('Timeout');
        err.name = 'Timeout';
        throw err;
      },
    },
  };

  const survival = new SurvivalManager(bot);
  const got = await survival.gather('đá', 4);
  assert.equal(got, 0);
  assert.equal(collectAttempts, 2);
});

test('ensurePickaxe auto-crafts missing pickaxe tier when materials exist and returns false otherwise', async () => {
  const inv = [];
  const crafted = [];
  const bot = {
    inventory: { items: () => inv },
  };
  const crafting = {
    craftItem: async (name) => {
      crafted.push(name);
      if (name === 'cuốc gỗ') inv.push({ name: 'wooden_pickaxe', count: 1 });
      else throw new Error('Thiếu nguyên liệu');
    },
  };

  const survival = new SurvivalManager(bot, {}, { crafting });
  assert.equal(await survival.ensurePickaxe('wood'), true);
  assert.deepEqual(crafted, ['cuốc gỗ']);
  assert.equal(await survival.ensurePickaxe('stone'), false);
});

test('handleHazards escapes suffocating gravel at head with shovel and resets survival.busy', async () => {
  const actions = [];
  const headPos = pos(0, 65, 0);
  let headCleared = false;
  let busyDuringDig = null;

  const bot = {
    oxygenLevel: 20,
    isSleeping: false,
    game: { dimension: 'overworld' },
    entity: { position: pos(0, 64, 0), metadata: { 0: 0 } },
    inventory: { items: () => [{ name: 'iron_shovel', count: 1 }] },
    blockAt: (p) => {
      if (!headCleared && Math.floor(p.y) === 65) {
        return { name: 'gravel', boundingBox: 'block', diggable: true, position: headPos };
      }
      return { name: 'air', boundingBox: 'empty', position: p };
    },
    equip: async (item, dest) => actions.push(['equip', item.name, dest]),
    dig: async (b) => {
      busyDuringDig = survival.busy;
      actions.push(['dig', b.name]);
      headCleared = true;
    },
  };

  const survival = new SurvivalManager(bot);
  const acted = await survival.handleHazards();
  assert.equal(acted, true);
  assert.equal(busyDuringDig, true);
  assert.equal(survival.busy, false);
  assert.deepEqual(actions, [['equip', 'iron_shovel', 'hand'], ['dig', 'gravel']]);
});

test('gather skips blocks adjacent to lava, stops on mid-gather pickaxe breakage, and stops when inventory is full', async () => {
  // 1) Adjacent lava skip
  const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const lavaWorld = new Map([
    ['2,64,0', { type: 1, name: 'stone' }],
    ['2,64,1', { type: 11, name: 'lava' }],
    ['4,64,0', { type: 1, name: 'stone' }],
  ]);
  const collectedPos = [];
  const lavaBot = {
    registry: { blocksByName: { stone: { id: 1 } } },
    inventory: { items: () => [{ name: 'wooden_pickaxe', count: 1 }], emptySlotCount: () => 5 },
    findBlocks: () => [pos(2, 64, 0), pos(4, 64, 0)],
    blockAt: (p) => {
      const k = keyOf(p);
      const b = lavaWorld.get(k);
      return b ? { ...b, position: p } : { type: 0, name: 'air', position: p };
    },
    collectBlock: {
      collect: async (b) => {
        collectedPos.push(b.position.x);
        lavaWorld.delete(keyOf(b.position));
      },
    },
  };
  const s1 = new SurvivalManager(lavaBot);
  assert.equal(await s1.gather('đá', 2), 1);
  assert.deepEqual(collectedPos, [4]);

  // 2) Mid-gather pickaxe breakage stops after collecting 1st block
  const pickWorld = new Map([
    ['2,64,0', { type: 1, name: 'stone' }],
    ['3,64,0', { type: 1, name: 'stone' }],
  ]);
  let pickInv = [{ name: 'wooden_pickaxe', count: 1 }];
  const pickBot = {
    registry: { blocksByName: { stone: { id: 1 } } },
    inventory: { items: () => pickInv, emptySlotCount: () => 5 },
    findBlocks: () => [...pickWorld.keys()].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return pos(x, y, z);
    }),
    blockAt: (p) => {
      const k = keyOf(p);
      const b = pickWorld.get(k);
      return b ? { ...b, position: p } : { type: 0, name: 'air', position: p };
    },
    collectBlock: {
      collect: async (b) => {
        pickWorld.delete(keyOf(b.position));
        pickInv = [];
      },
    },
  };
  const s2 = new SurvivalManager(pickBot);
  assert.equal(await s2.gather('đá', 2), 1);

  // 3) Full inventory with no matching partial stack stops immediately
  let fullCollectCalls = 0;
  const fullBot = {
    registry: { blocksByName: { stone: { id: 1 } } },
    inventory: {
      emptySlotCount: () => 0,
      items: () => [
        { name: 'wooden_pickaxe', count: 1, stackSize: 1 },
        { name: 'dirt', count: 64, stackSize: 64 },
      ],
    },
    findBlocks: () => [pos(2, 64, 0)],
    blockAt: (p) => ({ type: 1, name: 'stone', position: p }),
    collectBlock: { collect: async () => { fullCollectCalls++; } },
  };
  const s3 = new SurvivalManager(fullBot);
  assert.equal(await s3.gather('đá', 2), 0);
  assert.equal(fullCollectCalls, 0);
});
