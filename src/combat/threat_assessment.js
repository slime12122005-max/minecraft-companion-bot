import { Vec3 } from 'vec3';

export const NON_HOSTILE_NAMES = new Set([
  'allay', 'iron_golem', 'snow_golem', 'skeleton_horse', 'zombie_horse',
  'villager', 'wandering_trader', 'cow', 'pig', 'sheep', 'chicken',
  'horse', 'donkey', 'mule', 'wolf', 'cat', 'axolotl', 'armadillo',
  'sniffer', 'camel', 'fox', 'frog', 'goat', 'llama', 'trader_llama',
  'mooshroom', 'ocelot', 'panda', 'parrot', 'rabbit', 'strider', 'turtle',
  'dolphin', 'cod', 'salmon', 'squid', 'glow_squid', 'tadpole',
  'tropical_fish', 'pufferfish', 'bat', 'bee',
]);

export const NEUTRAL_UNLESS_AGGRO = new Set(['enderman', 'zombified_piglin']);
export const RANGED_MOBS = ['skeleton', 'stray', 'bogged', 'pillager', 'blaze'];
export const FLYING_MOBS = new Set(['phantom', 'ghast', 'blaze', 'vex', 'wither', 'ender_dragon', 'breeze']);
export const HAZARD_BLOCKS = new Set(['lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush']);

export const MOB_BASE_DAMAGE = Object.freeze({
  warden: 15,
  ravager: 12,
  creeper: 10,
  vindicator: 9,
  piglin_brute: 9,
  enderman: 7,
  evoker: 5,
  witch: 5,
  blaze: 5,
  guardian: 5,
  skeleton: 4,
  stray: 4,
  bogged: 4,
  pillager: 4,
  wither_skeleton: 6,
  zombie: 3,
  husk: 3,
  drowned: 3,
  spider: 3,
  cave_spider: 3,
});

export const MOB_HAZARD_MULTIPLIER = Object.freeze({
  warden: 3.5,
  creeper: 3.0,
  ravager: 2.2,
  evoker: 2.0,
  witch: 2.0,
  blaze: 2.0,
  vindicator: 2.0,
  piglin_brute: 2.0,
  skeleton: 1.8,
  stray: 1.8,
  bogged: 1.8,
  pillager: 1.8,
  enderman: 1.6,
  wither_skeleton: 1.6,
  zombie: 1.0,
  husk: 1.0,
  drowned: 1.0,
  spider: 1.0,
  cave_spider: 1.0,
});

export function evaluateThreatScore(nearbyMobs = [], { health = 20, armorMitigation = 0 } = {}) {
  const H = Math.max(1, Number(health ?? 20));
  const A = Math.max(0, Number(armorMitigation ?? 0));
  let totalThreatPower = 0;

  for (const mob of nearbyMobs) {
    const name = String(mob?.name ?? mob?.entity?.name ?? '').toLowerCase();
    const baseName = Object.keys(MOB_BASE_DAMAGE).find(k => name.includes(k));
    const D = baseName ? MOB_BASE_DAMAGE[baseName] : 3;
    const multKey = Object.keys(MOB_HAZARD_MULTIPLIER).find(k => name.includes(k));
    const M = multKey ? MOB_HAZARD_MULTIPLIER[multKey] : 1.0;
    totalThreatPower += D * M;
  }

  const T = totalThreatPower / (H * (1 + A));
  let posture = 'aggressive';
  if (T >= 1.2) posture = 'retreat';
  else if (T >= 0.6) posture = 'kite';

  return {
    score: Number(T.toFixed(3)),
    posture,
    totalThreatPower: Number(totalThreatPower.toFixed(2)),
    health: H,
    armorMitigation: A,
    mobCount: nearbyMobs.length,
  };
}

export function isHostileThreat(bot, e, owner) {
  if (!e || !e.position) return false;
  if (e.health !== undefined && e.health <= 0) return false;
  const name = (e.name ?? '').toLowerCase();
  if (NON_HOSTILE_NAMES.has(name)) return false;

  const isHostileType = e.kind === 'Hostile mobs' || e.type === 'hostile' || e.type === 'mob';
  if (!isHostileType) return false;

  if (NEUTRAL_UNLESS_AGGRO.has(name)) {
    const targetingUs = e.target === bot.entity || (owner && e.target === owner);
    const dist = bot.entity.position.distanceTo(e.position);
    if (!targetingUs && dist > 2.5) return false;
  }

  return true;
}

export function isSolidOccluder(block) {
  if (!block || block.boundingBox !== 'block') return false;
  const name = (block.name ?? '').toLowerCase();
  return !['leaves', 'glass', 'door', 'gate', 'fence', 'trapdoor', 'bars'].some(k => name.includes(k));
}

export function isReachableThreat(bot, e, owner, maxVerticalDistance = 5) {
  const pos = bot.entity?.position;
  if (!pos || !e?.position) return true;
  const name = (e.name ?? '').toLowerCase();
  if (FLYING_MOBS.has(name)) return true;
  if (e.target === bot.entity || (owner && e.target === owner)) return true;

  const dy = Math.abs(e.position.y - pos.y);
  if (dy > maxVerticalDistance) return false;

  if (dy >= 2.5 && typeof bot.blockAt === 'function') {
    const x0 = pos.x;
    const y0 = pos.y + 1.5;
    const z0 = pos.z;
    const x1 = e.position.x;
    const y1 = e.position.y + 1.0;
    const z1 = e.position.z;
    for (const t of [0.25, 0.5, 0.75]) {
      const sx = Math.floor(x0 + (x1 - x0) * t);
      const sy = Math.floor(y0 + (y1 - y0) * t);
      const sz = Math.floor(z0 + (z1 - z0) * t);
      const block = bot.blockAt(new Vec3(sx, sy, sz));
      if (isSolidOccluder(block)) return false;
    }
  }
  return true;
}

export function pickThreat(bot, mobs, state, owner = null, ownerHurtRecently = false) {
  const scored = mobs.map(m => {
    let score = 0;
    const name = m.name.toLowerCase();
    if (name.includes('warden')) score += 1000;
    if (name.includes('creeper')) score += 900;
    if (name.includes('evoker') || name.includes('piglin_brute')) score += 780;
    if (name.includes('skeleton') || name.includes('bogged') || name.includes('stray') || name.includes('pillager')) score += 700;
    if (name.includes('witch') || name.includes('breeze')) score += 650;
    if (name.includes('ravager') || name.includes('vindicator') || name.includes('wither_skeleton')) score += 620;
    if (name.includes('blaze') || name.includes('ghast') || name.includes('guardian')) score += 550;
    if (name.includes('zombie') || name.includes('husk') || name.includes('drowned')) score += 400;
    if (name.includes('phantom') || name.includes('vex')) score += 420;
    if (name.includes('spider') || name.includes('cave_spider')) score += 340;
    if (name.includes('slime') || name.includes('magma_cube')) score += 250;
    if (name.includes('enderman')) score += 300;
    score += Math.max(0, 50 - Math.round(m.distance * 2));
    if (m.entity?.target === bot.entity) score += 300;
    if (state?.owner && m.entity?.target?.name === state.owner) score += 200;
    if (ownerHurtRecently && owner?.position) {
      const distToOwner = m.position.distanceTo(owner.position);
      if (distToOwner <= 6) {
        score += Math.max(0, 450 - Math.round(distToOwner * 60));
      }
    }
    return { ...m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

export function serializeCombatEntity(entity) {
  if (!entity?.position) return null;
  return {
    id: entity.id ?? null,
    name: entity.name ?? null,
    type: entity.type ?? null,
    health: entity.health ?? null,
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
  };
}

export function resolveFocusTarget(focus, nearby, owner) {
  if (!nearby.length) return null;
  if (focus === 'creeper') return nearby.find(m => m.name.toLowerCase().includes('creeper'))?.id ?? null;
  if (focus === 'ranged') return nearby.find(m => RANGED_MOBS.some(r => m.name.toLowerCase().includes(r)))?.id ?? null;
  if (focus === 'hurting_owner' && owner?.position) {
    return [...nearby].sort((a, b) => a.position.distanceTo(owner.position) - b.position.distanceTo(owner.position))[0]?.id ?? null;
  }
  return nearby[0]?.id ?? null;
}

export function resolveJevDecision(ctx, raw, nearby, threat, owner, health) {
  if (!raw || typeof raw !== 'object') return ctx._localReflexDecision(threat, nearby, health, ctx.lastThreatAssessment);
  if (typeof raw.urgentRetreat === 'number' && raw.urgentRetreat >= 0.75) {
    return { action: 'retreat', targetId: threat.id };
  }
  if (typeof raw.danger === 'number' && raw.danger >= 2.6 && health <= 12) {
    return { action: 'retreat', targetId: threat.id };
  }
  const minConf = ctx.config.minConfidence ?? 0.3;
  if (typeof raw.confidence === 'number' && raw.confidence < minConf) {
    return ctx._localReflexDecision(threat, nearby, health, ctx.lastThreatAssessment);
  }
  const action = raw.action ?? 'melee';
  const retreatHealth = ctx.config.retreatHealth ?? 8;
  if (
    (action === 'retreat' || action === 'flee') &&
    health > retreatHealth + 4 &&
    (
      (threat.distance > 10 &&
        (raw.danger == null || raw.danger < 1.8) &&
        (raw.confidence == null || raw.confidence < 0.65)) ||
      (threat.distance > 6 &&
        typeof raw.confidence === 'number' &&
        raw.confidence < 0.55 &&
        (raw.danger == null || raw.danger < 1.3))
    )
  ) {
    return { action: 'idle', targetId: threat.id };
  }
  let targetId = raw.targetId ?? null;
  if (targetId == null && raw.focus) {
    targetId = resolveFocusTarget(raw.focus, nearby, owner) ?? threat.id;
  }
  return { action, targetId: targetId ?? threat.id };
}
