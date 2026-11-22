export const SWARM_ROLES = Object.freeze(['miner', 'carrier', 'guard', 'builder', 'general']);
const ROLE_SET = new Set(SWARM_ROLES);
const MAX_ALERT_HISTORY = 100;
const DEFAULT_CLAIM_TTL_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 5_000;

export function computeEscortArcPositions(ownerPos, ownerYaw = 0, botCount = 1, { radius = 3.2, spreadRad = Math.PI / 4 } = {}) {
  if (!ownerPos || botCount <= 0) return [];
  const count = Math.max(1, Math.floor(Number(botCount) || 1));
  const r = Math.max(1.5, Number(radius) || 3.2);
  // In Mineflayer: yaw=0 -> north (-z), PI/2 -> west (-x), -PI/2 -> east (+x), PI -> south (+z)
  const forwardAngle = Math.atan2(-Math.cos(ownerYaw), -Math.sin(ownerYaw));
  const spots = [];
  for (let k = 0; k < count; k++) {
    const alpha = forwardAngle + Math.PI + (k - (count - 1) / 2) * spreadRad;
    spots.push({
      index: k,
      angle: alpha,
      x: Number((ownerPos.x + r * Math.cos(alpha)).toFixed(3)),
      y: ownerPos.y,
      z: Number((ownerPos.z + r * Math.sin(alpha)).toFixed(3)),
    });
  }
  return spots;
}

export class ClaimRegistry {
  constructor({ defaultTtlMs = DEFAULT_CLAIM_TTL_MS } = {}) {
    this.defaultTtlMs = Math.max(100, Number(defaultTtlMs) || DEFAULT_CLAIM_TTL_MS);
    this._claims = new Map();
  }

  static blockKey(pos) {
    return `block:${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  }

  static entityKey(entityId) {
    return `entity:${entityId}`;
  }

  pruneExpired(now = Date.now()) {
    let removed = 0;
    for (const [key, entry] of this._claims.entries()) {
      if (entry.expiresAt <= now) {
        this._claims.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  getClaim(key, { now = Date.now() } = {}) {
    const existing = this._claims.get(String(key));
    if (!existing) return null;
    if (existing.expiresAt <= now) {
      this._claims.delete(String(key));
      return null;
    }
    return { ...existing };
  }

  tryClaim(key, botId, { ttlMs = this.defaultTtlMs, now = Date.now() } = {}) {
    const k = String(key);
    const owner = String(botId ?? '').trim();
    if (!k || !owner) return { ok: false, reason: 'INVALID_CLAIM_ARGS' };
    const ttl = Math.max(50, Number(ttlMs) || this.defaultTtlMs);
    const existing = this.getClaim(k, { now });
    if (existing && existing.botId !== owner) {
      return { ok: false, reason: 'ALREADY_CLAIMED', owner: existing.botId, expiresAt: existing.expiresAt };
    }
    const entry = { key: k, botId: owner, claimedAt: existing?.claimedAt ?? now, expiresAt: now + ttl };
    this._claims.set(k, entry);
    return { ok: true, claim: { ...entry } };
  }

  tryClaimBlock(pos, botId, opts = {}) {
    if (!pos) return { ok: false, reason: 'INVALID_POS' };
    return this.tryClaim(ClaimRegistry.blockKey(pos), botId, opts);
  }

  tryClaimEntity(entityId, botId, opts = {}) {
    if (entityId == null) return { ok: false, reason: 'INVALID_ENTITY' };
    return this.tryClaim(ClaimRegistry.entityKey(entityId), botId, opts);
  }

  renewClaim(key, botId, { ttlMs = this.defaultTtlMs, now = Date.now() } = {}) {
    const k = String(key);
    const owner = String(botId ?? '').trim();
    const existing = this.getClaim(k, { now });
    if (!existing) return { ok: false, reason: 'NOT_CLAIMED' };
    if (existing.botId !== owner) return { ok: false, reason: 'NOT_CLAIM_OWNER', owner: existing.botId };
    const ttl = Math.max(50, Number(ttlMs) || this.defaultTtlMs);
    existing.expiresAt = now + ttl;
    this._claims.set(k, existing);
    return { ok: true, claim: { ...existing } };
  }

  releaseClaim(key, botId = null) {
    const k = String(key);
    const existing = this._claims.get(k);
    if (!existing) return false;
    if (botId != null && existing.botId !== String(botId).trim()) return false;
    return this._claims.delete(k);
  }

  releaseAllForBot(botId) {
    const owner = String(botId ?? '').trim();
    let count = 0;
    for (const [k, entry] of this._claims.entries()) {
      if (entry.botId === owner) {
        this._claims.delete(k);
        count += 1;
      }
    }
    return count;
  }

  async withClaim(key, botId, fn, { ttlMs = this.defaultTtlMs, heartbeatMs = DEFAULT_HEARTBEAT_MS, signal = null } = {}) {
    const acquired = this.tryClaim(key, botId, { ttlMs });
    if (!acquired.ok) return acquired;

    const intervalMs = Math.max(10, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);
    const timer = setInterval(() => {
      if (signal?.aborted) return;
      this.renewClaim(key, botId, { ttlMs });
    }, intervalMs);
    timer.unref?.();

    try {
      const result = await fn(signal);
      return { ok: true, result };
    } finally {
      clearInterval(timer);
      this.releaseClaim(key, botId);
    }
  }

  size({ now = Date.now() } = {}) {
    this.pruneExpired(now);
    return this._claims.size;
  }
}

function normalizeRole(role) {
  const r = String(role ?? 'general').trim().toLowerCase();
  return ROLE_SET.has(r) ? r : 'general';
}

export class SwarmCoordinator {
  constructor({ memory = null, log = () => {}, claimTtlMs = DEFAULT_CLAIM_TTL_MS } = {}) {
    this.memory = memory;
    this.log = log;
    this.bots = new Map();
    this.transfers = [];
    this.alerts = [];
    this.claims = new ClaimRegistry({ defaultTtlMs: claimTtlMs });
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
    this.claims.releaseAllForBot(botId);
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

  tryClaimBlock(pos, botId, opts) {
    return this.claims.tryClaimBlock(pos, botId, opts);
  }

  tryClaimEntity(entityId, botId, opts) {
    return this.claims.tryClaimEntity(entityId, botId, opts);
  }

  renewClaim(key, botId, opts) {
    return this.claims.renewClaim(key, botId, opts);
  }

  releaseClaim(key, botId) {
    return this.claims.releaseClaim(key, botId);
  }

  withClaim(key, botId, fn, opts) {
    return this.claims.withClaim(key, botId, fn, opts);
  }

  getEscortFormation(ownerPos, ownerYaw = 0, botIds = null, opts = {}) {
    const ids = Array.isArray(botIds) && botIds.length > 0
      ? botIds
      : Array.from(this.bots.keys());
    const spots = computeEscortArcPositions(ownerPos, ownerYaw, ids.length, opts);
    return ids.map((botId, idx) => ({ botId, ...spots[idx] }));
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
      activeClaims: this.claims.size(),
      pendingTransfers: this.transfers.filter(t => t.status === 'pending').length,
      inTransitTransfers: this.transfers.filter(t => t.status === 'in_transit').length,
      completedTransfers: this.transfers.filter(t => t.status === 'completed').length,
      recentAlerts: this.alerts.slice(-10),
    };
  }
}

export default SwarmCoordinator;
