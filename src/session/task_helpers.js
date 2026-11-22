import pf from 'mineflayer-pathfinder';
const { Movements, goals } = pf;
import { Vec3 } from 'vec3';
import { resolveCandidateNames } from '../survival/index.js';
import { foodSupply, requiredPickTier, PICK_ITEM_BY_TIER, PREP_HINT_BY_TIER } from '../readiness.js';
import { TASK_TIERS } from '../tasks.js';

const CHEST_BLOCK_NAMES = new Set(['chest', 'trapped_chest', 'barrel']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function formatError(err) {
  if (!err) return 'Lỗi không xác định';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.map(e => e?.message || e?.code || String(e)).filter(Boolean).join('; ') || err.code || 'AggregateError';
  }
  return err.code || String(err);
}

export function configureMovements(bot) {
  const defaultMove = new Movements(bot);
  defaultMove.maxDropDown = 3;
  defaultMove.liquidCost = 4;
  for (const blockName of ['magma_block', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'cactus', 'wither_rose']) {
    const id = bot.registry?.blocksByName?.[blockName]?.id;
    if (id != null) defaultMove.blocksToAvoid.add(id);
  }
  bot.pathfinder.setMovements(defaultMove);
}

export function createTaskHelpers(ctx) {
  const { bot, config, tasks, combat, survival, home, builder, memory, warnFor, state } = ctx;

  function stopCurrentTask(reason, { clearQueue = false } = {}) {
    tasks.abort(reason, { clearQueue });
    if (bot.pathfinder) bot.pathfinder.setGoal(null);
  }

  async function checkWorkReadiness(parsed, { ignoreFood = false, signal = null } = {}) {
    let reqTier = 'none';
    let actionLabel = '';
    if (parsed.type === 'tunnel') {
      reqTier = 'wood';
      actionLabel = 'đào hầm';
    } else if (parsed.type === 'gather') {
      reqTier = requiredPickTier(resolveCandidateNames(parsed.target));
      actionLabel = `đào ${parsed.target}`;
    } else {
      return { ok: true };
    }
    if (reqTier === 'none') return { ok: true };

    const hasPick = await survival.ensurePickaxe(reqTier, signal);
    if (!hasPick) {
      const reqPick = PICK_ITEM_BY_TIER[reqTier] ?? reqTier;
      const hint = PREP_HINT_BY_TIER[reqTier];
      return {
        ok: false,
        hard: true,
        reason: 'pickaxe',
        message: `Chưa có công cụ đủ cấp để ${actionLabel} (cần ${reqPick}).${hint ? ` Gợi ý: ${hint}.` : ''}`,
      };
    }

    if (!ignoreFood && config.survival?.requireFood !== false && typeof bot.inventory?.items === 'function') {
      const minFoodPoints = config.survival?.minFoodPoints ?? 20;
      const pts = foodSupply(bot.inventory.items() ?? []);
      if (pts < minFoodPoints) {
        return {
          ok: false,
          hard: false,
          reason: 'food',
          message: `Túi mình chỉ còn ${pts}/${minFoodPoints} điểm đồ ăn, chưa an toàn để ${actionLabel}. Gõ "xác nhận" để vẫn đi, hoặc chuẩn bị đồ ăn trước (lấy từ rương / nung thịt / đưa mình bánh mì).`,
        };
      }
    }

    return { ok: true };
  }

  async function runStepTask(
    taskMeta,
    fn,
    { onAbort = () => bot.pathfinder?.setGoal?.(null), errPrefix = '', onError = null } = {},
    parentSignal = null,
    reply = () => {}
  ) {
    if (parentSignal) {
      if (parentSignal.aborted) throw new Error('Đã hủy');
      const abortHandler = () => {
        try { onAbort(); } catch {}
      };
      parentSignal.addEventListener('abort', abortHandler, { once: true });
      try {
        return await fn(parentSignal);
      } finally {
        parentSignal.removeEventListener('abort', abortHandler);
      }
    }
    stopCurrentTask(taskMeta.reason ?? taskMeta.name);
    const run = tasks.run(taskMeta, fn, { onAbort, priority: taskMeta.priority ?? TASK_TIERS.PLAYER });
    run?.promise?.catch(err => {
      if (!run.signal.aborted && errPrefix) {
        const errMsg = `${errPrefix}: ${err.message}`;
        if (onError) onError(errMsg);
        else reply(errMsg);
      }
    });
    return run;
  }

  async function gotoSafe(goal, signal, { maxCombatRetries = null, resumeCooldownMs = 0 } = {}) {
    let combatRetries = 0;
    while (!signal?.aborted) {
      let waitedForCombat = false;
      while ((combat.busy || tasks.paused || survival.busy) && !signal?.aborted) {
        if (combat.busy || tasks.paused) waitedForCombat = true;
        await sleep(200);
      }
      if (signal?.aborted) throw new Error('Đã hủy');
      if (resumeCooldownMs > 0 && combat.lastRetreatAt > 0) {
        while (!signal?.aborted && Date.now() - combat.lastRetreatAt < resumeCooldownMs) {
          await sleep(200);
          if (combat.busy || tasks.paused || survival.busy) {
            if (combat.busy || tasks.paused) waitedForCombat = true;
            break;
          }
        }
        if (signal?.aborted) throw new Error('Đã hủy');
        if (combat.busy || tasks.paused || survival.busy) continue;
      }
      if (waitedForCombat) {
        combatRetries++;
        if (maxCombatRetries != null && combatRetries >= maxCombatRetries) {
          throw Object.assign(new Error('quanh đó vẫn còn quái nguy hiểm'), { name: 'CombatBlocked' });
        }
      }
      try {
        await bot.pathfinder.goto(goal);
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        const interruptedByCombat = combat.busy || tasks.paused || (Date.now() - state.lastCombatEndedAt < 500);
        const interruptedByPause = interruptedByCombat || survival.busy;
        if ((err.name === 'GoalChanged' || err.name === 'PathStopped') && interruptedByPause) {
          if (interruptedByCombat && !combat.busy && !tasks.paused) {
            combatRetries++;
            if (maxCombatRetries != null && combatRetries >= maxCombatRetries) {
              throw Object.assign(new Error('quanh đó vẫn còn quái nguy hiểm'), { name: 'CombatBlocked' });
            }
          }
          continue;
        }
        throw err;
      }
    }
  }

  async function restockBuildMaterials(spec, signal, reply) {
    const info = await builder.inspect(spec.file);
    const pos = bot.entity?.position;
    if (!info?.materials || !pos) return 0;
    const originPos = { x: pos.x, y: pos.y, z: pos.z };

    const invCounts = new Map();
    for (const item of bot.inventory?.items?.() ?? []) {
      if (item?.name) invCounts.set(item.name, (invCounts.get(item.name) ?? 0) + (item.count ?? 1));
    }

    let totalRestocked = 0;
    for (const [mat, needed] of Object.entries(info.materials)) {
      if (signal?.aborted) throw new Error('Đã hủy');
      const have = invCounts.get(mat) ?? 0;
      let missing = needed - have;
      if (missing <= 0) continue;

      const hits = home.findInChests(mat).filter(h =>
        h.name === mat &&
        h.x != null && h.y != null && h.z != null &&
        Math.hypot(h.x - originPos.x, h.y - originPos.y, h.z - originPos.z) <= 16
      );

      for (const hit of hits) {
        if (missing <= 0) break;
        if (signal?.aborted) throw new Error('Đã hủy');
        await gotoSafe(new goals.GoalGetToBlock(hit.x, hit.y, hit.z), signal);
        const block = bot.blockAt?.(new Vec3(hit.x, hit.y, hit.z));
        if (!block || !CHEST_BLOCK_NAMES.has(block.name)) continue;
        try {
          const res = await home.takeFromChest(block, mat, missing);
          const taken = res?.count ?? 0;
          if (taken > 0) {
            missing -= taken;
            invCounts.set(mat, (invCounts.get(mat) ?? 0) + taken);
            totalRestocked += taken;
          }
        } catch (err) {
          if (signal?.aborted) throw err;
          warnFor('building', `Không lấy được ${mat} từ rương: ${err.message}`);
        }
      }
    }

    if (totalRestocked > 0) {
      await memory.flush();
      reply(`Đã tự lấy thêm ${totalRestocked} vật liệu từ rương gần đây.`);
    }
    return totalRestocked;
  }

  function startGoHomeTask(replyFn, { background = false } = {}) {
    const target = home.get();
    if (!target) return false;
    stopCurrentTask('Lệnh về nhà');
    const run = tasks.run({ name: 've_nha' }, async (signal) => {
      await gotoSafe(new goals.GoalNear(target.x, target.y, target.z, 2), signal);
      replyFn('Đã về tới nhà.');
    }, {
      onAbort: () => bot.pathfinder?.setGoal(null),
      priority: background ? TASK_TIERS.BACKGROUND : TASK_TIERS.PLAYER,
    });
    run?.promise?.catch(err => {
      if (!run.signal.aborted) replyFn(`Không về nhà được: ${err.message}`);
    });
    return true;
  }

  function startDeathRecoveryTask(death, replyFn) {
    if (!death) return false;
    stopCurrentTask('Đi nhặt lại đồ sau khi chết');
    replyFn(`Tôi đang chạy tới chỗ chết (${death.x}, ${death.y}, ${death.z}) để nhặt lại đồ.`);
    const run = tasks.run({ name: 'nhat_do_chet', ...death }, async (signal) => {
      await gotoSafe(new goals.GoalNear(death.x, death.y, death.z, 1.5), signal, {
        maxCombatRetries: 3,
        resumeCooldownMs: 2500,
      });
      await sleep(1500);
      if (signal.aborted) return;
      survival.clearDeath();
      await memory.flush();
      replyFn('Đã tới vị trí chết để nhặt lại đồ.');
    }, { onAbort: () => bot.pathfinder?.setGoal(null) });
    run?.promise?.catch(err => {
      if (run.signal.aborted) return;
      if (err.name === 'CombatBlocked') {
        replyFn(`Quanh chỗ chết (${death.x}, ${death.y}, ${death.z}) vẫn còn quái nguy hiểm nên mình tạm dừng nhặt đồ; khi nào an toàn bạn gọi "nhặt đồ chết" nhé.`);
        return;
      }
      replyFn(`Chưa nhặt lại được đồ: ${err.message}`);
    });
    return true;
  }

  return {
    stopCurrentTask,
    checkWorkReadiness,
    runStepTask,
    gotoSafe,
    restockBuildMaterials,
    startGoHomeTask,
    startDeathRecoveryTask,
  };
}
