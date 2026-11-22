import test from 'node:test';
import assert from 'node:assert/strict';
import { EquipmentManager, getDurabilityRatio, rank } from '../src/equipment.js';

const makeItem = (name, count = 1, slot) => ({ name, count, slot });

test('ranks materials from wooden/leather to netherite', () => {
  assert.ok(rank(makeItem('wooden_sword')) < rank(makeItem('stone_sword')));
  assert.ok(rank(makeItem('stone_sword')) < rank(makeItem('iron_sword')));
  assert.ok(rank(makeItem('iron_sword')) < rank(makeItem('diamond_sword')));
  assert.ok(rank(makeItem('diamond_sword')) < rank(makeItem('netherite_sword')));
  assert.ok(rank(makeItem('leather_helmet')) < rank(makeItem('chainmail_helmet')));
  assert.ok(rank(makeItem('chainmail_helmet')) < rank(makeItem('iron_helmet')));
});

test('equipMelee selects best sword by material rank', async () => {
  let equipped = null;
  const bot = {
    heldItem: null,
    inventory: {
      items: () => [makeItem('wooden_sword', 1, 36), makeItem('iron_sword', 1, 37)],
      slots: [],
    },
    equip: async (item, dest) => {
      equipped = { item, dest };
      bot.heldItem = item;
    },
  };
  const equip = new EquipmentManager(bot);
  const ok = await equip.equipMelee();
  assert.equal(ok, true);
  assert.equal(equipped?.item.name, 'iron_sword');
  assert.equal(equipped?.dest, 'hand');
});

test('maintain equips armor from inventory when armor slots are empty and equips shield to off-hand', async () => {
  const helmet = makeItem('iron_helmet', 1, 9);
  const shield = makeItem('shield', 1, 10);
  const sword = makeItem('diamond_sword', 1, 36);
  const pickaxe = makeItem('diamond_pickaxe', 1, 37);
  const slots = new Array(46).fill(null);
  slots[9] = helmet;
  slots[10] = shield;
  slots[36] = sword;
  slots[37] = pickaxe;

  const equippedCalls = [];
  const bot = {
    heldItem: null,
    inventory: {
      items: () => [helmet, shield, sword, pickaxe],
      slots,
    },
    equip: async (item, dest) => {
      equippedCalls.push({ name: item.name, dest });
      if (dest === 'head') slots[5] = item;
      if (dest === 'off-hand') slots[45] = item;
      if (dest === 'hand') bot.heldItem = item;
    },
  };

  const equip = new EquipmentManager(bot);
  const st = await equip.maintain();

  assert.equal(slots[5]?.name, 'iron_helmet');
  assert.equal(slots[45]?.name, 'shield');
  assert.equal(bot.heldItem?.name, 'diamond_sword');
  assert.equal(st.equipped.head, 'iron_helmet');
  assert.equal(st.equipped.shield, 'shield');
  assert.equal(st.equipped.sword, 'diamond_sword');
  assert.equal(equippedCalls.some(c => c.name === 'diamond_pickaxe'), false);
});

test('status does not report unequipped inventory items as equipped', () => {
  const slots = new Array(46).fill(null);
  slots[9] = makeItem('iron_chestplate', 1, 9);
  slots[10] = makeItem('shield', 1, 10);
  const bot = {
    heldItem: null,
    inventory: {
      items: () => [slots[9], slots[10]],
      slots,
    },
  };
  const equip = new EquipmentManager(bot);
  const st = equip.status();
  assert.deepEqual(st.equipped, {});
});

test('maintainArmorAndShield prioritizes totem_of_undying at low health and keeps totem over shield', async () => {
  const slots = new Array(46).fill(null);
  const shield = makeItem('shield', 1, 9);
  const totem = makeItem('totem_of_undying', 1, 10);
  slots[9] = shield;
  slots[10] = totem;
  slots[45] = shield;

  const bot = {
    health: 8,
    heldItem: null,
    inventory: {
      items: () => [shield, totem],
      slots,
    },
    equip: async (item, dest) => {
      if (dest === 'off-hand') slots[45] = item;
    },
  };

  const equip = new EquipmentManager(bot);
  await equip.maintainArmorAndShield();
  assert.equal(slots[45]?.name, 'totem_of_undying');
});

test('maintain upgrades armor progressively and deduplicates concurrent maintain calls', async () => {
  const slots = new Array(46).fill(null);
  const leather = makeItem('leather_helmet', 1, 9);
  const diamond = makeItem('diamond_helmet', 1, 10);
  const axe = makeItem('diamond_axe', 1, 36);
  slots[5] = leather;
  slots[9] = leather;
  slots[10] = diamond;
  slots[36] = axe;

  let equipCalls = 0;
  const bot = {
    health: 20,
    heldItem: null,
    inventory: {
      items: () => [diamond, axe],
      slots,
    },
    equip: async (item, dest) => {
      equipCalls++;
      await new Promise(r => setTimeout(r, 10));
      if (dest === 'head') slots[5] = item;
      if (dest === 'hand') bot.heldItem = item;
    },
  };

  const equip = new EquipmentManager(bot);
  const [s1, s2] = await Promise.all([equip.maintain(), equip.maintain()]);
  assert.equal(s1.equipped.head, 'diamond_helmet');
  assert.equal(s2.equipped.head, 'diamond_helmet');
  assert.equal(bot.heldItem?.name, 'diamond_axe');
  assert.equal(equipCalls, 2);
});

test('discardObsoleteItems tosses lower-tier armor and tools when enabled', async () => {
  const slots = new Array(46).fill(null);
  const ironHelm = makeItem('iron_helmet', 1, 5);
  const leatherHelm = makeItem('leather_helmet', 1, 9);
  const diamondSword = makeItem('diamond_sword', 1, 36);
  const woodSword = makeItem('wooden_sword', 1, 10);
  const pickaxe = makeItem('iron_pickaxe', 1, 11);
  slots[5] = ironHelm;

  const tossed = [];
  const bot = {
    heldItem: diamondSword,
    inventory: {
      items: () => [leatherHelm, woodSword, pickaxe],
      slots,
    },
    tossStack: async (item) => tossed.push(item.name),
  };

  const equip = new EquipmentManager(bot, { inventory: { discardObsolete: true } });
  const dropped = await equip.discardObsoleteItems();
  assert.deepEqual(dropped, ['leather_helmet', 'wooden_sword']);
  assert.deepEqual(tossed, ['leather_helmet', 'wooden_sword']);
});

test('armorMitigation, getLowDurabilityItems, and equipWeaponForSituation select tactical weapons safely', async () => {
  const slots = new Array(46).fill(null);
  slots[5] = makeItem('iron_helmet', 1, 5);
  slots[6] = makeItem('diamond_chestplate', 1, 6);
  slots[7] = makeItem('iron_leggings', 1, 7);
  slots[8] = makeItem('leather_boots', 1, 8);

  const wornSword = { name: 'diamond_sword', count: 1, slot: 36, maxDurability: 100, durabilityUsed: 95 };
  const healthySword = { name: 'iron_sword', count: 1, slot: 37, maxDurability: 100, durabilityUsed: 10 };
  const axe = { name: 'iron_axe', count: 1, slot: 38, maxDurability: 100, durabilityUsed: 5 };
  const bow = { name: 'bow', count: 1, slot: 39, maxDurability: 384, durabilityUsed: 0 };
  const arrow = { name: 'arrow', count: 16, slot: 40 };
  const items = [wornSword, healthySword, axe, bow, arrow];

  assert.equal(getDurabilityRatio(wornSword), 0.05);
  assert.equal(getDurabilityRatio(healthySword), 0.9);

  const bot = {
    heldItem: null,
    inventory: { items: () => items, slots },
    equip: async (item) => { bot.heldItem = item; },
  };
  const equip = new EquipmentManager(bot, {}, { log: () => {} });

  // 0.14 + 0.18 + 0.14 + 0.05 = 0.51
  assert.equal(equip.armorMitigation(), 0.51);

  const low = equip.getLowDurabilityItems(0.10);
  assert.equal(low.length, 1);
  assert.equal(low[0].name, 'diamond_sword');

  // Blocking opponent -> axe
  const r1 = await equip.equipWeaponForSituation({ opponentBlocking: true });
  assert.equal(r1.weapon, 'iron_axe');
  assert.equal(r1.reason, 'shield_break');

  // Swarm -> healthy sword (skips <10% diamond_sword in favor of iron_sword)
  const r2 = await equip.equipWeaponForSituation({ mobCount: 3, distance: 2 });
  assert.equal(r2.weapon, 'iron_sword');
  assert.equal(r2.reason, 'sweep');

  // Distant -> bow
  const r3 = await equip.equipWeaponForSituation({ distance: 12 });
  assert.equal(r3.weapon, 'bow');
  assert.equal(r3.reason, 'ranged');
});
