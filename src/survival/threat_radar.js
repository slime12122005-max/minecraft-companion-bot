const PASSIVE_OR_FRIENDLY_NAMES = new Set([
  'allay', 'iron_golem', 'snow_golem', 'skeleton_horse', 'zombie_horse',
  'villager', 'wandering_trader', 'cow', 'pig', 'sheep', 'chicken',
  'horse', 'donkey', 'mule', 'wolf', 'cat', 'axolotl', 'armadillo',
  'sniffer', 'camel', 'fox', 'frog', 'goat', 'llama', 'trader_llama',
  'mooshroom', 'ocelot', 'panda', 'parrot', 'rabbit', 'strider', 'turtle',
  'dolphin', 'cod', 'salmon', 'squid', 'glow_squid', 'tadpole',
  'tropical_fish', 'pufferfish', 'bat', 'bee', 'player', 'item',
  'experience_orb', 'xp_orb', 'armor_stand', 'boat', 'chest_boat', 'minecart',
  'arrow', 'spectral_arrow', 'trident', 'egg', 'snowball', 'ender_pearl',
  'potion', 'area_effect_cloud', 'falling_block', 'tnt', 'painting',
  'item_frame', 'glow_item_frame', 'leash_knot', 'firework_rocket',
  'fishing_bobber', 'lightning_bolt',
]);

function calcDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function scanNearbyThreats(bot, { radius = 16, ownerName = null } = {}) {
  const empty = {
    count: 0,
    closest: null,
    nearestCreeper: null,
    ownerThreat: null,
    dangerLevel: 'none',
    hostiles: [],
  };
  const botPos = bot?.entity?.position;
  if (!botPos) return empty;

  const ownerPos = ownerName ? bot.players?.[ownerName]?.entity?.position ?? null : null;
  const hostiles = [];
  let nearestCreeper = null;
  let ownerThreat = null;

  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity || !entity.position || entity === bot.entity) continue;
    if (entity.type === 'player' || entity.type === 'object' || entity.type === 'orb' || entity.type === 'projectile') continue;
    const name = String(entity.name ?? entity.displayName ?? '').toLowerCase();
    if (!name || PASSIVE_OR_FRIENDLY_NAMES.has(name)) continue;

    const distance = calcDistance(botPos, entity.position);
    if (distance > radius) continue;

    const info = { id: entity.id ?? null, name, distance };
    hostiles.push(info);

    if (name === 'creeper' && (!nearestCreeper || distance < nearestCreeper.distance)) {
      nearestCreeper = info;
    }

    if (ownerPos) {
      const ownerDist = calcDistance(ownerPos, entity.position);
      if (ownerDist <= 8 && (!ownerThreat || ownerDist < ownerThreat.distance)) {
        ownerThreat = { id: entity.id ?? null, name, distance: ownerDist };
      }
    }
  }

  hostiles.sort((a, b) => a.distance - b.distance);
  const closest = hostiles[0] ?? null;

  let dangerLevel = 'none';
  if ((nearestCreeper && nearestCreeper.distance <= 5) || hostiles.length >= 3) {
    dangerLevel = 'high';
  } else if (closest && closest.distance <= 8) {
    dangerLevel = 'medium';
  } else if (hostiles.length > 0) {
    dangerLevel = 'low';
  }

  return {
    count: hostiles.length,
    closest,
    nearestCreeper,
    ownerThreat,
    dangerLevel,
    hostiles,
  };
}
