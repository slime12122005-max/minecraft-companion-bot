export class HealthWatchdog {
  constructor({
    stuckThresholdMs = 8000,
    lagThresholdMs = 1500,
    minMoveDistance = 0.25,
  } = {}) {
    this.stuckThresholdMs = stuckThresholdMs;
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
  }

  recordTick(now = Date.now(), {
    pos = null,
    moving = false,
    digging = false,
    sleeping = false,
    activeTask = false,
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

    if (pos && (moving || activeTask) && !digging && !sleeping) {
      if (!this._anchorPos) {
        this._anchorPos = { x: pos.x, y: pos.y, z: pos.z };
        this._anchorAt = now;
        this.stuckMs = 0;
        this.stuck = false;
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
        } else {
          this.stuckMs = Math.max(0, now - (this._anchorAt ?? now));
          this.stuck = this.stuckMs >= this.stuckThresholdMs;
        }
      }
    } else {
      this._anchorPos = null;
      this._anchorAt = now;
      this.stuckMs = 0;
      this.stuck = false;
    }

    return this.status();
  }

  status() {
    return {
      healthy: !this.stuck && !this.lagDetected,
      stuck: this.stuck,
      stuckMs: this.stuckMs,
      lagDetected: this.lagDetected,
      lastTickGapMs: this.lastTickGapMs,
      maxTickLagMs: this.maxTickLagMs,
      lastTickAt: this.lastTickAt,
    };
  }
}

export default HealthWatchdog;
