import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import { hasPickaxeTier, requiredPickTier, PICK_ITEM_BY_TIER, PREP_HINT_BY_TIER } from '../readiness.js';
import { isTreeLogName, posKey, raceTimeout, resolveCandidateNames, sleep } from './constants.js';

const BLOCK_DROP_EQUIVALENTS = {
  stone: ['cobblestone'],
  deepslate: ['cobbled_deepslate'],
  coal_ore: ['coal'],
  deepslate_coal_ore: ['coal'],
  iron_ore: ['raw_iron'],
  deepslate_iron_ore: ['raw_iron'],
  gold_ore: ['raw_gold'],
  deepslate_gold_ore: ['raw_gold'],
  copper_ore: ['raw_copper'],
  deepslate_copper_ore: ['raw_copper'],
  diamond_ore: ['diamond'],
  deepslate_diamond_ore: ['diamond'],
  emerald_ore: ['emerald'],
  deepslate_emerald_ore: ['emerald'],
  lapis_ore: ['lapis_lazuli'],
  deepslate_lapis_ore: ['lapis_lazuli'],
  redstone_ore: ['redstone'],
  deepslate_redstone_ore: ['redstone'],
};

/**
 * Counts items in bot.inventory matching any candidate block name or its dropped item equivalent.
 */
export function countMatchingInventoryItems(bot, candidates = [], extraNames = []) {
  const items = bot?.inventory?.items?.() ?? [];
  if (items.length === 0) return 0;
  const matchSet = new Set();
  for (const raw of [...(candidates ?? []), ...(extraNames ?? [])]) {
    const n = String(raw ?? '').toLowerCase();
    if (!n) continue;
    matchSet.add(n);
    for (const eq of BLOCK_DROP_EQUIVALENTS[n] ?? []) {
      matchSet.add(eq);
    }
  }
  let total = 0;
  for (const item of items) {
    const name = String(item?.name ?? '').toLowerCase();
    if (name && matchSet.has(name)) {
      total += Math.max(0, Number(item.count ?? 1));
    }
  }
  return total;
}

/**
 * Counts inventory items matching a natural Vietnamese/English target resource name.
 */
export function countTargetItems(ctx, targetText) {
  const candidates = resolveCandidateNames(targetText);
  if (candidates.length === 0) return 0;
  return countMatchingInventoryItems(ctx?.bot, candidates);
}

const RAW_DROP_NAMES = new Set([
  'raw_iron', 'raw_gold', 'raw_copper', 'coal', 'diamond', 'emerald',
  'redstone', 'lapis_lazuli', 'cobblestone', 'cobbled_deepslate',
]);

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
const SOFT_OVERBURDEN_BLOCKS = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium',
  'mud', 'farmland', 'sand', 'red_sand', 'gravel', 'clay', 'snow_block', 'moss_block',
]);
const FALLING_HAZARD_BLOCKS = new Set(['sand', 'red_sand', 'gravel']);
const PROTECTED_STRUCTURE_BLOCKS = new Set([
  'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
  'crafting_table', 'ender_chest', 'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil',
]);
const PICKAXE_PRIORITY = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'];
const SHOVEL_PRIORITY = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel', 'golden_shovel'];

function hasAdjacentLava(bot, blockPos) {
  if (typeof bot?.blockAt !== 'function' || !blockPos) return false;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const neighborPos = typeof blockPos.offset === 'function'
      ? blockPos.offset(dx, dy, dz)
      : { x: blockPos.x + dx, y: blockPos.y + dy, z: blockPos.z + dz };
    const neighbor = bot.blockAt(neighborPos);
    if (neighbor?.name?.toLowerCase().includes('lava')) return true;
  }
  return false;
}

function hasAdjacentLiquid(bot, blockPos) {
  if (typeof bot?.blockAt !== 'function' || !blockPos) return false;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const neighborPos = typeof blockPos.offset === 'function'
      ? blockPos.offset(dx, dy, dz)
      : { x: blockPos.x + dx, y: blockPos.y + dy, z: blockPos.z + dz };
    const neighbor = bot.blockAt(neighborPos);
    const n = neighbor?.name?.toLowerCase() ?? '';
    if (n.includes('lava') || n.includes('water')) return true;
  }
  return false;
}

export function hasExposedAirFace(bot, blockPos) {
  if (typeof bot?.blockAt !== 'function' || !blockPos) return true;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const neighborPos = typeof blockPos.offset === 'function'
      ? blockPos.offset(dx, dy, dz)
      : { x: blockPos.x + dx, y: blockPos.y + dy, z: blockPos.z + dz };
    const nb = bot.blockAt(neighborPos);
    const n = String(nb?.name ?? '').toLowerCase();
    if (
      !nb ||
      nb.type === 0 ||
      AIR_NAMES.has(n) ||
      nb.boundingBox === 'empty' ||
      (Array.isArray(nb.shapes) && nb.shapes.length === 0)
    ) {
      return true;
    }
  }
  return false;
}

function isSolidDiggableBlock(block) {
  if (!block || block.type === 0 || block.diggable === false) return false;
  const n = String(block.name ?? '').toLowerCase();
  if (!n || AIR_NAMES.has(n) || block.boundingBox === 'empty') return false;
  if (n === 'bedrock' || n.includes('lava') || n.includes('water')) return false;
  return true;
}

function isProtectedExcavationBlock(block, homePos = null) {
  if (!block) return false;
  const n = String(block.name ?? '').toLowerCase();
  if (!n) return false;
  if (PROTECTED_STRUCTURE_BLOCKS.has(n) || n === 'bed' || n.endsWith('_bed') || n.endsWith('_door')) return true;
  if (homePos && block.position) {
    const d = Math.hypot(block.position.x - homePos.x, block.position.z - homePos.z);
    if (d <= 6 && (n.endsWith('_planks') || n === 'cobblestone' || n.endsWith('_stairs') || n.endsWith('_slab'))) {
      return true;
    }
  }
  return false;
}

async function equipForExcavation(ctx, block, reqTier, signal) {
  const bot = ctx.bot;
  const name = String(block?.name ?? '').toLowerCase();
  const isSoft = SOFT_OVERBURDEN_BLOCKS.has(name);
  const items = bot.inventory?.items?.() ?? [];

  if (isSoft) {
    const shovel = SHOVEL_PRIORITY.map(n => items.find(i => i?.name === n)).find(Boolean);
    if (shovel && typeof bot.equip === 'function') {
      await bot.equip(shovel, 'hand').catch(() => {});
      return;
    }
    if (bot.heldItem?.name?.endsWith?.('_pickaxe')) {
      const filler = items.find(i => {
        const iname = String(i?.name ?? '').toLowerCase();
        return iname && !iname.endsWith('_pickaxe') && !iname.endsWith('_sword') && !iname.endsWith('_axe');
      });
      if (filler && typeof bot.equip === 'function') {
        await bot.equip(filler, 'hand').catch(() => {});
      } else if (typeof bot.unequip === 'function') {
        await bot.unequip('hand').catch(() => {});
      }
    }
    return;
  }

  if (reqTier && reqTier !== 'none' && typeof bot.inventory?.items === 'function') {
    if (!hasPickaxeTier(bot.inventory.items() ?? [], reqTier)) {
      await ctx.ensurePickaxe(reqTier, signal);
    }
  }

  const latestItems = bot.inventory?.items?.() ?? [];
  const pick = PICKAXE_PRIORITY.map(n => latestItems.find(i => i?.name === n)).find(Boolean);
  if (pick && typeof bot.equip === 'function') {
    await bot.equip(pick, 'hand').catch(() => {});
    return;
  }
  if (bot.tool?.equipForBlock) {
    await bot.tool.equipForBlock(block, { requireHarvest: false }).catch(() => {});
  }
}

export async function placeMiningTorchIfDark(ctx, feetPos, stepIdx, signal) {
  const bot = ctx?.bot;
  if (!bot || !feetPos || typeof bot.placeBlock !== 'function') return false;

  let needsTorch = stepIdx > 0 && stepIdx % 5 === 0;
  if (typeof bot.world?.getBlockLight === 'function') {
    const blockLight = bot.world.getBlockLight(feetPos);
    const skyLight = typeof bot.world?.getSkyLight === 'function' ? bot.world.getSkyLight(feetPos) : 0;
    const tod = bot.time?.timeOfDay;
    const isNight = bot.time?.isDay === false || (typeof tod === 'number' && tod >= 12542 && tod <= 23459);
    needsTorch = blockLight < 7 && (skyLight < 7 || isNight);
  }
  if (!needsTorch) return false;

  const findTorch = () => (bot.inventory?.items?.() ?? []).find((i) => i?.name === 'torch') ?? null;
  let torchItem = findTorch();
  if (!torchItem && stepIdx >= 2 && ctx.crafting?.craftItem) {
    const items = bot.inventory?.items?.() ?? [];
    const hasFuel = items.some((i) => (i?.name === 'coal' || i?.name === 'charcoal') && (i.count ?? 1) >= 1);
    const hasStick = items.some((i) => i?.name === 'stick' && (i.count ?? 1) >= 1);
    if (hasFuel && hasStick) {
      await ctx.crafting.craftItem('torch', 4, signal).catch(() => {});
      torchItem = findTorch();
    }
  }
  if (!torchItem) return false;

  const feetBlk = bot.blockAt?.(feetPos);
  const feetName = String(feetBlk?.name ?? '').toLowerCase();
  if (feetBlk && feetBlk.type !== 0 && !AIR_NAMES.has(feetName)) return false;

  const floorPos = new Vec3(feetPos.x, feetPos.y - 1, feetPos.z);
  const floor = bot.blockAt?.(floorPos);
  const floorName = String(floor?.name ?? '').toLowerCase();
  if (!floor || floor.type === 0 || floor.boundingBox === 'empty' || floorName.includes('lava') || floorName.includes('water')) {
    return false;
  }

  try {
    if (typeof bot.equip === 'function') {
      await bot.equip(torchItem, 'hand');
    }
    await bot.placeBlock(floor, new Vec3(0, 1, 0));
    return true;
  } catch {
    return false;
  }
}

async function excavateStaircaseForStone(ctx, {
  ids,
  candidates,
  matchedNames,
  reqTier,
  needed,
  skipped,
  signal,
  isPaused,
}) {
  const bot = ctx.bot;
  const startPos = bot?.entity?.position;
  if (!startPos || typeof bot?.blockAt !== 'function' || needed <= 0) return 0;

  const homePos = ctx.home?.get?.() ?? null;
  const ownerPos = ctx.config?.owner ? bot.players?.[ctx.config.owner]?.entity?.position ?? null : null;
  const startX = Math.floor(startPos.x);
  const startY = Math.floor(startPos.y);
  const startZ = Math.floor(startPos.z);

  const isColumnSafe = (px, minY, maxY, pz) => {
    const floor = bot.blockAt(new Vec3(px, minY - 1, pz));
    const floorName = String(floor?.name ?? '').toLowerCase();
    if (!floor || floor.type === 0 || AIR_NAMES.has(floorName) || floor.boundingBox === 'empty') return false;
    if (floorName.includes('lava') || floorName.includes('water') || floorName === 'magma_block') return false;

    const ceil = bot.blockAt(new Vec3(px, maxY + 1, pz));
    const ceilName = String(ceil?.name ?? '').toLowerCase();
    if (FALLING_HAZARD_BLOCKS.has(ceilName) || ceilName.includes('lava') || ceilName.includes('water')) return false;

    for (let yy = minY; yy <= maxY; yy++) {
      const cell = bot.blockAt(new Vec3(px, yy, pz));
      if (cell) {
        const cn = String(cell.name ?? '').toLowerCase();
        if (cn === 'bedrock' || cn.includes('lava') || cn.includes('water')) return false;
        if (isProtectedExcavationBlock(cell, homePos)) return false;
      }
      if (hasAdjacentLiquid(bot, new Vec3(px, yy, pz))) return false;
    }
    return true;
  };

  const scoreDirection = (dir) => {
    const entryDistOwner = ownerPos
      ? Math.hypot((startX + dir.x + 0.5) - ownerPos.x, (startZ + dir.z + 0.5) - ownerPos.z)
      : 10;
    let walkableDepth = 0;
    for (let s = 1; s <= 5; s++) {
      const sx = startX + dir.x * s;
      const sy = startY - s;
      const sz = startZ + dir.z * s;
      if (!isColumnSafe(sx, sy, sy + 2, sz)) break;
      walkableDepth += 1;
    }
    const homeDist = homePos
      ? Math.hypot((startX + dir.x) - homePos.x, (startZ + dir.z) - homePos.z)
      : 0;
    return {
      dir,
      nearOwnerPenalty: ownerPos && entryDistOwner < 2.2 ? 1 : 0,
      walkableDepth,
      distScore: entryDistOwner + homeDist,
    };
  };

  const cardinals = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 },
  ]
    .map(scoreDirection)
    .sort((a, b) => (a.nearOwnerPenalty - b.nearOwnerPenalty) || (b.walkableDepth - a.walkableDepth) || (b.distScore - a.distScore));

  let chosenDir = null;
  for (const cand of cardinals) {
    if (isColumnSafe(startX + cand.dir.x, startY - 1, startY + 2, startZ + cand.dir.z)) {
      chosenDir = cand.dir;
      break;
    }
  }
  if (!chosenDir) {
    for (const cand of cardinals) {
      if (isColumnSafe(startX + cand.dir.x, startY - 1, startY + 1, startZ + cand.dir.z)) {
        chosenDir = cand.dir;
        break;
      }
    }
  }
  if (!chosenDir) return 0;

  let cur = { x: startX, y: startY, z: startZ };
  const stairSteps = [{ x: startX, y: startY, z: startZ }];
  let dugTargets = 0;

  const digCellIfSolid = async (p) => {
    if (signal?.aborted) throw new Error('Đã hủy');
    while (isPaused?.()) {
      if (signal?.aborted) throw new Error('Đã hủy');
      await sleep(200);
    }
    if (isInventoryTrulyFull(bot, candidates, matchedNames)) return false;

    const blk = bot.blockAt(p);
    if (!isSolidDiggableBlock(blk)) return true;
    if (isProtectedExcavationBlock(blk, homePos) || hasAdjacentLava(bot, p)) return false;

    const above = bot.blockAt(new Vec3(p.x, p.y + 1, p.z));
    if (above && FALLING_HAZARD_BLOCKS.has(String(above.name ?? '').toLowerCase())) return false;

    const isTarget = ids.includes(blk.type);
    if (isTarget && reqTier !== 'none' && typeof bot.inventory?.items === 'function') {
      if (!hasPickaxeTier(bot.inventory.items() ?? [], reqTier)) {
        const ok = await ctx.ensurePickaxe(reqTier, signal);
        if (!ok) {
          if (dugTargets > 0) return false;
          const reqPick = PICK_ITEM_BY_TIER[reqTier] ?? reqTier;
          const hint = PREP_HINT_BY_TIER[reqTier];
          throw new Error(`Chưa có công cụ đủ cấp (cần ${reqPick}).${hint ? ` Gợi ý: ${hint}.` : ''}`);
        }
      }
    }

    await equipForExcavation(ctx, blk, reqTier, signal);
    const prevType = blk.type;
    await ctx._digWithTimeout(blk, { signal });
    const after = bot.blockAt(p);
    if (after && after.type === prevType) return false;
    if (isTarget) {
      dugTargets += 1;
      skipped?.add(posKey(p));
    }
    return true;
  };

  const stepTo = async (tx, ty, tz) => {
    if (typeof bot.pathfinder?.goto === 'function') {
      try {
        await ctx._gotoWithTimeout(new goals.GoalBlock(tx, ty, tz), {
          timeoutMs: Math.min(5000, ctx._timeouts.gotoMs),
          stuckMs: Math.min(2500, ctx._timeouts.stuckMs),
          signal,
          isPaused,
        });
      } catch (err) {
        if (signal?.aborted) throw new Error('Đã hủy');
        return false;
      }
      const bp = bot.entity?.position;
      if (bp && Math.hypot(bp.x - (tx + 0.5), bp.z - (tz + 0.5)) <= 1.8 && Math.abs(bp.y - ty) <= 1.5) {
        cur = { x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) };
      } else {
        cur = { x: tx, y: ty, z: tz };
      }
      stairSteps.push({ ...cur });
      return true;
    }
    cur = { x: tx, y: ty, z: tz };
    if (bot.entity) bot.entity.position = new Vec3(tx + 0.5, ty, tz + 0.5);
    stairSteps.push({ ...cur });
    return true;
  };

  const harvestNearbyReachableTargets = async () => {
    const offsets = [
      [chosenDir.x, 1, chosenDir.z],
      [chosenDir.x, 0, chosenDir.z],
      [-chosenDir.z, 1, chosenDir.x],
      [-chosenDir.z, 0, chosenDir.x],
      [chosenDir.z, 1, -chosenDir.x],
      [chosenDir.z, 0, -chosenDir.x],
    ];
    for (const [dx, dy, dz] of offsets) {
      if (dugTargets >= needed) break;
      const p = new Vec3(cur.x + dx, cur.y + dy, cur.z + dz);
      const b = bot.blockAt(p);
      if (b && ids.includes(b.type)) {
        await digCellIfSolid(p);
      }
    }
  };

  // Phase 1: Walkable 4-high staircase descent (ample jump headroom) with priority torch lighting
  let inTargetLayer = false;
  for (let step = 0; step < 11 && dugTargets < needed; step++) {
    const nx = cur.x + chosenDir.x;
    const ny = cur.y - 1;
    const nz = cur.z + chosenDir.z;
    const clearTopY = isColumnSafe(nx, ny, cur.y + 2, nz)
      ? cur.y + 2
      : (isColumnSafe(nx, ny, cur.y + 1, nz) ? cur.y + 1 : null);
    if (clearTopY == null) break;

    for (let yy = clearTopY; yy >= ny; yy--) {
      if (dugTargets >= needed) break;
      const ok = await digCellIfSolid(new Vec3(nx, yy, nz));
      if (!ok) return dugTargets;
    }
    if (dugTargets >= needed) break;

    const moved = await stepTo(nx, ny, nz);
    if (!moved) break;

    await placeMiningTorchIfDark(ctx, new Vec3(cur.x, cur.y, cur.z), stairSteps.length - 1, signal);
    await harvestNearbyReachableTargets();
    const frontHeadBlk = bot.blockAt(new Vec3(cur.x + chosenDir.x, cur.y + 1, cur.z + chosenDir.z));
    if (dugTargets > 0 && frontHeadBlk && ids.includes(frontHeadBlk.type)) {
      inTargetLayer = true;
      break;
    }
  }
  if (dugTargets > 0) inTargetLayer = true;

  // Phase 2: Short 2-high horizontal quarry along the stone layer with torch lighting
  for (let h = 0; h < 12 && inTargetLayer && dugTargets < needed; h++) {
    await harvestNearbyReachableTargets();
    if (dugTargets >= needed) break;

    const nx = cur.x + chosenDir.x;
    const ny = cur.y;
    const nz = cur.z + chosenDir.z;
    if (!isColumnSafe(nx, ny, ny + 1, nz)) break;

    for (let yy = ny + 1; yy >= ny; yy--) {
      if (dugTargets >= needed) break;
      const ok = await digCellIfSolid(new Vec3(nx, yy, nz));
      if (!ok) return dugTargets;
    }
    if (dugTargets >= needed) break;
    const moved = await stepTo(nx, ny, nz);
    if (!moved) break;

    await placeMiningTorchIfDark(ctx, new Vec3(cur.x, cur.y, cur.z), stairSteps.length - 1, signal);
  }

  if (dugTargets > 0 && ctx._collectNearbyItemDrops) {
    await ctx._collectNearbyItemDrops(new Vec3(cur.x + 0.5, cur.y, cur.z + 0.5), signal, isPaused);
  }

  // Walk cleanly back up the staircase entrance in live play so bot returns onto walkable surface
  if (stairSteps.length > 1 && typeof bot.pathfinder?.goto === 'function' && bot._client) {
    await ctx._gotoWithTimeout(new goals.GoalNear(startX + 0.5, startY, startZ + 0.5, 1.5), {
      timeoutMs: Math.min(8000, ctx._timeouts.gotoMs),
      stuckMs: Math.min(3000, ctx._timeouts.stuckMs),
      signal,
      isPaused,
    }).catch(() => {});
  }

  return dugTargets;
}

function isInventoryTrulyFull(bot, candidates, matchedNames) {
  if (typeof bot?.inventory?.emptySlotCount !== 'function' || bot.inventory.emptySlotCount() > 0) {
    return false;
  }
  const items = bot.inventory?.items?.() ?? [];
  const matchSet = new Set([...(candidates ?? []), ...(matchedNames ?? [])].map(s => String(s).toLowerCase()));
  for (const item of items) {
    const name = item?.name?.toLowerCase() ?? '';
    if (!name) continue;
    const count = item.count ?? 64;
    const stackSize = item.stackSize ?? 64;
    if (count < stackSize && (matchSet.has(name) || RAW_DROP_NAMES.has(name))) {
      return false;
    }
  }
  return true;
}

export async function ensurePickaxe(ctx, tier = 'none', signal = null) {
  if (!tier || tier === 'none') return true;
  if (typeof ctx.bot.inventory?.items !== 'function') return true;
  const current = ctx.bot.inventory.items() ?? [];
  if (hasPickaxeTier(current, tier)) return true;

  const itemName = PICK_ITEM_BY_TIER[tier];
  if (itemName && ctx.crafting?.craftItem) {
    await ctx.crafting.craftItem(itemName, 1, signal).catch(() => {});
  }
  return hasPickaxeTier(ctx.bot.inventory.items() ?? [], tier);
}

export async function gather(ctx, targetText, count = 16, signal = null, { isPaused = null } = {}) {
  const candidates = resolveCandidateNames(targetText);
  const reqTier = requiredPickTier(candidates);
  if (reqTier !== 'none') {
    const ok = await ctx.ensurePickaxe(reqTier, signal);
    if (!ok) {
      const reqPick = PICK_ITEM_BY_TIER[reqTier] ?? reqTier;
      const hint = PREP_HINT_BY_TIER[reqTier];
      throw new Error(`Chưa có công cụ đủ cấp để đào ${targetText} (cần ${reqPick}).${hint ? ` Gợi ý: ${hint}.` : ''}`);
    }
  }

  const blocksByName = ctx.bot.registry?.blocksByName ?? {};
  const ids = [];
  const matchedNames = [];
  for (const name of candidates) {
    const id = blocksByName[name]?.id;
    if (id) {
      ids.push(id);
      matchedNames.push(name);
    }
  }

  if (ids.length === 0) {
    for (const [name, def] of Object.entries(blocksByName)) {
      if (candidates.some(c => name.includes(c))) {
        ids.push(def.id);
        matchedNames.push(name);
      }
    }
  }
  if (ids.length === 0) {
    throw new Error(`Không nhận ra loại block "${targetText}".`);
  }

  if (typeof ctx.bot.findBlocks !== 'function' || !ctx.bot.collectBlock?.collect) {
    throw new Error('Bot chưa sẵn sàng collectBlock.');
  }

  const isTreeTarget = candidates.some(isTreeLogName) || matchedNames.some(isTreeLogName);
  const invBefore = countMatchingInventoryItems(ctx.bot, candidates, matchedNames);
  let topUpPasses = 0;
  let collected = 0;
  const skipped = new Set();
  let consecutiveUnreachableWeight = 0;

  const verifyGainOrTopUp = async () => {
    if (ctx.bot.entity?.position && typeof ctx.bot.pathfinder?.goto === 'function') {
      const botPos = ctx.bot.entity.position;
      const hasNearbyDrop = Object.values(ctx.bot.entities ?? {}).some(
        e => e?.position && (e.name === 'item' || e.displayName === 'Item') && Math.hypot(e.position.x - botPos.x, e.position.y - botPos.y, e.position.z - botPos.z) <= 8
      );
      if (hasNearbyDrop) {
        await ctx._collectNearbyItemDrops(botPos, signal, isPaused);
      }
    }
    const invNow = countMatchingInventoryItems(ctx.bot, candidates, matchedNames);
    const invGained = invNow - invBefore;
    const inventoryTrackingActive = Boolean(ctx.bot._client) || invNow > invBefore;
    if (
      inventoryTrackingActive &&
      invGained < count &&
      topUpPasses < 4 &&
      !isInventoryTrulyFull(ctx.bot, candidates, matchedNames)
    ) {
      topUpPasses += 1;
      collected = Math.max(0, invGained);
      return true;
    }
    return false;
  };

  while (collected < count) {
    if (signal?.aborted) throw new Error('Đã hủy');
    while (isPaused?.()) {
      if (signal?.aborted) throw new Error('Đã hủy');
      await sleep(200);
    }

    const rawPositions = ctx.bot.findBlocks({
      matching: ids,
      maxDistance: 48,
      count: Math.min(Math.max((count - collected) * 2, isTreeTarget ? 16 : 0) + skipped.size, 256),
    }) ?? [];

    const positions = rawPositions.filter(p => !skipped.has(posKey(p)));
    if (positions.length === 0) break;

    if (isTreeTarget) {
      const treeRes = await ctx._chopWholeTree(positions[0], ids, targetText, skipped, signal, isPaused);
      collected += treeRes.collected;
      if (!treeRes.anySuccess && positions.every(p => skipped.has(posKey(p)))) {
        break;
      }
      if (collected >= count) {
        await verifyGainOrTopUp();
      }
      continue;
    }

    const exposedPositions = [];
    const buriedPositions = [];
    for (const p of positions) {
      if (hasExposedAirFace(ctx.bot, p)) exposedPositions.push(p);
      else buriedPositions.push(p);
    }
    if (exposedPositions.length > 1 && ctx.bot.entity?.position) {
      const bp = ctx.bot.entity.position;
      const botFootY = Math.floor(bp.y);
      exposedPositions.sort((a, b) => {
        const dyA = a.y - botFootY;
        const dyB = b.y - botFootY;
        const walkPenA = (dyA >= -1 && dyA <= 2) ? 0 : Math.abs(dyA) * 4;
        const walkPenB = (dyB >= -1 && dyB <= 2) ? 0 : Math.abs(dyB) * 4;
        if (walkPenA !== walkPenB) return walkPenA - walkPenB;
        const dA = Math.hypot(a.x + 0.5 - bp.x, a.y - bp.y, a.z + 0.5 - bp.z);
        const dB = Math.hypot(b.x + 0.5 - bp.x, b.y - bp.y, b.z + 0.5 - bp.z);
        return dA - dB;
      });
    }

    let madeProgress = false;
    for (const blockPos of exposedPositions) {
      if (signal?.aborted) throw new Error('Đã hủy');
      if (collected >= count) break;
      while (isPaused?.()) {
        if (signal?.aborted) throw new Error('Đã hủy');
        await sleep(200);
      }

      if (isInventoryTrulyFull(ctx.bot, candidates, matchedNames)) {
        ctx.log('🎒 Túi đồ đã đầy, dừng thu thập.');
        madeProgress = false;
        break;
      }

      if (reqTier !== 'none' && typeof ctx.bot.inventory?.items === 'function' && !hasPickaxeTier(ctx.bot.inventory.items() ?? [], reqTier)) {
        const ok = await ctx.ensurePickaxe(reqTier, signal);
        if (!ok) {
          if (collected > 0) {
            ctx.log('⚠️ Cuốc đã hỏng giữa chừng, dừng đào để tránh đào tay không.');
            madeProgress = false;
            break;
          }
          const reqPick = PICK_ITEM_BY_TIER[reqTier] ?? reqTier;
          const hint = PREP_HINT_BY_TIER[reqTier];
          throw new Error(`Chưa có công cụ đủ cấp để đào ${targetText} (cần ${reqPick}).${hint ? ` Gợi ý: ${hint}.` : ''}`);
        }
      }

      if (hasAdjacentLava(ctx.bot, blockPos)) {
        ctx.log('🔥 Bỏ qua block sát lava để đảm bảo an toàn.');
        skipped.add(posKey(blockPos));
        continue;
      }

      const block = ctx.bot.blockAt(blockPos);
      if (!block || block.type === 0) {
        skipped.add(posKey(blockPos));
        continue;
      }

      try {
        await ctx._collectBlockWithTimeout(block, { signal });
        const after = ctx.bot.blockAt(blockPos);
        if (!after || after.type !== block.type) {
          collected++;
          consecutiveUnreachableWeight = 0;
          madeProgress = true;
        } else {
          skipped.add(posKey(blockPos));
        }
      } catch (err) {
        if (signal?.aborted) throw new Error('Đã hủy');
        if ((err.name === 'GoalChanged' || err.name === 'PathStopped' || /Digging aborted/i.test(err.message ?? '')) && isPaused?.()) {
          madeProgress = true;
          break;
        }
        if (err.name === 'NoPath' || err.name === 'Timeout') {
          skipped.add(posKey(blockPos));
          consecutiveUnreachableWeight += err.name === 'Timeout' ? 2 : 1;
          if (consecutiveUnreachableWeight >= 4) {
            madeProgress = false;
            break;
          }
          continue;
        }
        if (err.name === 'NoChests' || err.name === 'NoItem' || /chest locations|harvestable tool/i.test(err.message ?? '')) {
          throw new Error(`Chưa có công cụ đủ cấp để đào ${targetText}`);
        }
        throw err;
      }
    }

    if (
      !madeProgress &&
      collected < count &&
      buriedPositions.length > 0 &&
      !isInventoryTrulyFull(ctx.bot, candidates, matchedNames)
    ) {
      const botY = ctx.bot.entity?.position?.y;
      const canExcavateDown =
        candidates.some(c => c === 'stone' || c === 'cobblestone' || c === 'deepslate') ||
        (typeof botY === 'number' && buriedPositions.some(p => (botY - p.y) >= 1 && (botY - p.y) <= 10));
      if (canExcavateDown) {
        const staircaseGot = await excavateStaircaseForStone(ctx, {
          ids,
          candidates,
          matchedNames,
          reqTier,
          needed: count - collected,
          skipped,
          signal,
          isPaused,
        });
        if (staircaseGot > 0) {
          collected += staircaseGot;
          madeProgress = true;
        }
      }
    }

    if (!madeProgress) break;
    if (collected >= count) {
      await verifyGainOrTopUp();
    }
  }
  const finalInvGained = countMatchingInventoryItems(ctx.bot, candidates, matchedNames) - invBefore;
  return (Boolean(ctx.bot._client) || finalInvGained > 0) ? Math.max(0, finalInvGained) : collected;
}

export async function giveToOwner(ctx, ownerName, targetText, count = 1, signal = null, { isPaused = null } = {}) {
  if (signal?.aborted) throw new Error('Đã hủy');
  const owner = ctx.bot.players?.[ownerName]?.entity;
  if (!owner?.position) {
    throw new Error('Tôi không thấy bạn ở gần để đưa đồ.');
  }

  const candidates = resolveCandidateNames(targetText);
  const findMatchingItems = () => (ctx.bot.inventory?.items?.() ?? []).filter(i => {
    const name = i?.name?.toLowerCase() ?? '';
    return candidates.some(c => name === c || name.includes(c));
  });

  let items = findMatchingItems();
  if (items.length === 0 && ctx.bot.entity?.position && typeof ctx.bot.pathfinder?.goto === 'function') {
    await ctx._collectNearbyItemDrops(ctx.bot.entity.position, signal, isPaused);
    items = findMatchingItems();
  }

  if (items.length === 0) {
    throw new Error(`Tôi không có "${targetText}" trong túi.`);
  }

  if (ctx.bot.pathfinder?.goto && ctx.bot.entity?.position) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new Error('Đã hủy');
      while (isPaused?.()) {
        if (signal?.aborted) throw new Error('Đã hủy');
        await sleep(200);
      }
      const liveOwner = ctx.bot.players?.[ownerName]?.entity ?? owner;
      if (!liveOwner?.position) break;
      if (ctx.bot.entity.position.distanceTo(liveOwner.position) <= 3.5) break;
      try {
        await ctx._gotoWithTimeout(
          new goals.GoalNear(liveOwner.position.x, liveOwner.position.y, liveOwner.position.z, 2.5),
          { timeoutMs: 25000, stuckMs: 5000, signal, isPaused }
        );
      } catch (err) {
        if (signal?.aborted) throw new Error('Đã hủy');
        if ((err.name === 'GoalChanged' || err.name === 'PathStopped') && isPaused?.()) {
          attempt--;
          continue;
        }
        if (err.name === 'NoPath' || err.name === 'Timeout') break;
        throw err;
      }
    }
  }

  const targetOwner = ctx.bot.players?.[ownerName]?.entity ?? owner;
  if (typeof ctx.bot.lookAt === 'function' && targetOwner?.position) {
    await raceTimeout(
      ctx.bot.lookAt(targetOwner.position.offset(0, 1.5, 0), true),
      ctx._timeouts.lookMs
    ).catch(() => {});
  }

  const giveAll = count === 'all' || count === Infinity;
  let remaining = giveAll ? Infinity : Math.max(1, Number(count) || 1);
  let givenCount = 0;
  const givenName = items[0].name;

  for (const stack of items) {
    if (signal?.aborted) throw new Error('Đã hủy');
    if (remaining <= 0) break;
    const amount = giveAll ? stack.count : Math.min(remaining, stack.count);
    if (amount <= 0) continue;
    await ctx.bot.toss(stack.type, stack.metadata ?? null, amount);
    if (giveAll) {
      givenCount += amount;
    } else {
      remaining -= amount;
      givenCount += amount;
    }
  }

  if (givenCount > 0) {
    ctx.lastGaveItemAt = Date.now();
  }
  return { name: givenName, count: givenCount };
}
