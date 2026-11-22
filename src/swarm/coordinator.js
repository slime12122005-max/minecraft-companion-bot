export const SWARM_ROLES = Object.freeze(['miner', 'carrier', 'guard', 'builder', 'general']);
const ROLE_SET = new Set(SWARM_ROLES);
const MAX_ALERT_HISTORY = 100;

function normalizeRole(role) {
  const r = String(role ?? 'general').trim().toLowerCase();
  return ROLE_SET.has(r) ? r : 'general';
}

export class SwarmCoordinator {
  constructor({ memory = null, log = () => {} } = {}) {
    this.memory = memory;
    this.log = log;
    this.bots = new Map();
    this.transfers = [];
    this.alerts = [];
    this._seq = 0;
  }

  _nextId(prefix) {
    this._seq += 1;
    return `${prefix}_${this._seq}`;
  }

  registerBot(id, { role = 'general', session = null, capabilities = [], onAlert = null, onTask = null } = {}) {
    const botId = String(id ?? '').trim();
    if (!botId) throw new Error('Bot id is required');
    const record = {
      id: botId,
      role: normalizeRole(role),
      session,
      capabilities: Array.isArray(capabilities) ? capabilities.map(String) : [],
      onAlert: typeof onAlert === 'function' ? onAlert : null,
      onTask: typeof onTask === 'function' ? onTask : null,
      status: 'idle',
      activeTask: null,
      completedCount: 0,
      registeredAt: Date.now(),
    };
    this.bots.set(botId, record);
    this.log(`🤖 Swarm registered ${botId} (${record.role})`);
    return this._summarizeBot(record);
  }

  unregisterBot(id) {
    const botId = String(id ?? '').trim();
    const existed = this.bots.delete(botId);
    if (!existed) return false;
    for (const tr of this.transfers) {
      if (tr.status === 'in_transit' && tr.carrierId === botId) {
        tr.status = 'pending';
        tr.carrierId = null;
        tr.claimedAt = null;
      }
    }
    this.log(`🔌 Swarm unregistered ${botId}`);
    return true;
  }

  _summarizeBot(b) {
    return {
      id: b.id,
      role: b.role,
      capabilities: [...b.capabilities],
      status: b.status,
      activeTask: b.activeTask ? { id: b.activeTask.id, name: b.activeTask.name } : null,
      completedCount: b.completedCount,
    };
  }

  listBots({ role = null, status = null } = {}) {
    const out = [];
    for (const b of this.bots.values()) {
      if (role != null && b.role !== normalizeRole(role)) continue;
      if (status != null && b.status !== status) continue;
      out.push(this._summarizeBot(b));
    }
    return out;
  }

  _pickCandidate(requiredRole) {
    const req = requiredRole ? normalizeRole(requiredRole) : null;
    const idle = Array.from(this.bots.values()).filter(b => b.status === 'idle');
    if (idle.length === 0) return null;

    const sortLeastLoaded = (arr) =>
      arr.sort((a, b) => (a.completedCount - b.completedCount) || (a.registeredAt - b.registeredAt));

    if (!req) return sortLeastLoaded(idle)[0];

    const exact = idle.filter(b => b.role === req || b.capabilities.includes(req));
    if (exact.length > 0) return sortLeastLoaded(exact)[0];

    const general = idle.filter(b => b.role === 'general');
    if (general.length > 0) return sortLeastLoaded(general)[0];

    return null;
  }

  assignTask(taskSpec = {}) {
    const name = String(taskSpec.name ?? '').trim();
    if (!name) return { assigned: false, reason: 'task_name_required' };
    const candidate = this._pickCandidate(taskSpec.requiredRole ?? null);
    if (!candidate) {
      return { assigned: false, reason: 'no_eligible_idle_bot' };
    }
    const task = {
      id: taskSpec.id ? String(taskSpec.id) : this._nextId('task'),
      name,
      requiredRole: taskSpec.requiredRole ? normalizeRole(taskSpec.requiredRole) : null,
      priority: Number(taskSpec.priority ?? 50),
      payload: taskSpec.payload ?? null,
      assignedAt: Date.now(),
    };
    candidate.status = 'busy';
    candidate.activeTask = task;
    try { candidate.onTask?.(task); } catch {}
    return { assigned: true, botId: candidate.id, task };
  }

  completeTask(botId, taskId = null) {
    const bot = this.bots.get(String(botId ?? '').trim());
    if (!bot) return { ok: false, reason: 'unknown_bot' };
    if (taskId && bot.activeTask && bot.activeTask.id !== taskId) {
      return { ok: false, reason: 'task_mismatch' };
    }
    const completedId = bot.activeTask?.id ?? taskId;
    bot.status = 'idle';
    bot.activeTask = null;
    bot.completedCount += 1;
    return { ok: true, botId: bot.id, taskId: completedId };
  }

  requestSupplyTransfer({ fromBotId, toBotId = null, itemName, count = 1, location = null, autoClaim = true } = {}) {
    const cleanFrom = String(fromBotId ?? '').trim();
    const cleanItem = String(itemName ?? '').trim();
    if (!cleanFrom || !cleanItem) throw new Error('fromBotId and itemName are required');
    const transfer = {
      id: this._nextId('tr'),
      fromBotId: cleanFrom,
      toBotId: toBotId ? String(toBotId).trim() : null,
      itemName: cleanItem,
      count: Math.max(1, Number(count) || 1),
      location: location ? { x: Number(location.x), y: Number(location.y), z: Number(location.z) } : null,
      status: 'pending',
      carrierId: null,
      createdAt: Date.now(),
      claimedAt: null,
      completedAt: null,
    };
    this.transfers.push(transfer);
    if (autoClaim !== false) {
      const carrier = Array.from(this.bots.values())
        .filter(b => b.role === 'carrier' && b.status === 'idle')
        .sort((a, b) => a.completedCount - b.completedCount)[0];
      if (carrier) this.claimTransfer(carrier.id, transfer.id);
    }
    return { ...transfer };
  }

  claimTransfer(carrierId, transferId = null) {
    const carrier = this.bots.get(String(carrierId ?? '').trim());
    if (!carrier) return { ok: false, reason: 'unknown_carrier' };
    const transfer = transferId
      ? this.transfers.find(t => t.id === transferId && t.status === 'pending')
      : this.transfers.find(t => t.status === 'pending');
    if (!transfer) return { ok: false, reason: 'no_pending_transfer' };
    transfer.status = 'in_transit';
    transfer.carrierId = carrier.id;
    transfer.claimedAt = Date.now();
    carrier.status = 'busy';
    carrier.activeTask = {
      id: transfer.id,
      name: 'supply_transfer',
      transferId: transfer.id,
      payload: { ...transfer },
    };
    try { carrier.onTask?.(carrier.activeTask); } catch {}
    return { ok: true, transfer: { ...transfer } };
  }

  completeTransfer(transferId) {
    const transfer = this.transfers.find(t => t.id === transferId);
    if (!transfer) return { ok: false, reason: 'unknown_transfer' };
    transfer.status = 'completed';
    transfer.completedAt = Date.now();
    if (transfer.carrierId) {
      const carrier = this.bots.get(transfer.carrierId);
      if (carrier && carrier.activeTask?.transferId === transfer.id) {
        carrier.status = 'idle';
        carrier.activeTask = null;
        carrier.completedCount += 1;
      }
    }
    return { ok: true, transfer: { ...transfer } };
  }

  broadcastAlert({ fromBotId, type = 'info', summary, x = null, y = null, z = null, category = null, dimension = 'overworld' } = {}) {
    const sender = String(fromBotId ?? 'system').trim();
    const alertType = String(type ?? 'info').trim();
    const text = String(summary ?? '').trim();
    const alert = {
      id: this._nextId('alert'),
      fromBotId: sender,
      type: alertType,
      summary: text,
      x: x != null ? Number(x) : null,
      y: y != null ? Number(y) : null,
      z: z != null ? Number(z) : null,
      category: category ? String(category) : null,
      dimension: String(dimension || 'overworld'),
      createdAt: Date.now(),
    };
    this.alerts.push(alert);
    if (this.alerts.length > MAX_ALERT_HISTORY) this.alerts.shift();

    for (const bot of this.bots.values()) {
      if (bot.id === sender || !bot.onAlert) continue;
      try { bot.onAlert(alert); } catch {}
    }

    if (this.memory) {
      try {
        this.memory.recordEvent?.({
          eventType: `swarm_${alertType}`,
          summary: `[${sender}] ${text}`,
          x: alert.x,
          y: alert.y,
          z: alert.z,
        });
      } catch {}
      const hasCoords = alert.x != null && alert.y != null && alert.z != null &&
        Number.isFinite(alert.x) && Number.isFinite(alert.y) && Number.isFinite(alert.z);
      if (alert.category && hasCoords) {
        try {
          this.memory.upsertPoi?.({
            category: alert.category,
            label: `${alertType}:${sender}`,
            dimension: alert.dimension,
            x: alert.x,
            y: alert.y,
            z: alert.z,
            metadata: { fromBotId: sender, summary: text },
          });
        } catch {}
      }
    }

    return { ...alert };
  }

  status() {
    const bots = this.listBots();
    const idleBots = bots.filter(b => b.status === 'idle').length;
    const busyBots = bots.filter(b => b.status === 'busy').length;
    return {
      totalBots: bots.length,
      idleBots,
      busyBots,
      bots,
      pendingTransfers: this.transfers.filter(t => t.status === 'pending').length,
      inTransitTransfers: this.transfers.filter(t => t.status === 'in_transit').length,
      completedTransfers: this.transfers.filter(t => t.status === 'completed').length,
      recentAlerts: this.alerts.slice(-10),
    };
  }
}

export default SwarmCoordinator;
