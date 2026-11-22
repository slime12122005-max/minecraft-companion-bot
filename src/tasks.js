export const TASK_TIERS = Object.freeze({
  SURVIVAL: 95,
  COMBAT: 80,
  PLAYER: 60,
  BACKGROUND: 30,
});

export function computeTaskUtility(entry, {
  now = Date.now(),
  urgencyWeight = 0.002,
  distanceWeight = 2.0,
  maxUrgencyBonus = 15,
} = {}) {
  const base = Number(entry?.priority ?? entry?.task?.priority ?? TASK_TIERS.PLAYER);
  const waitMs = Math.max(0, now - (entry?.enqueuedAt ?? now));
  const urgencyBonus = Math.min(maxUrgencyBonus, waitMs * urgencyWeight);
  const dist = Math.max(0, Number(entry?.distance ?? entry?.task?.distance ?? 0));
  return base + urgencyBonus - distanceWeight * Math.log(1 + dist);
}

export class TaskCoordinator {
  constructor({ log } = {}) {
    this.log = log || console.log;
    this.active = null;
    this.waiting = new Map();
    this.queue = [];
    this.suspended = [];
    this.paused = false;
  }

  start(task, {
    onAbort = null,
    onResume = null,
    onPause = null,
    priority = task?.priority ?? TASK_TIERS.PLAYER,
    distance = task?.distance ?? 0,
  } = {}) {
    if (this.active && !this.active.aborted) return false;
    const controller = new AbortController();
    this.active = {
      task,
      startedAt: Date.now(),
      aborted: false,
      controller,
      onAbort,
      onResume,
      onPause,
      priority: Number(priority ?? TASK_TIERS.PLAYER),
      distance: Math.max(0, Number(distance ?? 0)),
      snapshot: null,
    };
    this.paused = false;
    this.log(`▶ Task: ${task?.name || 'untitled'}`);
    return true;
  }

  _launchEntry(entry) {
    if (!this.start(entry.task, {
      onAbort: entry.onAbort,
      onResume: entry.onResume,
      onPause: entry.onPause,
      priority: entry.priority,
      distance: entry.distance,
    })) {
      return null;
    }
    const current = this.active;
    const promise = Promise.resolve()
      .then(() => entry.fn(current.controller.signal, current.snapshot))
      .finally(() => {
        if (this.active === current) {
          this.active = null;
          this.paused = false;
          this._resumeNext();
        }
      });
    current.promise = promise;
    return { signal: current.controller.signal, promise };
  }

  run(task, fn, { onAbort = null, onResume = null, onPause = null, priority, distance } = {}) {
    return this._launchEntry({
      task,
      fn,
      onAbort,
      onResume,
      onPause,
      priority: priority ?? task?.priority ?? TASK_TIERS.PLAYER,
      distance: distance ?? task?.distance ?? 0,
    });
  }

  schedule(taskOrSpec, fn = null, opts = {}) {
    const isSpec = typeof taskOrSpec === 'object' && taskOrSpec !== null;
    const taskMeta = isSpec ? taskOrSpec : { name: String(taskOrSpec ?? 'untitled') };

    if (isSpec && typeof taskOrSpec.canStart === 'function' && !taskOrSpec.canStart(opts.ctx)) {
      return { status: 'rejected', reason: 'canStart_failed' };
    }

    const priority = Number(opts.priority ?? taskMeta.priority ?? TASK_TIERS.PLAYER);
    const distance = Math.max(0, Number(opts.distance ?? taskMeta.distance ?? 0));
    const onPause = opts.onPause ?? (isSpec && typeof taskOrSpec.pause === 'function'
      ? (info) => taskOrSpec.pause(opts.ctx, info)
      : null);
    const onResume = opts.onResume ?? (isSpec && typeof taskOrSpec.resume === 'function'
      ? (snap) => taskOrSpec.resume(opts.ctx, snap)
      : null);
    const onAbort = opts.onAbort ?? (isSpec && typeof taskOrSpec.abort === 'function'
      ? (reason) => taskOrSpec.abort(reason, opts.ctx)
      : null);
    const runner = fn ?? ((signal, snapshot) => taskOrSpec.start({ ...(opts.ctx ?? {}), signal, snapshot }));

    const entry = {
      task: taskMeta,
      fn: runner,
      onPause,
      onResume,
      onAbort,
      priority,
      distance,
      enqueuedAt: Date.now(),
    };

    if (!this.active || this.active.aborted) {
      const handle = this._launchEntry(entry);
      return { status: 'started', signal: handle.signal, promise: handle.promise };
    }

    const currentPriority = this.active.priority ?? TASK_TIERS.PLAYER;
    if (opts.preempt !== false && priority > currentPriority) {
      const prev = this.active;
      const prevName = prev.task?.name || 'untitled';
      if (typeof prev.onPause === 'function') {
        try {
          const snap = prev.onPause({ reason: 'preempted' });
          if (snap !== undefined) prev.snapshot = snap;
        } catch {}
      }
      this.log(`⏸ Preempted: ${prevName}`);
      this.suspended.push({ entry: prev, pausedAt: Date.now() });
      this.active = null;
      this.paused = false;

      const handle = this._launchEntry(entry);
      return {
        status: 'preempted',
        preempted: prevName,
        signal: handle.signal,
        promise: handle.promise,
      };
    }

    let resolveHandle;
    let rejectHandle;
    const promise = new Promise((res, rej) => {
      resolveHandle = res;
      rejectHandle = rej;
    });
    this.queue.push({ entry, resolveHandle, rejectHandle, enqueuedAt: entry.enqueuedAt });
    return { status: 'queued', promise };
  }

  enqueue(taskOrSpec, fn = null, opts = {}) {
    return this.schedule(taskOrSpec, fn, opts);
  }

  _resumeNext() {
    if (this.active && !this.active.aborted) return;

    while (this.suspended.length > 0) {
      const { entry: prev } = this.suspended.pop();
      if (prev.aborted) continue;
      this.active = prev;
      this.paused = false;
      this.log(`▶ Resumed: ${prev.task?.name || 'untitled'}`);
      try { prev.onResume?.(prev.snapshot); } catch {}
      return;
    }

    if (this.queue.length > 0) {
      const now = Date.now();
      let bestIdx = 0;
      let bestUtil = -Infinity;
      for (let i = 0; i < this.queue.length; i++) {
        const util = computeTaskUtility(this.queue[i].entry, { now });
        if (util > bestUtil) {
          bestUtil = util;
          bestIdx = i;
        }
      }
      const [nextItem] = this.queue.splice(bestIdx, 1);
      const handle = this._launchEntry(nextItem.entry);
      if (handle) {
        handle.promise.then(nextItem.resolveHandle, nextItem.rejectHandle);
      } else {
        nextItem.rejectHandle(new Error('Failed to start queued task'));
      }
    }
  }

  get signal() {
    return this.active?.controller?.signal ?? null;
  }

  saveSnapshot(snapshot) {
    if (!this.active) return false;
    this.active.snapshot = snapshot;
    return true;
  }

  getSnapshot() {
    return this.active?.snapshot ?? null;
  }

  complete(taskName = null) {
    if (!this.active) return false;
    if (taskName && this.active.task?.name !== taskName) return false;
    this.active = null;
    this.paused = false;
    this._resumeNext();
    return true;
  }

  pause(reason = '') {
    if (this.active && !this.paused) {
      this.paused = true;
      if (typeof this.active.onPause === 'function') {
        try {
          const snap = this.active.onPause({ reason });
          if (snap !== undefined) this.active.snapshot = snap;
        } catch {}
      }
      this.log(`⏸ Paused: ${this.active.task?.name || 'untitled'}`);
      return true;
    }
    return false;
  }

  resume() {
    if (this.active && this.paused) {
      this.paused = false;
      this.log(`▶ Resumed: ${this.active.task?.name || 'untitled'}`);
      try { this.active.onResume?.(this.active.snapshot); } catch {}
      return true;
    }
    return false;
  }

  wait(key, task, { condition, at, maxAgeMs = 600000 } = {}) {
    this.waiting.set(key, { task, condition, at, maxAgeMs, createdAt: Date.now() });
    this.log(`⏳ Waiting: ${key}`);
  }

  trigger(key) {
    const entry = this.waiting.get(key);
    if (!entry) return null;
    this.waiting.delete(key);
    this.log(`✓ Ready: ${key}`);
    return entry.task;
  }

  abort(reason = 'aborted', { clearQueue = false } = {}) {
    let old = null;
    if (this.active) {
      old = this.active;
      old.aborted = true;
      this.active = null;
      this.paused = false;
      try { old.controller?.abort(new Error(reason)); } catch {}
      try { old.onAbort?.(reason); } catch {}
      this.log(`⏹ Aborted: ${old.task?.name || 'untitled'} (${reason})`);
    }
    if (clearQueue) {
      for (const q of this.queue) {
        try { q.rejectHandle(new Error(reason)); } catch {}
      }
      this.queue.length = 0;
      for (const s of this.suspended) {
        s.entry.aborted = true;
        try { s.entry.controller?.abort(new Error(reason)); } catch {}
        try { s.entry.onAbort?.(reason); } catch {}
      }
      this.suspended.length = 0;
    }
    return old;
  }

  status() {
    const now = Date.now();
    return {
      active: this.active
        ? {
            name: this.active.task?.name,
            priority: this.active.priority,
            runningMs: now - this.active.startedAt,
            paused: this.paused,
            snapshot: this.active.snapshot ?? null,
          }
        : null,
      paused: this.paused,
      suspended: this.suspended.map(s => ({
        name: s.entry.task?.name,
        priority: s.entry.priority,
      })),
      queued: this.queue.map(q => ({
        name: q.entry.task?.name,
        priority: q.entry.priority,
        utility: computeTaskUtility(q.entry, { now }),
      })),
      waiting: Array.from(this.waiting.entries()).map(([k, v]) => ({ key: k, ageMs: now - v.createdAt })),
    };
  }
}
