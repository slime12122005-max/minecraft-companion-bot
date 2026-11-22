export class ConnectionManager {
  constructor({
    baseDelayMs = 3000,
    maxDelayMs = 30000,
    kickPenaltyMs = 10000,
    maxRecentKicks = 3,
    kickWindowMs = 60000,
  } = {}) {
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.kickPenaltyMs = kickPenaltyMs;
    this.maxRecentKicks = maxRecentKicks;
    this.kickWindowMs = kickWindowMs;

    this.connected = false;
    this.connectedAt = null;
    this.attempt = 0;
    this.disconnectCount = 0;
    this._kickTimestamps = [];
    this.lastKickReason = '';
  }

  _pruneKicks(now = Date.now()) {
    const cutoff = now - this.kickWindowMs;
    while (this._kickTimestamps.length > 0 && this._kickTimestamps[0] < cutoff) {
      this._kickTimestamps.shift();
    }
  }

  markConnected() {
    this.connected = true;
    this.connectedAt = Date.now();
    this.attempt = 0;
  }

  markDisconnected() {
    this.connected = false;
    this.disconnectCount += 1;
  }

  markKicked(reason = '') {
    const now = Date.now();
    this._pruneKicks(now);
    this._kickTimestamps.push(now);
    this.lastKickReason = String(reason ?? '');
  }

  nextReconnectDelayMs() {
    const now = Date.now();
    this._pruneKicks(now);
    const expDelay = Math.min(this.baseDelayMs * (2 ** this.attempt), this.maxDelayMs);
    const kickSpammed = this._kickTimestamps.length >= this.maxRecentKicks;
    this.attempt += 1;
    return expDelay + (kickSpammed ? this.kickPenaltyMs : 0);
  }

  resetBackoff() {
    this.attempt = 0;
  }

  status() {
    this._pruneKicks();
    return {
      connected: this.connected,
      attempts: this.attempt,
      disconnectCount: this.disconnectCount,
      recentKicks: this._kickTimestamps.length,
    };
  }
}

export default ConnectionManager;
