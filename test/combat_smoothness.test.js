import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatController } from '../src/combat.js';

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
    heldItem: null,
    entity: { position: pos(0, 64, 0), onGround: true, velocity: { y: 0 }, yaw: 0, isInWater: false },
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

test('resolveJevDecision overrides Jev false-retreat to melee at healthy HP vs zombies, while honoring real emergencies', async () => {
  const bot = makeBot();
  bot.health = 20;
  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile', health: 20, position: pos(2.4, 64, 0) };
  bot.entities[2] = { id: 2, name: 'zombie', type: 'hostile', health: 20, position: pos(2.8, 64, 0.5) };

  let attacked = 0;
  const goalsSet = [];
  bot.attack = async () => { attacked += 1; };
  bot.pathfinder.setGoal = (goal, dynamic) => { goalsSet.push({ goal, dynamic }); };

  let nextJev = { action: 'retreat', confidence: 0.98, danger: 1.8, urgentRetreat: 0.2, focus: 'closest' };
  const combat = new CombatController(
    bot,
    { combat: { enabled: true, crit: false, retreatHealth: 8, jevIntervalMs: 0 } },
    { jev: { chooseCombat: async () => nextJev }, log: () => {} }
  );
  combat.start();

  // Trigger async Jev and resolve decision
  await combat.tick({});
  await new Promise(r => setTimeout(r, 10));
  attacked = 0;
  goalsSet.length = 0;
  combat.lastAttackAt = 0;

  // At 20 HP vs 2 zombies, Jev 98% retreat is overridden to melee attack
  await combat.tick({});
  assert.equal(attacked, 1);
  assert.equal(goalsSet.length, 0);

  // urgentRetreat >= 0.75 still retreats
  nextJev = { action: 'retreat', confidence: 0.98, danger: 1.8, urgentRetreat: 0.85 };
  await combat.tick({});
  await new Promise(r => setTimeout(r, 10));
  attacked = 0;
  goalsSet.length = 0;
  await combat.tick({});
  assert.equal(attacked, 0);
  assert.ok(goalsSet.length >= 1 && goalsSet[0].goal.x < 0);

  // Low HP (<= 8) retreats regardless
  bot.health = 8;
  goalsSet.length = 0;
  await combat.tick({});
  assert.ok(goalsSet.length >= 1 && goalsSet[0].goal.x < 0);

  // Close creeper or warden still allows Jev retreat even at healthy HP
  bot.health = 20;
  nextJev = { action: 'retreat', confidence: 0.95, danger: 1.8, urgentRetreat: 0.1 };
  bot.entities[3] = { id: 3, name: 'creeper', type: 'hostile', health: 20, position: pos(5.2, 64, 0) };
  await combat.tick({});
  await new Promise(r => setTimeout(r, 10));
  goalsSet.length = 0;
  await combat.tick({});
  assert.ok(goalsSet.length >= 1 && goalsSet[0].goal.x < 0);

  delete bot.entities[3];
  bot.entities[4] = { id: 4, name: 'warden', type: 'hostile', health: 500, position: pos(10, 64, 0) };
  goalsSet.length = 0;
  await combat.tick({});
  assert.ok(goalsSet.length >= 1 && goalsSet[0].goal.x < 0);

  combat.stop();
});

test('retreat does not drag zombie onto unsafe owner, while retreating toward distant safe owner', async () => {
  const bot = makeBot();
  bot.health = 5;
  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile', health: 20, position: pos(4, 64, 0) };
  // Owner is standing right next to the zombie (unsafe to run into!)
  bot.players.araslime = { entity: { id: 99, username: 'araslime', position: pos(5, 64, 0) } };

  let lastGoal = null;
  bot.pathfinder.setGoal = (g) => { lastGoal = g; };

  const combat = new CombatController(
    bot,
    { combat: { enabled: true, retreatHealth: 8, defendOwner: true } },
    { log: () => {} }
  );
  combat.start();
  await combat.tick({ owner: 'araslime' });
  assert.ok(lastGoal);
  assert.ok(lastGoal.x < 0, `expected fleeing away (-x) instead of running into zombie at owner, got x=${lastGoal.x}`);

  // Move owner safely far away from the zombie (> bot->zombie + 1.5)
  bot.players.araslime.entity.position = pos(-12, 64, 0);
  bot.entities[1].position = pos(3, 64, 0);
  lastGoal = null;
  await combat.tick({ owner: 'araslime' });
  assert.ok(lastGoal);
  assert.equal(lastGoal.x, -12);

  combat.stop();
});

test('knockback dead-zone uses dynamic GoalFollow and holds swing beyond real melee reach until closing in', async () => {
  const bot = makeBot();
  bot._client = {}; // simulate real connection
  const sword = { name: 'iron_sword', slot: 36 };
  bot.heldItem = sword;
  bot.inventory.items = () => [sword];
  bot.entities[10] = { id: 10, name: 'zombie', type: 'hostile', health: 20, position: pos(3.6, 64, 0) };

  let attacked = 0;
  const goalsSet = [];
  bot.attack = async () => { attacked += 1; };
  bot.pathfinder.setGoal = (goal, dynamic) => { goalsSet.push({ goal, dynamic }); };

  const combat = new CombatController(
    bot,
    { combat: { enabled: true, crit: false, useCausality: false } },
    { log: () => {} }
  );
  combat.start();

  // At 3.6 blocks (inside old 4.5 dead-zone, beyond 3.25 survival reach): pursues with dynamic GoalFollow, does NOT swing at air
  await combat.tick({});
  assert.equal(attacked, 0);
  assert.equal(goalsSet.length, 1);
  assert.equal(goalsSet[0].dynamic, true);
  assert.equal(goalsSet[0].goal.entity, bot.entities[10]);

  // Next tick at 3.5 blocks following same target: does not spam setGoal again
  bot.entities[10].position = pos(3.5, 64, 0);
  await combat.tick({});
  assert.equal(attacked, 0);
  assert.equal(goalsSet.length, 1);

  // Zombie closes to 2.9 blocks -> lands hit smoothly
  bot.entities[10].position = pos(2.9, 64, 0);
  await combat.tick({});
  assert.equal(attacked, 1);

  combat.stop();
});

test('multi-mob sword combat stays grounded for sweep AoE while single-mob triggers falling-edge jumpCrit early', async () => {
  const bot = makeBot();
  bot.heldItem = { name: 'iron_sword', slot: 36 };
  const events = [];
  bot.setControlState = (k, v) => { events.push(['ctrl', k, v]); };
  bot.attack = async () => { events.push(['attack']); };

  // Two zombies -> grounded sweep (no jump)
  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile', health: 20, position: pos(2.2, 64, 0) };
  bot.entities[2] = { id: 2, name: 'zombie', type: 'hostile', health: 20, position: pos(2.4, 64, 0.5) };

  const combat = new CombatController(
    bot,
    { combat: { enabled: true, crit: true, useCausality: false } },
    { critJumpMs: 200, log: () => {} }
  );
  combat.start();
  await combat.tick({});
  assert.deepEqual(events, [['attack']]);

  // Single zombie -> triggers jumpCrit and exits early once velocity.y < 0 (!onGround)
  delete bot.entities[2];
  events.length = 0;
  combat.lastAttackAt = 0;
  setTimeout(() => {
    bot.entity.onGround = false;
    bot.entity.velocity = { y: -0.1 };
  }, 45);

  const startedAt = Date.now();
  await combat.tick({});
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 170, `expected early falling-edge crit (<170ms), took ${elapsed}ms`);
  assert.deepEqual(events, [['ctrl', 'jump', true], ['ctrl', 'jump', false], ['attack']]);

  combat.stop();
});
