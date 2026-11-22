import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatController, evaluateThreatScore } from '../src/combat.js';

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); },
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

function makeBot() {
  const entities = {};
  const slots = new Array(46).fill(null);
  return {
    entities,
    players: {},
    health: 20,
    food: 20,
    saturation: 5,
    entity: { position: pos(0, 64, 0), onGround: true, velocity: { y: 0 }, yaw: 0 },
    inventory: { items: () => [], slots },
    pathfinder: { setGoal: () => {} },
    equip: async () => {},
    lookAt: async () => {},
    look: async () => {},
    attack: async () => {},
    setControlState: () => {},
    activateItem: () => {},
    deactivateItem: () => {},
    placeBlock: async () => {},
    blockAt: () => null,
  };
}

test('combat starts and stops without crashing', async () => {
  const bot = makeBot();
  const combat = new CombatController(bot, { combat: { enabled: true, radius: 16 } }, { log: () => {} });
  combat.start();
  assert.equal(combat.running, true);
  combat.stop();
  assert.equal(combat.running, false);
  assert.equal(combat.busy, false);
});

test('no mobs means not busy', async () => {
  const bot = makeBot();
  const combat = new CombatController(bot, { combat: { enabled: true } }, { log: () => {} });
  combat.start();
  await combat.tick({ health: 20, nearby: [], owner: 'player' });
  assert.equal(combat.busy, false);
  combat.stop();
});

test('picks highest scored threat', () => {
  const bot = makeBot();
  const combat = new CombatController(bot, { combat: { enabled: true, radius: 16 } }, { log: () => {} });
  bot.entities.zombie = { id: 1, name: 'zombie', type: 'mob', health: 20, position: pos(2, 64, 0), target: null };
  bot.entities.creeper = { id: 2, name: 'creeper', type: 'mob', health: 20, position: pos(1, 64, 0), target: bot.entity };
  const threat = combat._pickThreat(combat._nearbyMobs(), {});
  assert.equal(threat.name, 'creeper');
  combat.stop();
});

test('retreat with string owner moves toward owner entity without crashing', async () => {
  const bot = makeBot();
  let lastGoal = null;
  bot.pathfinder.setGoal = (goal) => { lastGoal = goal; };
  bot.players.araslime = { entity: { id: 99, username: 'araslime', position: pos(10, 64, 0) } };
  bot.entities[1] = { id: 1, name: 'zombie', type: 'mob', health: 20, position: pos(2, 64, 0) };
  bot.health = 5;

  const combat = new CombatController(bot, { combat: { enabled: true, retreatHealth: 8, defendOwner: true } }, { log: () => {} });
  combat.start();
  await combat.tick({ owner: 'araslime' });

  assert.ok(lastGoal);
  assert.equal(lastGoal.x, 10);
  combat.stop();
});

test('creeper within 4 blocks raises shield with activateItem(true)', async () => {
  const bot = makeBot();
  const shield = { name: 'shield', slot: 10 };
  bot.inventory.items = () => [shield];
  const calls = [];
  bot.equip = async (item, dest) => {
    calls.push(['equip', item.name, dest]);
    if (dest === 'off-hand') bot.inventory.slots[45] = item;
  };
  bot.activateItem = (offHand) => { calls.push(['activate', offHand]); };
  bot.entities[2] = { id: 2, name: 'creeper', type: 'mob', health: 20, position: pos(3, 64, 0) };

  const combat = new CombatController(bot, { combat: { enabled: true } }, { log: () => {} });
  combat.start();
  await combat.tick({ owner: 'araslime' });

  assert.deepEqual(calls, [['equip', 'shield', 'off-hand'], ['activate', true]]);
  combat.stop();
});

test('bow decision shoots bow from inventory when arrows exist and idle does not attack', async () => {
  const bot = makeBot();
  const bow = { name: 'bow', slot: 11 };
  const arrow = { name: 'arrow', count: 16, slot: 12 };
  bot.inventory.items = () => [bow, arrow];
  const actions = [];
  bot.equip = async (item, dest) => { actions.push(['equip', item.name, dest]); };
  bot.activateItem = (offHand) => { actions.push(['activate', offHand]); };
  bot.deactivateItem = () => { actions.push(['deactivate']); };
  bot.attack = async () => { actions.push(['attack']); };
  bot.entities[3] = { id: 3, name: 'skeleton', type: 'mob', health: 20, position: pos(10, 64, 0) };

  let nextAction = 'bow';
  const combat = new CombatController(bot, { combat: { enabled: true, jevIntervalMs: 0 } }, {
    jev: { chooseCombat: async () => ({ action: nextAction, targetId: 3 }) },
    bowChargeMs: 5,
  });
  combat.start();
  await combat.tick({ owner: 'araslime' });
  assert.deepEqual(actions, [['equip', 'bow', 'hand'], ['activate', false], ['deactivate']]);

  nextAction = 'idle';
  await combat.tick({ owner: 'araslime' });
  await new Promise(r => setTimeout(r, 10));
  actions.length = 0;
  await combat.tick({ owner: 'araslime' });
  assert.deepEqual(actions, []);
  assert.equal(combat.busy, false);
  combat.stop();
});

test('jevState passed to chooseCombat is JSON-serializable even with circular entity refs', async () => {
  const bot = makeBot();
  const mob = { id: 4, name: 'zombie', type: 'mob', health: 20, position: pos(3, 64, 0) };
  mob.self = mob;
  bot.entities[4] = mob;

  let receivedState = null;
  const combat = new CombatController(bot, { combat: { enabled: true, jevIntervalMs: 0 } }, {
    jev: {
      chooseCombat: async (s) => {
        receivedState = s;
        return { action: 'idle' };
      },
    },
  });
  combat.start();
  await combat.tick({ owner: 'araslime' });

  assert.doesNotThrow(() => JSON.stringify(receivedState));
  combat.stop();
});

test('dangerous fall triggers emergency water bucket', async () => {
  const bot = makeBot();
  const bucket = { name: 'water_bucket', slot: 12 };
  bot.inventory.items = () => [bucket];
  bot.entity.onGround = false;
  bot.entity.velocity = { y: -0.9 };
  const calls = [];
  bot.equip = async (item, dest) => { calls.push(['equip', item.name, dest]); };
  bot.look = async (yaw, pitch) => { calls.push(['look', pitch < 0]); };
  bot.activateItem = (offHand) => { calls.push(['activate', offHand]); };

  const combat = new CombatController(bot, { combat: { enabled: true } });
  combat.start();
  await combat.tick({});

  assert.deepEqual(calls, [['equip', 'water_bucket', 'hand'], ['look', true], ['activate', false]]);
  combat.stop();
});

test('combat tick does not block on slow LLM planner and still attacks via local reflex', async () => {
  const bot = makeBot();
  let attacked = 0;
  bot.attack = async () => { attacked++; };
  bot.entities[5] = { id: 5, name: 'zombie', type: 'mob', health: 20, position: pos(2, 64, 0) };

  let resolvePlanner;
  const combat = new CombatController(bot, { combat: { enabled: true, crit: false, jevIntervalMs: 0 } }, {
    jev: {
      chooseCombat: () => new Promise(r => { resolvePlanner = r; }),
    },
  });
  combat.start();

  const start = Date.now();
  await combat.tick({ owner: 'araslime' });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 50, `tick took too long (${elapsed}ms)`);
  assert.equal(attacked, 1);

  resolvePlanner?.({ action: 'melee' });
  await new Promise(r => setTimeout(r, 10));
  combat.stop();
});

test('combat preserves external pathfinder goal if combat never took pathfinder, and notifies onBusyChange', async () => {
  const bot = makeBot();
  const goalCalls = [];
  bot.pathfinder.setGoal = (g) => { goalCalls.push(g); };
  bot.entities[6] = { id: 6, name: 'zombie', type: 'mob', health: 20, position: pos(2, 64, 0) };

  const busyLog = [];
  const combat = new CombatController(bot, { combat: { enabled: true, crit: false } }, {
    onBusyChange: ({ busy }) => busyLog.push(busy),
  });
  combat.start();
  await combat.tick({ owner: 'araslime' });
  delete bot.entities[6];
  await combat.tick({ owner: 'araslime' });

  assert.deepEqual(busyLog, [true, false]);
  assert.deepEqual(goalCalls, []);
  combat.stop();
});

test('crit jumps when onGround and attacks immediately when already falling', async () => {
  const bot = makeBot();
  const events = [];
  bot.setControlState = (k, v) => events.push(['ctrl', k, v]);
  bot.attack = async () => events.push(['attack']);
  bot.entities[7] = { id: 7, name: 'zombie', type: 'mob', health: 20, position: pos(2, 64, 0) };

  const combat = new CombatController(bot, { combat: { enabled: true, crit: true } }, { critJumpMs: 5 });
  combat.start();
  await combat.tick({});
  assert.deepEqual(events, [['ctrl', 'jump', true], ['ctrl', 'jump', false], ['attack']]);

  events.length = 0;
  combat.lastAttackAt = 0;
  bot.entity.onGround = false;
  bot.entity.velocity = { y: -0.3 };
  await combat.tick({});
  assert.deepEqual(events, [['attack']]);
  combat.stop();
});

test('owner hurt boosts priority of mob near owner and jev network error falls back cleanly', async () => {
  const bot = makeBot();
  const attacked = [];
  bot.attack = async (t) => attacked.push(t.id);
  bot.players.araslime = { entity: { id: 99, username: 'araslime', position: pos(4.5, 64, 0), health: 20 } };
  bot.entities[1] = { id: 1, name: 'zombie', type: 'mob', health: 20, position: pos(1.5, 64, 0) };
  bot.entities[2] = { id: 2, name: 'zombie', type: 'mob', health: 20, position: pos(4, 64, 0) };

  const combat = new CombatController(bot, { combat: { enabled: true, crit: false, jevIntervalMs: 0 } }, {
    jev: { chooseCombat: async () => { throw new Error('network down'); } },
  });
  combat.start();
  await combat.tick({ owner: 'araslime' });

  // Simulate owner taking damage
  bot.players.araslime.entity.health = 14;
  combat.lastAttackAt = 0;
  await combat.tick({ owner: 'araslime' });
  await new Promise(r => setTimeout(r, 10));

  assert.equal(combat.targetId, 2);
  assert.ok(attacked.includes(2));
  combat.stop();
});

test('bow decision falls back to melee when enemy closes to <= 4 blocks, and stop() aborts bow charge', async () => {
  const bot = makeBot();
  const bow = { name: 'bow', slot: 10 };
  const arrow = { name: 'arrow', count: 8, slot: 11 };
  bot.inventory.items = () => [bow, arrow];
  let attacked = 0;
  let deactivated = 0;
  bot.attack = async () => { attacked++; };
  bot.deactivateItem = () => { deactivated++; };
  bot.entities[8] = { id: 8, name: 'skeleton', type: 'mob', health: 20, position: pos(3, 64, 0) };

  const combat = new CombatController(bot, { combat: { enabled: true, crit: false, jevIntervalMs: 0 } }, {
    jev: { chooseCombat: async () => ({ action: 'bow', targetId: 8 }) },
    bowChargeMs: 80,
  });
  combat.start();
  await combat.tick({});
  await new Promise(r => setTimeout(r, 10));
  await combat.tick({});
  assert.ok(attacked >= 1);

  // Move skeleton far and stop mid-charge
  bot.entities[8].position = pos(10, 64, 0);
  const chargeTick = combat.tick({});
  await new Promise(r => setTimeout(r, 10));
  combat.stop();
  await chargeTick;
  assert.ok(deactivated >= 1);
});

test('retreat runs away from threat when owner is absent or defendOwner is false', async () => {
  const bot = makeBot();
  let goalSet = null;
  bot.pathfinder.setGoal = (g) => { goalSet = g; };
  bot.entities[9] = { id: 9, name: 'zombie', type: 'mob', health: 20, position: pos(3, 64, 0) };
  bot.health = 4;

  const combat = new CombatController(bot, { combat: { enabled: true, retreatHealth: 8, defendOwner: false } });
  combat.start();
  await combat.tick({});
  assert.ok(goalSet);
  assert.ok(goalSet.x < 0, `expected fleeing in -x direction, got ${goalSet.x}`);
  combat.stop();
});

test('1.21.1 entity filter attacks hostile/phantom, ignores iron_golem and neutral enderman/piglin', () => {
  const bot = makeBot();
  bot.entities.golem = { id: 1, name: 'iron_golem', type: 'mob', kind: 'Passive mobs', health: 100, position: pos(2, 64, 0) };
  bot.entities.enderman = { id: 2, name: 'enderman', type: 'hostile', kind: 'Hostile mobs', health: 40, position: pos(5, 64, 0), target: null };
  bot.entities.piglin = { id: 3, name: 'zombified_piglin', type: 'hostile', kind: 'Hostile mobs', health: 20, position: pos(4, 64, 0), target: null };
  bot.entities.zombie = { id: 4, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', health: 20, position: pos(6, 64, 0) };
  bot.entities.phantom = { id: 5, name: 'phantom', type: 'mob', kind: 'Hostile mobs', health: 20, position: pos(8, 64, 0) };

  const combat = new CombatController(bot, { combat: { enabled: true, radius: 16 } });
  const mobs = combat._nearbyMobs(null).map(m => m.name);
  assert.deepEqual(mobs, ['zombie', 'phantom']);

  // Aggroed enderman IS targeted
  bot.entities.enderman.target = bot.entity;
  const mobsAggro = combat._nearbyMobs(null).map(m => m.name);
  assert.ok(mobsAggro.includes('enderman'));
  combat.stop();
});

test('creeper without shield triggers immediate flee instead of freezing', async () => {
  const bot = makeBot();
  let fleeGoal = null;
  bot.pathfinder.setGoal = (g) => { fleeGoal = g; };
  bot.entities[1] = { id: 1, name: 'creeper', type: 'hostile', health: 20, position: pos(3, 64, 0) };

  const combat = new CombatController(bot, { combat: { enabled: true, shieldAgainstCreeper: true } });
  combat.start();
  await combat.tick({});
  assert.ok(fleeGoal);
  assert.ok(fleeGoal.x < 0, `expected fleeing away from creeper, got ${fleeGoal.x}`);
  combat.stop();
});

test('bow with zero arrows falls back to melee/moveClose, while infinity bow works without arrows', async () => {
  const bot = makeBot();
  const emptyBow = { name: 'bow', slot: 10 };
  bot.inventory.items = () => [emptyBow];
  let moved = false;
  let activated = false;
  bot.pathfinder.setGoal = () => { moved = true; };
  bot.activateItem = () => { activated = true; };
  bot.entities[1] = { id: 1, name: 'skeleton', type: 'hostile', health: 20, position: pos(10, 64, 0) };

  const combat = new CombatController(bot, { combat: { enabled: true, bow: true } }, { bowChargeMs: 5 });
  combat.start();
  await combat.tick({});
  assert.equal(activated, false);
  assert.equal(moved, true);

  // Now equip Infinity bow (with BigInt in nbt)
  const infBow = { name: 'bow', slot: 10, nbt: { id: 1n, Enchantments: [{ id: 'minecraft:infinity' }] } };
  bot.inventory.items = () => [infBow];
  await combat.tick({});
  assert.equal(activated, true);
  combat.stop();
});

test('swarmed by 3+ mobs at moderate-low health or encountering warden triggers shield + retreat', async () => {
  const bot = makeBot();
  const shield = { name: 'shield', slot: 10 };
  bot.inventory.items = () => [shield];
  bot.health = 11;
  let shieldRaised = false;
  let goalSet = null;
  bot.activateItem = (offHand) => { if (offHand) shieldRaised = true; };
  bot.pathfinder.setGoal = (g) => { goalSet = g; };

  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile', health: 20, position: pos(3, 64, 0) };
  bot.entities[2] = { id: 2, name: 'zombie', type: 'hostile', health: 20, position: pos(3, 64, 1) };
  bot.entities[3] = { id: 3, name: 'skeleton', type: 'hostile', health: 20, position: pos(4, 64, 0) };

  const combat = new CombatController(bot, { combat: { enabled: true, retreatHealth: 8 } });
  combat.start();
  await combat.tick({});
  assert.equal(shieldRaised, true);
  assert.ok(goalSet);
  assert.ok(goalSet.x < 0);

  // Full health vs Warden still retreats
  bot.health = 20;
  shieldRaised = false;
  goalSet = null;
  bot.entities = { 10: { id: 10, name: 'warden', type: 'hostile', health: 500, position: pos(8, 64, 0) } };
  await combat.tick({});
  assert.equal(shieldRaised, true);
  assert.ok(goalSet && goalSet.x < 0);
  combat.stop();
});

test('_fleeFrom avoids lava behind bot and chooses safe side escape angle', async () => {
  const bot = makeBot();
  let goalSet = null;
  bot.pathfinder.setGoal = (g) => { goalSet = g; };
  bot.blockAt = (p) => {
    // Straight -x behind bot (x < -4, |z| <= 2) is lava!
    if (p.x < -4 && Math.abs(p.z) <= 2) return { name: 'lava' };
    if (p.y < 64) return { name: 'stone' };
    return { name: 'air' };
  };
  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile', health: 20, position: pos(3, 64, 0) };
  bot.health = 4;

  const combat = new CombatController(bot, { combat: { enabled: true, retreatHealth: 8, defendOwner: false } });
  combat.start();
  await combat.tick({});
  assert.ok(goalSet);
  assert.ok(Math.abs(goalSet.z) > 2, `expected angled escape avoiding lava, got (${goalSet.x}, ${goalSet.z})`);
  combat.stop();
});

test('underwater combat disables jump-crit and stops chasing when oxygen is low', async () => {
  const bot = makeBot();
  let jumped = false;
  let attacked = 0;
  bot.setControlState = (k, v) => { if (k === 'jump' && v) jumped = true; };
  bot.attack = async () => { attacked++; };
  bot.entity.isInWater = true;
  bot.oxygenLevel = 20;
  bot.entities[1] = { id: 1, name: 'drowned', type: 'hostile', health: 20, position: pos(2, 64, 0) };

  const combat = new CombatController(bot, { combat: { enabled: true, crit: true } });
  combat.start();
  await combat.tick({});
  assert.equal(jumped, false);
  assert.equal(attacked, 1);

  // Low oxygen -> stop fighting so survival can surface
  attacked = 0;
  combat.lastAttackAt = 0;
  bot.oxygenLevel = 6;
  await combat.tick({});
  assert.equal(attacked, 0);
  combat.stop();
});

test('advancing toward distant skeleton raises shield while closing distance', async () => {
  const bot = makeBot();
  const shield = { name: 'shield', slot: 10 };
  bot.inventory.items = () => [shield];
  let shieldRaised = false;
  let movedGoal = null;
  bot.activateItem = (offHand) => { if (offHand) shieldRaised = true; };
  bot.pathfinder.setGoal = (g) => { movedGoal = g; };
  bot.entities[1] = { id: 1, name: 'skeleton', type: 'hostile', health: 20, position: pos(12, 64, 0) };

  const combat = new CombatController(bot, { combat: { enabled: true } });
  combat.start();
  await combat.tick({});
  assert.equal(shieldRaised, true);
  assert.ok(movedGoal);
  combat.stop();
});

test('combat skips equipMelee/attack while isEating() is true so eating is not interrupted', async () => {
  const bot = makeBot();
  let attacked = 0;
  let equipped = 0;
  bot.attack = async () => { attacked++; };
  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile', health: 20, position: pos(2, 64, 0) };

  let eating = true;
  const combat = new CombatController(bot, { combat: { enabled: true, crit: false } }, {
    equipment: { equipMelee: async () => { equipped++; } },
    isEating: () => eating,
  });
  combat.start();
  await combat.tick({});
  assert.equal(equipped, 0);
  assert.equal(attacked, 0);

  eating = false;
  await combat.tick({});
  assert.equal(equipped, 1);
  assert.equal(attacked, 1);
  combat.stop();
});

test('jev planner skips trivial 1-zombie melee fight and honors useCausality: false', async () => {
  const bot = makeBot();
  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile', health: 20, position: pos(2, 64, 0) };
  let jevCalls = 0;

  const combat = new CombatController(bot, { combat: { enabled: true, jevIntervalMs: 4000, useCausality: true } }, {
    jev: { chooseCombat: async () => { jevCalls++; return { action: 'melee' }; } },
  });
  combat.start();
  await combat.tick({});
  assert.equal(jevCalls, 0);

  // Now 2 mobs -> complex situation triggers Jev
  bot.entities[2] = { id: 2, name: 'skeleton', type: 'hostile', health: 20, position: pos(8, 64, 0) };
  await combat.tick({});
  await new Promise(r => setTimeout(r, 10));
  assert.equal(jevCalls, 1);

  // useCausality: false disables Jev even with 2 mobs
  const noJev = new CombatController(bot, { combat: { enabled: true, jevIntervalMs: 0, useCausality: false } }, {
    jev: { chooseCombat: async () => { jevCalls++; return { action: 'melee' }; } },
  });
  noJev.start();
  await noJev.tick({});
  assert.equal(jevCalls, 1);
  combat.stop();
  noJev.stop();
});

test('combat enforces Jev confidence gating, urgentRetreat, danger score, focus target, and telemetry', async () => {
  const bot = makeBot();
  const attacked = [];
  let goalSet = null;
  bot.attack = async (t) => attacked.push(t.id);
  bot.pathfinder.setGoal = (g) => { goalSet = g; };
  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile', health: 20, position: pos(2, 64, 0) };
  bot.entities[2] = { id: 2, name: 'skeleton', type: 'hostile', health: 20, position: pos(3.5, 64, 0) };

  let nextJev = { action: 'idle', confidence: 0.15, focus: 'ranged', danger: 1.0, urgentRetreat: 0.1 };
  const combat = new CombatController(bot, { combat: { enabled: true, crit: false, minConfidence: 0.3, jevIntervalMs: 0 } }, {
    jev: { chooseCombat: async () => nextJev },
  });
  combat.start();

  // First tick queues Jev; wait for resolution
  await combat.tick({});
  await new Promise(r => setTimeout(r, 10));
  attacked.length = 0;

  // Confidence 0.15 < 0.3 -> ignores 'idle' and attacks via local reflex
  combat.lastAttackAt = 0;
  await combat.tick({});
  assert.equal(attacked.length, 1);
  assert.equal(combat.lastJevTelemetry?.action, 'idle');

  // High confidence focusing ranged skeleton
  nextJev = { action: 'melee', confidence: 0.85, focus: 'ranged', danger: 1.5, urgentRetreat: 0.2 };
  combat.lastAttackAt = 0;
  await combat.tick({});
  await new Promise(r => setTimeout(r, 10));
  attacked.length = 0;
  combat.lastAttackAt = 0;
  await combat.tick({});
  assert.deepEqual(attacked, [2]);

  // Urgent retreat overrides melee
  nextJev = { action: 'melee', confidence: 0.9, focus: 'closest', danger: 2.8, urgentRetreat: 0.9 };
  await combat.tick({});
  await new Promise(r => setTimeout(r, 10));
  goalSet = null;
  await combat.tick({});
  assert.ok(goalSet);
  assert.ok(goalSet.x < 0);
  combat.stop();
});

test('retreat hysteresis keeps combat busy while mob lingers in radius+6 buffer and clears once far', async () => {
  const bot = makeBot();
  bot.health = 5; // forces _retreat
  bot.entities[1] = { id: 1, name: 'zombie', type: 'mob', health: 20, position: pos(4, 64, 0) };

  const busyLog = [];
  const combat = new CombatController(bot, { combat: { enabled: true, radius: 16, retreatHealth: 8, defendOwner: false } }, {
    onBusyChange: ({ busy }) => busyLog.push(busy),
  });
  combat.start();
  await combat.tick({});
  assert.equal(combat.busy, true);
  assert.deepEqual(busyLog, [true]);

  // Mob is now just outside radius (16), inside radius+6 (22): stay busy so task doesn't yo-yo back in
  bot.entities[1].position = pos(19, 64, 0);
  await combat.tick({});
  assert.equal(combat.busy, true);
  assert.deepEqual(busyLog, [true]);

  // Mob moves well past buffer (>22): release combat busy cleanly
  bot.entities[1].position = pos(25, 64, 0);
  await combat.tick({});
  assert.equal(combat.busy, false);
  assert.deepEqual(busyLog, [true, false]);
  combat.stop();
});

test('distant low-confidence Jev retreat at high health resolves to idle instead of fleeing', async () => {
  const bot = makeBot();
  bot.health = 20;
  bot.entities[1] = { id: 1, name: 'zombie', type: 'mob', health: 20, position: pos(14, 64, 0) };

  let goalSet = null;
  bot.pathfinder.setGoal = (g) => { goalSet = g; };
  const combat = new CombatController(bot, {
    combat: { enabled: true, radius: 16, retreatHealth: 8, minConfidence: 0.3, jevIntervalMs: 0, alwaysUseJev: true },
  }, {
    jev: {
      chooseCombat: async () => ({
        action: 'retreat',
        confidence: 0.47,
        danger: 1.0,
        urgentRetreat: 0.1,
        focus: 'closest',
      }),
    },
  });

  combat.start();
  await combat.tick({});
  await new Promise(r => setTimeout(r, 15));
  goalSet = null;
  await combat.tick({});

  assert.equal(combat.busy, false);
  assert.equal(goalSet, null);
  combat.stop();
});

test('combat filters underground and occluded cave mobs while keeping flying or aggro threats', () => {
  const bot = makeBot();
  bot.blockAt = (p) => {
    // Solid stone ceiling between bot (y=65.5) and shallow cave mob (y=61)
    if (Math.floor(p.y) >= 62 && Math.floor(p.y) <= 64 && Math.floor(p.x) >= 1) {
      return { name: 'stone', boundingBox: 'block', position: p };
    }
    return { name: 'air', boundingBox: 'empty', position: p };
  };

  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile', health: 20, position: pos(2, 55, 0) }; // dy = -9 deep cave
  bot.entities[2] = { id: 2, name: 'skeleton', type: 'hostile', health: 20, position: pos(3, 61, 0) }; // dy = -3 behind stone
  bot.entities[3] = { id: 3, name: 'phantom', type: 'hostile', health: 20, position: pos(2, 74, 0) }; // flying dy = +10
  bot.entities[4] = { id: 4, name: 'spider', type: 'hostile', health: 20, position: pos(3, 55, 0), target: bot.entity }; // aggro

  const combat = new CombatController(bot, { combat: { enabled: true, radius: 16 } }, { log: () => {} });
  const mobs = combat._nearbyMobs();
  assert.deepEqual(mobs.map(m => m.id).sort((a, b) => a - b), [3, 4]);
  combat.stop();
});

test('medium-distance low-confidence Jev retreat (32%, danger=0.9) at full health resolves to idle', async () => {
  const bot = makeBot();
  bot.health = 20;
  bot.entities[1] = { id: 1, name: 'zombie', type: 'mob', health: 20, position: pos(8, 64, 0) };

  let goalSet = null;
  bot.pathfinder.setGoal = (g) => { goalSet = g; };
  const combat = new CombatController(bot, {
    combat: { enabled: true, radius: 16, retreatHealth: 8, minConfidence: 0.3, jevIntervalMs: 0, alwaysUseJev: true },
  }, {
    jev: {
      chooseCombat: async () => ({
        action: 'retreat',
        confidence: 0.32,
        danger: 0.9,
        urgentRetreat: 0.1,
        focus: 'closest',
      }),
    },
  });

  combat.start();
  await combat.tick({});
  await new Promise(r => setTimeout(r, 15));
  goalSet = null;
  await combat.tick({});

  assert.equal(combat.busy, false);
  assert.equal(goalSet, null);
  combat.stop();
});

test('evaluateThreatScore computes posture bands across health/armor and combat updates lastThreatAssessment + smart weapon', async () => {
  // 1 zombie (D=3, M=1) at H=20 -> T = 3/20 = 0.15 -> aggressive
  const agg = evaluateThreatScore([{ name: 'zombie' }], { health: 20, armorMitigation: 0 });
  assert.equal(agg.posture, 'aggressive');
  assert.ok(agg.score < 0.6);

  // 2 skeletons (2 * 4 * 1.8 = 14.4) at H=18, A=0 -> T = 0.8 -> kite
  const kite = evaluateThreatScore([{ name: 'skeleton' }, { name: 'skeleton' }], { health: 18, armorMitigation: 0 });
  assert.equal(kite.posture, 'kite');
  assert.ok(kite.score >= 0.6 && kite.score < 1.2);

  // With heavy armor (A=0.6): 14.4 / (18 * 1.6) = 0.5 -> aggressive
  const armored = evaluateThreatScore([{ name: 'skeleton' }, { name: 'skeleton' }], { health: 18, armorMitigation: 0.6 });
  assert.equal(armored.posture, 'aggressive');

  // Creeper + 2 zombies at H=20 -> (30 + 6)/20 = 1.8 -> retreat
  const ret = evaluateThreatScore([{ name: 'creeper' }, { name: 'zombie' }, { name: 'zombie' }], { health: 20, armorMitigation: 0 });
  assert.equal(ret.posture, 'retreat');
  assert.ok(ret.score >= 1.2);

  const bot = makeBot();
  bot.health = 20;
  bot.entities[1] = { id: 1, name: 'zombie', type: 'mob', health: 20, position: pos(2, 64, 0) };
  bot.entities[2] = { id: 2, name: 'zombie', type: 'mob', health: 20, position: pos(2.5, 64, 0) };
  let weaponSituations = [];
  const equipment = {
    armorMitigation: () => 0.4,
    equipWeaponForSituation: async (opts) => {
      weaponSituations.push(opts);
      return { equipped: true, weapon: 'iron_sword', reason: 'sweep' };
    },
  };

  const combat = new CombatController(bot, { combat: { enabled: true, crit: false, useCausality: false } }, { equipment, log: () => {} });
  combat.start();
  await combat.tick({});
  assert.ok(combat.lastThreatAssessment);
  assert.equal(combat.lastThreatAssessment.mobCount, 2);
  assert.equal(weaponSituations.length, 1);
  assert.equal(weaponSituations[0].mobCount, 2);
  combat.stop();
});
