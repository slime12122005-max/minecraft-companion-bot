import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MotorHumanizer,
  shortestAngleDelta,
  smoothStep,
  computeYawPitch,
  computeTypingDelayMs,
} from '../src/humanizer.js';
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

function makeHumanizerBot() {
  const looks = [];
  const instantLookAts = [];
  const controls = [];
  return {
    looks,
    instantLookAts,
    controls,
    entities: {},
    players: {},
    health: 20,
    food: 20,
    entity: {
      position: pos(0, 64, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      velocity: { y: 0 },
      isInWater: false,
    },
    inventory: { items: () => [], slots: new Array(46).fill(null) },
    pathfinder: { setGoal: () => {} },
    equip: async () => {},
    look: async (yaw, pitch, force) => {
      looks.push({ yaw, pitch, force });
    },
    lookAt: async (target, force) => {
      instantLookAts.push({ target, force });
    },
    attack: async () => {},
    setControlState: (key, active) => {
      controls.push({ key, active });
    },
    activateItem: () => {},
    deactivateItem: () => {},
    blockAt: () => ({ name: 'stone' }),
  };
}

test('humanizer pure math helpers compute shortest angles, easing, yaw/pitch, and typing delay', () => {
  assert.ok(Math.abs(shortestAngleDelta(0, Math.PI * 1.5) + Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(shortestAngleDelta(0.1, 0.1 + Math.PI * 2)) < 1e-6);

  assert.equal(smoothStep(-0.5), 0);
  assert.equal(smoothStep(0), 0);
  assert.equal(smoothStep(0.5), 0.5);
  assert.equal(smoothStep(1), 1);
  assert.equal(smoothStep(2), 1);

  const straightAhead = computeYawPitch(pos(0, 64, 0), pos(0, 65.62, -5));
  assert.ok(Math.abs(straightAhead.yaw) < 1e-6);
  assert.ok(Math.abs(straightAhead.pitch) < 1e-6);

  assert.equal(computeTypingDelayMs('hello', { enabled: false }), 0);
  assert.equal(computeTypingDelayMs('   '), 0);
  assert.equal(computeTypingDelayMs('hi', { baseMs: 220, msPerChar: 26, maxMs: 1600 }), 272);
  assert.equal(computeTypingDelayMs('x'.repeat(200), { baseMs: 220, msPerChar: 26, maxMs: 1600 }), 1600);
});

test('MotorHumanizer.smoothLookAt eases across steps, preempts stale calls, and bypasses smoothing when urgent', async () => {
  const bot = makeHumanizerBot();
  const sleeps = [];
  const h = new MotorHumanizer(bot, {
    humanizer: { lookSteps: 4, lookStepMs: 15, lookJitterRad: 0 },
  }, {
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  await h.smoothLookAt(pos(5, 65.62, 0));
  assert.equal(bot.looks.length, 4);
  assert.equal(bot.instantLookAts.length, 0);
  assert.deepEqual(sleeps, [15, 15, 15]);
  assert.ok(Math.abs(bot.looks[3].yaw - (-Math.PI / 2)) < 1e-3);

  // Urgent look falls back to instant lookAt(target, true)
  await h.smoothLookAt(pos(0, 62, 0), { urgent: true });
  assert.equal(bot.instantLookAts.length, 1);
  assert.equal(bot.instantLookAts[0].force, true);

  // Preemption: newer call stops older in-flight look
  let releaseStep;
  const bot2 = makeHumanizerBot();
  const h2 = new MotorHumanizer(bot2, {
    humanizer: { lookSteps: 5, lookStepMs: 20, lookJitterRad: 0 },
  }, {
    random: () => 0.5,
    sleep: () => new Promise(resolve => { releaseStep = resolve; }),
  });

  const first = h2.smoothLookAt(pos(5, 65.62, 0));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(bot2.looks.length, 1);
  const second = h2.smoothLookAt(pos(-5, 65.62, 0), { steps: 2, stepMs: 0 });
  releaseStep?.();
  await Promise.all([first, second]);
  assert.equal(bot2.looks.length, 3);
  h.dispose();
  h2.dispose();
});

test('MotorHumanizer.updateIdleGaze tracks nearby owner, glances around when idle, and skips busy unsafe states', async () => {
  const bot = makeHumanizerBot();
  const h = new MotorHumanizer(bot, {
    humanizer: { lookSteps: 3, lookStepMs: 0, lookJitterRad: 0 },
  }, {
    random: () => 0.2,
    sleep: async () => {},
  });

  const ownerEntity = { position: pos(4, 64, 0) };
  assert.equal(h.updateIdleGaze(1000, { combatBusy: true, ownerEntity }), false);
  assert.equal(h.updateIdleGaze(1000, { digging: true, ownerEntity }), false);
  assert.equal(h.updateIdleGaze(1000, { sleeping: true, ownerEntity }), false);
  assert.equal(h.updateIdleGaze(1000, { windowOpen: true, ownerEntity }), false);

  assert.equal(h.updateIdleGaze(1000, { ownerEntity, busy: false, moving: false }), true);
  assert.equal(h.updateIdleGaze(1100, { ownerEntity, busy: false, moving: false }), false);
  await new Promise(r => setTimeout(r, 10));
  assert.ok(bot.looks.length >= 1);

  const countAfterOwner = bot.looks.length;
  assert.equal(h.updateIdleGaze(10000, { ownerEntity: null, busy: false, moving: false }), true);
  await new Promise(r => setTimeout(r, 10));
  assert.ok(bot.looks.length > countAfterOwner);
  h.dispose();
});

test('MotorHumanizer.expressGesture executes nod and crouch_greet and cleans up sneak even on error', async () => {
  const bot = makeHumanizerBot();
  const h = new MotorHumanizer(bot, {
    humanizer: { gestureStepMs: 5 },
  }, {
    sleep: async () => {},
  });

  assert.equal(await h.expressGesture('nod', { unsafe: true }), false);
  assert.equal(await h.expressGesture('nod'), true);
  assert.equal(bot.looks.length, 2);

  assert.equal(await h.expressGesture('crouch_greet'), true);
  assert.deepEqual(bot.controls, [
    { key: 'sneak', active: true },
    { key: 'sneak', active: false },
    { key: 'sneak', active: true },
    { key: 'sneak', active: false },
  ]);

  // Even if sleep throws mid-gesture, sneak is explicitly released
  const botErr = makeHumanizerBot();
  const hErr = new MotorHumanizer(botErr, {
    humanizer: { gestureStepMs: 10 },
  }, {
    sleep: async () => { throw new Error('interrupted'); },
  });
  await hErr.expressGesture('crouch_greet');
  assert.deepEqual(botErr.controls.at(-1), { key: 'sneak', active: false });
  h.dispose();
  hErr.dispose();
});

test('MotorHumanizer handles typing delay, attack jitter, safe combat strafe, W-tap, and dispose', async () => {
  const bot = makeHumanizerBot();
  const slept = [];
  const h = new MotorHumanizer(bot, {
    humanizer: {
      attackJitterMs: 50,
      typingBaseMs: 200,
      typingMsPerChar: 20,
      maxChatDelayMs: 500,
      strafeDurationMs: 25,
      strafeCooldownMs: 10,
      lookStepMs: 0,
    },
  }, {
    random: () => 0.5,
    sleep: async (ms) => { slept.push(ms); },
  });

  assert.equal(h.getAttackJitterMs(), 25);

  const delay = await h.waitTypingDelay('Xin chào', {
    ownerEntity: { position: pos(0, 64, -4) },
  });
  assert.equal(delay, 360);
  assert.deepEqual(slept, [360]);

  assert.equal(await h.waitTypingDelay('Chạy đi!', { urgent: true }), 0);

  // Strafe guards
  assert.equal(h.maybeCombatStrafe({ distance: 2.5, isCreeper: true, safeLeft: true, safeRight: true }), null);
  assert.equal(h.maybeCombatStrafe({ distance: 2.5, inWater: true, safeLeft: true, safeRight: true }), null);
  assert.equal(h.maybeCombatStrafe({ distance: 2.5, safeLeft: false, safeRight: false }), null);

  assert.equal(h.maybeCombatStrafe({ distance: 2.5, safeLeft: true, safeRight: true }), 'right');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(h.maybeCombatStrafe({ distance: 2.5, safeLeft: true, safeRight: false }), 'left');

  assert.equal(h.triggerWTap({ inWater: true }), false);
  assert.equal(h.triggerWTap({ inWater: false }), true);
  assert.ok(bot.controls.some(c => c.key === 'sprint' && c.active === false));

  h.dispose();
  assert.equal(bot.controls.at(-1).active, false);
});

test('CombatController uses MotorHumanizer for smooth facing, attack jitter, and safe lateral strafe', async () => {
  const bot = makeHumanizerBot();
  let attacked = 0;
  bot.attack = async () => { attacked += 1; };
  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile', health: 20, position: pos(0, 64, -2.6) };

  const humanizer = new MotorHumanizer(bot, {
    humanizer: {
      lookSteps: 3,
      lookStepMs: 0,
      lookJitterRad: 0,
      strafeDurationMs: 15,
      strafeCooldownMs: 0,
      attackJitterMs: 0,
    },
  }, { random: () => 0.5 });

  const combat = new CombatController(bot, {
    combat: { enabled: true, crit: false },
  }, { humanizer, log: () => {} });

  combat.start();
  await combat.tick({});
  assert.equal(bot.instantLookAts.length, 0);
  assert.equal(bot.looks.length, 3);
  assert.equal(attacked, 1);
  assert.ok(bot.controls.some(c => (c.key === 'right' || c.key === 'left') && c.active === true));
  assert.ok(bot.controls.some(c => c.key === 'sprint' && c.active === false));
  combat.stop();
  humanizer.dispose();
  await new Promise(r => setTimeout(r, 80));
});
