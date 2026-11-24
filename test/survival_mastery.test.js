import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';

import { EquipmentManager, getEnchantmentBonus } from '../src/equipment.js';
import { HomeManager } from '../src/home.js';
import { Memory } from '../src/memory.js';
import { MiningFarmingManager } from '../src/mining_farming.js';
import { CompanionManager } from '../src/companion.js';
import { CombatController } from '../src/combat/index.js';
import { pickThreat, resolveJevDecision } from '../src/combat/threat_assessment.js';
import { applyDecision, isNearFarmland, jumpCrit } from '../src/combat/micro_control.js';
import { MotorHumanizer, wouldTriggerEnderman } from '../src/humanizer.js';
import { performUnstuckStep } from '../src/survival/hazard_reflex.js';

const require = createRequire(import.meta.url);
const mineflayerPkgPath = require.resolve('mineflayer/package.json');
const mineflayerRequire = createRequire(mineflayerPkgPath);
const prismarineRegistry = mineflayerRequire('prismarine-registry');
const realRegistry = prismarineRegistry('1.21.1');

function pos(x, y, z) {
  return new Vec3(x, y, z);
}

test('Enchanted gear scoring keeps Sharpness sword + 1 diamond blank + 1 golden_helmet while discarding trash and duplicate bow', async () => {
  const tossed = [];
  const equipped = [];

  const sharpIron = { name: 'iron_sword', count: 1, enchants: [{ name: 'sharpness', lvl: 4 }] };
  const blankDiamond1 = { name: 'diamond_sword', count: 1 };
  const blankDiamond2 = { name: 'diamond_sword', count: 1 };
  const enchLeatherChest = { name: 'leather_chestplate', count: 1, enchants: [{ name: 'protection', lvl: 1 }] };
  const ironChest = { name: 'iron_chestplate', count: 1 };
  const goldHelm = { name: 'golden_helmet', count: 1 };
  const diamondHelm = { name: 'diamond_helmet', count: 1 };
  const powerBow = { name: 'bow', count: 1, enchants: [{ name: 'power', lvl: 3 }] };
  const plainBow = { name: 'bow', count: 1 };

  assert.ok(getEnchantmentBonus(sharpIron) >= 1.4);

  const items = [sharpIron, blankDiamond1, blankDiamond2, enchLeatherChest, ironChest, goldHelm, diamondHelm, powerBow, plainBow];
  const bot = {
    game: { dimension: 'overworld' },
    heldItem: null,
    inventory: { slots: new Array(46).fill(null), items: () => items },
    equip: async (item, slot) => { equipped.push(`${item.name}->${slot}`); },
    tossStack: async (item) => { tossed.push(item); },
  };

  const eq = new EquipmentManager(bot, { inventory: { discardObsolete: true } });
  await eq.equipMelee();
  assert.ok(equipped.includes('iron_sword->hand'));

  const dropped = await eq.discardObsoleteItems();
  assert.ok(dropped.includes('leather_chestplate'), 'enchanted low-tier leather should still be dropped');
  assert.equal(tossed.filter((i) => i.name === 'diamond_sword').length, 1, 'should keep 1 blank diamond sword and toss extra');
  assert.ok(!tossed.includes(blankDiamond1));
  assert.ok(!tossed.includes(goldHelm), 'should keep 1 golden_helmet for Nether safety');
  assert.ok(!tossed.includes(powerBow));
  assert.ok(tossed.includes(plainBow), 'should toss weaker duplicate bow');
});

test('Nether golden_helmet takes priority over diamond_helmet, crafts in Nether, and crafts bucket in Overworld', async () => {
  const slots = new Array(46).fill(null);
  const goldHelm = { name: 'golden_helmet', count: 1 };
  const diamondHelm = { name: 'diamond_helmet', count: 1 };
  const ironChest = { name: 'iron_chestplate', count: 1 };

  const bot = {
    game: { dimension: 'minecraft:the_nether' },
    heldItem: null,
    inventory: {
      slots,
      items: () => [goldHelm, diamondHelm, ironChest],
    },
    equip: async (item, slot) => {
      const idxMap = { head: 5, torso: 6, legs: 7, feet: 8 };
      if (idxMap[slot] != null) slots[idxMap[slot]] = item;
    },
  };

  const eq = new EquipmentManager(bot, {});
  await eq.maintainArmorAndShield();
  assert.equal(slots[5]?.name, 'golden_helmet');
  assert.equal(slots[6]?.name, 'iron_chestplate');

  // Returning to overworld swaps back to diamond_helmet
  bot.game.dimension = 'overworld';
  await eq.maintainArmorAndShield();
  assert.equal(slots[5]?.name, 'diamond_helmet');

  // Nether upgrade planner wants golden_helmet when gold ingots >= 5 and no gold armor exists
  bot.game.dimension = 'the_nether';
  slots[5] = null;
  bot.inventory.items = () => [{ name: 'gold_ingot', count: 6 }];
  assert.equal(eq.planNextGearUpgrade()?.item, 'golden_helmet');

  // Overworld planner crafts bucket once core iron pickaxe + sword + shield exist
  bot.game.dimension = 'overworld';
  slots[45] = { name: 'shield', count: 1 };
  bot.inventory.items = () => [
    { name: 'iron_pickaxe', count: 1 },
    { name: 'iron_sword', count: 1 },
    { name: 'iron_ingot', count: 4 },
  ];
  assert.equal(eq.planNextGearUpgrade()?.item, 'bucket');
});

test('HomeManager auto-detects base cluster, deposits duplicate sword, uses secondary chest, and restocks essentials', async () => {
  const memory = new Memory({ autoSaveMs: 0 });
  const baseBlocks = new Map([
    ['2,64,2', { name: 'red_bed', position: pos(2, 64, 2) }],
    ['4,64,2', { name: 'chest', position: pos(4, 64, 2) }],
    ['5,64,2', { name: 'furnace', position: pos(5, 64, 2) }],
    ['6,64,2', { name: 'crafting_table', position: pos(6, 64, 2) }],
  ]);

  let primaryFullOnce = true;
  const altDeposits = [];
  const withdrawn = [];

  const sharpSword = { name: 'iron_sword', type: 10, count: 1, enchants: [{ name: 'sharpness', lvl: 4 }] };
  const spareSword = { name: 'iron_sword', type: 10, count: 1 };
  const blankDiamond = { name: 'diamond_sword', type: 11, count: 1 };

  const bot = {
    registry: realRegistry,
    game: { dimension: 'overworld' },
    entity: { position: pos(3, 64, 3) },
    heldItem: null,
    inventory: {
      slots: new Array(46).fill(null),
      items: () => [sharpSword, spareSword, blankDiamond],
    },
    pathfinder: { goto: async () => {} },
    blockAt: (p) => baseBlocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? null,
    findBlocks: ({ matching }) => {
      const set = new Set(matching);
      return [...baseBlocks.values()]
        .filter((b) => set.has(realRegistry.blocksByName[b.name]?.id))
        .map((b) => b.position);
    },
    findBlock: ({ matching }) => [...baseBlocks.values()].find(matching) ?? null,
    openChest: async (blk) => {
      if (blk.position.x === 4) {
        return {
          containerItems: () => [
            { name: 'iron_sword', type: 10, count: 1 },
            { name: 'iron_pickaxe', type: 12, count: 1 },
            { name: 'cooked_beef', type: 13, count: 12 },
          ],
          deposit: async () => {
            if (primaryFullOnce) throw new Error('Chest full');
          },
          withdraw: async (type, _meta, count) => { withdrawn.push({ type, count }); },
          close: () => {},
        };
      }
      return {
        containerItems: () => [],
        deposit: async (type, _meta, count) => { altDeposits.push({ type, count }); },
        close: () => {},
      };
    },
  };

  const home = new HomeManager(bot, { home: { setOnCommand: true }, inventory: { keepFood: 16, blockStacks: 1 } }, { memory });

  // 1. Auto-detect base cluster
  const detected = home.detectNearbyBase();
  assert.equal(detected.home?.x, 2);
  assert.equal(detected.storageChest?.x, 4);

  // Explicit manual home overrides & locks against later autoSetFromBed
  home.set({ position: pos(50, 64, 50), dimension: 'overworld' });
  assert.equal(home.autoSetFromBed(pos(2, 64, 2)), null);
  assert.equal(home.get().x, 50);

  // 2. Surplus keeps sharpSword + 1 blankDiamond, deposits duplicate spareSword into fallback alt chest
  baseBlocks.set('5,64,3', { name: 'barrel', position: pos(5, 64, 3) });
  const stored = await home.storeSurplus(baseBlocks.get('4,64,2'));
  assert.equal(stored, true);
  assert.deepEqual(altDeposits, [{ type: 10, count: 1 }]);

  // 3. Restock essentials when empty-handed near chest
  bot.inventory.items = () => [];
  const restock = await home.restockEssentialsFromNearbyChest();
  assert.ok(restock.withdrawn.length >= 2);
  assert.ok(withdrawn.some((w) => w.type === 10));
  assert.ok(withdrawn.some((w) => w.type === 12));
  assert.ok(withdrawn.some((w) => w.type === 13 && w.count === 12));
});

test('MiningFarmingManager & CompanionManager harvest village hay_block, craft bread, hunt adult livestock, fill bucket, and close wooden doors', async () => {
  const logs = [];
  let inv = [
    { name: 'iron_hoe', count: 1 },
    { name: 'iron_sword', count: 1 },
    { name: 'iron_pickaxe', count: 1 },
    { name: 'bucket', count: 1 },
  ];
  const worldBlocks = new Map([
    ['4,64,0', { name: 'hay_block', position: pos(4, 64, 0) }],
    ['2,64,1', { name: 'water', type: realRegistry.blocksByName.water.id, metadata: 0, position: pos(2, 64, 1) }],
    ['1,64,0', { name: 'oak_door', open: true, properties: { open: true, half: 'lower' }, position: pos(1, 64, 0) }],
  ]);

  let attacks = 0;
  let waterActivated = 0;
  let doorClosed = 0;
  const craftCalls = [];

  const cow = { id: 21, name: 'cow', health: 10, position: pos(3, 64, 0) };
  const babyCow = { id: 22, name: 'cow', isBaby: true, health: 10, position: pos(1, 64, 0) };
  const wolf = { id: 23, name: 'wolf', health: 8, position: pos(1, 64, 0) };

  const bot = {
    registry: realRegistry,
    entity: { position: pos(0, 64, 0), onGround: true, yaw: 0 },
    heldItem: null,
    entities: { 21: cow, 22: babyCow, 23: wolf },
    players: {},
    inventory: {
      slots: new Array(46).fill(null),
      items: () => inv,
      emptySlotCount: () => 20,
    },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    equip: async () => {},
    lookAt: async () => {},
    blockAt: (p) => worldBlocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? null,
    findBlocks: ({ matching }) => {
      if (typeof matching === 'function') {
        return [...worldBlocks.values()].filter(matching).map((b) => b.position);
      }
      const ids = Array.isArray(matching) ? matching : [matching];
      const set = new Set(ids);
      return [...worldBlocks.values()]
        .filter((b) => set.has(b.type ?? realRegistry.blocksByName[b.name]?.id))
        .map((b) => b.position);
    },
    findBlock: ({ matching }) => {
      if (typeof matching === 'function') return [...worldBlocks.values()].find(matching) ?? null;
      return [...worldBlocks.values()].find((b) => b.type === matching || realRegistry.blocksByName[b.name]?.id === matching) ?? null;
    },
    dig: async (blk) => {
      worldBlocks.delete(`${blk.position.x},${blk.position.y},${blk.position.z}`);
      inv.push({ name: 'hay_block', count: 1 });
    },
    attack: async (ent) => {
      assert.equal(ent.id, 21, 'should only hunt adult cow, never baby cow or wolf');
      attacks += 1;
      ent.health = 0;
    },
    activateItem: () => {
      waterActivated += 1;
      inv = inv.map((i) => (i.name === 'bucket' ? { name: 'water_bucket', count: 1 } : i));
    },
    activateBlock: async () => { doorClosed += 1; },
  };

  const mining = new MiningFarmingManager(bot, {}, { log: (m) => logs.push(m), seedWaitMs: 0 });
  const hayRes = await mining.harvestHayBales(1);
  assert.equal(hayRes.dug, 1);

  const huntRes = await mining.huntNearbyFoodAnimal();
  assert.equal(huntRes.hunted, 'cow');
  assert.equal(attacks, 1);

  const companion = new CompanionManager({
    bot,
    config: { owner: 'araslime', companion: { ambientChatter: false } },
    state: { stayPut: false },
    combat: { busy: false },
    survival: { busy: false },
    tasks: { active: null },
    equipment: new EquipmentManager(bot, {}),
    mining,
    crafting: {
      craftItem: async (item, count) => {
        craftCalls.push(`${item}x${count}`);
        if (item === 'wheat') {
          inv = inv.filter((i) => i.name !== 'hay_block');
          inv.push({ name: 'wheat', count });
        } else if (item === 'bread') {
          inv.push({ name: 'bread', count });
        }
        return { name: item, count };
      },
    },
  }, { enabledChat: true, enabledIdle: true });

  // Water bucket fill triggers first when holding empty bucket near water
  await companion.tickSurvivalAutonomy(100_000, { force: true });
  assert.equal(waterActivated, 1);

  // Next autonomy cycle turns hay_block into wheat & bread
  await companion.tickSurvivalAutonomy(125_000, { force: true });
  assert.deepEqual(craftCalls, ['wheatx9', 'breadx3']);

  // Wooden door close etiquette: pass close at t=10_000 then move 2.5m away at t=12_000
  bot.entity.position = pos(1.5, 64, 0.2);
  assert.equal(companion._tickAutoCloseDoors(10_000), false);
  bot.entity.position = pos(4.0, 64, 0.2);
  assert.equal(companion._tickAutoCloseDoors(12_000), true);
  assert.equal(doorClosed, 1);
});

test('Farmland protection, Enderman gaze deflection, and Skeleton/Witch/Creeper combat tactics', async () => {
  // 1. Farmland jump protection prevents jumpCrit and unstuck jumps
  const jumpControls = [];
  let attacked = 0;
  const farmBot = {
    entity: { position: pos(2, 64, 2), onGround: true },
    setControlState: (k, v) => { if (k === 'jump' && v) jumpControls.push(k); },
    blockAt: (p) => (Math.floor(p.y) === 63 ? { name: 'farmland' } : { name: 'air' }),
  };
  assert.equal(isNearFarmland(farmBot), true);
  await jumpCrit({ bot: farmBot, _attack: async () => { attacked += 1; }, isEating: () => false }, { id: 1, position: pos(3, 64, 2) });
  assert.equal(attacked, 1);
  assert.equal(jumpControls.length, 0);

  await performUnstuckStep({ bot: farmBot }, { stage: 1, jumpMs: 10, strafeMs: 10 });
  assert.equal(jumpControls.length, 0);

  // 2. Enderman gaze avoidance lowers pitch/y target away from Enderman eye height
  let lookedPitch = null;
  const lookBot = {
    entity: { position: pos(0, 64, 0), yaw: 0, pitch: 0 },
    entities: { 9: { id: 9, name: 'enderman', position: pos(0, 64, -10) } },
    look: async (_yaw, pitch) => { lookedPitch = pitch; },
    lookAt: async (p) => { lookedPitch = p.y; },
  };
  assert.equal(wouldTriggerEnderman(lookBot, lookBot.entity.position, pos(0, 66.5, -10)), true);
  const humanizer = new MotorHumanizer(lookBot, { humanizer: { enabled: true, smoothLook: true, lookSteps: 1, lookStepMs: 0, lookJitterRad: 0 } });
  await humanizer.smoothLookAt(pos(0, 66.5, -10), { jitterRad: 0 });
  assert.ok(lookedPitch < 0, `should deflect gaze downward from Enderman head, got pitch=${lookedPitch}`);

  // 3. Threat priority & tactical actions (Witch rush, Creeper bow >= 4.5m, Skeleton shield + strafe weave)
  const botPos = pos(0, 64, 0);
  const witch = { id: 1, name: 'witch', distance: 8, position: pos(8, 64, 0), entity: { id: 1, name: 'witch', position: pos(8, 64, 0) } };
  const skel = { id: 2, name: 'skeleton', distance: 8, position: pos(0, 64, 8), entity: { id: 2, name: 'skeleton', position: pos(0, 64, 8) } };
  const picked = pickThreat({ entity: { position: botPos } }, [skel, witch], {});
  assert.equal(picked.name, 'witch');

  // Witch <= 12m forces melee rush even if Jev suggested bow
  const witchCtx = {
    config: { retreatHealth: 8, minConfidence: 0.3 },
    equipment: { armorMitigation: () => 0.5 },
    _canUseBow: () => true,
  };
  assert.equal(resolveJevDecision(witchCtx, { action: 'bow', confidence: 0.9 }, [witch], witch, null, 20).action, 'melee');

  // Creeper >= 4.5m uses bow reflex when bow + arrow exist
  const bowBot = {
    entity: { position: pos(0, 64, 0), onGround: true, isInWater: false },
    heldItem: null,
    inventory: {
      slots: (() => { const s = new Array(46).fill(null); s[45] = { name: 'shield', count: 1 }; return s; })(),
      items: () => [{ name: 'bow', count: 1 }, { name: 'arrow', count: 16 }],
    },
    pathfinder: { setGoal: () => {} },
    activateItem: () => {},
    deactivateItem: () => {},
    setControlState: () => {},
    lookAt: async () => {},
    blockAt: () => ({ name: 'grass_block' }),
  };
  const combat = new CombatController(bowBot, { combat: { enabled: true, bow: true } }, { equipment: new EquipmentManager(bowBot, {}) });
  const creeperThreat = { id: 3, name: 'creeper', distance: 9, position: pos(9, 64, 0), entity: { id: 3, name: 'creeper', position: pos(9, 64, 0) } };
  assert.equal(combat._localReflexDecision(creeperThreat, [creeperThreat], 20, { posture: 'aggressive' }).action, 'bow');

  // Advancing toward Skeleton at 10m raises shield and triggers lateral strafe weave
  const strafes = [];
  const skelEntity = { id: 2, name: 'skeleton', position: pos(10, 64, 0) };
  bowBot.entities = { 2: skelEntity };
  combat.humanizer = new MotorHumanizer(
    { ...bowBot, setControlState: (k, v) => { if (v) strafes.push(k); } },
    { humanizer: { enabled: true, combatStrafe: true, strafeCooldownMs: 0, strafeDurationMs: 5 } }
  );
  await applyDecision(combat, { action: 'melee', targetId: 2 }, { id: 2, entity: skelEntity, distance: 10 }, null);
  assert.equal(combat.shieldActive, true);
  assert.ok(strafes.some((k) => k === 'left' || k === 'right'), `should weave laterally toward skeleton, got ${JSON.stringify(strafes)}`);
});
