import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { normalizeText } from '../commands.js';

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

export function getPendingDeathRecovery(ctx, { maxAgeMs = 240000, currentDimension = null, allowUnrecoverable = false } = {}) {
  const death = ctx.memory?.get('lastDeath');
  if (!death) return null;
  if (!allowUnrecoverable && death.unrecoverable) return null;
  if (Date.now() - death.diedAt > maxAgeMs) return null;
  if (currentDimension && death.dimension && String(currentDimension) !== String(death.dimension)) {
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

export function pickupNearbyItem(ctx) {
  const now = Date.now();
  if (now - ctx.lastPickupAt < 3000) return false;
  if (!ctx.bot.entity?.position || !ctx.bot.pathfinder) return false;
  if (typeof ctx.bot.inventory?.emptySlotCount === 'function' && ctx.bot.inventory.emptySlotCount() <= 0) {
    return false;
  }

  const pos = ctx.bot.entity.position;
  const dropped = Object.values(ctx.bot.entities ?? {})
    .filter(e => e && e.position && (e.name === 'item' || e.displayName === 'Item'))
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

export function checkAutoReturnCondition(ctx, { busy = false } = {}) {
  if (!ctx.config.home?.autoReturn || busy || !ctx.home?.get?.()) return null;
  const now = Date.now();
  if (now - ctx.lastAutoReturnAt < 120000) return null;

  const timeOfDay = ctx.bot.time?.timeOfDay;
  const isNight = typeof timeOfDay === 'number' && timeOfDay >= 13000 && timeOfDay <= 23000;
  const isFull = typeof ctx.bot.inventory?.emptySlotCount === 'function' && ctx.bot.inventory.emptySlotCount() === 0;
  if (!isNight && !isFull) return null;

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
