import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskCoordinator, TASK_TIERS, computeTaskUtility } from '../src/tasks.js';

test('starts one task and aborts previous', () => {
  const log = [];
  const tasks = new TaskCoordinator({ log: (...a) => log.push(a.join(' ')) });
  assert.equal(tasks.start({ name: 'a' }), true);
  assert.equal(tasks.start({ name: 'b' }), false);
  const old = tasks.abort('new command');
  assert.equal(old.task.name, 'a');
  assert.equal(tasks.start({ name: 'b' }), true);
});

test('wait and trigger', () => {
  const tasks = new TaskCoordinator({ log: () => {} });
  tasks.wait('nun', { name: 'check_lava' });
  assert.equal(tasks.trigger('nun').name, 'check_lava');
  assert.equal(tasks.trigger('nun'), null);
});

test('run aborts signal and triggers onAbort cleanup', async () => {
  const tasks = new TaskCoordinator({ log: () => {} });
  let aborted = false;
  let cleaned = false;
  let observedSignal = null;

  const handle = tasks.run({ name: 'gather' }, async (signal) => {
    observedSignal = signal;
    if (signal.aborted) {
      aborted = true;
      return;
    }
    await new Promise(resolve => {
      signal.addEventListener('abort', () => {
        aborted = true;
        resolve();
      });
    });
  }, { onAbort: () => { cleaned = true; } });

  await Promise.resolve();
  tasks.abort('stop');
  await handle.promise;
  assert.equal(observedSignal.aborted, true);
  assert.equal(aborted, true);
  assert.equal(cleaned, true);
  assert.equal(tasks.active, null);
});

test('pause and resume invoke onResume callback', () => {
  let resumed = 0;
  const tasks = new TaskCoordinator({ log: () => {} });
  tasks.start({ name: 'follow' }, { onResume: () => { resumed++; } });
  assert.equal(tasks.pause(), true);
  assert.equal(tasks.paused, true);
  assert.equal(tasks.resume(), true);
  assert.equal(tasks.paused, false);
  assert.equal(resumed, 1);
});

test('computeTaskUtility balances priority, waiting urgency, and distance', () => {
  const now = 100000;
  const near = computeTaskUtility({ priority: TASK_TIERS.PLAYER, enqueuedAt: now, distance: 1 }, { now });
  const far = computeTaskUtility({ priority: TASK_TIERS.PLAYER, enqueuedAt: now, distance: 50 }, { now });
  const starved = computeTaskUtility({ priority: TASK_TIERS.PLAYER, enqueuedAt: now - 5000, distance: 1 }, { now });

  assert.ok(near > far);
  assert.ok(starved > near);
});

test('schedule preempts lower-tier task with snapshot and resumes it automatically', async () => {
  const tasks = new TaskCoordinator({ log: () => {} });
  const events = [];
  let releaseWorker = null;
  let resumedSnapshot = null;

  tasks.start({ name: 'build_house', priority: TASK_TIERS.PLAYER }, {
    onPause: () => ({ placed: 42, total: 120 }),
    onResume: (snap) => {
      resumedSnapshot = snap;
      events.push(`resumed:${snap?.placed}`);
    },
  });

  const preemptRes = tasks.schedule(
    { name: 'escape_lava', priority: TASK_TIERS.SURVIVAL },
    async () => {
      events.push('survival_start');
      await new Promise(r => { releaseWorker = r; });
      events.push('survival_done');
    }
  );

  assert.equal(preemptRes.status, 'preempted');
  assert.equal(preemptRes.preempted, 'build_house');
  assert.equal(tasks.status().active.name, 'escape_lava');
  assert.equal(tasks.status().suspended.length, 1);

  await Promise.resolve();
  releaseWorker();
  await preemptRes.promise;

  assert.deepEqual(events, ['survival_start', 'survival_done', 'resumed:42']);
  assert.deepEqual(resumedSnapshot, { placed: 42, total: 120 });
  assert.equal(tasks.status().active.name, 'build_house');
  assert.equal(tasks.complete('build_house'), true);
});

test('schedule queues same/lower priority tasks and executes them in highest-utility order, respecting canStart', async () => {
  const tasks = new TaskCoordinator({ log: () => {} });
  const order = [];
  let releaseFirst = null;

  const rejected = tasks.schedule({
    name: 'needs_pick',
    canStart: () => false,
    start: async () => {},
  });
  assert.equal(rejected.status, 'rejected');

  const first = tasks.schedule({ name: 'first', priority: TASK_TIERS.PLAYER }, async () => {
    await new Promise(r => { releaseFirst = r; });
    order.push('first');
  });
  const bg = tasks.schedule({ name: 'bg_far', priority: TASK_TIERS.BACKGROUND, distance: 30 }, async () => {
    order.push('bg_far');
  });
  const playerNear = tasks.schedule({ name: 'player_near', priority: TASK_TIERS.PLAYER, distance: 2 }, async () => {
    order.push('player_near');
  });

  assert.equal(bg.status, 'queued');
  assert.equal(playerNear.status, 'queued');

  await Promise.resolve();
  releaseFirst();
  await Promise.all([first.promise, bg.promise, playerNear.promise]);
  assert.deepEqual(order, ['first', 'player_near', 'bg_far']);
});
