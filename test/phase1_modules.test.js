import test from 'node:test';
import assert from 'node:assert/strict';
import { BotStateMachine, SESSION_STATES } from '../src/session/state_machine.js';
import { ConnectionManager } from '../src/session/connection_manager.js';
import { HealthWatchdog } from '../src/session/health_watchdog.js';
import { scanNearbyThreats } from '../src/survival/threat_radar.js';

test('BotStateMachine transitions and syncs states in strict priority order', () => {
  const sm = new BotStateMachine();
  assert.equal(sm.snapshot().state, SESSION_STATES.DISCONNECTED);

  assert.equal(sm.sync({ connected: true }), SESSION_STATES.IDLE);
  assert.equal(sm.sync({ connected: true, activeTask: true }), SESSION_STATES.BUSY);
  assert.equal(sm.sync({ connected: true, activeTask: true, sleeping: true }), SESSION_STATES.SLEEPING);
  assert.equal(sm.sync({ connected: true, activeTask: true, sleeping: true, combatBusy: true }), SESSION_STATES.COMBAT);
  assert.equal(sm.sync({ connected: true, activeTask: true, combatBusy: true, retreating: true }), SESSION_STATES.RETREATING);
  assert.equal(sm.sync({ connected: true, alive: false, combatBusy: true, retreating: true }), SESSION_STATES.DEAD);
  assert.equal(sm.sync({ connected: false, alive: false }), SESSION_STATES.DISCONNECTED);

  // Repeating same state does not add redundant history entries
  assert.equal(sm.transition(SESSION_STATES.DISCONNECTED, 'noop'), false);
  const snap = sm.snapshot();
  assert.equal(snap.previousState, SESSION_STATES.DEAD);
  assert.ok(snap.history.length >= 6);
});

test('ConnectionManager applies exponential backoff, caps at maxDelayMs, penalizes kick-spam, and resets on connect', () => {
  const cm = new ConnectionManager({
    baseDelayMs: 1000,
    maxDelayMs: 4000,
    kickPenaltyMs: 5000,
    maxRecentKicks: 3,
    kickWindowMs: 60000,
  });

  assert.equal(cm.nextReconnectDelayMs(), 1000);
  assert.equal(cm.nextReconnectDelayMs(), 2000);
  assert.equal(cm.nextReconnectDelayMs(), 4000);
  assert.equal(cm.nextReconnectDelayMs(), 4000);

  cm.markConnected();
  assert.equal(cm.status().connected, true);
  assert.equal(cm.status().attempts, 0);
  assert.equal(cm.nextReconnectDelayMs(), 1000);

  cm.markConnected();
  cm.markKicked('kick 1');
  cm.markKicked('kick 2');
  cm.markKicked('kick 3');
  cm.markDisconnected();
  assert.equal(cm.nextReconnectDelayMs(), 6000); // 1000 + 5000 kick penalty
  assert.equal(cm.status().recentKicks, 3);
  assert.equal(cm.status().disconnectCount, 1);

  cm.resetBackoff();
  assert.equal(cm.status().attempts, 0);
});

test('HealthWatchdog detects movement stuck vs digging/sleeping exemptions and tick lag', () => {
  const wd = new HealthWatchdog({
    stuckThresholdMs: 5000,
    lagThresholdMs: 1000,
    minMoveDistance: 0.25,
  });

  const p0 = { x: 10, y: 64, z: 10 };
  let st = wd.recordTick(1000, { pos: p0, moving: true });
  assert.equal(st.healthy, true);

  st = wd.recordTick(6200, { pos: p0, moving: true });
  assert.equal(st.stuck, true);
  assert.equal(st.lagDetected, true);
  assert.equal(st.healthy, false);
  assert.equal(st.stuckMs, 5200);
  assert.equal(st.maxTickLagMs, 5200);

  // Moving >= minMoveDistance resets stuck state
  st = wd.recordTick(6500, { pos: { x: 11, y: 64, z: 10 }, moving: true });
  assert.equal(st.stuck, false);
  assert.equal(st.lagDetected, false);
  assert.equal(st.healthy, true);

  // Digging or sleeping resets stuck timer even if stationary
  st = wd.recordTick(13000, { pos: { x: 11, y: 64, z: 10 }, moving: false, activeTask: true, digging: true });
  assert.equal(st.stuck, false);
});

test('scanNearbyThreats ignores passive/friendly entities and scores hostiles and creepers', () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    players: {
      araslime: { entity: { position: { x: 6, y: 64, z: 0 } } },
    },
    entities: {
      1: { id: 1, name: 'cow', position: { x: 2, y: 64, z: 0 } },
      2: { id: 2, type: 'player', name: 'araslime', position: { x: 6, y: 64, z: 0 } },
      3: { id: 3, name: 'item', position: { x: 1, y: 64, z: 0 } },
      4: { id: 4, name: 'zombie', position: { x: 7, y: 64, z: 0 } },
      5: { id: 5, name: 'creeper', position: { x: 4, y: 64, z: 0 } },
    },
  };

  const summary = scanNearbyThreats(bot, { radius: 16, ownerName: 'araslime' });
  assert.equal(summary.count, 2);
  assert.equal(summary.closest.name, 'creeper');
  assert.equal(summary.nearestCreeper.id, 5);
  assert.equal(summary.ownerThreat.name, 'zombie');
  assert.equal(summary.dangerLevel, 'high');
});
