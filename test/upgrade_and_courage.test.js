import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';

import { CombatController } from '../src/combat/index.js';
import { evaluateThreatScore, resolveJevDecision } from '../src/combat/threat_assessment.js';
import { EquipmentManager } from '../src/equipment.js';
import { Memory } from '../src/memory.js';
import { CompanionManager } from '../src/companion.js';
import { SurvivalManager } from '../src/survival/index.js';
import { giveToOwner } from '../src/survival/gather.js';
import { formatCompactStateSnapshot, buildWakePrompt } from '../src/mcp/antigravity_bridge.js';

function makeZombie(id, x, z, distFromOrigin = null) {
  return {
    id,
    name: 'zombie',
    type: 'mob',
    position: new Vec3(x, 64, z),
    distance: distFromOrigin ?? Math.hypot(x, z),
    velocity: new Vec3(0, 0, 0),
    isValid: true,
  };
}

function makeDiamondBot({ health = 20 } = {}) {
  const bot = new EventEmitter();
  bot.username = 'bot_dong_hanh';
  bot.health = health;
  bot.food = 20;
  bot.isAlive = true;
  bot.isSleeping = false;
  bot.heldItem = { name: 'diamond_sword', count: 1 };
  bot.time = { timeOfDay: 6000, age: 6000 };
  bot.game = { dimension: 'overworld' };
  bot.entity = { position: new Vec3(0, 64, 0), onGround: true, velocity: { y: 0 }, yaw: 0 };
  bot.entities = {};
  bot.players = {};
  const slots = new Array(46).fill(null);
  slots[5] = { name: 'diamond_helmet', count: 1 };
  slots[6] = { name: 'diamond_chestplate', count: 1 };
  slots[7] = { name: 'diamond_leggings', count: 1 };
  slots[8] = { name: 'diamond_boots', count: 1 };
  slots[45] = { name: 'shield', count: 1 };
  bot.inventory = {
    slots,
    items: () => [{ name: 'diamond_sword', count: 1 }, { name: 'cooked_beef', count: 16 }],
    emptySlotCount: () => 25,
  };
  bot.pathfinder = {
    setMovements: () => {},
    setGoal: () => {},
    isMoving: () => false,
  };
  bot.lookAt = async () => {};
  bot.attack = () => {};
  bot.activateItem = () => {};
  bot.deactivateItem = () => {};
  bot.equip = async () => {};
  bot.blockAt = (p) => (Math.floor(p.y) < 64
    ? { name: 'grass_block', boundingBox: 'block', position: p }
    : { name: 'air', boundingBox: 'empty', position: p });
  return bot;
}

test('Combat courage scales with armor: diamond bot fights 4 zombies despite Jev panic', async () => {
  const fourZombies = [
    makeZombie(1, 2, 0, 2),
    makeZombie(2, -2, 0, 2),
    makeZombie(3, 0, 2, 2),
    makeZombie(4, 0, -2, 2),
  ];

  // 1. evaluateThreatScore uses real damage reduction H / (1 - min(0.82, A))
  const diamondEval = evaluateThreatScore(fourZombies, { health: 20, armorMitigation: 0.72 });
  assert.equal(diamondEval.posture, 'aggressive');
  assert.ok(diamondEval.score < 0.6, `expected score < 0.6, got ${diamondEval.score}`);

  // 2. resolveJevDecision overrides nervous retreat/urgentRetreat when armored and healthy
  const armoredCtx = {
    config: { retreatHealth: 8, minConfidence: 0.3 },
    equipment: { armorMitigation: () => 0.72 },
    lastThreatAssessment: diamondEval,
    _canUseBow: () => false,
    _localReflexDecision: () => ({ action: 'melee', targetId: 1 }),
  };
  const panicJev = { action: 'retreat', urgentRetreat: 0.9, danger: 3.1, confidence: 0.95 };
  const armoredDecision = resolveJevDecision(armoredCtx, panicJev, fourZombies, fourZombies[0], null, 18);
  assert.equal(armoredDecision.action, 'melee');

  // Still retreats if unarmored against same 4 zombies + urgentRetreat, or against close creeper
  const unarmoredCtx = { ...armoredCtx, equipment: { armorMitigation: () => 0 } };
  const unarmoredDecision = resolveJevDecision(unarmoredCtx, panicJev, fourZombies, fourZombies[0], null, 18);
  assert.equal(unarmoredDecision.action, 'retreat');

  const withCreeper = [...fourZombies.slice(0, 3), { id: 9, name: 'creeper', distance: 4 }];
  const creeperDecision = resolveJevDecision(armoredCtx, panicJev, withCreeper, withCreeper[3], null, 18);
  assert.equal(creeperDecision.action, 'retreat');

  // 3. CombatController._runTick does NOT swarm-retreat in diamond armor at 11 HP vs 4 zombies
  const bot = makeDiamondBot({ health: 11 });
  for (const z of fourZombies) bot.entities[z.id] = z;
  const equipment = new EquipmentManager(bot, {});
  let attacked = 0;
  let retreated = 0;
  const combat = new CombatController(bot, { retreatHealth: 8, radius: 16 }, {
    equipment,
    jev: { enabled: false },
  });
  combat._attack = async () => { attacked += 1; };
  combat._retreat = async () => { retreated += 1; };

  await combat._runTick();
  assert.equal(attacked, 1);
  assert.equal(retreated, 0);

  // At low HP <= retreatHealth (7 <= 8), diamond bot still retreats properly
  bot.health = 7;
  combat._busy = false;
  await combat._runTick();
  assert.equal(retreated, 1);
});

test('EquipmentManager handles worn durability, junk disposal, and self-upgrade planning', async () => {
  const tossed = [];
  const equipped = [];
  const items = [
    { name: 'diamond_sword', count: 1, maxDurability: 100, durabilityUsed: 95 }, // 5% dur left
    { name: 'iron_sword', count: 1, maxDurability: 100, durabilityUsed: 5 }, // 95% dur left
    { name: 'iron_chestplate', count: 1, maxDurability: 100, durabilityUsed: 2 },
    { name: 'rotten_flesh', count: 12 },
    { name: 'poisonous_potato', count: 2 },
    { name: 'andesite', count: 20 },
    { name: 'cobblestone', count: 64 },
    { name: 'cobblestone', count: 64 },
    { name: 'cobblestone', count: 32 },
    { name: 'diamond', count: 8 },
    { name: 'iron_ingot', count: 4 },
    { name: 'stick', count: 4 },
    { name: 'iron_pickaxe', count: 1 },
  ];
  const bot = {
    heldItem: null,
    inventory: {
      slots: (() => {
        const s = new Array(46).fill(null);
        s[6] = { name: 'iron_chestplate', count: 1, maxDurability: 100, durabilityUsed: 60 }; // 40% dur
        return s;
      })(),
      items: () => items,
    },
    equip: async (item, dest) => { equipped.push({ name: item.name, dest }); },
    tossStack: async (item) => { tossed.push(`${item.name}:${item.count}`); },
  };

  const eq = new EquipmentManager(bot, { inventory: { discardObsolete: true, blockStacks: 2 } });

  // Durability-aware equip prefers healthy iron_sword over nearly-broken diamond_sword
  await eq.equipMelee();
  assert.equal(equipped[0].name, 'iron_sword');

  // Fresh same-tier chestplate replaces worn chestplate
  await eq.maintainArmorAndShield();
  assert.ok(equipped.some((e) => e.name === 'iron_chestplate' && e.dest === 'torso'));

  // Junk disposal clears trash & excess cobble past 2 stacks while keeping diamonds/ingots/pickaxe
  const dropped = await eq.discardJunkItems();
  assert.ok(dropped.includes('rotten_flesh'));
  assert.ok(dropped.includes('poisonous_potato'));
  assert.ok(dropped.includes('andesite'));
  assert.ok(dropped.includes('cobblestone'));
  assert.ok(!dropped.includes('diamond'));
  assert.ok(!dropped.includes('iron_ingot'));
  assert.ok(!dropped.includes('iron_pickaxe'));

  // Upgrade planner wants diamond_sword first when no healthy diamond sword is owned (or shield / diamond_chestplate)
  // Notice inventory has nearly-broken diamond_sword (rank 4 exists so swordRank=4), shield missing + iron+woods absent -> diamond_chestplate!
  const plan = eq.planNextGearUpgrade();
  assert.equal(plan?.action, 'craft');
  assert.equal(plan?.item, 'diamond_chestplate');
});

test('CompanionManager.tickAutoUpgrade crafts & equips upgrade automatically', async () => {
  const events = [];
  const bot = makeDiamondBot();
  bot.inventory.slots[6] = null; // remove chestplate
  bot.inventory.items = () => [
    { name: 'diamond', count: 9 },
    { name: 'iron_pickaxe', count: 1 },
    { name: 'diamond_sword', count: 1 },
    { name: 'shield', count: 1 },
  ];
  bot.chat = (msg) => events.push(`chat:${msg}`);
  const eq = new EquipmentManager(bot, { inventory: { discardObsolete: true } });
  const ctx = {
    bot,
    config: { owner: 'araslime', companion: { autoUpgrade: true, idleLife: true, preserveInTests: true } },
    state: { stayPut: false, idleGoalActive: false },
    combat: { busy: false },
    survival: { busy: false },
    tasks: { active: null },
    equipment: eq,
    crafting: {
      craftItem: async (item, count) => {
        events.push(`craft:${item}x${count}`);
        return { name: item, count };
      },
    },
  };
  const companion = new CompanionManager(ctx, { enabledChat: true, enabledIdle: true });
  const res = await companion.tickAutoUpgrade(100000);
  assert.equal(res?.plan?.item, 'diamond_chestplate');
  assert.ok(events.includes('craft:diamond_chestplatex1'));
  assert.ok(events.some((e) => e.startsWith('chat:')));
});

test('giveToOwner 8s anti-steal window, stayPut pickup guard, and night escort rule', async () => {
  let lastGoal = null;
  const closeOwner = { position: new Vec3(2, 64, 0) };
  const farOwner = { position: new Vec3(50, 64, 0) };
  const bot = {
    heldItem: null,
    entity: { position: new Vec3(0, 64, 0) },
    time: { timeOfDay: 15000 }, // night!
    players: { araslime: { entity: closeOwner } },
    entities: {
      10: { id: 10, name: 'item', position: new Vec3(3, 64, 0) },
    },
    inventory: {
      items: () => [{ name: 'iron_ingot', count: 5, type: 100 }],
      emptySlotCount: () => 10,
    },
    pathfinder: {
      setGoal: (g) => { lastGoal = g; },
    },
    lookAt: async () => {},
    toss: async () => {},
    tossStack: async () => {},
  };

  const survival = new SurvivalManager(bot, { home: { autoReturn: true } }, {
    home: { get: () => new Vec3(100, 64, 100) },
  });

  // stayPut blocks pickup
  assert.equal(survival.pickupNearbyItem({ stayPut: true }), false);
  assert.equal(lastGoal, null);

  // Night autoReturn is skipped when owner is close (<= 24 blocks), triggered when owner is far
  assert.equal(survival.checkAutoReturnCondition({ busy: false, ownerEntity: closeOwner }), null);
  assert.deepEqual(survival.checkAutoReturnCondition({ busy: false, ownerEntity: farOwner }), { reason: 'trời đã tối' });

  // After giveToOwner, 8s cooldown prevents picking the tossed item back up
  const gave = await giveToOwner(survival, 'araslime', 'iron_ingot', 5);
  assert.equal(gave.count, 5);
  assert.ok(survival.lastGaveItemAt > 0);
  assert.equal(survival.pickupNearbyItem({ stayPut: false }), false);
  assert.equal(lastGoal, null);
});

test('CompanionManager steps out of owner crosshair and persists pronoun style across sessions', async () => {
  const mem = new Memory({ path: ':memory:' });
  await mem.load();

  let goalSet = null;
  const bot = makeDiamondBot();
  // Bot stands 2.5m directly in front of owner's yaw=0 gaze (-Z)
  bot.entity.position = new Vec3(0, 64, -2.5);
  bot.players = {
    araslime: {
      entity: { id: 99, username: 'araslime', position: new Vec3(0, 64, 0), yaw: 0, health: 20 },
    },
  };
  bot.pathfinder.setGoal = (g) => { goalSet = g; };

  const ctx1 = {
    bot,
    memory: mem,
    config: { owner: 'araslime', companion: { ambientChatter: false } },
    state: { stayPut: false, idleGoalActive: false },
    combat: { busy: false },
    survival: { busy: false, lastGaveItemAt: 0 },
    tasks: { active: null },
    equipment: new EquipmentManager(bot, {}),
    chatHistory: [],
  };

  const c1 = new CompanionManager(ctx1, { enabledChat: true, enabledIdle: true });
  const moved = await c1.tickIdle(50000);
  assert.equal(moved, true);
  assert.ok(goalSet != null, 'should set step-aside goal');
  assert.ok(Math.abs(goalSet.x) > 1, `should move laterally off X=0 crosshair, got x=${goalSet.x}`);

  // Pronoun persistence across fresh CompanionManager instance
  const pronouns = c1._resolvePronouns('ông đi đào sắt đi tui chờ');
  assert.deepEqual(pronouns, { self: 'tui', you: 'ông' });

  const c2 = new CompanionManager({ ...ctx1, chatHistory: [] }, { enabledChat: true, enabledIdle: false });
  assert.deepEqual(c2.getOwnerPronounStyle('araslime'), { self: 'tui', you: 'ông' });
  assert.deepEqual(c2._resolvePronouns('ok đi luôn'), { self: 'tui', you: 'ông' });

  const snapText = formatCompactStateSnapshot({
    health: 20,
    food: 20,
    ownerStyle: c2.getOwnerPronounStyle('araslime'),
  });
  assert.match(snapText, /xưng hô đã quen: tui\/ông/);

  const firstTurnPrompt = buildWakePrompt([{ kind: 'chat', username: 'araslime', message: 'hi' }], { health: 20 }, { isNewConversation: true });
  assert.match(firstTurnPrompt, /mc_say\(\{message/);
  const secondTurnPrompt = buildWakePrompt([{ kind: 'chat', username: 'araslime', message: 'ok' }], { health: 20 }, { isNewConversation: false });
  assert.doesNotMatch(secondTurnPrompt, /Tham số call_mcp_tool/);
});
