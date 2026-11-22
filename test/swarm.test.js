import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SwarmCoordinator, SWARM_ROLES } from '../src/swarm/coordinator.js';
import { Memory } from '../src/memory.js';

test('SwarmCoordinator routes tasks by role, balances load, and handles busy workers', () => {
  assert.deepEqual(SWARM_ROLES, ['miner', 'carrier', 'guard', 'builder', 'general']);
  const assignedLog = [];
  const swarm = new SwarmCoordinator({ log: () => {} });

  swarm.registerBot('m1', { role: 'miner', onTask: (t) => assignedLog.push(['m1', t.name]) });
  swarm.registerBot('m2', { role: 'miner', onTask: (t) => assignedLog.push(['m2', t.name]) });
  swarm.registerBot('g1', { role: 'guard', onTask: (t) => assignedLog.push(['g1', t.name]) });

  const r1 = swarm.assignTask({ name: 'dig_iron_vein', requiredRole: 'miner', priority: 70 });
  assert.equal(r1.assigned, true);
  assert.equal(r1.botId, 'm1');

  const r2 = swarm.assignTask({ name: 'dig_coal_vein', requiredRole: 'miner', priority: 60 });
  assert.equal(r2.assigned, true);
  assert.equal(r2.botId, 'm2');

  const rBusy = swarm.assignTask({ name: 'dig_gold', requiredRole: 'miner' });
  assert.equal(rBusy.assigned, false);
  assert.equal(rBusy.reason, 'no_eligible_idle_bot');

  const rGuard = swarm.assignTask({ name: 'patrol_base', requiredRole: 'guard' });
  assert.equal(rGuard.assigned, true);
  assert.equal(rGuard.botId, 'g1');

  // Complete m1 -> m1 now has 1 completed, m2 still busy -> next goes to m1
  assert.equal(swarm.completeTask('m1', r1.task.id).ok, true);
  const r3 = swarm.assignTask({ name: 'dig_copper', requiredRole: 'miner' });
  assert.equal(r3.assigned, true);
  assert.equal(r3.botId, 'm1');

  const st = swarm.status();
  assert.equal(st.totalBots, 3);
  assert.equal(st.busyBots, 3);
  assert.equal(st.idleBots, 0);
  assert.equal(assignedLog.length, 4);
});

test('SwarmCoordinator coordinates Miner to Carrier supply transfers and unregister recovery', () => {
  const swarm = new SwarmCoordinator({ log: () => {} });
  const carrierTasks = [];
  swarm.registerBot('miner_1', { role: 'miner' });
  swarm.registerBot('carrier_1', { role: 'carrier', onTask: (t) => carrierTasks.push(t) });

  const tr = swarm.requestSupplyTransfer({
    fromBotId: 'miner_1',
    toBotId: 'home_chest',
    itemName: 'raw_iron',
    count: 64,
    location: { x: 120, y: -12, z: -40 },
  });

  assert.equal(tr.status, 'in_transit');
  assert.equal(tr.carrierId, 'carrier_1');
  assert.equal(carrierTasks.length, 1);
  assert.equal(carrierTasks[0].name, 'supply_transfer');

  // Unregistering active carrier releases transfer back to pending
  assert.equal(swarm.unregisterBot('carrier_1'), true);
  assert.equal(swarm.status().pendingTransfers, 1);
  assert.equal(swarm.status().inTransitTransfers, 0);

  // New carrier claims and completes pending transfer
  swarm.registerBot('carrier_2', { role: 'carrier' });
  const claimed = swarm.claimTransfer('carrier_2', tr.id);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.transfer.carrierId, 'carrier_2');

  const done = swarm.completeTransfer(tr.id);
  assert.equal(done.ok, true);
  assert.equal(done.transfer.status, 'completed');
  assert.equal(swarm.status().completedTransfers, 1);
  assert.equal(swarm.status().idleBots, 2);
});

test('SwarmCoordinator broadcastAlert notifies peers and syncs POIs/events to SQLite Memory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-swarm-mem-'));
  const mem = new Memory({ dbPath: path.join(dir, 'swarm.db') });
  await mem.load();
  try {
    const minerAlerts = [];
    const guardAlerts = [];
    const swarm = new SwarmCoordinator({ memory: mem, log: () => {} });

    swarm.registerBot('miner_1', { role: 'miner', onAlert: (a) => minerAlerts.push(a) });
    swarm.registerBot('guard_1', { role: 'guard', onAlert: (a) => guardAlerts.push(a) });

    const alert = swarm.broadcastAlert({
      fromBotId: 'miner_1',
      type: 'diamond_vein',
      summary: 'Tìm thấy 8 kim cương gần dung nham',
      x: 42,
      y: -54,
      z: -18,
      category: 'ore',
    });

    assert.equal(alert.type, 'diamond_vein');
    // Sender does not receive own alert; peer guard does
    assert.equal(minerAlerts.length, 0);
    assert.equal(guardAlerts.length, 1);
    assert.equal(guardAlerts[0].summary, 'Tìm thấy 8 kim cương gần dung nham');

    const pois = mem.queryPois({ category: 'ore' });
    assert.equal(pois.length, 1);
    assert.equal(pois[0].x, 42);
    assert.equal(pois[0].y, -54);
    assert.equal(pois[0].z, -18);

    const events = mem.recentEvents({ eventType: 'swarm_diamond_vein' });
    assert.equal(events.length, 1);
    assert.match(events[0].summary, /miner_1/);
  } finally {
    mem.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
