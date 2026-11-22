import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeManager, classifyItemCategory } from '../src/home.js';
import { Memory } from '../src/memory.js';

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

test('returnHome sets GoalNear without throwing constructor error', async () => {
  let goalSet = null;
  const bot = {
    pathfinder: { setGoal: (g) => { goalSet = g; } },
  };
  const memory = new Memory({ autoSaveMs: 0 });
  const home = new HomeManager(bot, {}, { memory, log: () => {} });

  home.set({ position: pos(10.4, 64, -20.2), dimension: 'overworld' });
  const ok = await home.returnHome();
  assert.equal(ok, true);
  assert.equal(goalSet.x, 10);
  assert.equal(goalSet.y, 64);
  assert.equal(goalSet.z, -20);
});

test('storeSurplus opens chest block, keeps weapons/armor/food, deposits surplus, and closes chest', async () => {
  const invItems = [
    { name: 'iron_sword', type: 1, count: 1 },
    { name: 'iron_helmet', type: 2, count: 1 },
    { name: 'bread', type: 3, count: 20 },
    { name: 'cobblestone', type: 4, count: 64 },
  ];
  const deposited = [];
  let closed = false;

  const bot = {
    entity: { position: pos(0, 64, 0) },
    inventory: { items: () => invItems },
    openChest: async () => ({
      deposit: async (type, _meta, count) => {
        deposited.push({ type, count });
      },
      close: () => { closed = true; },
    }),
  };

  const home = new HomeManager(bot, { inventory: { keepFood: 16, blockStacks: 0 } }, { log: () => {} });
  const chestBlock = { name: 'chest', position: pos(1, 64, 0) };
  const ok = await home.storeSurplus(chestBlock);

  assert.equal(ok, true);
  assert.equal(closed, true);
  assert.deepEqual(deposited, [
    { type: 3, count: 4 },
    { type: 4, count: 64 },
  ]);
});

test('storeSurplus honors inventory.blockStacks and storageChest persistence', async () => {
  const memory = new Memory({ autoSaveMs: 0 });
  const deposited = [];
  const bot = {
    entity: { position: pos(0, 64, 0) },
    inventory: {
      items: () => [
        { name: 'cobblestone', type: 4, count: 64 },
        { name: 'cobblestone', type: 4, count: 32 },
      ],
    },
    openChest: async () => ({
      deposit: async (type, _meta, count) => deposited.push({ type, count }),
      close: () => {},
    }),
  };

  const home = new HomeManager(bot, {
    inventory: { blockStacks: 1 },
    home: { storageChest: { x: 10, y: 64, z: 10 } },
  }, { memory, log: () => {} });

  assert.deepEqual(home.getStorageChest(), { x: 10, y: 64, z: 10 });
  home.setStorageChest(pos(5.8, 64.1, -3.2));
  assert.deepEqual(home.getStorageChest(), { x: 5, y: 64, z: -4 });

  await home.storeSurplus({ name: 'chest', position: pos(1, 64, 0) });
  assert.deepEqual(deposited, [{ type: 4, count: 32 }]);
});

test('storeSurplus still closes chest and keeps going if one deposit fails (chest full)', async () => {
  let closed = false;
  const deposited = [];
  const bot = {
    entity: { position: pos(0, 64, 0) },
    inventory: {
      items: () => [
        { name: 'dirt', type: 3, count: 64 },
        { name: 'cobblestone', type: 4, count: 32 },
      ],
    },
    openChest: async () => ({
      deposit: async (type, _meta, count) => {
        if (type === 3) throw new Error('Destination full');
        deposited.push({ type, count });
      },
      close: () => { closed = true; },
    }),
  };

  const home = new HomeManager(bot, { inventory: { blockStacks: 0 } }, { log: () => {} });
  const ok = await home.storeSurplus({ name: 'chest', position: pos(1, 64, 0) });
  assert.equal(ok, true);
  assert.equal(closed, true);
  assert.deepEqual(deposited, [{ type: 4, count: 32 }]);
});

test('HomeManager indexes chest contents and takeFromChest withdraws matching items', async () => {
  const memory = new Memory({ autoSaveMs: 0 });
  const chestItems = [{ name: 'iron_ingot', type: 265, count: 16 }];
  const withdrawn = [];
  const bot = {
    entity: { position: pos(0, 64, 0) },
    inventory: { items: () => [{ name: 'diamond', type: 264, count: 2 }] },
    openChest: async () => ({
      containerItems: () => chestItems,
      deposit: async (_t, _m, count) => { chestItems.push({ name: 'diamond', type: 264, count }); },
      withdraw: async (type, _m, count) => {
        withdrawn.push({ type, count });
        chestItems[0].count -= count;
      },
      close: () => {},
    }),
  };

  const home = new HomeManager(bot, { inventory: { blockStacks: 0 } }, { memory, log: () => {} });
  const chestBlock = { name: 'chest', position: pos(2, 64, 0) };
  await home.storeSurplus(chestBlock);

  const hits = home.findInChests('sắt');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 16);

  const taken = await home.takeFromChest(chestBlock, 'sắt', 6);
  assert.deepEqual(taken, { name: 'iron_ingot', count: 6 });
  assert.deepEqual(withdrawn, [{ type: 265, count: 6 }]);
  assert.equal(home.findInChests('sắt')[0].count, 10);
});

test('classifyItemCategory, assignCategoryChest, isInventoryNearFull, and storeSurplusSorted route items to category chests', async () => {
  assert.equal(classifyItemCategory('iron_ingot'), 'minerals');
  assert.equal(classifyItemCategory('oak_planks'), 'wood_build');
  assert.equal(classifyItemCategory('bread'), 'food');
  assert.equal(classifyItemCategory('iron_pickaxe'), 'gear');
  assert.equal(classifyItemCategory('ender_pearl'), 'misc');

  const memory = new Memory({ autoSaveMs: 0 });
  const depositsByPos = new Map();
  const invItems = [
    { name: 'iron_ingot', type: 265, count: 12 },
    { name: 'oak_log', type: 17, count: 16 },
    { name: 'bread', type: 297, count: 24 },
  ];

  const bot = {
    entity: { position: pos(0, 64, 0) },
    game: { dimension: 'overworld' },
    inventory: {
      items: () => invItems,
      emptySlotCount: () => 5, // (36-5)/36 = 0.861 >= 0.80
    },
    blockAt: (p) => ({ name: 'chest', position: p }),
    openChest: async (block) => {
      const k = `${block.position.x},${block.position.y},${block.position.z}`;
      if (!depositsByPos.has(k)) depositsByPos.set(k, []);
      return {
        containerItems: () => depositsByPos.get(k),
        deposit: async (type, _meta, count) => {
          const item = invItems.find(i => i.type === type);
          depositsByPos.get(k).push({ name: item.name, type, count });
        },
        close: () => {},
      };
    },
  };

  const home = new HomeManager(bot, { inventory: { keepFood: 16, blockStacks: 0 } }, { memory, log: () => {} });
  assert.equal(home.isInventoryNearFull(0.80), true);

  home.assignCategoryChest('minerals', pos(2, 64, 0));
  home.assignCategoryChest('wood_build', pos(3, 64, 0));
  home.assignCategoryChest('food', pos(4, 64, 0));

  const res = await home.storeSurplusSorted();
  assert.equal(res.stored, 36); // 12 iron + 16 oak_log + (24-16)=8 bread
  assert.deepEqual(res.byCategory, { minerals: 12, wood_build: 16, food: 8 });
  assert.equal(depositsByPos.get('2,64,0')[0].name, 'iron_ingot');
  assert.equal(depositsByPos.get('3,64,0')[0].name, 'oak_log');
  assert.equal(depositsByPos.get('4,64,0')[0].name, 'bread');
  assert.equal(memory.listChestIndexTotals().iron_ingot, 12);
});
