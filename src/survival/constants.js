import { Vec3 } from 'vec3';
import { normalizeText } from '../commands.js';

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

export const RESOURCE_ALIASES = {
  go: ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log', 'mangrove_log', 'cherry_log'],
  cay: ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log', 'mangrove_log', 'cherry_log'],
  cui: ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log', 'mangrove_log', 'cherry_log'],
  wood: ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log', 'mangrove_log', 'cherry_log'],
  log: ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log', 'mangrove_log', 'cherry_log'],
  da: ['stone', 'cobblestone'],
  stone: ['stone', 'cobblestone'],
  cuoi: ['cobblestone'],
  cobblestone: ['cobblestone'],
  than: ['coal_ore', 'deepslate_coal_ore', 'coal'],
  coal: ['coal_ore', 'deepslate_coal_ore', 'coal'],
  sat: ['iron_ore', 'deepslate_iron_ore', 'raw_iron', 'iron_ingot'],
  iron: ['iron_ore', 'deepslate_iron_ore', 'raw_iron', 'iron_ingot'],
  vang: ['gold_ore', 'deepslate_gold_ore', 'raw_gold', 'gold_ingot'],
  gold: ['gold_ore', 'deepslate_gold_ore', 'raw_gold', 'gold_ingot'],
  'kim cuong': ['diamond_ore', 'deepslate_diamond_ore', 'diamond'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore', 'diamond'],
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
};

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const posKey = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
export const toVec3 = p => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));

export function isTreeLogName(name) {
  const lower = String(name ?? '').toLowerCase();
  return lower.endsWith('_log') || lower.endsWith('_stem');
}

export function isTreeFoliageObstruction(block) {
  const name = block?.name?.toLowerCase() ?? '';
  if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return false;
  return (
    name.endsWith('_leaves') ||
    name === 'vine' ||
    name === 'azalea' ||
    name === 'flowering_azalea' ||
    name === 'mangrove_roots' ||
    name === 'moss_carpet'
  );
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
  const norm = normalizeText(targetText);
  if (!norm) return [];
  if (RESOURCE_ALIASES[norm]) return RESOURCE_ALIASES[norm];
  const snake = norm.replace(/\s+/g, '_');
  return [snake, norm];
}
