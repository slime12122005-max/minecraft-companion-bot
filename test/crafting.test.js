import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { CraftManager, planCraftDependencies, resolveCraftName, resolveSmeltInputs } from '../src/crafting.js';

test('resolves Vietnamese and English crafting and smelting aliases', () => {
  assert.equal(resolveCraftName('cuốc sắt'), 'iron_pickaxe');
  assert.equal(resolveCraftName('bàn chế tạo'), 'crafting_table');
  assert.equal(resolveCraftName('khiên'), 'shield');
  assert.deepEqual(resolveSmeltInputs('sắt'), ['raw_iron', 'iron_ore', 'deepslate_iron_ore']);
  assert.deepEqual(resolveSmeltInputs('thịt'), ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit']);
});

test('CraftManager crafts intermediate planks and sticks recursively for wooden_pickaxe', async () => {
  const counts = new Map([[17, 2]]); // 2 oak_log
  const craftedSteps = [];
  const tablePos = new Vec3(2, 64, 0);

  const recipes = {
    // oak_planks (5): 1 oak_log (17) -> 4 planks
    5: [{ result: { id: 5, count: 4 }, requiresTable: false, delta: [{ id: 17, count: -1 }, { id: 5, count: 4 }] }],
    // stick (280): 2 oak_planks (5) -> 4 sticks
    280: [{ result: { id: 280, count: 4 }, requiresTable: false, delta: [{ id: 5, count: -2 }, { id: 280, count: 4 }] }],
    // wooden_pickaxe (270): 3 oak_planks (5) + 2 sticks (280) -> 1 pickaxe (requires table)
    270: [{ result: { id: 270, count: 1 }, requiresTable: true, delta: [{ id: 5, count: -3 }, { id: 280, count: -2 }, { id: 270, count: 1 }] }],
  };

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: {
      blocksByName: { crafting_table: { id: 58 } },
      itemsByName: {
        oak_log: { id: 17 },
        oak_planks: { id: 5 },
        stick: { id: 280 },
        wooden_pickaxe: { id: 270 },
      },
    },
    inventory: {
      count: (id) => counts.get(id) ?? 0,
      items: () => [],
    },
    findBlock: ({ matching }) => (matching === 58 ? { name: 'crafting_table', position: tablePos } : null),
    recipesAll: (id) => recipes[id] ?? [],
    recipesFor: (id) => recipes[id] ?? [],
    craft: async (recipe, times, table) => {
      craftedSteps.push({ id: recipe.result.id, times, hasTable: !!table });
      for (const d of recipe.delta) {
        counts.set(d.id, (counts.get(d.id) ?? 0) + d.count * times);
      }
    },
  };

  const craft = new CraftManager(bot, {}, { log: () => {} });
  const res = await craft.craftItem('cuốc gỗ', 1);
  assert.equal(res.name, 'wooden_pickaxe');
  assert.equal(counts.get(270), 1);
  assert.ok((counts.get(5) ?? 0) >= 0);
  assert.ok(craftedSteps.some(s => s.id === 5));
  assert.ok(craftedSteps.some(s => s.id === 280));
  assert.ok(craftedSteps.some(s => s.id === 270 && s.hasTable));
});

test('CraftManager.smeltItem loads fuel + input, takes output, and closes furnace', async () => {
  let outputTaken = false;
  let closed = false;
  let putFuelArgs = null;
  let putInputArgs = null;

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { furnace: { id: 61 } } },
    inventory: {
      items: () => [
        { name: 'raw_iron', type: 700, count: 4 },
        { name: 'coal', type: 263, count: 2 },
      ],
    },
    findBlock: () => ({ name: 'furnace', position: new Vec3(1, 64, 0) }),
    openFurnace: async () => ({
      putFuel: async (t, _m, c) => { putFuelArgs = { t, c }; },
      putInput: async (t, _m, c) => { putInputArgs = { t, c }; },
      outputItem: () => (outputTaken ? null : { name: 'iron_ingot', count: 4 }),
      takeOutput: async () => { outputTaken = true; },
      close: () => { closed = true; },
    }),
  };

  const craft = new CraftManager(bot, {}, { log: () => {} });
  const res = await craft.smeltItem('sắt', 4, null, { pollMs: 5, timeoutMs: 200 });
  assert.deepEqual(putFuelArgs, { t: 263, c: 1 });
  assert.deepEqual(putInputArgs, { t: 700, c: 4 });
  assert.deepEqual(res, { name: 'iron_ingot', count: 4, requested: 4 });
  assert.equal(closed, true);
});

test('resolveCraftName matches plank variant from inventory logs and falls back to oak_planks', () => {
  assert.equal(resolveCraftName('ván gỗ', null, [{ name: 'birch_log', count: 2 }]), 'birch_planks');
  assert.equal(resolveCraftName('planks', null, [{ name: 'spruce_log', count: 1 }]), 'spruce_planks');
  assert.equal(resolveCraftName('ván gỗ', null, []), 'oak_planks');
});

test('CraftManager does not craft or place crafting_table when primary ore ingredients are missing', async () => {
  let placedTable = false;
  let craftedTable = false;
  const counts = new Map([[17, 4]]); // only 4 oak_log, 0 diamonds

  const recipes = {
    5: [{ result: { id: 5, count: 4 }, requiresTable: false, delta: [{ id: 17, count: -1 }, { id: 5, count: 4 }] }],
    280: [{ result: { id: 280, count: 4 }, requiresTable: false, delta: [{ id: 5, count: -2 }, { id: 280, count: 4 }] }],
    58: [{ result: { id: 58, count: 1 }, requiresTable: false, delta: [{ id: 5, count: -4 }, { id: 58, count: 1 }] }],
    278: [{
      result: { id: 278, count: 1 },
      requiresTable: true,
      delta: [{ id: 264, count: -3 }, { id: 280, count: -2 }, { id: 278, count: 1 }],
    }],
  };

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: {
      blocksByName: { crafting_table: { id: 58 } },
      itemsByName: {
        oak_log: { id: 17 },
        oak_planks: { id: 5 },
        stick: { id: 280 },
        crafting_table: { id: 58 },
        diamond: { id: 264 },
        diamond_pickaxe: { id: 278 },
      },
    },
    inventory: {
      count: (id) => counts.get(id) ?? 0,
      items: () => [],
    },
    findBlock: () => null,
    blockAt: () => ({ name: 'air' }),
    equip: async () => {},
    placeBlock: async () => { placedTable = true; },
    recipesAll: (id) => recipes[id] ?? [],
    recipesFor: (id) => recipes[id] ?? [],
    craft: async (recipe) => {
      if (recipe.result.id === 58) craftedTable = true;
    },
  };

  const craft = new CraftManager(bot, {}, { log: () => {} });
  await assert.rejects(craft.craftItem('cuốc kim cương', 1), /Thiếu nguyên liệu/);
  assert.equal(craftedTable, false);
  assert.equal(placedTable, false);
});

test('CraftManager.smeltItem computes plank fuel, caps batch when fuel is partial, rejects <1 fuel, and auto-crafts furnace', async () => {
  // 1) 8 beef + 6 oak_planks -> needs ceil(8 / 1.5) = 6 planks; default timeout scales cleanly
  let fuel1 = null;
  let input1 = null;
  let ready1 = false;
  setTimeout(() => { ready1 = true; }, 20);
  const botPlanks = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { furnace: { id: 61 } } },
    inventory: {
      items: () => [
        { name: 'beef', type: 363, count: 8 },
        { name: 'oak_planks', type: 5, count: 6 },
      ],
    },
    findBlock: () => ({ name: 'furnace', position: new Vec3(1, 64, 0) }),
    openFurnace: async () => ({
      putFuel: async (_t, _m, c) => { fuel1 = c; },
      putInput: async (_t, _m, c) => { input1 = c; },
      outputItem: () => (ready1 ? { name: 'cooked_beef', count: 8 } : null),
      takeOutput: async () => { ready1 = false; },
      close: () => {},
    }),
  };
  const craft1 = new CraftManager(botPlanks, {}, { log: () => {} });
  const res1 = await craft1.smeltItem('thịt', 8, null, { pollMs: 5 });
  assert.equal(fuel1, 6);
  assert.equal(input1, 8);
  assert.deepEqual(res1, { name: 'cooked_beef', count: 8, requested: 8 });

  // 2) 8 beef + 2 oak_planks (max 3 items) -> caps input to 3
  let fuel2 = null;
  let input2 = null;
  let taken2 = false;
  const botPartial = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { furnace: { id: 61 } } },
    inventory: {
      items: () => [
        { name: 'beef', type: 363, count: 8 },
        { name: 'oak_planks', type: 5, count: 2 },
      ],
    },
    findBlock: () => ({ name: 'furnace', position: new Vec3(1, 64, 0) }),
    openFurnace: async () => ({
      putFuel: async (_t, _m, c) => { fuel2 = c; },
      putInput: async (_t, _m, c) => { input2 = c; },
      outputItem: () => (taken2 ? null : { name: 'cooked_beef', count: 3 }),
      takeOutput: async () => { taken2 = true; },
      close: () => {},
    }),
  };
  const craft2 = new CraftManager(botPartial, {}, { log: () => {} });
  const res2 = await craft2.smeltItem('thịt', 8, null, { pollMs: 5, timeoutMs: 100 });
  assert.equal(fuel2, 2);
  assert.equal(input2, 3);
  assert.deepEqual(res2, { name: 'cooked_beef', count: 3, requested: 3 });

  // 3) 1 stick (0.5 items < 1) rejects before opening furnace
  const botTinyFuel = {
    inventory: {
      items: () => [
        { name: 'beef', type: 363, count: 2 },
        { name: 'stick', type: 280, count: 1 },
      ],
    },
  };
  const craftTiny = new CraftManager(botTinyFuel, {}, { log: () => {} });
  await assert.rejects(craftTiny.smeltItem('thịt', 2), /Nhiên liệu không đủ/);

  // 4) Auto-crafts furnace from 8 cobblestone when no furnace is nearby, or gives clear error when missing
  let hasFurnacePlaced = false;
  let cobbleCount = 8;
  let furnaceItemCount = 0;
  let furnaceTaken = false;
  const botAutoFurnace = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: {
      blocksByName: { furnace: { id: 61 }, crafting_table: { id: 58 } },
      itemsByName: { furnace: { id: 61 }, cobblestone: { id: 4 } },
    },
    inventory: {
      count: (id) => (id === 4 ? cobbleCount : id === 61 ? furnaceItemCount : 0),
      items: () => {
        const list = [
          { name: 'raw_iron', type: 700, count: 2 },
          { name: 'coal', type: 263, count: 1 },
        ];
        if (cobbleCount > 0) list.push({ name: 'cobblestone', type: 4, count: cobbleCount });
        if (furnaceItemCount > 0) list.push({ name: 'furnace', type: 61, count: furnaceItemCount });
        return list;
      },
    },
    findBlock: ({ matching }) => {
      if (matching === 58) return { name: 'crafting_table', position: new Vec3(1, 64, 0) };
      if (Array.isArray(matching) && hasFurnacePlaced) return { name: 'furnace', position: new Vec3(1, 64, 0) };
      return null;
    },
    blockAt: (p) => {
      if (hasFurnacePlaced && Math.floor(p.x) === 1 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0) {
        return { name: 'furnace', position: p };
      }
      if (Math.floor(p.y) === 63) return { name: 'stone', position: p };
      return { name: 'air', position: p };
    },
    recipesAll: (id) => (id === 61 ? [{ result: { id: 61, count: 1 }, requiresTable: true, delta: [{ id: 4, count: -8 }] }] : []),
    recipesFor: (id) => (id === 61 ? [{ result: { id: 61, count: 1 }, requiresTable: true, delta: [{ id: 4, count: -8 }] }] : []),
    craft: async () => { cobbleCount -= 8; furnaceItemCount += 1; },
    equip: async () => {},
    placeBlock: async () => { furnaceItemCount = 0; hasFurnacePlaced = true; },
    openFurnace: async () => ({
      putFuel: async () => {},
      putInput: async () => {},
      outputItem: () => (furnaceTaken ? null : { name: 'iron_ingot', count: 2 }),
      takeOutput: async () => { furnaceTaken = true; },
      close: () => {},
    }),
  };
  const craftAuto = new CraftManager(botAutoFurnace, {}, { log: () => {} });
  const resAuto = await craftAuto.smeltItem('sắt', 2, null, { pollMs: 5, timeoutMs: 100 });
  assert.equal(hasFurnacePlaced, true);
  assert.deepEqual(resAuto, { name: 'iron_ingot', count: 2, requested: 2 });

  const botNoFurnace = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { furnace: { id: 61 } } },
    inventory: {
      items: () => [
        { name: 'raw_iron', type: 700, count: 2 },
        { name: 'coal', type: 263, count: 1 },
      ],
    },
    findBlock: () => null,
    blockAt: () => ({ name: 'air' }),
  };
  const craftFail = new CraftManager(botNoFurnace, {}, { log: () => {} });
  await assert.rejects(craftFail.smeltItem('sắt', 2), /Không có lò nung gần đây và thiếu 8 đá cuội để làm lò/);
});

test('planCraftDependencies resolves multi-tier craft+smelt chain and CraftManager auto-smelts missing iron_ingot', async () => {
  const plan = planCraftDependencies('iron_pickaxe', 1, [
    { name: 'raw_iron', count: 3 },
    { name: 'oak_log', count: 3 },
    { name: 'cobblestone', count: 8 },
  ]);
  assert.equal(plan.some(s => s.action === 'missing'), false);
  assert.ok(plan.some(s => s.action === 'smelt' && s.item === 'iron_ingot' && s.count === 3));
  assert.equal(plan[plan.length - 1].item, 'iron_pickaxe');

  const counts = new Map([
    [17, 2],   // oak_log
    [700, 3],  // raw_iron
    [263, 2],  // coal
  ]);
  let furnaceSmelted = false;
  const recipes = {
    5: [{ result: { id: 5, count: 4 }, requiresTable: false, delta: [{ id: 17, count: -1 }, { id: 5, count: 4 }] }],
    280: [{ result: { id: 280, count: 4 }, requiresTable: false, delta: [{ id: 5, count: -2 }, { id: 280, count: 4 }] }],
    257: [{ result: { id: 257, count: 1 }, requiresTable: true, delta: [{ id: 265, count: -3 }, { id: 280, count: -2 }, { id: 257, count: 1 }] }],
  };

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: {
      blocksByName: { crafting_table: { id: 58 }, furnace: { id: 61 } },
      items: {
        17: { id: 17, name: 'oak_log' },
        5: { id: 5, name: 'oak_planks' },
        280: { id: 280, name: 'stick' },
        265: { id: 265, name: 'iron_ingot' },
        257: { id: 257, name: 'iron_pickaxe' },
        700: { id: 700, name: 'raw_iron' },
        263: { id: 263, name: 'coal' },
      },
      itemsByName: {
        oak_log: { id: 17 },
        oak_planks: { id: 5 },
        stick: { id: 280 },
        iron_ingot: { id: 265 },
        iron_pickaxe: { id: 257 },
      },
    },
    inventory: {
      count: (id) => counts.get(id) ?? 0,
      items: () => [
        { name: 'oak_log', type: 17, count: counts.get(17) ?? 0 },
        { name: 'raw_iron', type: 700, count: counts.get(700) ?? 0 },
        { name: 'coal', type: 263, count: counts.get(263) ?? 0 },
      ].filter(i => i.count > 0),
    },
    findBlock: ({ matching }) => {
      const ids = Array.isArray(matching) ? matching : [matching];
      if (ids.includes(58)) return { name: 'crafting_table', position: new Vec3(1, 64, 0) };
      if (ids.includes(61)) return { name: 'furnace', position: new Vec3(2, 64, 0) };
      return null;
    },
    openFurnace: async () => ({
      putFuel: async (t, _m, c) => { counts.set(t, (counts.get(t) ?? 0) - c); },
      putInput: async (t, _m, c) => { counts.set(t, (counts.get(t) ?? 0) - c); },
      outputItem: () => (furnaceSmelted ? null : { name: 'iron_ingot', count: 3 }),
      takeOutput: async () => {
        furnaceSmelted = true;
        counts.set(265, (counts.get(265) ?? 0) + 3);
      },
      close: () => {},
    }),
    recipesAll: (id) => recipes[id] ?? [],
    recipesFor: (id) => recipes[id] ?? [],
    craft: async (recipe, times) => {
      for (const d of recipe.delta) counts.set(d.id, (counts.get(d.id) ?? 0) + d.count * times);
    },
  };

  const craft = new CraftManager(bot, {}, { log: () => {} });
  const res = await craft.craftItem('iron_pickaxe', 1);
  assert.equal(res.name, 'iron_pickaxe');
  assert.equal(furnaceSmelted, true);
  assert.equal(counts.get(257), 1);
});

test('CraftManager._moveNextTo retries on GoalChanged when interrupted and waits while paused', async () => {
  let paused = false;
  let interrupted = false;
  let gotoCalls = 0;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: {
      blocksByName: { crafting_table: { id: 58 } },
      itemsByName: {
        oak_planks: { id: 5 },
        stick: { id: 280 },
        wooden_pickaxe: { id: 270 },
      },
    },
    inventory: {
      count: (id) => ({ 5: 3, 280: 2 }[id] ?? 0),
      items: () => [],
    },
    findBlock: () => ({ name: 'crafting_table', position: new Vec3(10, 64, 0) }),
    pathfinder: {
      goto: async () => {
        gotoCalls += 1;
        if (gotoCalls === 1) {
          paused = true;
          interrupted = true;
          setTimeout(() => {
            paused = false;
          }, 30);
          const err = new Error('Goal changed by combat');
          err.name = 'GoalChanged';
          throw err;
        }
        interrupted = false;
        bot.entity.position = new Vec3(9, 64, 0);
      },
    },
    recipesAll: (id) => (id === 270 ? [{
      result: { id: 270, count: 1 },
      requiresTable: true,
      delta: [{ id: 5, count: -3 }, { id: 280, count: -2 }, { id: 270, count: 1 }],
    }] : []),
    recipesFor: (id) => (id === 270 ? [{
      result: { id: 270, count: 1 },
      requiresTable: true,
      delta: [{ id: 5, count: -3 }, { id: 280, count: -2 }, { id: 270, count: 1 }],
    }] : []),
    craft: async () => {},
  };

  const craft = new CraftManager(bot, {}, {
    log: () => {},
    isPaused: () => paused,
    isInterrupted: () => interrupted,
  });
  const res = await craft.craftItem('wooden_pickaxe', 1);
  assert.equal(res.name, 'wooden_pickaxe');
  assert.equal(gotoCalls, 2);
});
