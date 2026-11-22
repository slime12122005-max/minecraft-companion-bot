export const SESSION_STATES = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  IDLE: 'IDLE',
  BUSY: 'BUSY',
  COMBAT: 'COMBAT',
  RETREATING: 'RETREATING',
  SLEEPING: 'SLEEPING',
  DEAD: 'DEAD',
});

export class BotStateMachine {
  constructor(initial = SESSION_STATES.DISCONNECTED) {
    this.state = initial;
    this.previousState = null;
    this.changedAt = Date.now();
    this.reason = '';
    this.history = [];
  }

  transition(nextState, reason = '') {
    if (!nextState || nextState === this.state) return false;
    const now = Date.now();
    this.history.push({
      from: this.state,
      to: nextState,
      reason: String(reason ?? ''),
      at: now,
    });
    if (this.history.length > 20) {
      this.history.shift();
    }
    this.previousState = this.state;
    this.state = nextState;
    this.changedAt = now;
    this.reason = String(reason ?? '');
    return true;
  }

  sync({
    connected = false,
    alive = true,
    sleeping = false,
    combatBusy = false,
    retreating = false,
    activeTask = false,
  } = {}) {
    let target = SESSION_STATES.IDLE;
    let reason = 'ready';
    if (!connected) {
      target = SESSION_STATES.DISCONNECTED;
      reason = 'disconnected';
    } else if (!alive) {
      target = SESSION_STATES.DEAD;
      reason = 'dead';
    } else if (retreating) {
      target = SESSION_STATES.RETREATING;
      reason = 'retreating';
    } else if (combatBusy) {
      target = SESSION_STATES.COMBAT;
      reason = 'combat';
    } else if (sleeping) {
      target = SESSION_STATES.SLEEPING;
      reason = 'sleeping';
    } else if (activeTask) {
      target = SESSION_STATES.BUSY;
      reason = 'task';
    }
    this.transition(target, reason);
    return this.state;
  }

  snapshot() {
    return {
      state: this.state,
      previousState: this.previousState,
      changedAt: this.changedAt,
      reason: this.reason,
      history: this.history.map(entry => ({ ...entry })),
    };
  }
}

export default BotStateMachine;
