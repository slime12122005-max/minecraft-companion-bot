import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import {
  chooseDigFace,
  isMatchingTreeBlock,
  isTreeFoliageObstruction,
  isTreeLogName,
  isWithinDigReach,
  pickTreePillarItem,
  posKey,
  raceTimeout,
  sleep,
  toVec3,
} from './constants.js';

const MAX_TREE_PILLAR_HEIGHT = 14;
const UNSAFE_PILLAR_GROUND_NAMES = new Set([
  'water',
  'flowing_water',
  'lava',
  'flowing_lava',
  'magma_block',
  'campfire',
  'soul_campfire',
  'sweet_berry_bush',
  'cactus',
  'powder_snow',
  'scaffolding',
  'pointed_dripstone',
  'wither_rose',
]);

async function waitIfPaused(signal, isPaused) {
  if (signal?.aborted) throw new Error('Đã hủy');
  while (isPaused?.()) {
    if (signal?.aborted) throw new Error('Đã hủy');
    await sleep(200);
  }
}

function hasFoliageBetween(bot, a, b) {
  for (const t of [0.34, 0.5, 0.67]) {
    const px = Math.floor(a.x + 0.5 + (b.x - a.x) * t);
    const py = Math.floor(a.y + 0.5 + (b.y - a.y) * t);
    const pz = Math.floor(a.z + 0.5 + (b.z - a.z) * t);
    if ((px === a.x && py === a.y && pz === a.z) || (px === b.x && py === b.y && pz === b.z)) continue;
    const blk = bot.blockAt(new Vec3(px, py, pz));
    if (isTreeFoliageObstruction(blk)) return true;
  }
  return false;
}

function hasIndependentGroundStump(bot, candPos, baseMinY, seedBlock, knownOrVisitedKeys, pillarKeys) {
  const cx = Math.floor(candPos.x);
  const cyStart = Math.floor(candPos.y);
  const cz = Math.floor(candPos.z);
  let steps = 0;
  let lowestTrunkY = cyStart;

  for (let cy = cyStart - 1; cy >= baseMinY; cy--) {
    const key = `${cx},${cy},${cz}`;
    if (knownOrVisitedKeys?.has(key) || pillarKeys?.has(key)) {
      return false;
    }
    const blk = bot.blockAt(new Vec3(cx, cy, cz));
    if (!isMatchingTreeBlock(blk, seedBlock)) break;
    steps++;
    lowestTrunkY = cy;
  }

  return steps > 0 && lowestTrunkY <= baseMinY + 1;
}

function sortPositionsBottomUp(list, botPos) {
  list.sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    if (botPos) {
      const da = Math.hypot(a.x + 0.5 - botPos.x, a.z + 0.5 - botPos.z);
      const db = Math.hypot(b.x + 0.5 - botPos.x, b.z + 0.5 - botPos.z);
      return da - db;
    }
    return 0;
  });
  return list;
}

export function findTreeCluster(ctx, seedPos, allowedIds, skipped, maxBlocks = 256) {
  const seedVec = toVec3(seedPos);
  const seedBlock = ctx.bot.blockAt(seedVec);
  if (!seedBlock || seedBlock.type === 0 || (!allowedIds.includes(seedBlock.type) && !isTreeLogName(seedBlock.name))) {
    return [];
  }

  const visited = new Set([posKey(seedVec)]);
  const queue = [seedVec];
  const cluster = [];
  const connectedLogs = [seedVec];
  let baseMinY = seedVec.y;

  while (queue.length > 0 && cluster.length < maxBlocks) {
    const curr = queue.shift();
    const currKey = posKey(curr);
    if (!skipped.has(currKey)) {
      cluster.push(curr);
    }

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = curr.x + dx;
          const ny = curr.y + dy;
          const nz = curr.z + dz;
          if (
            Math.abs(nx - seedVec.x) > 8 ||
            Math.abs(nz - seedVec.z) > 8 ||
            ny - seedVec.y < -10 ||
            ny - seedVec.y > 32
          ) {
            continue;
          }
          const nKey = `${nx},${ny},${nz}`;
          if (visited.has(nKey)) continue;
          visited.add(nKey);

          const nVec = new Vec3(nx, ny, nz);
          const nb = ctx.bot.blockAt(nVec);
          if (!isMatchingTreeBlock(nb, seedBlock)) continue;
          if (nb.position && posKey(nb.position) !== nKey) continue;
          if (ny < baseMinY) baseMinY = ny;
          connectedLogs.push(nVec);
          queue.push(nVec);
        }
      }
    }
  }

  // Bridge 1-block leaf gaps in the upper crown without jumping onto separate nearby trees.
  const bridgeQueue = connectedLogs.filter(c => c.y >= baseMinY + 1);
  while (bridgeQueue.length > 0 && cluster.length < maxBlocks) {
    const curr = bridgeQueue.shift();
    if (curr.y < baseMinY + 1) continue;

    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const maxDelta = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
          if (maxDelta === 0) continue;
          const nx = curr.x + dx;
          const ny = curr.y + dy;
          const nz = curr.z + dz;
          if (
            Math.abs(nx - seedVec.x) > 8 ||
            Math.abs(nz - seedVec.z) > 8 ||
            ny - seedVec.y < -10 ||
            ny - seedVec.y > 32
          ) {
            continue;
          }
          if (maxDelta === 2 && ny < baseMinY + 2) continue;

          const nKey = `${nx},${ny},${nz}`;
          if (visited.has(nKey)) continue;

          const nVec = new Vec3(nx, ny, nz);
          const nb = ctx.bot.blockAt(nVec);
          if (!isMatchingTreeBlock(nb, seedBlock)) continue;
          if (nb.position && posKey(nb.position) !== nKey) continue;

          if (maxDelta === 2) {
            if (ny < curr.y && !hasFoliageBetween(ctx.bot, curr, nVec)) continue;
            if (hasIndependentGroundStump(ctx.bot, nVec, baseMinY, seedBlock, visited, null)) continue;
          }

          visited.add(nKey);
          if (!skipped.has(nKey)) {
            cluster.push(nVec);
          }
          bridgeQueue.push(nVec);
        }
      }
    }
  }

  return sortPositionsBottomUp(cluster, ctx.bot.entity?.position);
}

export async function clearTreeFoliageObstruction(ctx, targetBlock, signal, isPaused) {
  if (typeof ctx.bot.dig !== 'function' || !ctx.bot.entity?.position) return;
  const eyeHeight = ctx.bot.entity.eyeHeight ?? 1.62;
  const bx = Math.floor(targetBlock.position.x);
  const by = Math.floor(targetBlock.position.y);
  const bz = Math.floor(targetBlock.position.z);
  const targetKey = posKey(targetBlock.position);

  for (let attempt = 0; attempt < 8; attempt++) {
    await waitIfPaused(signal, isPaused);

    const botPos = ctx.bot.entity.position;
    const eye = new Vec3(botPos.x, botPos.y + eyeHeight, botPos.z);
    const digFace = chooseDigFace(botPos, targetBlock.position, eyeHeight);
    const aimTargets = [
      new Vec3(bx + 0.5 + digFace.x * 0.45, by + 0.5 + digFace.y * 0.45, bz + 0.5 + digFace.z * 0.45),
      new Vec3(bx + 0.5, by + 0.5, bz + 0.5),
      ...(eye.y < by ? [new Vec3(bx + 0.5, by + 0.05, bz + 0.5)] : []),
    ];

    let blocker = null;

    if (typeof ctx.bot.world?.raycast === 'function') {
      for (const aim of aimTargets) {
        const dx = aim.x - eye.x;
        const dy = aim.y - eye.y;
        const dz = aim.z - eye.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist <= 0) continue;
        const hit = ctx.bot.world.raycast(eye, new Vec3(dx / dist, dy / dist, dz / dist), Math.min(dist + 0.5, 5.2));
        if (hit?.position && posKey(hit.position) !== targetKey) {
          const candidate = ctx.bot.blockAt(hit.position);
          if (candidate && isTreeFoliageObstruction(candidate) && isWithinDigReach(botPos, candidate.position, eyeHeight)) {
            blocker = candidate;
            break;
          }
        }
      }
    }

    if (!blocker && typeof ctx.bot.blockAt === 'function') {
      const checked = new Set([targetKey]);
      for (const aim of aimTargets) {
        for (let s = 1; s <= 9; s++) {
          const t = s / 10;
          const sx = Math.floor(eye.x + (aim.x - eye.x) * t);
          const sy = Math.floor(eye.y + (aim.y - eye.y) * t);
          const sz = Math.floor(eye.z + (aim.z - eye.z) * t);
          const sKey = `${sx},${sy},${sz}`;
          if (checked.has(sKey)) continue;
          checked.add(sKey);
          const candidate = ctx.bot.blockAt(new Vec3(sx, sy, sz));
          if (candidate && isTreeFoliageObstruction(candidate) && isWithinDigReach(botPos, candidate.position, eyeHeight)) {
            blocker = candidate;
            break;
          }
        }
        if (blocker) break;
      }
    }

    if (!blocker && eye.y < by && typeof ctx.bot.blockAt === 'function') {
      const below = ctx.bot.blockAt(new Vec3(bx, by - 1, bz));
      if (below && isTreeFoliageObstruction(below) && isWithinDigReach(botPos, below.position, eyeHeight)) {
        blocker = below;
      }
    }

    if (!blocker) break;
    if (typeof ctx.bot.lookAt === 'function') {
      await raceTimeout(
        ctx.bot.lookAt(new Vec3(blocker.position.x + 0.5, blocker.position.y + 0.5, blocker.position.z + 0.5), true),
        ctx._timeouts.lookMs
      ).catch(() => {});
    }
    try {
      await ctx._digWithTimeout(blocker, {
        signal,
        digFace: chooseDigFace(botPos, blocker.position, eyeHeight),
      });
    } catch (err) {
      if (signal?.aborted) throw new Error('Đã hủy');
      if (isPaused?.()) throw err;
      if (err.name === 'Timeout' || /Digging aborted|Block not in view/i.test(err.message ?? '')) {
        break;
      }
      throw err;
    }
  }
}

async function clearLowLeafPathToColumn(ctx, bx, bz, signal, isPaused) {
  if (typeof ctx.bot.dig !== 'function' || typeof ctx.bot.blockAt !== 'function' || !ctx.bot.entity?.position) {
    return false;
  }
  const eyeHeight = ctx.bot.entity.eyeHeight ?? 1.62;
  const botPos = ctx.bot.entity.position;
  const footY = Math.floor(botPos.y);
  const seen = new Set();
  const candidates = [];

  const horizDist = Math.hypot(bx + 0.5 - botPos.x, bz + 0.5 - botPos.z);
  const steps = Math.max(1, Math.min(8, Math.ceil(horizDist)));
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const sx = Math.floor(botPos.x + (bx + 0.5 - botPos.x) * t);
    const sz = Math.floor(botPos.z + (bz + 0.5 - botPos.z) * t);
    for (const sy of [footY + 1, footY]) {
      const k = `${sx},${sy},${sz}`;
      if (seen.has(k)) continue;
      seen.add(k);
      candidates.push(new Vec3(sx, sy, sz));
    }
  }

  let dugAny = 0;
  for (const cPos of candidates) {
    if (dugAny >= 6) break;
    await waitIfPaused(signal, isPaused);
    const livePos = ctx.bot.entity?.position;
    if (!livePos) break;
    const blk = ctx.bot.blockAt(cPos);
    if (!blk || !isTreeFoliageObstruction(blk) || !isWithinDigReach(livePos, blk.position, eyeHeight)) {
      continue;
    }
    if (typeof ctx.bot.lookAt === 'function') {
      await raceTimeout(
        ctx.bot.lookAt(new Vec3(cPos.x + 0.5, cPos.y + 0.5, cPos.z + 0.5), true),
        ctx._timeouts.lookMs
      ).catch(() => {});
    }
    try {
      const ok = await ctx._digWithTimeout(blk, {
        signal,
        digFace: chooseDigFace(livePos, blk.position, eyeHeight),
      });
      if (ok) dugAny++;
    } catch (err) {
      if (signal?.aborted) throw new Error('Đã hủy');
      if (isPaused?.()) throw err;
    }
  }

  if (dugAny > 0 && typeof ctx.bot.pathfinder?.goto === 'function') {
    const retryY = Math.floor(ctx.bot.entity.position.y);
    try {
      await ctx._gotoWithTimeout(new goals.GoalNear(bx + 0.5, retryY, bz + 0.5, 0.9), { signal, isPaused });
    } catch (err) {
      if (signal?.aborted) throw new Error('Đã hủy');
      if ((err.name === 'GoalChanged' || err.name === 'PathStopped') && isPaused?.()) {
        throw err;
      }
    }
  }
  return dugAny > 0;
}

export async function digReachableTreeLog(ctx, block, signal, isPaused) {
  if (!ctx.bot.entity?.position || typeof ctx.bot.dig !== 'function' || typeof ctx.bot.pathfinder?.goto !== 'function') {
    return 'unreachable';
  }

  const bx = Math.floor(block.position.x);
  const by = Math.floor(block.position.y);
  const bz = Math.floor(block.position.z);
  const eyeHeight = ctx.bot.entity.eyeHeight ?? 1.62;

  if (!isWithinDigReach(ctx.bot.entity.position, block.position, eyeHeight, 3.6, 4.2)) {
    const moveGoals = [];
    if (Math.abs(by - ctx.bot.entity.position.y) <= 2.5) {
      moveGoals.push(new goals.GoalNear(bx, by, bz, 2));
    }
    if (typeof goals.GoalNearXZ === 'function') {
      moveGoals.push(new goals.GoalNearXZ(bx + 0.5, bz + 0.5, 0.9));
    }
    moveGoals.push(new goals.GoalNear(bx, Math.max(by - 3, Math.floor(ctx.bot.entity.position.y)), bz, 2));

    for (const goal of moveGoals) {
      if (signal?.aborted) throw new Error('Đã hủy');
      try {
        await ctx._gotoWithTimeout(goal, { signal, isPaused });
      } catch (err) {
        if (signal?.aborted) throw new Error('Đã hủy');
        if ((err.name === 'GoalChanged' || err.name === 'PathStopped') && isPaused?.()) {
          return 'paused';
        }
        if (err.name === 'NoPath' || err.name === 'Timeout') {
          continue;
        }
        throw err;
      }
      if (isWithinDigReach(ctx.bot.entity.position, block.position, eyeHeight, 3.6, 4.2)) {
        break;
      }
    }

    const posAfterMove = ctx.bot.entity.position;
    if (
      !isWithinDigReach(posAfterMove, block.position, eyeHeight) &&
      by - posAfterMove.y <= 5.2 &&
      Math.hypot(bx + 0.5 - posAfterMove.x, bz + 0.5 - posAfterMove.z) <= 6.5
    ) {
      try {
        await clearLowLeafPathToColumn(ctx, bx, bz, signal, isPaused);
      } catch (err) {
        if (signal?.aborted) throw new Error('Đã hủy');
        if (isPaused?.()) return 'paused';
        throw err;
      }
    }
  }

  if (!isWithinDigReach(ctx.bot.entity.position, block.position, eyeHeight)) {
    return by - ctx.bot.entity.position.y >= 4.3 ? 'too_high' : 'unreachable';
  }

  const current = ctx.bot.blockAt(block.position);
  if (!current || current.type === 0) return 'already_gone';

  try {
    await ctx._clearTreeFoliageObstruction(current, signal, isPaused);
    const refreshed = ctx.bot.blockAt(block.position);
    if (!refreshed || refreshed.type === 0) return 'already_gone';

    if (ctx.bot.tool?.equipForBlock) {
      await raceTimeout(
        ctx.bot.tool.equipForBlock(refreshed, { requireHarvest: false, getFromChest: false }),
        ctx._timeouts.equipMs
      ).catch(() => {});
    }
    const digPos = ctx.bot.entity.position;
    const digFace = chooseDigFace(digPos, refreshed.position, eyeHeight);
    if (typeof ctx.bot.lookAt === 'function') {
      await raceTimeout(
        ctx.bot.lookAt(
          new Vec3(bx + 0.5 + digFace.x * 0.45, by + 0.5 + digFace.y * 0.45, bz + 0.5 + digFace.z * 0.45),
          true
        ),
        ctx._timeouts.lookMs
      ).catch(() => {});
    }
    const digOk = await ctx._digWithTimeout(refreshed, { signal, digFace });
    if (!digOk) return 'unreachable';
    if (ctx._timeouts.verifyDelayMs > 0) {
      await sleep(ctx._timeouts.verifyDelayMs);
      if (signal?.aborted) throw new Error('Đã hủy');
    }
    const after = ctx.bot.blockAt(block.position);
    return !after || after.type !== refreshed.type ? 'collected_direct' : 'unreachable';
  } catch (err) {
    if (signal?.aborted) throw new Error('Đã hủy');
    if (isPaused?.()) return 'paused';
    if (err.name === 'Timeout') {
      const after = ctx.bot.blockAt(block.position);
      return !after || after.type !== current.type ? 'collected_direct' : 'unreachable';
    }
    if (err.name === 'NoPath' || /Digging aborted|Block not in view/i.test(err.message ?? '')) {
      return 'unreachable';
    }
    throw err;
  }
}

export async function mineTreeLogBlock(ctx, block, targetText, signal, isPaused) {
  const canDirectDig = Boolean(
    ctx.bot.entity?.position &&
    typeof ctx.bot.dig === 'function' &&
    typeof ctx.bot.pathfinder?.goto === 'function'
  );

  if (canDirectDig) {
    return await ctx._digReachableTreeLog(block, signal, isPaused);
  }

  try {
    await ctx._collectBlockWithTimeout(block, { signal });
    const after = ctx.bot.blockAt(block.position);
    if (!after || after.type !== block.type) {
      return 'collected';
    }
  } catch (err) {
    if (signal?.aborted) throw new Error('Đã hủy');
    if ((err.name === 'GoalChanged' || err.name === 'PathStopped') && isPaused?.()) {
      return 'paused';
    }
    if (err.name === 'NoChests' || err.name === 'NoItem' || /chest locations|harvestable tool/i.test(err.message ?? '')) {
      throw new Error(`Chưa có công cụ đủ cấp để đào ${targetText}`);
    }
    if (err.name !== 'NoPath' && err.name !== 'Timeout') {
      throw err;
    }
  }

  return 'unreachable';
}

function setBotYMockSafe(bot, targetY) {
  const pos = bot.entity?.position;
  if (!pos || bot._client) return;
  const dy = targetY - pos.y;
  if (Math.abs(dy) < 1e-6) return;
  if (typeof pos.offset === 'function') {
    bot.entity.position = pos.offset(0, dy, 0);
  } else {
    bot.entity.position = { ...pos, y: targetY };
  }
}

function isSafePillarGround(block) {
  if (!block || block.type === 0 || block.boundingBox === 'empty') return false;
  const name = String(block.name ?? '').toLowerCase();
  if (UNSAFE_PILLAR_GROUND_NAMES.has(name)) return false;
  if (isTreeFoliageObstruction(block)) return false;
  return true;
}

function selectSafePillarBase(bot, seedVec, anchorLog, skipped, pillarKeys) {
  const botPos = bot.entity?.position;
  if (!botPos || typeof bot.blockAt !== 'function') return null;

  const baseY = Math.floor(botPos.y);
  const candidatesXZ = [];
  const seenXZ = new Set();
  const addXZ = (x, z) => {
    const k = `${x},${z}`;
    if (seenXZ.has(k)) return;
    seenXZ.add(k);
    candidatesXZ.push([x, z]);
  };

  if (Math.hypot(seedVec.x - anchorLog.x, seedVec.z - anchorLog.z) <= 2.5) {
    addXZ(seedVec.x, seedVec.z);
  }
  addXZ(anchorLog.x, anchorLog.z);

  const offsets = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      offsets.push([anchorLog.x + dx, anchorLog.z + dz]);
    }
  }
  offsets.sort((a, b) => Math.hypot(a[0] - anchorLog.x, a[1] - anchorLog.z) - Math.hypot(b[0] - anchorLog.x, b[1] - anchorLog.z));
  for (const [ox, oz] of offsets) addXZ(ox, oz);

  for (const [cx, cz] of candidatesXZ) {
    for (const gy of [baseY, baseY - 1, baseY + 1]) {
      const ground = bot.blockAt(new Vec3(cx, gy - 1, cz));
      if (!isSafePillarGround(ground)) continue;
      const body0 = bot.blockAt(new Vec3(cx, gy, cz));
      const body1 = bot.blockAt(new Vec3(cx, gy + 1, cz));
      const body0Ok = !body0 || body0.type === 0 || body0.boundingBox === 'empty' || isTreeFoliageObstruction(body0);
      const body1Ok = !body1 || body1.type === 0 || body1.boundingBox === 'empty' || isTreeFoliageObstruction(body1);
      if (body0Ok && body1Ok && !pillarKeys.has(`${cx},${gy},${cz}`) && !skipped.has(`${cx},${gy},${cz}`)) {
        return new Vec3(cx, gy, cz);
      }
    }
  }
  return null;
}

async function digInPlaceTreeLog(ctx, block, pillarKeys, signal, isPaused) {
  if (!block || block.type === 0 || pillarKeys.has(posKey(block.position))) return 'skipped';
  const eyeHeight = ctx.bot.entity.eyeHeight ?? 1.62;
  const botPos = ctx.bot.entity?.position;
  if (!botPos || !isWithinDigReach(botPos, block.position, eyeHeight)) return 'unreachable';

  try {
    await ctx._clearTreeFoliageObstruction(block, signal, isPaused);
    const refreshed = ctx.bot.blockAt(block.position);
    if (!refreshed || refreshed.type === 0) return 'already_gone';
    if (!isWithinDigReach(ctx.bot.entity.position, refreshed.position, eyeHeight)) return 'unreachable';

    if (ctx.bot.tool?.equipForBlock) {
      await raceTimeout(
        ctx.bot.tool.equipForBlock(refreshed, { requireHarvest: false, getFromChest: false }),
        ctx._timeouts.equipMs
      ).catch(() => {});
    }
    const bx = Math.floor(refreshed.position.x);
    const by = Math.floor(refreshed.position.y);
    const bz = Math.floor(refreshed.position.z);
    const digPos = ctx.bot.entity.position;
    const digFace = chooseDigFace(digPos, refreshed.position, eyeHeight);
    if (typeof ctx.bot.lookAt === 'function') {
      await raceTimeout(
        ctx.bot.lookAt(
          new Vec3(bx + 0.5 + digFace.x * 0.45, by + 0.5 + digFace.y * 0.45, bz + 0.5 + digFace.z * 0.45),
          true
        ),
        ctx._timeouts.lookMs
      ).catch(() => {});
    }
    const digOk = await ctx._digWithTimeout(refreshed, { signal, digFace });
    if (!digOk) return 'unreachable';
    if (ctx._timeouts.verifyDelayMs > 0) {
      await sleep(ctx._timeouts.verifyDelayMs);
      if (signal?.aborted) throw new Error('Đã hủy');
    }
    const after = ctx.bot.blockAt(refreshed.position);
    return !after || after.type !== refreshed.type ? 'collected_direct' : 'unreachable';
  } catch (err) {
    if (signal?.aborted) throw new Error('Đã hủy');
    if (isPaused?.()) throw err;
    if (err.name === 'Timeout') {
      const after = ctx.bot.blockAt(block.position);
      return !after || after.type !== block.type ? 'collected_direct' : 'unreachable';
    }
    if (/Digging aborted|Block not in view/i.test(err.message ?? '')) return 'unreachable';
    throw err;
  }
}

function getPillarPingMs(ctx) {
  const raw = Number(ctx?.bot?.player?.ping ?? ctx?.bot?.players?.[ctx?.bot?.username]?.ping ?? 0);
  const host = String(ctx?.config?.minecraft?.host ?? '').trim().toLowerCase();
  const isRemote = Boolean(
    host &&
    host !== 'localhost' &&
    host !== '127.0.0.1' &&
    host !== '::1' &&
    !host.startsWith('192.168.') &&
    !host.startsWith('10.')
  );
  return Math.max(0, Number.isFinite(raw) && raw > 0 ? raw : (isRemote ? 110 : 0));
}

async function pillarUpOneBlock(ctx, px, pz, seedBlock, pillarKeys, pillarStack, signal, isPaused) {
  const bot = ctx.bot;
  const eyeHeight = bot.entity.eyeHeight ?? 1.62;
  const curY = Math.floor(bot.entity.position.y);
  let dugLogs = 0;

  if (Math.hypot(bot.entity.position.x - (px + 0.5), bot.entity.position.z - (pz + 0.5)) > 0.55) {
    try {
      await ctx._gotoWithTimeout(new goals.GoalNear(px + 0.5, curY, pz + 0.5, 0.25), { signal, isPaused });
    } catch (err) {
      if (signal?.aborted) throw new Error('Đã hủy');
      if ((err.name === 'GoalChanged' || err.name === 'PathStopped') && isPaused?.()) throw err;
    }
  }

  const refBlock = bot.blockAt(new Vec3(px, curY - 1, pz));
  if (!refBlock || refBlock.type === 0 || refBlock.boundingBox === 'empty') {
    return { placed: false, dugLogs };
  }

  const clearPosList = [
    new Vec3(px, curY, pz),
    new Vec3(px, curY + 1, pz),
    new Vec3(px, curY + 2, pz),
  ];
  const bxPos = bot.entity.position.x;
  const bzPos = bot.entity.position.z;
  for (const hx of [Math.floor(bxPos - 0.29), Math.floor(bxPos + 0.29)]) {
    for (const hz of [Math.floor(bzPos - 0.29), Math.floor(bzPos + 0.29)]) {
      if (hx === px && hz === pz) continue;
      clearPosList.push(new Vec3(hx, curY + 2, hz));
    }
  }

  for (const cPos of clearPosList) {
    await waitIfPaused(signal, isPaused);
    const k = posKey(cPos);
    if (pillarKeys.has(k)) continue;
    const blk = bot.blockAt(cPos);
    if (!blk || blk.type === 0 || blk.boundingBox === 'empty') continue;

    if (isMatchingTreeBlock(blk, seedBlock) && isWithinDigReach(bot.entity.position, blk.position, eyeHeight)) {
      const res = await digInPlaceTreeLog(ctx, blk, pillarKeys, signal, isPaused);
      if (res === 'collected_direct') dugLogs++;
    } else if (isTreeFoliageObstruction(blk) && isWithinDigReach(bot.entity.position, blk.position, eyeHeight)) {
      if (typeof bot.lookAt === 'function') {
        await raceTimeout(
          bot.lookAt(new Vec3(cPos.x + 0.5, cPos.y + 0.5, cPos.z + 0.5), true),
          ctx._timeouts.lookMs
        ).catch(() => {});
      }
      try {
        await ctx._digWithTimeout(blk, { signal, digFace: chooseDigFace(bot.entity.position, blk.position, eyeHeight) });
      } catch (err) {
        if (signal?.aborted) throw new Error('Đã hủy');
        if (isPaused?.()) throw err;
      }
    }
  }

  const ceiling = bot.blockAt(new Vec3(px, curY + 2, pz));
  if (ceiling && ceiling.type !== 0 && ceiling.boundingBox !== 'empty') {
    return { placed: false, dugLogs };
  }

  const item = pickTreePillarItem(bot);
  if (!item) return { placed: false, dugLogs };

  if (typeof bot.equip === 'function') {
    await raceTimeout(bot.equip(item, 'hand'), ctx._timeouts.equipMs).catch(() => {});
  }
  if (typeof bot.lookAt === 'function') {
    await raceTimeout(
      bot.lookAt(new Vec3(px + 0.5, curY, pz + 0.5), true),
      ctx._timeouts.lookMs
    ).catch(() => {});
  }

  const pingMs = getPillarPingMs(ctx);
  const jumpMs = pingMs >= 60
    ? Math.max(ctx._timeouts.pillarJumpMs ?? 450, Math.min(750, 450 + pingMs))
    : (ctx._timeouts.pillarJumpMs ?? 450);
  const settleMs = pingMs >= 60
    ? Math.max(ctx._timeouts.pillarSettleMs ?? 80, Math.min(400, Math.round(pingMs * 1.6)))
    : (ctx._timeouts.pillarSettleMs ?? 80);

  const targetPos = new Vec3(px, curY, pz);
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitIfPaused(signal, isPaused);
    try {
      bot.setControlState?.('jump', true);
      if (bot._client) {
        const deadline = Date.now() + jumpMs;
        while (Date.now() < deadline && bot.entity.position.y < curY + 1.0) {
          if (signal?.aborted) throw new Error('Đã hủy');
          await sleep(20);
        }
      } else if (jumpMs > 0) {
        await sleep(Math.min(25, jumpMs));
      }

      if (bot.entity.position.y >= curY + 1.0 || !bot._client) {
        await raceTimeout(
          bot.placeBlock(refBlock, new Vec3(0, 1, 0)),
          ctx._timeouts.placeMs ?? 1500
        );
      }
    } catch (err) {
      if (signal?.aborted) throw new Error('Đã hủy');
      if (isPaused?.()) throw err;
    } finally {
      try { bot.setControlState?.('jump', false); } catch {}
    }

    if (settleMs > 0) {
      await sleep(settleMs);
      if (signal?.aborted) throw new Error('Đã hủy');
    }

    const placed = bot.blockAt(targetPos);
    if (placed && placed.type !== 0) {
      if (bot._client && bot.entity.position.y < curY + 0.8) {
        await sleep(Math.min(200, Math.max(80, pingMs)));
        continue;
      }
      if (!bot._client && bot.entity.position.y < curY + 1) {
        setBotYMockSafe(bot, curY + 1);
      }
      pillarStack.push(targetPos);
      pillarKeys.add(posKey(targetPos));
      return { placed: true, dugLogs };
    }
  }

  return { placed: false, dugLogs };
}

async function teardownTreePillar(ctx, pillarStack, pillarKeys, signal, isPaused) {
  try { ctx.bot.setControlState?.('jump', false); } catch {}
  if (pillarStack.length === 0 || signal?.aborted) return;

  const eyeHeight = ctx.bot.entity?.eyeHeight ?? 1.62;
  while (pillarStack.length > 0) {
    if (signal?.aborted) return;
    while (isPaused?.()) {
      if (signal?.aborted) return;
      await sleep(200);
    }

    const p = pillarStack.pop();
    const key = posKey(p);
    const blk = ctx.bot.blockAt(p);
    if (!blk || blk.type === 0) {
      pillarKeys.delete(key);
      continue;
    }

    const botPos = ctx.bot.entity?.position;
    if (botPos && !isWithinDigReach(botPos, p, eyeHeight) && typeof ctx.bot.pathfinder?.goto === 'function') {
      try {
        await ctx._gotoWithTimeout(new goals.GoalNear(p.x + 0.5, p.y + 1, p.z + 0.5, 2), { signal, isPaused });
      } catch (err) {
        if (signal?.aborted) return;
      }
    }

    if (ctx.bot.tool?.equipForBlock) {
      await raceTimeout(
        ctx.bot.tool.equipForBlock(blk, { requireHarvest: false, getFromChest: false }),
        ctx._timeouts.equipMs
      ).catch(() => {});
    }
    if (typeof ctx.bot.lookAt === 'function') {
      await raceTimeout(
        ctx.bot.lookAt(new Vec3(p.x + 0.5, p.y + 1.0, p.z + 0.5), true),
        ctx._timeouts.lookMs
      ).catch(() => {});
    }

    if (ctx.bot._client && ctx.bot.entity?.onGround === false) {
      const groundDeadline = Date.now() + 400;
      while (Date.now() < groundDeadline && ctx.bot.entity?.onGround === false) {
        if (signal?.aborted) return;
        await sleep(30);
      }
    }

    try {
      await ctx._digWithTimeout(blk, { signal, digFace: new Vec3(0, 1, 0) });
      if (ctx._timeouts.verifyDelayMs > 0) {
        await sleep(ctx._timeouts.verifyDelayMs);
      }
    } catch (err) {
      if (signal?.aborted) return;
    }

    pillarKeys.delete(key);
    const after = ctx.bot.blockAt(p);
    if (!ctx.bot._client && (!after || after.type === 0) && ctx.bot.entity?.position) {
      const bp = ctx.bot.entity.position;
      if (Math.hypot(bp.x - (p.x + 0.5), bp.z - (p.z + 0.5)) <= 0.85 && bp.y > p.y) {
        setBotYMockSafe(ctx.bot, p.y);
      }
    }
    if (ctx._timeouts.pillarSettleMs > 0 && !signal?.aborted) {
      await sleep(ctx._timeouts.pillarSettleMs);
    }
  }
}

async function chopElevatedLogsWithPillar(
  ctx,
  { seedPos, seedVec, seedBlock, anchorLog, dugDirectly, lastPos, scanRemainingTreeLogs, skipped, pillarKeys, signal, isPaused }
) {
  if (typeof ctx.bot.placeBlock !== 'function' || !ctx.bot.entity?.position) {
    return { collected: 0, attempted: false, lastPos };
  }

  let pillarItem = pickTreePillarItem(ctx.bot);
  if (!pillarItem && dugDirectly > 0) {
    await ctx._collectNearbyItemDrops([seedPos, lastPos, anchorLog], signal, isPaused);
    pillarItem = pickTreePillarItem(ctx.bot);
  }
  if (!pillarItem) {
    return { collected: 0, attempted: false, lastPos };
  }

  const basePos = selectSafePillarBase(ctx.bot, seedVec, anchorLog, skipped, pillarKeys);
  if (!basePos) {
    return { collected: 0, attempted: false, lastPos };
  }

  const px = basePos.x;
  const groundY = basePos.y;
  const pz = basePos.z;
  const eyeHeight = ctx.bot.entity.eyeHeight ?? 1.62;

  for (const cPos of [new Vec3(px, groundY + 1, pz), new Vec3(px, groundY, pz)]) {
    const blk = ctx.bot.blockAt(cPos);
    if (blk && isTreeFoliageObstruction(blk) && isWithinDigReach(ctx.bot.entity.position, cPos, eyeHeight)) {
      await ctx._digWithTimeout(blk, { signal, digFace: chooseDigFace(ctx.bot.entity.position, cPos, eyeHeight) }).catch(() => {});
    }
  }

  const pillarPingMs = getPillarPingMs(ctx);
  const centerTol = pillarPingMs >= 60 ? 0.32 : 0.7;
  const centerGoalRange = pillarPingMs >= 60 ? 0.25 : 0.35;
  if (
    Math.hypot(ctx.bot.entity.position.x - (px + 0.5), ctx.bot.entity.position.z - (pz + 0.5)) > centerTol ||
    Math.abs(ctx.bot.entity.position.y - groundY) > 0.6
  ) {
    try {
      await ctx._gotoWithTimeout(new goals.GoalNear(px + 0.5, groundY, pz + 0.5, centerGoalRange), { signal, isPaused });
    } catch (err) {
      if (signal?.aborted) throw new Error('Đã hủy');
      if ((err.name === 'GoalChanged' || err.name === 'PathStopped') && isPaused?.()) {
        return { collected: 0, attempted: false, lastPos };
      }
    }
  }

  if (Math.hypot(ctx.bot.entity.position.x - (px + 0.5), ctx.bot.entity.position.z - (pz + 0.5)) > 1.2) {
    return { collected: 0, attempted: false, lastPos };
  }

  const pillarStack = [];
  let pillarCollected = 0;
  let updatedLastPos = lastPos;

  try {
    while (pillarStack.length <= MAX_TREE_PILLAR_HEIGHT) {
      await waitIfPaused(signal, isPaused);

      let dugOnThisLevel = false;
      do {
        dugOnThisLevel = false;
        const botPos = ctx.bot.entity.position;
        const curFootY = Math.floor(botPos.y);
        const candidates = scanRemainingTreeLogs().filter(p => {
          const k = posKey(p);
          if (pillarKeys.has(k) || skipped.has(k)) return false;
          if (p.x === px && p.z === pz && p.y <= curFootY - 1) return false;
          return isWithinDigReach(botPos, p, eyeHeight);
        });

        for (const p of candidates) {
          const b = ctx.bot.blockAt(p);
          if (!isMatchingTreeBlock(b, seedBlock)) continue;
          const res = await digInPlaceTreeLog(ctx, b, pillarKeys, signal, isPaused);
          if (res === 'collected_direct') {
            pillarCollected++;
            updatedLastPos = p;
            dugOnThisLevel = true;
          }
        }
      } while (dugOnThisLevel);

      const curFootY = Math.floor(ctx.bot.entity.position.y);
      const overheadRemaining = scanRemainingTreeLogs().filter(
        p => !pillarKeys.has(posKey(p)) && Math.hypot(p.x - px, p.z - pz) <= 3.3 && p.y > curFootY
      );
      if (overheadRemaining.length === 0 || pillarStack.length >= MAX_TREE_PILLAR_HEIGHT) {
        break;
      }

      const stepRes = await pillarUpOneBlock(ctx, px, pz, seedBlock, pillarKeys, pillarStack, signal, isPaused);
      if (stepRes.dugLogs > 0) {
        pillarCollected += stepRes.dugLogs;
      }
      if (!stepRes.placed) break;
    }
  } finally {
    await teardownTreePillar(ctx, pillarStack, pillarKeys, signal, isPaused);
  }

  return { collected: pillarCollected, attempted: true, lastPos: updatedLastPos };
}

export async function chopWholeTree(ctx, seedPos, ids, targetText, skipped, signal, isPaused) {
  const seedVec = toVec3(seedPos);
  const seedBlock = ctx.bot.blockAt(seedVec);
  if (!seedBlock || seedBlock.type === 0) {
    skipped.add(posKey(seedPos));
    return { collected: 0, anySuccess: false };
  }

  const initialCluster = ctx._findTreeCluster(seedPos, ids, skipped);
  if (initialCluster.length === 0) {
    skipped.add(posKey(seedPos));
    return { collected: 0, anySuccess: false };
  }

  ctx.log(`🌲 Đang chặt cây (${initialCluster.length} khối gỗ)...`);

  const canDirectDig = Boolean(
    ctx.bot.entity?.position &&
    typeof ctx.bot.dig === 'function' &&
    typeof ctx.bot.pathfinder?.goto === 'function'
  );
  const knownCoords = [...initialCluster];
  const knownKeys = new Set(initialCluster.map(posKey));
  const pillarKeys = new Set();
  const failCounts = new Map();

  const scanRemainingTreeLogs = () => {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const c of knownCoords) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
      if (c.z < minZ) minZ = c.z;
      if (c.z > maxZ) maxZ = c.z;
    }
    const baseMinY = Math.min(minY, seedVec.y);
    const lowX = Math.max(seedVec.x - 8, minX - 2);
    const highX = Math.min(seedVec.x + 8, maxX + 2);
    const lowY = Math.max(seedVec.y - 10, minY - 1);
    const highY = Math.min(seedVec.y + 32, maxY + 2);
    const lowZ = Math.max(seedVec.z - 8, minZ - 2);
    const highZ = Math.min(seedVec.z + 8, maxZ + 2);

    const found = [];
    for (let y = lowY; y <= highY; y++) {
      for (let x = lowX; x <= highX; x++) {
        for (let z = lowZ; z <= highZ; z++) {
          const key = `${x},${y},${z}`;
          if (skipped.has(key) || pillarKeys.has(key)) continue;
          const nVec = new Vec3(x, y, z);
          const nb = ctx.bot.blockAt(nVec);
          if (!isMatchingTreeBlock(nb, seedBlock)) continue;
          if (nb.position && posKey(nb.position) !== key) continue;

          if (!knownKeys.has(key)) {
            const directNeighbor = knownCoords.some(
              c => Math.abs(c.x - x) <= 1 && Math.abs(c.y - y) <= 1 && Math.abs(c.z - z) <= 1
            );
            if (!directNeighbor) {
              const gapAnchor = knownCoords.find(
                c => Math.abs(c.x - x) <= 2 && Math.abs(c.y - y) <= 2 && Math.abs(c.z - z) <= 2
              );
              if (!gapAnchor || y < baseMinY + 2 || gapAnchor.y < baseMinY + 1) continue;
              if (y < gapAnchor.y && !hasFoliageBetween(ctx.bot, gapAnchor, nVec)) continue;
              if (hasIndependentGroundStump(ctx.bot, nVec, baseMinY, seedBlock, knownKeys, pillarKeys)) continue;
            }
            knownKeys.add(key);
            knownCoords.push(nVec);
          }
          found.push(nVec);
        }
      }
    }

    return sortPositionsBottomUp(found, ctx.bot.entity?.position);
  };

  let treeCollected = 0;
  let dugDirectly = 0;
  let lastPos = seedPos;
  let unreached = 0;

  for (let round = 0; round < 8; round++) {
    const queue = round === 0 ? initialCluster : scanRemainingTreeLogs();
    if (queue.length === 0) {
      unreached = 0;
      break;
    }

    const failedThisRound = [];
    const highThisRound = [];
    let roundProgress = false;

    for (let i = 0; i < queue.length; i++) {
      await waitIfPaused(signal, isPaused);

      const blockPos = queue[i];
      const key = posKey(blockPos);
      if (skipped.has(key) || pillarKeys.has(key)) continue;

      const block = ctx.bot.blockAt(blockPos);
      if (!block || block.type === 0) continue;

      const res = await ctx._mineTreeLogBlock(block, targetText, signal, isPaused);
      if (res === 'paused') {
        await waitIfPaused(signal, isPaused);
        i--;
        continue;
      }
      if (res === 'collected' || res === 'collected_direct') {
        treeCollected++;
        roundProgress = true;
        lastPos = blockPos;
        if (res === 'collected_direct') {
          dugDirectly++;
          if (dugDirectly % 12 === 0) {
            await ctx._collectNearbyItemDrops([seedPos, lastPos], signal, isPaused);
          }
        }
      } else if (res === 'too_high') {
        highThisRound.push(blockPos);
      } else if (res === 'unreachable') {
        const nextFail = (failCounts.get(key) ?? 0) + 1;
        failCounts.set(key, nextFail);
        if (nextFail >= 2) {
          skipped.add(key);
          unreached++;
        } else {
          failedThisRound.push(blockPos);
        }
      }
    }

    if (highThisRound.length > 0) {
      const seenHigh = new Set();
      const remainingHigh = [];
      for (const p of highThisRound) {
        const k = posKey(p);
        if (seenHigh.has(k) || skipped.has(k) || pillarKeys.has(k)) continue;
        seenHigh.add(k);
        const b = ctx.bot.blockAt(p);
        if (b && isMatchingTreeBlock(b, seedBlock)) remainingHigh.push(p);
      }

      if (remainingHigh.length > 0 && canDirectDig && typeof ctx.bot.placeBlock === 'function') {
        const triedBases = [];
        for (let pass = 0; pass < 2; pass++) {
          const anchor = remainingHigh.find(p => {
            const b = ctx.bot.blockAt(p);
            if (!b || !isMatchingTreeBlock(b, seedBlock) || skipped.has(posKey(p))) return false;
            return triedBases.every(tb => Math.hypot(p.x - tb.x, p.z - tb.z) >= 2);
          });
          if (!anchor) break;
          triedBases.push(anchor);

          const pillarRes = await chopElevatedLogsWithPillar(ctx, {
            seedPos,
            seedVec,
            seedBlock,
            anchorLog: anchor,
            dugDirectly,
            lastPos,
            scanRemainingTreeLogs,
            skipped,
            pillarKeys,
            signal,
            isPaused,
          });
          if (pillarRes.collected > 0) {
            treeCollected += pillarRes.collected;
            dugDirectly += pillarRes.collected;
            roundProgress = true;
            lastPos = pillarRes.lastPos;
          }
        }
      }

      for (const p of remainingHigh) {
        const k = posKey(p);
        if (skipped.has(k) || pillarKeys.has(k)) continue;
        const after = ctx.bot.blockAt(p);
        if (after && isMatchingTreeBlock(after, seedBlock)) {
          const nextFail = (failCounts.get(k) ?? 0) + 1;
          failCounts.set(k, nextFail);
          if (nextFail >= 2) {
            skipped.add(k);
            unreached++;
          } else {
            failedThisRound.push(p);
          }
        }
      }
    }

    if (!roundProgress) {
      for (const p of failedThisRound) {
        const k = posKey(p);
        if (!skipped.has(k)) {
          skipped.add(k);
          unreached++;
        }
      }
      break;
    }

    if (canDirectDig && ctx._timeouts.verifyDelayMs > 0) {
      await sleep(ctx._timeouts.verifyDelayMs);
      if (signal?.aborted) throw new Error('Đã hủy');
    }
  }

  if (dugDirectly > 0) {
    await ctx._collectNearbyItemDrops([seedPos, lastPos], signal, isPaused);
  }

  if (unreached > 0) {
    ctx.log(`🌲 Đã chặt ${treeCollected} khối gỗ (bỏ qua ${unreached} khối không thể tới).`);
  } else if (treeCollected > 0) {
    ctx.log(`🌲 Đã chặt xong cây (${treeCollected} khối gỗ).`);
  }

  return { collected: treeCollected, anySuccess: treeCollected > 0 };
}
