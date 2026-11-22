export const FOOD_POINTS = {
  cooked_beef: 8,
  cooked_porkchop: 8,
  pumpkin_pie: 8,
  golden_carrot: 6,
  cooked_mutton: 6,
  cooked_salmon: 6,
  cooked_chicken: 6,
  mushroom_stew: 6,
  rabbit_stew: 10,
  bread: 5,
  baked_potato: 5,
  cooked_cod: 5,
  cooked_rabbit: 5,
  beetroot_soup: 6,
  apple: 4,
  carrot: 3,
  beef: 3,
  porkchop: 3,
  rabbit: 3,
  melon_slice: 2,
  sweet_berries: 2,
  glow_berries: 2,
  cookie: 2,
  mutton: 2,
  cod: 2,
  salmon: 2,
  dried_kelp: 1,
  potato: 1,
  beetroot: 1,
};

export const PICK_TIERS = ['none', 'wood', 'stone', 'iron', 'diamond'];

export const PICK_ITEM_BY_TIER = {
  wood: 'cuốc gỗ',
  stone: 'cuốc đá',
  iron: 'cuốc sắt',
  diamond: 'cuốc kim cương',
};

export const PREP_HINT_BY_TIER = {
  wood: 'lấy 3 gỗ ; chế tạo 1 cuốc gỗ',
  stone: 'chế tạo 1 cuốc gỗ ; lấy 3 đá ; chế tạo 1 cuốc đá',
  iron: 'lấy 3 sắt ; nung 3 sắt ; chế tạo 1 cuốc sắt',
  diamond: 'cần kim cương để làm cuốc kim cương',
};

const DIAMOND_ORES = new Set(['obsidian', 'crying_obsidian', 'ancient_debris']);
const IRON_ORES = new Set([
  'gold_ore', 'deepslate_gold_ore',
  'diamond_ore', 'deepslate_diamond_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'emerald_ore', 'deepslate_emerald_ore',
]);
const STONE_ORES = new Set([
  'iron_ore', 'deepslate_iron_ore',
  'copper_ore', 'deepslate_copper_ore',
  'lapis_ore', 'deepslate_lapis_ore',
]);
const WOOD_ORES = new Set([
  'stone', 'cobblestone', 'coal_ore', 'deepslate_coal_ore',
]);

/**
 * Total hunger restoration points carried in inventory (excludes raw chicken, rotten flesh, and golden apples).
 */
export function foodSupply(items = []) {
  let total = 0;
  for (const item of items ?? []) {
    const name = item?.name?.toLowerCase?.() ?? '';
    const pts = FOOD_POINTS[name];
    if (!pts) continue;
    total += pts * Math.max(0, item?.count ?? 1);
  }
  return total;
}

/**
 * Highest pickaxe tier present in inventory.
 */
export function bestPickTier(items = []) {
  let bestIdx = 0;
  for (const item of items ?? []) {
    const name = item?.name?.toLowerCase?.() ?? '';
    let idx = 0;
    if (name === 'diamond_pickaxe' || name === 'netherite_pickaxe') idx = 4;
    else if (name === 'iron_pickaxe') idx = 3;
    else if (name === 'stone_pickaxe') idx = 2;
    else if (name === 'wooden_pickaxe' || name === 'golden_pickaxe') idx = 1;
    if (idx > bestIdx) bestIdx = idx;
  }
  return PICK_TIERS[bestIdx];
}

export function hasPickaxeTier(items = [], requiredTier = 'none') {
  const reqIdx = PICK_TIERS.indexOf(requiredTier);
  if (reqIdx <= 0) return true;
  return PICK_TIERS.indexOf(bestPickTier(items)) >= reqIdx;
}

/**
 * Minimum pickaxe tier needed to harvest any of the candidate block names.
 */
export function requiredPickTier(blockNames = []) {
  let reqIdx = 0;
  for (const raw of blockNames ?? []) {
    const name = String(raw ?? '').toLowerCase();
    let idx = 0;
    if (DIAMOND_ORES.has(name)) idx = 4;
    else if (IRON_ORES.has(name)) idx = 3;
    else if (STONE_ORES.has(name)) idx = 2;
    else if (WOOD_ORES.has(name)) idx = 1;
    if (idx > reqIdx) reqIdx = idx;
  }
  return PICK_TIERS[reqIdx];
}

export function summarizeReadiness(items = [], { minFoodPoints = 20 } = {}) {
  const foodPoints = foodSupply(items);
  return {
    foodPoints,
    minFoodPoints,
    foodOk: foodPoints >= minFoodPoints,
    pickaxe: bestPickTier(items),
  };
}
