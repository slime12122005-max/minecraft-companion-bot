import { Vec3 } from 'vec3';
import { cleanTargetPhrase, normalizeText } from '../commands.js';

export const FOOD_PRIORITY = [
  'golden_carrot',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_salmon',
  'bread',
  'baked_potato',
  'cooked_chicken',
  'cooked_cod',
  'cooked_rabbit',
  'pumpkin_pie',
  'apple',
  'carrot',
  'melon_slice',
  'sweet_berries',
  'glow_berries',
  'cookie',
  'beef',
  'porkchop',
  'chicken',
  'mutton',
  'potato',
];

const ALL_TREE_LOGS = [
  'oak_log', 'birch_log', 'spruce_log', 'dark_oak_log',
  'acacia_log', 'jungle_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
  'crimson_stem', 'warped_stem',
  'oak_wood', 'birch_wood', 'spruce_wood', 'dark_oak_wood',
  'acacia_wood', 'jungle_wood', 'mangrove_wood', 'cherry_wood', 'pale_oak_wood',
  'crimson_hyphae', 'warped_hyphae',
];

export const RESOURCE_ALIASES = {
  go: ALL_TREE_LOGS,
  cay: ALL_TREE_LOGS,
  cui: ALL_TREE_LOGS,
  wood: ALL_TREE_LOGS,
  log: ALL_TREE_LOGS,
  'go soi': ['oak_log', 'oak_wood'],
  'cay soi': ['oak_log', 'oak_wood'],
  soi: ['oak_log', 'oak_wood'],
  'go bach duong': ['birch_log', 'birch_wood'],
  'cay bach duong': ['birch_log', 'birch_wood'],
  'bach duong': ['birch_log', 'birch_wood'],
  'go thong': ['spruce_log', 'spruce_wood'],
  'cay thong': ['spruce_log', 'spruce_wood'],
  thong: ['spruce_log', 'spruce_wood'],
  'go van sam': ['spruce_log', 'spruce_wood'],
  'cay van sam': ['spruce_log', 'spruce_wood'],
  'van sam': ['spruce_log', 'spruce_wood'],
  'go soi sam': ['dark_oak_log', 'dark_oak_wood'],
  'cay soi sam': ['dark_oak_log', 'dark_oak_wood'],
  'soi sam': ['dark_oak_log', 'dark_oak_wood'],
  'go keo': ['acacia_log', 'acacia_wood'],
  'cay keo': ['acacia_log', 'acacia_wood'],
  keo: ['acacia_log', 'acacia_wood'],
  'go rung': ['jungle_log', 'jungle_wood'],
  'cay rung': ['jungle_log', 'jungle_wood'],
  'go duoc': ['mangrove_log', 'mangrove_wood'],
  'cay duoc': ['mangrove_log', 'mangrove_wood'],
  'go anh dao': ['cherry_log', 'cherry_wood'],
  'cay anh dao': ['cherry_log', 'cherry_wood'],
  'anh dao': ['cherry_log', 'cherry_wood'],
  da: ['stone', 'cobblestone'],
  'da cuoi': ['cobblestone'],
  stone: ['stone', 'cobblestone'],
  cuoi: ['cobblestone'],
  cobblestone: ['cobblestone'],
  than: ['coal_ore', 'deepslate_coal_ore', 'coal'],
  'quang than': ['coal_ore', 'deepslate_coal_ore', 'coal'],
  coal: ['coal_ore', 'deepslate_coal_ore', 'coal'],
  sat: ['iron_ore', 'deepslate_iron_ore', 'raw_iron', 'iron_ingot'],
  'quang sat': ['iron_ore', 'deepslate_iron_ore', 'raw_iron', 'iron_ingot'],
  iron: ['iron_ore', 'deepslate_iron_ore', 'raw_iron', 'iron_ingot'],
  vang: ['gold_ore', 'deepslate_gold_ore', 'raw_gold', 'gold_ingot'],
  'quang vang': ['gold_ore', 'deepslate_gold_ore', 'raw_gold', 'gold_ingot'],
  gold: ['gold_ore', 'deepslate_gold_ore', 'raw_gold', 'gold_ingot'],
  'kim cuong': ['diamond_ore', 'deepslate_diamond_ore', 'diamond'],
  'quang kim cuong': ['diamond_ore', 'deepslate_diamond_ore', 'diamond'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore', 'diamond'],
  dong: ['copper_ore', 'deepslate_copper_ore', 'raw_copper', 'copper_ingot'],
  'quang dong': ['copper_ore', 'deepslate_copper_ore', 'raw_copper', 'copper_ingot'],
  cat: ['sand', 'red_sand'],
  sand: ['sand', 'red_sand'],
  dat: ['dirt', 'grass_block'],
  dirt: ['dirt', 'grass_block'],
  'banh mi': ['bread'],
  bread: ['bread'],
  tao: ['apple'],
  apple: ['apple'],
  thit: ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'beef', 'porkchop'],
  meat: ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken'],
  duoc: ['torch'],
  torch: ['torch'],
  day: ['string'],
  'kien rom': ['hay_block'],
  rom: ['hay_block'],
  hay: ['hay_block'],
  hay_block: ['hay_block'],
  'ngoc ender': ['ender_pearl'],
  'mat ender': ['ender_pearl'],
  'ender pearl': ['ender_pearl'],
  ender_pearl: ['ender_pearl'],
};

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const posKey = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
export const toVec3 = p => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));

const TREE_WOOD_FAMILY_RE = /^([a-z0-9_]+)_(?:log|wood|stem|hyphae)$/;

const TREE_FOLIAGE_EXACT_NAMES = new Set([
  'vine',
  'azalea',
  'flowering_azalea',
  'mangrove_roots',
  'moss_carpet',
  'nether_wart_block',
  'warped_wart_block',
  'shroomlight',
  'hanging_roots',
  'spore_blossom',
  'glow_lichen',
  'cave_vines',
  'cave_vines_plant',
  'weeping_vines',
  'weeping_vines_plant',
  'twisting_vines',
  'twisting_vines_plant',
  'snow',
  'short_grass',
  'grass',
  'tall_grass',
  'fern',
  'large_fern',
]);

const PILLAR_DISPOSABLE_BLOCKS = [
  'dirt',
  'coarse_dirt',
  'rooted_dirt',
  'mud',
  'cobblestone',
  'cobbled_deepslate',
  'netherrack',
  'andesite',
  'diorite',
  'granite',
  'tuff',
  'stone',
  'end_stone',
];

/**
 * Extracts the wood species prefix from natural tree logs, bark blocks, or stems.
 */
export function getTreeWoodFamily(name) {
  const lower = String(name ?? '').toLowerCase();
  if (!lower || lower.startsWith('stripped_') || lower === 'mushroom_stem') return null;
  const match = TREE_WOOD_FAMILY_RE.exec(lower);
  return match ? match[1] : null;
}

export function isTreeLogName(name) {
  return Boolean(getTreeWoodFamily(name));
}

/**
 * Returns true if block belongs to the same tree species as seedBlock (including *_log and *_wood variants).
 */
export function isMatchingTreeBlock(block, seedBlock) {
  if (!block || block.type === 0 || !seedBlock) return false;
  if (block.type === seedBlock.type) return true;
  const f1 = getTreeWoodFamily(block.name);
  const f2 = getTreeWoodFamily(seedBlock.name);
  return Boolean(f1 && f1 === f2);
}

export function isTreeFoliageObstruction(block) {
  const name = block?.name?.toLowerCase() ?? '';
  if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return false;
  return name.endsWith('_leaves') || TREE_FOLIAGE_EXACT_NAMES.has(name);
}

/**
 * Selects a safe disposable non-gravity solid block for temporary tree pillaring.
 */
export function pickTreePillarItem(bot) {
  const items = (bot?.inventory?.items?.() ?? []).filter(i => i?.name && (i.count ?? 1) > 0);
  if (items.length === 0) return null;

  for (const preferred of PILLAR_DISPOSABLE_BLOCKS) {
    const match = items.find(i => i.name.toLowerCase() === preferred);
    if (match) return match;
  }
  const planks = items.find(i => i.name.toLowerCase().endsWith('_planks'));
  if (planks) return planks;
  return items.find(i => isTreeLogName(i.name)) ?? null;
}

export function isWithinDigReach(botPos, blockPos, eyeHeight = 1.62, maxBoxDist = 4.35, maxCenterDist = 5.0) {
  if (!botPos || !blockPos) return false;
  const eyeX = botPos.x;
  const eyeY = botPos.y + eyeHeight;
  const eyeZ = botPos.z;
  const bx = Math.floor(blockPos.x);
  const by = Math.floor(blockPos.y);
  const bz = Math.floor(blockPos.z);
  const cx = Math.max(bx, Math.min(eyeX, bx + 1));
  const cy = Math.max(by, Math.min(eyeY, by + 1));
  const cz = Math.max(bz, Math.min(eyeZ, bz + 1));
  const boxDist = Math.hypot(eyeX - cx, eyeY - cy, eyeZ - cz);
  const centerDist = Math.hypot(eyeX - (bx + 0.5), eyeY - (by + 0.5), eyeZ - (bz + 0.5));
  return boxDist <= maxBoxDist && centerDist <= maxCenterDist;
}

export function chooseDigFace(botPos, blockPos, eyeHeight = 1.62) {
  const eyeX = botPos.x;
  const eyeY = botPos.y + eyeHeight;
  const eyeZ = botPos.z;
  const bx = Math.floor(blockPos.x);
  const by = Math.floor(blockPos.y);
  const bz = Math.floor(blockPos.z);

  if (eyeY < by) return new Vec3(0, -1, 0);
  if (eyeY > by + 1) return new Vec3(0, 1, 0);

  const dx = eyeX - (bx + 0.5);
  const dz = eyeZ - (bz + 0.5);
  if (Math.abs(dx) >= Math.abs(dz)) {
    return new Vec3(dx >= 0 ? 1 : -1, 0, 0);
  }
  return new Vec3(0, 0, dz >= 0 ? 1 : -1);
}

export async function raceTimeout(promise, ms, onTimeout) {
  const target = Promise.resolve(promise);
  target.catch(() => {});
  if (!(ms > 0)) return await target;

  let timer = null;
  try {
    return await Promise.race([
      target,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch {}
          reject(Object.assign(new Error('Timeout'), { name: 'Timeout' }));
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function safeSerialize(obj) {
  try {
    return JSON.stringify(obj ?? '', (_, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase();
  } catch {
    return '';
  }
}

export function isBeneficialPotion(item, { fireOnly = false } = {}) {
  const name = item?.name?.toLowerCase() ?? '';
  if (name !== 'potion') return false;
  const meta = safeSerialize(item.components ?? item.nbt);
  if (fireOnly) return meta.includes('fire_resistance');
  return /(healing|regeneration|fire_resistance|turtle_master)/.test(meta);
}

export function resolveCandidateNames(targetText) {
  const norm = cleanTargetPhrase(normalizeText(targetText).replace(/^\d+\s+(?=\S)/, ''));
  if (!norm) return [];
  if (RESOURCE_ALIASES[norm]) return RESOURCE_ALIASES[norm];
  const snake = norm.replace(/\s+/g, '_');
  return [snake, norm];
}
