import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import {
  chooseDigFace,
  isTreeFoliageObstruction,
  isTreeLogName,
  isWithinDigReach,
  posKey,
  raceTimeout,
  sleep,
  toVec3,
} from './constants.js';

export function findTreeCluster(ctx, seedPos, allowedIds, skipped, maxBlocks = 128) {
  const seedVec = toVec3(seedPos);
  const seedBlock = ctx.bot.blockAt(seedVec);
  if (!seedBlock || seedBlock.type === 0 || (!allowedIds.includes(seedBlock.type) && !isTreeLogName(seedBlock.name))) {
    return [];
  }

  const targetType = seedBlock.type;
  const visited = new Set([posKey(seedVec)]);
  const queue = [seedVec];
  const cluster = [];

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
          if (!nb || nb.type !== targetType) continue;
          if (nb.position && posKey(nb.position) !== nKey) continue;
          queue.push(nVec);
        }
      }
    }
  }

  const botPos = ctx.bot.entity?.position;
  cluster.sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    if (botPos) {
      const da = Math.hypot(a.x + 0.5 - botPos.x, a.z + 0.5 - botPos.z);
      const db = Math.hypot(b.x + 0.5 - botPos.x, b.z + 0.5 - botPos.z);
      return da - db;
    }
    return 0;
  });
  return cluster;
}

export async function clearTreeFoliageObstruction(ctx, targetBlock, signal, isPaused) {
  if (typeof ctx.bot.dig !== 'function' || !ctx.bot.entity?.position) return;
  const eyeHeight = ctx.bot.entity.eyeHeight ?? 1.62;
  const bx = Math.floor(targetBlock.position.x);
  const by = Math.floor(targetBlock.position.y);
  const bz = Math.floor(targetBlock.position.z);

  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw new Error('Đã hủy');
    while (isPaused?.()) {
      if (signal?.aborted) throw new Error('Đã hủy');
      await sleep(200);
    }

    const botPos = ctx.bot.entity.position;
    const eye = new Vec3(botPos.x, botPos.y + eyeHeight, botPos.z);
    let blocker = null;

    if (typeof ctx.bot.world?.raycast === 'function') {
      const aimTargets = [
        new Vec3(bx + 0.5, by + 0.5, bz + 0.5),
        ...(eye.y < by ? [new Vec3(bx + 0.5, by + 0.05, bz + 0.5)] : []),
      ];
      for (const aim of aimTargets) {
        const dx = aim.x - eye.x;
        const dy = aim.y - eye.y;
        const dz = aim.z - eye.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist <= 0) continue;
        const hit = ctx.bot.world.raycast(eye, new Vec3(dx / dist, dy / dist, dz / dist), Math.min(dist + 0.5, 5.2));
        if (hit?.position && posKey(hit.position) !== posKey(targetBlock.position)) {
          const candidate = ctx.bot.blockAt(hit.position);
          if (candidate && isTreeFoliageObstruction(candidate) && isWithinDigReach(botPos, candidate.position, eyeHeight)) {
            blocker = candidate;
            break;
          }
        }
      }
    }

    if (!blocker && eye.y < by) {
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
      moveGoals.push(new goals.GoalNearXZ(bx, bz, 1.0));
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
  }

  if (!isWithinDigReach(ctx.bot.entity.position, block.position, eyeHeight)) {
    return 'unreachable';
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
    if (typeof ctx.bot.lookAt === 'function') {
      await raceTimeout(
        ctx.bot.lookAt(new Vec3(bx + 0.5, by + 0.5, bz + 0.5), true),
        ctx._timeouts.lookMs
      ).catch(() => {});
    }
    const digOk = await ctx._digWithTimeout(refreshed, {
      signal,
      digFace: chooseDigFace(ctx.bot.entity.position, refreshed.position, eyeHeight),
    });
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

export async function chopWholeTree(ctx, seedPos, ids, targetText, skipped, signal, isPaused) {
  const seedVec = toVec3(seedPos);
  const seedBlock = ctx.bot.blockAt(seedVec);
  if (!seedBlock || seedBlock.type === 0) {
    skipped.add(posKey(seedPos));
    return { collected: 0, anySuccess: false };
  }
  const treeType = seedBlock.type;

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
    const lowX = Math.max(seedVec.x - 8, minX - 1);
    const highX = Math.min(seedVec.x + 8, maxX + 1);
    const lowY = Math.max(seedVec.y - 10, minY - 1);
    const highY = Math.min(seedVec.y + 32, maxY + 2);
    const lowZ = Math.max(seedVec.z - 8, minZ - 1);
    const highZ = Math.min(seedVec.z + 8, maxZ + 1);

    const found = [];
    for (let y = lowY; y <= highY; y++) {
      for (let x = lowX; x <= highX; x++) {
        for (let z = lowZ; z <= highZ; z++) {
          const key = `${x},${y},${z}`;
          if (skipped.has(key)) continue;
          const nVec = new Vec3(x, y, z);
          const nb = ctx.bot.blockAt(nVec);
          if (!nb || nb.type !== treeType) continue;
          if (nb.position && posKey(nb.position) !== key) continue;
          const connected =
            knownKeys.has(key) ||
            knownCoords.some(c => Math.abs(c.x - x) <= 2 && Math.abs(c.y - y) <= 2 && Math.abs(c.z - z) <= 2);
          if (!connected) continue;
          if (!knownKeys.has(key)) {
            knownKeys.add(key);
            knownCoords.push(nVec);
          }
          found.push(nVec);
        }
      }
    }

    const botPos = ctx.bot.entity?.position;
    found.sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      if (botPos) {
        const da = Math.hypot(a.x + 0.5 - botPos.x, a.z + 0.5 - botPos.z);
        const db = Math.hypot(b.x + 0.5 - botPos.x, b.z + 0.5 - botPos.z);
        return da - db;
      }
      return 0;
    });
    return found;
  };

  let treeCollected = 0;
  let dugDirectly = 0;
  let lastPos = seedPos;
  let unreached = 0;

  for (let round = 0; round < 5; round++) {
    const queue = round === 0 ? initialCluster : scanRemainingTreeLogs();
    if (queue.length === 0) {
      unreached = 0;
      break;
    }

    const failedThisRound = [];
    let roundProgress = false;

    for (let i = 0; i < queue.length; i++) {
      if (signal?.aborted) throw new Error('Đã hủy');
      while (isPaused?.()) {
        if (signal?.aborted) throw new Error('Đã hủy');
        await sleep(200);
      }

      const blockPos = queue[i];
      const key = posKey(blockPos);
      if (skipped.has(key)) continue;

      const block = ctx.bot.blockAt(blockPos);
      if (!block || block.type === 0) continue;

      const res = await ctx._mineTreeLogBlock(block, targetText, signal, isPaused);
      if (res === 'paused') {
        while (isPaused?.()) {
          if (signal?.aborted) throw new Error('Đã hủy');
          await sleep(200);
        }
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
