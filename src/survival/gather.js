import pf from 'mineflayer-pathfinder';
const { goals } = pf;
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

    let madeProgress = false;
    for (const blockPos of positions) {
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
