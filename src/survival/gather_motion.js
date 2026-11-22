import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { raceTimeout, sleep } from './constants.js';

export async function gotoWithTimeout(ctx, goal, {
  timeoutMs = ctx._timeouts.gotoMs,
  stuckMs = ctx._timeouts.stuckMs,
  signal = null,
  isPaused = null,
} = {}) {
  if (signal?.aborted) throw new Error('Đã hủy');
  const stopPath = () => {
    try { ctx.bot.pathfinder?.setGoal?.(null); } catch {}
    try { ctx.bot.pathfinder?.stop?.(); } catch {}
  };

  let timer = null;
  let stuckTimer = null;
  let abortHandler = null;

  const gotoPromise = Promise.resolve(ctx.bot.pathfinder.goto(goal));
  gotoPromise.catch(() => {});

  try {
    const guardPromise = new Promise((_, reject) => {
      let done = false;
      const fail = (err) => {
        if (done) return;
        done = true;
        stopPath();
        reject(err);
      };

      if (signal) {
        abortHandler = () => fail(new Error('Đã hủy'));
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          fail(Object.assign(new Error('Timeout'), { name: 'Timeout' }));
        }, timeoutMs);
        timer.unref?.();
      }

      if (stuckMs > 0 && ctx.bot.entity?.position) {
        const p0 = ctx.bot.entity.position;
        let lastPos = { x: p0.x, y: p0.y, z: p0.z };
        let lastMovedAt = Date.now();
        const intervalMs = Math.min(500, Math.max(25, Math.floor(stuckMs / 4)));
        stuckTimer = setInterval(() => {
          if (signal?.aborted) {
            fail(new Error('Đã hủy'));
            return;
          }
          if (isPaused?.() || ctx.bot.targetDigBlock) {
            lastMovedAt = Date.now();
            return;
          }
          const pos = ctx.bot.entity?.position;
          if (!pos) return;
          const moved = Math.hypot(pos.x - lastPos.x, pos.y - lastPos.y, pos.z - lastPos.z);
          if (moved >= 0.35) {
            lastPos = { x: pos.x, y: pos.y, z: pos.z };
            lastMovedAt = Date.now();
          } else if (Date.now() - lastMovedAt >= stuckMs) {
            fail(Object.assign(new Error('Bot stuck while moving'), { name: 'Timeout' }));
          }
        }, intervalMs);
        stuckTimer.unref?.();
      }
    });

    return await Promise.race([gotoPromise, guardPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (stuckTimer) clearInterval(stuckTimer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

export async function digWithTimeout(ctx, block, { signal = null, digFace = null } = {}) {
  if (signal?.aborted) throw new Error('Đã hủy');
  const estMs = typeof ctx.bot.digTime === 'function' ? ctx.bot.digTime(block) : 3000;
  if (!Number.isFinite(estMs)) return false;

  const timeoutMs = Math.min(
    Math.max(estMs + ctx._timeouts.digExtraMs, ctx._timeouts.digMinMs),
    ctx._timeouts.digMaxMs
  );

  const abortHandler = () => {
    try { ctx.bot.stopDigging?.(); } catch {}
  };
  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    const digPromise = digFace ? ctx.bot.dig(block, true, digFace) : ctx.bot.dig(block);
    await raceTimeout(digPromise, timeoutMs, abortHandler);
    return true;
  } finally {
    if (signal) signal.removeEventListener('abort', abortHandler);
  }
}

export async function collectBlockWithTimeout(ctx, block, { timeoutMs = ctx._timeouts.collectMs, signal = null } = {}) {
  if (signal?.aborted) throw new Error('Đã hủy');
  const cancelCollect = () => {
    try { ctx.bot.collectBlock?.targets?.clear?.(); } catch {}
    try { ctx.bot.stopDigging?.(); } catch {}
    try { ctx.bot.pathfinder?.setGoal?.(null); } catch {}
    try { ctx.bot.pathfinder?.stop?.(); } catch {}
    try { ctx.bot.collectBlock?.cancelTask?.()?.catch?.(() => {}); } catch {}
  };
  return await raceTimeout(ctx.bot.collectBlock.collect(block), timeoutMs, cancelCollect);
}

export async function collectNearbyItemDrops(ctx, centers, signal, isPaused) {
  const anchorList = Array.isArray(centers) ? centers.filter(Boolean) : [centers].filter(Boolean);
  if (anchorList.length === 0 || !ctx.bot.entity?.position || typeof ctx.bot.pathfinder?.goto !== 'function') return;
  if (typeof ctx.bot.inventory?.emptySlotCount === 'function' && ctx.bot.inventory.emptySlotCount() <= 0) return;

  if (ctx._timeouts.dropWaitMs > 0) {
    await sleep(ctx._timeouts.dropWaitMs);
    if (signal?.aborted) throw new Error('Đã hủy');
  }

  const botPos = ctx.bot.entity.position;
  const drops = Object.entries(ctx.bot.entities ?? {})
    .map(([id, e]) => ({ id, entity: e }))
    .filter(({ entity }) => entity?.position && (entity.name === 'item' || entity.displayName === 'Item'))
    .filter(({ entity }) => anchorList.some(c =>
      Math.hypot(entity.position.x - c.x, entity.position.y - c.y, entity.position.z - c.z) <= 8
    ))
    .map(({ id, entity }) => ({
      id,
      entity,
      dist: Math.hypot(entity.position.x - botPos.x, entity.position.y - botPos.y, entity.position.z - botPos.z),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 12);

  for (const drop of drops) {
    if (signal?.aborted) throw new Error('Đã hủy');
    while (isPaused?.()) {
      if (signal?.aborted) throw new Error('Đã hủy');
      await sleep(200);
    }
    if (!ctx.bot.entities?.[drop.id]) continue;
    const p = drop.entity.position;
    try {
      await ctx._gotoWithTimeout(new goals.GoalNear(p.x, p.y, p.z, 0.8), {
        timeoutMs: ctx._timeouts.dropGotoMs,
        stuckMs: ctx._timeouts.dropStuckMs,
        signal,
        isPaused,
      });
    } catch (err) {
      if (signal?.aborted) throw new Error('Đã hủy');
      if ((err.name === 'GoalChanged' || err.name === 'PathStopped') && isPaused?.()) continue;
      if (err.name === 'NoPath' || err.name === 'Timeout') continue;
    }
  }
}
