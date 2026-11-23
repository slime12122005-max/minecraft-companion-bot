export class HealthWatchdog {
  constructor({
    stuckThresholdMs = 8000,
    repathThresholdMs = 14000,
    abortThresholdMs = 24000,
    lagThresholdMs = 1500,
    minMoveDistance = 0.25,
  } = {}) {
    this.stuckThresholdMs = stuckThresholdMs;
    this.repathThresholdMs = repathThresholdMs;
    this.abortThresholdMs = abortThresholdMs;
    this.lagThresholdMs = lagThresholdMs;
    this.minMoveDistance = minMoveDistance;

    this.lastTickAt = null;
    this.lastTickGapMs = 0;
    this.maxTickLagMs = 0;
    this.lagDetected = false;

    this._anchorPos = null;
    this._anchorAt = null;
    this.stuckMs = 0;
    this.stuck = false;
    this.recoveryStage = 0;
  }

  resetStuck(now = Date.now()) {
    this._anchorPos = null;
    this._anchorAt = now;
    this.stuckMs = 0;
    this.stuck = false;
    this.recoveryStage = 0;
  }

  recordTick(now = Date.now(), {
    pos = null,
    moving = false,
    digging = false,
    sleeping = false,
    activeTask = false,
    exempt = false,
  } = {}) {
    if (this.lastTickAt != null) {
      const gap = Math.max(0, now - this.lastTickAt);
      this.lastTickGapMs = gap;
      if (gap > this.maxTickLagMs) {
        this.maxTickLagMs = gap;
      }
      this.lagDetected = gap >= this.lagThresholdMs;
    }
    this.lastTickAt = now;

    if (pos && (moving || activeTask) && !digging && !sleeping && !exempt) {
      if (!this._anchorPos) {
        this._anchorPos = { x: pos.x, y: pos.y, z: pos.z };
        this._anchorAt = now;
        this.stuckMs = 0;
        this.stuck = false;
        this.recoveryStage = 0;
      } else {
        const dist = Math.hypot(
          pos.x - this._anchorPos.x,
          pos.y - this._anchorPos.y,
          pos.z - this._anchorPos.z
        );
        if (dist >= this.minMoveDistance) {
          this._anchorPos = { x: pos.x, y: pos.y, z: pos.z };
          this._anchorAt = now;
          this.stuckMs = 0;
          this.stuck = false;
          this.recoveryStage = 0;
        } else {
          this.stuckMs = Math.max(0, now - (this._anchorAt ?? now));
          this.stuck = this.stuckMs >= this.stuckThresholdMs;
          if (this.stuckMs < this.stuckThresholdMs) {
            this.recoveryStage = 0;
          } else if (this.stuckMs < this.repathThresholdMs) {
            this.recoveryStage = 1;
          } else if (this.stuckMs < this.abortThresholdMs) {
            this.recoveryStage = 2;
          } else {
            this.recoveryStage = 3;
          }
        }
      }
    } else {
      this.resetStuck(now);
    }

    return this.status();
  }

  status() {
    return {
      healthy: !this.stuck && !this.lagDetected,
      stuck: this.stuck,
      stuckMs: this.stuckMs,
      recoveryStage: this.recoveryStage,
      lagDetected: this.lagDetected,
      lastTickGapMs: this.lastTickGapMs,
      maxTickLagMs: this.maxTickLagMs,
      lastTickAt: this.lastTickAt,
    };
  }
}

export default HealthWatchdog;
