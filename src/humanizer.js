const DEFAULT_HUMANIZER_CONFIG = Object.freeze({
  enabled: true,
  smoothLook: true,
  lookSteps: 5,
  lookStepMs: 22,
  lookJitterRad: 0.025,
  idleGaze: true,
  socialGestures: true,
  gestureStepMs: 115,
  chatTypingDelay: true,
  typingBaseMs: 220,
  typingMsPerChar: 26,
  maxChatDelayMs: 1600,
  personalSpace: 3,
  combatStrafe: true,
  strafeDurationMs: 140,
  strafeCooldownMs: 650,
  attackJitterMs: 25,
});

export function shortestAngleDelta(from, to) {
  let diff = ((Number(to) || 0) - (Number(from) || 0)) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

export function smoothStep(t) {
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  return x * x * (3 - 2 * x);
}

export function computeYawPitch(fromPos, targetPos, eyeHeight = 1.62) {
  const dx = targetPos.x - fromPos.x;
  const dy = targetPos.y - (fromPos.y + eyeHeight);
  const dz = targetPos.z - fromPos.z;
  const horiz = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, horiz || 1e-6);
  return { yaw, pitch };
}

export function wouldTriggerEnderman(bot, fromPos, targetPos) {
  if (!bot || !fromPos || !targetPos) return false;
  const ox = fromPos.x;
  const oy = fromPos.y + 1.62;
  const oz = fromPos.z;
  const rdx = targetPos.x - ox;
  const rdy = targetPos.y - oy;
  const rdz = targetPos.z - oz;
  const rLen = Math.hypot(rdx, rdy, rdz);
  if (rLen < 1e-4) return false;
  const ux = rdx / rLen;
  const uy = rdy / rLen;
  const uz = rdz / rLen;

  for (const e of Object.values(bot.entities ?? {})) {
    if (!e?.position) continue;
    const name = String(e.name ?? '').toLowerCase();
    if (name !== 'enderman') continue;
    if (e.target && e.target === bot.entity) continue;
    const vx = e.position.x - ox;
    const vy = (e.position.y + 2.5) - oy;
    const vz = e.position.z - oz;
    const vLenSq = vx * vx + vy * vy + vz * vz;
    if (vLenSq > 32 * 32) continue;
    const t = vx * ux + vy * uy + vz * uz;
    if (t <= 0.5 || t > 32) continue;
    const perpSq = Math.max(0, vLenSq - t * t);
    if (Math.sqrt(perpSq) <= 0.75) return true;
  }
  return false;
}

export function computeTypingDelayMs(text, {
  enabled = true,
  baseMs = 220,
  msPerChar = 26,
  maxMs = 1600,
} = {}) {
  if (!enabled) return 0;
  const clean = String(text ?? '').trim();
  if (!clean) return 0;
  return Math.min(maxMs, Math.max(baseMs, Math.round(baseMs + clean.length * msPerChar)));
}

export class MotorHumanizer {
  constructor(bot, config = {}, {
    random = Math.random,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    overrides = {},
  } = {}) {
    this.bot = bot;
    this.random = random;
    this.sleep = sleep;
    this.config = {
      ...DEFAULT_HUMANIZER_CONFIG,
      ...(config?.humanizer ?? {}),
      ...overrides,
    };

    this.disposed = false;
    this._lookGen = 0;
    this._nextGazeAt = 0;
    this._gestureActive = false;
    this._lastStrafeAt = 0;
    this._strafeDir = 1;
    this._activeStrafeKey = null;
    this._strafeTimer = null;
    this._wtapTimer = null;
    this._wtapSprintActive = false;
  }

  async smoothLookAt(targetPos, {
    steps = this.config.lookSteps,
    stepMs = this.config.lookStepMs,
    jitterRad = this.config.lookJitterRad,
    urgent = false,
    signal = null,
  } = {}) {
    if (!targetPos || this.disposed || signal?.aborted) return;
    if (!urgent && (this.bot?.pathfinder?.isMoving?.() || this.bot?.targetDigBlock)) return;
    const safeTargetPos = !urgent && this.bot?.entity?.position && wouldTriggerEnderman(this.bot, this.bot.entity.position, targetPos)
      ? { x: targetPos.x, y: targetPos.y - 1.8, z: targetPos.z }
      : targetPos;
    if (
      !this.config.enabled ||
      !this.config.smoothLook ||
      urgent ||
      typeof this.bot?.look !== 'function' ||
      !this.bot?.entity?.position
    ) {
      try {
        await this.bot?.lookAt?.(safeTargetPos, Boolean(urgent));
      } catch {}
      return;
    }

    const gen = ++this._lookGen;
    const { yaw: targetYaw, pitch: targetPitch } = computeYawPitch(this.bot.entity.position, safeTargetPos);
    const jy = (this.random() * 2 - 1) * jitterRad;
    const jp = (this.random() * 2 - 1) * (jitterRad * 0.6);
    const clampedPitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, targetPitch + jp));

    const startYaw = this.bot.entity.yaw ?? 0;
    const startPitch = this.bot.entity.pitch ?? 0;
    const dYaw = shortestAngleDelta(startYaw, targetYaw + jy);
    const dPitch = clampedPitch - startPitch;
    const count = Math.max(1, Math.round(steps || 1));

    for (let i = 1; i <= count; i++) {
      if (this.disposed || signal?.aborted || gen !== this._lookGen) break;
      if (!urgent && (this.bot?.pathfinder?.isMoving?.() || this.bot?.targetDigBlock)) break;
      const e = smoothStep(i / count);
      try {
        await this.bot.look(startYaw + dYaw * e, startPitch + dPitch * e, false);
      } catch {}
      if (i < count && stepMs > 0 && !this.disposed && !signal?.aborted && gen === this._lookGen) {
        await this.sleep(stepMs);
      }
    }
  }

  updateIdleGaze(now = Date.now(), {
    ownerEntity = null,
    busy = false,
    combatBusy = false,
    sleeping = false,
    digging = false,
    moving = false,
    windowOpen = false,
  } = {}) {
    if (
      !this.config.enabled ||
      !this.config.idleGaze ||
      this.disposed ||
      combatBusy ||
      sleeping ||
      digging ||
      windowOpen ||
      this._gestureActive ||
      !this.bot?.entity?.position
    ) {
      return false;
    }
    if (now < this._nextGazeAt) return false;
    this._nextGazeAt = now + 2200 + Math.floor(this.random() * 3000);

    const bp = this.bot.entity.position;
    if (ownerEntity?.position && !moving) {
      const op = ownerEntity.position;
      const dist = Math.hypot(op.x - bp.x, op.y - bp.y, op.z - bp.z);
      if (dist <= 10 && this.random() < 0.75) {
        this.smoothLookAt({ x: op.x, y: op.y + 1.62, z: op.z }, { steps: 4 }).catch(() => {});
        return true;
      }
    }

    if (!busy && !moving) {
      const baseYaw = this.bot.entity.yaw ?? 0;
      const yaw = baseYaw + (this.random() * 2 - 1) * 0.7;
      const dy = (this.random() * 2 - 1) * 1.1;
      const target = {
        x: bp.x - Math.sin(yaw) * 6,
        y: bp.y + 1.62 + dy,
        z: bp.z - Math.cos(yaw) * 6,
      };
      this.smoothLookAt(target, { steps: 4 }).catch(() => {});
      return true;
    }

    return false;
  }

  async expressGesture(kind = 'nod', { unsafe = false } = {}) {
    if (
      !this.config.enabled ||
      !this.config.socialGestures ||
      this.disposed ||
      unsafe ||
      this._gestureActive ||
      !this.bot?.entity
    ) {
      return false;
    }

    this._gestureActive = true;
    const stepMs = Math.max(0, Number(this.config.gestureStepMs ?? 115));
    try {
      if (kind === 'nod') {
        if (typeof this.bot.look !== 'function') return false;
        const yaw = this.bot.entity.yaw ?? 0;
        const pitch = this.bot.entity.pitch ?? 0;
        try {
          await this.bot.look(yaw, Math.max(-1.4, pitch - 0.3), false);
          if (stepMs > 0 && !this.disposed) await this.sleep(stepMs);
          if (!this.disposed) await this.bot.look(yaw, pitch, false);
        } catch {}
        return true;
      }

      if (kind === 'crouch_greet') {
        if (typeof this.bot.setControlState !== 'function') return false;
        try {
          this.bot.setControlState('sneak', true);
          if (stepMs > 0 && !this.disposed) await this.sleep(stepMs);
          this.bot.setControlState('sneak', false);
          if (stepMs > 0 && !this.disposed) await this.sleep(Math.round(stepMs * 0.8));
          if (!this.disposed) {
            this.bot.setControlState('sneak', true);
            if (stepMs > 0 && !this.disposed) await this.sleep(stepMs);
          }
        } catch {
        } finally {
          try { this.bot.setControlState('sneak', false); } catch {}
        }
        return true;
      }

      return false;
    } finally {
      this._gestureActive = false;
    }
  }

  getAttackJitterMs() {
    if (!this.config.enabled || !(this.config.attackJitterMs > 0)) return 0;
    return Math.round(this.random() * this.config.attackJitterMs);
  }

  computeChatDelay(text, { urgent = false } = {}) {
    if (urgent || !this.config.enabled || !this.config.chatTypingDelay) return 0;
    return computeTypingDelayMs(text, {
      enabled: true,
      baseMs: this.config.typingBaseMs,
      msPerChar: this.config.typingMsPerChar,
      maxMs: this.config.maxChatDelayMs,
    });
  }

  async waitTypingDelay(text, {
    urgent = false,
    ownerEntity = null,
    canMoveHead = true,
    signal = null,
  } = {}) {
    const delay = this.computeChatDelay(text, { urgent });
    if (
      canMoveHead &&
      ownerEntity?.position &&
      this.config.enabled &&
      this.config.smoothLook &&
      !this.disposed
    ) {
      this.smoothLookAt(
        { x: ownerEntity.position.x, y: ownerEntity.position.y + 1.62, z: ownerEntity.position.z },
        { steps: 3 }
      ).catch(() => {});
    }

    if (delay > 0 && !this.disposed && !signal?.aborted) {
      if (signal) {
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', finish);
            resolve();
          };
          signal.addEventListener('abort', finish, { once: true });
          Promise.resolve(this.sleep(delay)).then(finish, finish);
        });
      } else {
        await this.sleep(delay);
      }
    }
    return delay;
  }

  maybeCombatStrafe({
    distance = 0,
    inWater = false,
    isCreeper = false,
    onGround = true,
    safeLeft = false,
    safeRight = false,
  } = {}) {
    if (
      !this.config.enabled ||
      !this.config.combatStrafe ||
      this.disposed ||
      isCreeper ||
      inWater ||
      !onGround ||
      distance < 1.6 ||
      distance > 3.0 ||
      typeof this.bot?.setControlState !== 'function'
    ) {
      return null;
    }

    const now = Date.now();
    if (now - this._lastStrafeAt < this.config.strafeCooldownMs) return null;

    const preferred = this._strafeDir === 1 ? 'right' : 'left';
    let chosen = null;
    if (preferred === 'right') {
      if (safeRight) chosen = 'right';
      else if (safeLeft) chosen = 'left';
    } else {
      if (safeLeft) chosen = 'left';
      else if (safeRight) chosen = 'right';
    }
    if (!chosen) return null;

    this._lastStrafeAt = now;
    this._strafeDir *= -1;

    if (this._strafeTimer) {
      clearTimeout(this._strafeTimer);
      this._strafeTimer = null;
    }
    if (this._activeStrafeKey && this._activeStrafeKey !== chosen) {
      try { this.bot.setControlState(this._activeStrafeKey, false); } catch {}
    }

    this._activeStrafeKey = chosen;
    try { this.bot.setControlState(chosen, true); } catch {}
    const duration = Math.max(0, Number(this.config.strafeDurationMs ?? 200));
    this._strafeTimer = setTimeout(() => {
      this._strafeTimer = null;
      if (this._activeStrafeKey === chosen) {
        this._activeStrafeKey = null;
      }
      try { this.bot.setControlState(chosen, false); } catch {}
    }, duration);
    this._strafeTimer.unref?.();
    return chosen;
  }

  triggerWTap({ inWater = false } = {}) {
    if (
      !this.config.enabled ||
      !this.config.combatStrafe ||
      this.disposed ||
      inWater ||
      typeof this.bot?.setControlState !== 'function'
    ) {
      return false;
    }

    if (this._wtapTimer) {
      clearTimeout(this._wtapTimer);
      this._wtapTimer = null;
    }
    try { this.bot.setControlState('sprint', false); } catch {}
    this._wtapTimer = setTimeout(() => {
      this._wtapTimer = null;
      if (this.disposed) return;
      const movingForward = Boolean(this.bot.controlState?.forward || this.bot.pathfinder?.isMoving?.());
      if (movingForward) {
        this._wtapSprintActive = true;
        try { this.bot.setControlState('sprint', true); } catch {}
      }
    }, 65);
    this._wtapTimer.unref?.();
    return true;
  }

  stopCombatMotion() {
    if (this._strafeTimer) {
      clearTimeout(this._strafeTimer);
      this._strafeTimer = null;
    }
    if (this._wtapTimer) {
      clearTimeout(this._wtapTimer);
      this._wtapTimer = null;
    }
    if (this._activeStrafeKey && typeof this.bot?.setControlState === 'function') {
      try { this.bot.setControlState(this._activeStrafeKey, false); } catch {}
    }
    if (this._wtapSprintActive && typeof this.bot?.setControlState === 'function') {
      try { this.bot.setControlState('sprint', false); } catch {}
    }
    this._wtapSprintActive = false;
    this._activeStrafeKey = null;
  }

  dispose() {
    this.disposed = true;
    this._lookGen += 1;
    this.stopCombatMotion();
    if (this._gestureActive && typeof this.bot?.setControlState === 'function') {
      try { this.bot.setControlState('sneak', false); } catch {}
    }
  }
}

export default MotorHumanizer;
