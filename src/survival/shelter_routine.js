import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { normalizeText } from '../commands.js';

export const ITEM_DESPAWN_MS = 300_000;
export const DEATH_PICKUP_MARGIN_MS = 20_000;
export const DEATH_RECOVERY_SPEED_BPS = 2.6;
export const DEFAULT_MAX_DEATH_DISTANCE = 350;

export function recordDeath(ctx, entity, dimension = 'overworld') {
  if (!entity?.position) return null;
  const pos = entity.position;
  let unrecoverableReason = null;
  if (pos.y < -64) {
    unrecoverableReason = 'void';
  } else if (typeof ctx.bot?.blockAt === 'function') {
    const feet = ctx.bot.blockAt(pos);
    const belowPos = typeof pos.offset === 'function' ? pos.offset(0, -1, 0) : { x: pos.x, y: pos.y - 1, z: pos.z };
    const below = ctx.bot.blockAt(belowPos);
    if (String(feet?.name ?? '').toLowerCase().includes('lava') || String(below?.name ?? '').toLowerCase().includes('lava')) {
      unrecoverableReason = 'lava';
    }
  }
  const death = {
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    z: Math.round(pos.z),
    dimension: String(dimension),
    diedAt: Date.now(),
    ...(unrecoverableReason ? { unrecoverable: true, unrecoverableReason } : {}),
  };
  ctx.memory?.set('lastDeath', death);
  ctx.memory?.upsertPoi?.({
    category: 'danger_zone',
    label: 'last_death',
    dimension: death.dimension,
    x: death.x,
    y: death.y,
    z: death.z,
    metadata: { diedAt: death.diedAt, unrecoverable: death.unrecoverable, reason: unrecoverableReason },
  });
  ctx.memory?.recordEvent?.({
    eventType: 'death',
    summary: `Chết tại ${death.x}, ${death.y}, ${death.z}${unrecoverableReason ? ` (${unrecoverableReason})` : ''}`,
    x: death.x,
    y: death.y,
    z: death.z,
  });
  ctx.log(`💀 Ghi nhận vị trí chết tại ${death.x}, ${death.y}, ${death.z}${unrecoverableReason ? ` [${unrecoverableReason}]` : ''}`);
  return death;
}

export function evaluateDeathRecovery(
  death,
  {
    fromPos = null,
    currentDimension = null,
    now = Date.now(),
    maxAgeMs = ITEM_DESPAWN_MS,
    maxDistance = DEFAULT_MAX_DEATH_DISTANCE,
    itemDespawnMs = ITEM_DESPAWN_MS,
    allowUnrecoverable = false,
  } = {}
) {
  if (!death) {
    return { ok: false, reason: 'none', shouldClear: false, distance: null, estimatedTravelMs: null, remainingMs: 0 };
  }
  if (!allowUnrecoverable && death.unrecoverable) {
    return {
      ok: false,
      reason: death.unrecoverableReason || 'unrecoverable',
      shouldClear: true,
      distance: null,
      estimatedTravelMs: null,
      remainingMs: 0,
    };
  }

  const despawnLimitMs = Math.max(1000, Number(itemDespawnMs ?? ITEM_DESPAWN_MS));
  const effectiveMaxAgeMs = Math.min(despawnLimitMs, Number(maxAgeMs ?? despawnLimitMs));
  const ageMs = Math.max(0, now - Number(death.diedAt ?? 0));
  const remainingMs = Math.max(0, despawnLimitMs - ageMs);

  if (ageMs > effectiveMaxAgeMs) {
    return {
      ok: false,
      reason: 'despawned_time',
      shouldClear: ageMs >= despawnLimitMs,
      distance: null,
      estimatedTravelMs: null,
      remainingMs: 0,
    };
  }

  if (currentDimension && death.dimension && String(currentDimension) !== String(death.dimension)) {
    return {
      ok: false,
      reason: 'wrong_dimension',
      shouldClear: false,
      distance: null,
      estimatedTravelMs: null,
      remainingMs,
    };
  }

  if (fromPos && Number.isFinite(fromPos.x) && Number.isFinite(fromPos.y) && Number.isFinite(fromPos.z)) {
    const dx = fromPos.x - death.x;
    const dy = fromPos.y - death.y;
    const dz = fromPos.z - death.z;
    const distance = Math.hypot(dx, dy, dz);
    const effectiveDist = Math.hypot(dx, dz) + Math.abs(dy) * 2.5;
    const estimatedTravelMs = Math.round((effectiveDist / DEATH_RECOVERY_SPEED_BPS) * 1000);
    const maxDistLimit = Number(maxDistance ?? DEFAULT_MAX_DEATH_DISTANCE);

    if (distance > maxDistLimit) {
      return { ok: false, reason: 'too_far', shouldClear: true, distance, estimatedTravelMs, remainingMs };
    }
    if (estimatedTravelMs + DEATH_PICKUP_MARGIN_MS > remainingMs) {
      return { ok: false, reason: 'will_despawn_on_way', shouldClear: true, distance, estimatedTravelMs, remainingMs };
    }
    return { ok: true, reason: null, shouldClear: false, distance, estimatedTravelMs, remainingMs };
  }

  return { ok: true, reason: null, shouldClear: false, distance: null, estimatedTravelMs: null, remainingMs };
}

export function getPendingDeathRecovery(
  ctx,
  { maxAgeMs = 240000, currentDimension = null, allowUnrecoverable = false, fromPos = undefined, maxDistance = undefined } = {}
) {
  const death = ctx.memory?.get('lastDeath');
  if (!death) return null;
  const pos = fromPos === undefined ? (ctx.bot?.entity?.position ?? null) : fromPos;
  const maxDist = maxDistance ?? ctx.config?.survival?.maxDeathRecoverDistance ?? DEFAULT_MAX_DEATH_DISTANCE;
  const itemDespawnMs = ctx.config?.survival?.itemDespawnMs ?? ITEM_DESPAWN_MS;
  const res = evaluateDeathRecovery(death, {
    fromPos: pos,
    currentDimension,
    maxAgeMs,
    maxDistance: maxDist,
    itemDespawnMs,
    allowUnrecoverable,
  });
  if (!res.ok) {
    if (res.shouldClear) clearDeath(ctx);
    return null;
  }
  return death;
}

export function isSafeSleepDimension(dimension) {
  if (!dimension) return true;
  const dim = String(dimension).toLowerCase();
  if (dim.includes('nether') || dim.includes('the_end') || dim.endsWith(':end') || dim === 'end') {
    return false;
  }
  return dim === 'overworld' || dim.endsWith(':overworld');
}

export function findSafeSleepBed(bot, ownerEntity = null, maxDistance = 16) {
  if (!bot || typeof bot.findBlock !== 'function') return null;
  if (!isSafeSleepDimension(bot.game?.dimension)) return null;
  return bot.findBlock({
    matching: (b) => {
      if (!b || !bot.isABed?.(b)) return false;
      const parsed = bot.parseBedMetadata?.(b);
      const props = b.getProperties?.() ?? b.properties ?? {};
      if (parsed?.occupied || props.occupied === true || props.occupied === 'true') return false;
      if (ownerEntity?.position && b.position) {
        const dist = typeof b.position.distanceTo === 'function'
          ? b.position.distanceTo(ownerEntity.position)
          : Math.hypot(b.position.x - ownerEntity.position.x, b.position.y - ownerEntity.position.y, b.position.z - ownerEntity.position.z);
        if (dist < 1.2) return false;
      }
      return true;
    },
    maxDistance,
  });
}

export function clearDeath(ctx) {
  return ctx.memory?.delete('lastDeath') ?? false;
}

export function checkHealthAlerts(ctx, { ownerName } = {}) {
  const now = Date.now();
  const alerts = [];

  if (typeof ctx.bot.health === 'number' && ctx.bot.health > 0 && ctx.bot.health <= 6 && now - ctx._lastBotAlertAt >= 30000) {
    ctx._lastBotAlertAt = now;
    alerts.push(`Cảnh báo: máu tôi còn ${Math.round(ctx.bot.health)}/20!`);
  }

  const owner = ownerName ? ctx.bot.players?.[ownerName]?.entity : null;
  if (owner && typeof owner.health === 'number' && owner.health > 0 && owner.health <= 6 && now - ctx._lastOwnerAlertAt >= 30000) {
    ctx._lastOwnerAlertAt = now;
    alerts.push(`Cẩn thận ${ownerName}, máu bạn còn ${Math.round(owner.health)}/20!`);
  }

  return alerts;
}

export function pickupNearbyItem(ctx, { stayPut = false } = {}) {
  if (stayPut) return false;
  const now = Date.now();
  if (now - (ctx.lastGaveItemAt ?? 0) < 8000) return false;
  if (now - ctx.lastPickupAt < 3000) return false;
  if (!ctx.bot.entity?.position || !ctx.bot.pathfinder) return false;
  if (typeof ctx.bot.inventory?.emptySlotCount === 'function' && ctx.bot.inventory.emptySlotCount() <= 0) {
    return false;
  }

  const pos = ctx.bot.entity.position;
  const equipMgr = ctx.bot._equipment;
  if (equipMgr && Date.now() - (equipMgr.lastDiscardAt ?? 0) < 6000) return false;
  const hasChest = Boolean(ctx.home?.getStorageChest?.());
  const ownerEntity = ctx.config?.owner ? ctx.bot.players?.[ctx.config.owner]?.entity ?? null : null;
  const dropped = Object.values(ctx.bot.entities ?? {})
    .filter(e => e && e.position && (e.name === 'item' || e.displayName === 'Item'))
    .filter(e => !equipMgr?.shouldPickupDroppedEntity || equipMgr.shouldPickupDroppedEntity(e, { ownerEntity, hasChestAvailable: hasChest }))
    .map(e => ({ entity: e, dist: pos.distanceTo(e.position) }))
    .filter(x => x.dist <= 4.5 && x.dist > 1)
    .sort((a, b) => a.dist - b.dist)[0];

  if (!dropped) return false;
  ctx.lastPickupAt = now;
  try {
    const p = dropped.entity.position;
    ctx.bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 0.5));
    return true;
  } catch {
    return false;
  }
}

export function checkAutoReturnCondition(ctx, { busy = false, ownerEntity = null } = {}) {
  if (!ctx.config.home?.autoReturn || busy || !ctx.home?.get?.()) return null;
  const now = Date.now();
  if (now - ctx.lastAutoReturnAt < 120000) return null;

  const timeOfDay = ctx.bot.time?.timeOfDay;
  const isNight = typeof timeOfDay === 'number' && timeOfDay >= 13000 && timeOfDay <= 23000;
  const isFull = typeof ctx.bot.inventory?.emptySlotCount === 'function' && ctx.bot.inventory.emptySlotCount() === 0;
  if (!isNight && !isFull) return null;

  if (
    isNight &&
    !isFull &&
    ownerEntity?.position &&
    ctx.bot.entity?.position &&
    ctx.bot.entity.position.distanceTo(ownerEntity.position) <= 24
  ) {
    return null;
  }

  const reason = isFull ? 'túi đồ đã đầy' : 'trời đã tối';
  ctx.lastAutoReturnAt = now;
  return { reason };
}

export async function checkAutoReturn(ctx, { busy = false } = {}) {
  const cond = ctx.checkAutoReturnCondition({ busy });
  if (!cond) return null;
  const ok = await ctx.home.returnHome();
  if (!ok) return null;
  return { triggered: true, reason: cond.reason };
}

export function saveWaypoint(ctx, name, position) {
  if (!position) return null;
  const key = normalizeText(name);
  const waypoints = { ...(ctx.memory?.get('waypoints', {}) ?? {}) };
  const point = {
    x: Math.round(position.x),
    y: Math.round(position.y),
    z: Math.round(position.z),
    savedAt: Date.now(),
  };
  waypoints[key] = point;
  ctx.memory?.set('waypoints', waypoints);
  ctx.memory?.upsertPoi?.({
    category: 'waypoint',
    label: key,
    dimension: String(ctx.bot?.game?.dimension ?? 'overworld'),
    x: point.x,
    y: point.y,
    z: point.z,
  });
  return point;
}

export function getWaypoint(ctx, name) {
  const key = normalizeText(name);
  const waypoints = ctx.memory?.get('waypoints', {}) ?? {};
  return waypoints[key] ?? null;
}

export function listWaypoints(ctx) {
  return Object.keys(ctx.memory?.get('waypoints', {}) ?? {});
}
