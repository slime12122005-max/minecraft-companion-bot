import { handleBasicCommand } from './command_handlers_basic.js';
import { handleComplexCommand } from './command_handlers_complex.js';
import { cleanTargetPhrase, normalizeText } from '../commands.js';
import { resolveCandidateNames } from '../survival/index.js';

const RESOURCE_DISPLAY_LABELS = {
  go: 'gỗ',
  cay: 'gỗ',
  cui: 'gỗ',
  wood: 'gỗ',
  log: 'gỗ',
  'go soi': 'gỗ sồi',
  'cay soi': 'gỗ sồi',
  soi: 'gỗ sồi',
  'bach duong': 'gỗ bạch dương',
  'go bach duong': 'gỗ bạch dương',
  'cay bach duong': 'gỗ bạch dương',
  'go thong': 'gỗ thông',
  'cay thong': 'gỗ thông',
  thong: 'gỗ thông',
  'go anh dao': 'gỗ anh đào',
  'cay anh dao': 'gỗ anh đào',
  'anh dao': 'gỗ anh đào',
  da: 'đá',
  'da cuoi': 'đá cuội',
  cuoi: 'đá cuội',
  than: 'than',
  sat: 'sắt',
  vang: 'vàng',
  'kim cuong': 'kim cương',
  dong: 'đồng',
  cat: 'cát',
  dat: 'đất',
  'banh mi': 'bánh mì',
  tao: 'táo',
  thit: 'thịt',
  duoc: 'đuốc',
  'kien rom': 'kiện rơm',
  'ngoc ender': 'ngọc Ender',
};

function formatResourceLabel(target) {
  const key = cleanTargetPhrase(normalizeText(target));
  return RESOURCE_DISPLAY_LABELS[key] ?? target;
}

export function createCommandDispatcher(ctx) {
  const { bot, tasks, combat, survival, crafting, mining, state } = ctx;

  function isAntigravityOnline() {
    const lastPollAt = Math.max(state.lastSidecarPollAt ?? 0, state.lastMcpPollAt ?? 0);
    return lastPollAt > 0 && (Date.now() - lastPollAt) < 15000;
  }

  async function dispatchParsedCommand(parsed, username, reply, parentSignal = null, chatCtx = null) {
    let escalatedFailure = false;

    const maybeEscalateFailure = (errorText) => {
      if (escalatedFailure || chatCtx?.fromApi || parentSignal?.aborted) return false;
      const skipTypes = new Set(['confirm', 'cancel', 'dashboard_on', 'dashboard_off', 'scratchpad_status', 'scratchpad_clear']);
      if (skipTypes.has(parsed?.type)) return false;
      escalatedFailure = true;
      const userReq = String(chatCtx?.userMessage ?? '').trim();
      ctx.pushInbox?.({
        kind: 'alert',
        alertType: 'task_failed',
        role: 'SYSTEM',
        severity: 'high',
        username,
        userMessage: userReq || null,
        commandType: parsed?.type ?? 'unknown',
        target: parsed?.target ?? null,
        count: parsed?.count ?? null,
        error: String(errorText ?? ''),
        message: `Lệnh "${userReq || parsed?.type}" của ${username} chưa làm ngay được (${errorText}). Hãy tự suy luận và giải quyết bằng mc_plan_execute / mc_command / mc_run_macro / mc_smelt (lấy đồ từ rương, đào nguyên liệu còn thiếu, nung quặng, chế tạo công cụ trung gian) rồi trả lời tự nhiên bằng mc_say.`,
      });
      return isAntigravityOnline();
    };

    const say = (text, { kind = 'final' } = {}) => {
      if (!text) return Promise.resolve();
      if (kind === 'start' && chatCtx?.suppressStart) return Promise.resolve();
      if (kind === 'error') {
        const delegatedToAnti = maybeEscalateFailure(text);
        if (delegatedToAnti && !chatCtx?.onOutcome) {
          return Promise.resolve();
        }
      }
      if (chatCtx?.onOutcome) {
        if (kind === 'final' || kind === 'error') {
          chatCtx.onOutcome(text);
          return Promise.resolve();
        }
      }
      reply(text);
      return Promise.resolve();
    };
    const errorReply = (msg) => { say(msg, { kind: 'error' }).catch(() => {}); };

    const isNeedsCountChain =
      parsed.type === 'chain' &&
      Array.isArray(parsed.steps) &&
      parsed.steps.some(s => s?.needsCount);
    if (!parentSignal && (parsed.needsCount || isNeedsCountChain)) {
      if (tasks.active?.task?.autoFarm) {
        ctx.stopCurrentTask?.('Chờ chủ xác nhận số lượng');
      }
      const targetStep = parsed.type === 'chain'
        ? parsed.steps.find(s => s?.needsCount)
        : parsed;
      const label = formatResourceLabel(targetStep?.target ?? 'đồ');
      const pronouns = ctx.companion?._resolvePronouns?.(chatCtx?.userMessage ?? '') ?? { self: 'mình', you: 'bạn' };
      const You = pronouns.you ? pronouns.you[0].toUpperCase() + pronouns.you.slice(1) : 'Bạn';
      const verbPromptMap = {
        gather: 'cần lấy',
        give: 'muốn mình đưa',
        craft: 'muốn chế tạo',
        smelt: 'muốn nung',
        take_from_chest: 'muốn lấy từ rương',
      };
      const verb = verbPromptMap[targetStep?.type] ?? 'cần lấy';
      state.pendingQuantity = { parsed, username, chatCtx, expiresAt: Date.now() + 120000 };
      state.pendingAction = null;
      await say(`${You} ${verb} bao nhiêu ${label} nè? (nhắn số lượng, ví dụ: 10 hoặc "hủy")`, { kind: 'prompt' });
      return;
    }

    const args = { username, reply, parentSignal, chatCtx, say, errorReply };
    if (await handleBasicCommand(ctx, parsed, args)) return;
    if (await handleComplexCommand(ctx, parsed, args)) return;

    switch (parsed.type) {
      case 'craft': {
        let done = false;
        if (!parentSignal) {
          ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
        }
        say(`Đang chế tạo ${parsed.count} ${parsed.target}.`, { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'che_tao', reason: 'Lệnh chế tạo', target: parsed.target }, async (signal) => {
          try {
            const res = await crafting.craftItem(parsed.target, parsed.count, signal);
            done = true;
            state.lastIntentionalItemGainAt = Date.now();
            if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
            await say(`Đã chế tạo xong ${res.count} ${res.name}.`, { kind: 'final' });
          } finally {
            done = true;
          }
        }, { onAbort: () => { done = true; bot.pathfinder?.setGoal?.(null); }, errPrefix: 'Không chế tạo được', onError: errorReply }, parentSignal, reply);
        return;
      }

      case 'smelt': {
        let done = false;
        if (!parentSignal) {
          ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
        }
        say(`Đang nung ${parsed.count} ${parsed.target}.`, { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'nung_do', reason: 'Lệnh nung đồ', target: parsed.target }, async (signal) => {
          try {
            const res = await crafting.smeltItem(parsed.target, parsed.count, signal);
            done = true;
            if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
            await say(
              res.requested && res.count < res.requested
                ? `Mới nung được ${res.count}/${res.requested} ${res.name}, lò chưa kịp xong hết.`
                : `Đã nung xong ${res.count} ${res.name}.`,
              { kind: 'final' }
            );
          } finally {
            done = true;
          }
        }, { onAbort: () => { done = true; bot.pathfinder?.setGoal?.(null); }, errPrefix: 'Không nung được', onError: errorReply }, parentSignal, reply);
        return;
      }

      case 'tunnel': {
        state.stayPut = false;
        ctx.companion?.stopIdleMotion?.();
        const ready = await ctx.checkWorkReadiness(parsed, { ignoreFood: Boolean(chatCtx?.ignoreFood), signal: parentSignal });
        if (!ready.ok) {
          if (parentSignal) {
            throw Object.assign(new Error(ready.message), { name: 'ReadinessBlocked', hard: ready.hard, reason: ready.reason });
          }
          if (!ready.hard) {
            state.pendingBuild = null;
            state.pendingAction = {
              parsed,
              username,
              chatCtx: { ...(chatCtx ?? {}), ignoreFood: true },
              expiresAt: Date.now() + 120000,
            };
          }
          await say(ready.message, { kind: ready.hard ? 'error' : 'prompt' });
          return;
        }
        let done = false;
        if (!parentSignal) {
          ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
        }
        say(`Bắt đầu đào hầm an toàn dài ${parsed.length} block.`, { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'dao_ham', reason: 'Lệnh đào hầm', length: parsed.length }, async (signal) => {
          try {
            const res = await mining.digTunnel(parsed.length, signal);
            done = true;
            if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
            await say(res.stoppedReason
              ? `Dừng đào hầm sau ${res.steps} block vì ${res.stoppedReason}.`
              : `Đã đào hầm xong ${res.steps} block.`, { kind: 'final' });
          } finally {
            done = true;
          }
        }, {
          onAbort: () => {
            done = true;
            bot.stopDigging?.();
            bot.pathfinder?.setGoal(null);
          },
          errPrefix: 'Dừng đào hầm',
          onError: errorReply,
        }, parentSignal, reply);
        return;
      }

      case 'farm': {
        state.stayPut = false;
        ctx.companion?.stopIdleMotion?.();
        let done = false;
        if (!parentSignal) {
          ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
        }
        say('Đang đi thu hoạch và gieo lại ruộng.', { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'lam_ruong', reason: 'Lệnh làm ruộng' }, async (signal) => {
          try {
            const res = await mining.farmCrops(signal, { forageSeeds: true });
            done = true;
            if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
            if ((res.foragedSeeds ?? 0) > 0) {
              await say(`Đã thu hoạch ${res.harvested} cây, đập cỏ kiếm thêm ${res.foragedSeeds} hạt và gieo lại ${res.replanted} hạt.`, { kind: 'final' });
            } else {
              await say(`Đã thu hoạch ${res.harvested} cây, gieo lại ${res.replanted} hạt.`, { kind: 'final' });
            }
          } finally {
            done = true;
          }
        }, {
          onAbort: () => {
            done = true;
            bot.stopDigging?.();
            bot.pathfinder?.setGoal(null);
          },
          errPrefix: 'Lỗi làm ruộng',
          onError: errorReply,
        }, parentSignal, reply);
        return;
      }

      case 'farm_enderman': {
        state.stayPut = false;
        ctx.companion?.stopIdleMotion?.();
        let done = false;
        if (!parentSignal) {
          ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
        }
        say('Đang tìm gốc cây thấp núp hoặc đặt mái 3x3 trên đầu rồi nhìn mắt dụ Enderman tới farm.', { kind: 'start', isStale: () => done });
        await ctx.runStepTask({
          name: 'farm_enderman',
          reason: 'Dựng mái che farm Enderman',
          count: parsed.count ?? 8,
        }, async (signal) => {
          try {
            const res = await mining.farmEndermen(parsed.count ?? 8, { countMode: parsed.countMode ?? 'kills' }, signal);
            done = true;
            if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
            if (res.kills === 0 && res.pearlsGained === 0) {
              const spotDesc = res.shelterKind === 'tree' ? 'gốc cây' : 'mái che 3x3';
              await say(`Đã đứng sẵn dưới ${spotDesc} tại (${res.shelter.x}, ${res.shelter.y}, ${res.shelter.z}) nhưng chưa thấy Enderman nào quanh đây để dụ.`, { kind: 'final' });
            } else {
              await say(`Đã farm xong ${res.kills} Enderman dưới mái che (nhặt được ${res.pearlsGained} ngọc Ender).`, { kind: 'final' });
            }
          } finally {
            done = true;
          }
        }, {
          onAbort: () => {
            done = true;
            mining.setShelterHold?.(null);
            bot.stopDigging?.();
            bot.pathfinder?.setGoal(null);
          },
          errPrefix: 'Không farm Enderman được',
          onError: errorReply,
        }, parentSignal, reply);
        return;
      }

      case 'gather': {
        state.stayPut = false;
        ctx.companion?.stopIdleMotion?.();
        const ready = await ctx.checkWorkReadiness(parsed, { ignoreFood: Boolean(chatCtx?.ignoreFood), signal: parentSignal });
        if (!ready.ok) {
          if (parentSignal) {
            throw Object.assign(new Error(ready.message), { name: 'ReadinessBlocked', hard: ready.hard, reason: ready.reason });
          }
          if (!ready.hard) {
            state.pendingBuild = null;
            state.pendingAction = {
              parsed,
              username,
              chatCtx: { ...(chatCtx ?? {}), ignoreFood: true },
              expiresAt: Date.now() + 120000,
            };
          }
          await say(ready.message, { kind: ready.hard ? 'error' : 'prompt' });
          return;
        }
        let done = false;
        const label = formatResourceLabel(parsed.target);
        if (!parentSignal) {
          ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
        }
        say(`Đang đi lấy ${parsed.count} ${label}.`, { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'lay_tai_nguyen', reason: 'Lệnh lấy tài nguyên', target: parsed.target, count: parsed.count }, async (signal) => {
          try {
            const isPaused = ctx.isWorkPaused ?? (() => combat.busy || tasks.paused || survival.busy);
            const invBefore = survival.countMatchingItems?.(parsed.target) ?? 0;
            const got = await survival.gather(parsed.target, parsed.count, signal, { isPaused });
            done = true;
            if (parsed.autoDeliver && got > 0 && !signal.aborted) {
              const invAfter = survival.countMatchingItems?.(parsed.target) ?? 0;
              const gained = Math.max(0, invAfter - invBefore);
              const deliverAmount = Math.max(Number(parsed.count) || 1, gained, got);
              try {
                const given = await survival.giveToOwner(username, parsed.target, deliverAmount, signal, { isPaused });
                if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
                await say(`Đã lấy và đưa bạn ${given.count} ${given.name}.`, { kind: 'final' });
                return;
              } catch (deliverErr) {
                if (signal.aborted) throw deliverErr;
              }
            }
            if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
            await say(
              got > 0 ? `Đã lấy xong ${got} ${label}.` : `Không tìm thấy ${label} gần đây.`,
              { kind: got > 0 ? 'final' : 'error' }
            );
          } finally {
            done = true;
          }
        }, {
          onAbort: () => {
            done = true;
            bot.collectBlock?.cancelTask?.().catch?.(() => {});
            bot.stopDigging?.();
            bot.pathfinder?.setGoal?.(null);
          },
          errPrefix: `Lỗi khi lấy ${label}`,
          onError: errorReply,
        }, parentSignal, reply);
        return;
      }

      case 'give': {
        const requiredMin = Number(parsed.minDeliverCount ?? (typeof parsed.count === 'number' ? parsed.count : 0)) || 0;
        const haveNow = requiredMin > 0 ? (survival.countMatchingItems?.(parsed.target) ?? 0) : 0;
        const label = formatResourceLabel(parsed.target);
        if (requiredMin > 0 && haveNow < requiredMin && typeof bot.findBlocks === 'function' && bot.collectBlock?.collect) {
          const candidates = resolveCandidateNames(parsed.target);
          const blocksByName = bot.registry?.blocksByName ?? {};
          const ids = candidates.map(n => blocksByName[n]?.id).filter(Boolean);
          const hasNearby = ids.length > 0 && (bot.findBlocks({ matching: ids, maxDistance: 48, count: 1 })?.length ?? 0) > 0;
          if (hasNearby) {
            let done = false;
            say(`Trong túi mới có ${haveNow} ${label}, để mình đi lấy thêm cho đủ ít nhất ${requiredMin} ${label} rồi đưa bạn nha!`, { kind: 'start', isStale: () => done });
            await ctx.runStepTask({ name: 'kiem_va_dua', reason: 'Kiếm đủ số lượng rồi đưa chủ', target: parsed.target, count: requiredMin }, async (signal) => {
              try {
                const isPaused = ctx.isWorkPaused ?? (() => combat.busy || tasks.paused || survival.busy);
                await survival.gather(parsed.target, requiredMin - haveNow, signal, { isPaused });
                done = true;
                const totalAfter = survival.countMatchingItems?.(parsed.target) ?? 0;
                const giveAmount = parsed.count === 'all' ? 'all' : Math.max(requiredMin, totalAfter);
                const given = await survival.giveToOwner(username, parsed.target, giveAmount, signal, { isPaused });
                await say(`Đã đưa bạn ${given.count} ${given.name}.`, { kind: 'final' });
              } finally {
                done = true;
                if (!parentSignal && !combat.busy && !tasks.paused) tasks.active?.onResume?.();
              }
            }, {
              onAbort: () => {
                done = true;
                bot.collectBlock?.cancelTask?.().catch?.(() => {});
                bot.stopDigging?.();
                bot.pathfinder?.setGoal?.(null);
              },
              errPrefix: `Lỗi khi kiếm thêm ${label}`,
              onError: errorReply,
            }, parentSignal, reply);
            return;
          }
        }
        try {
          const isPaused = ctx.isWorkPaused ?? (() => combat.busy || tasks.paused || survival.busy);
          const totalHave = survival.countMatchingItems?.(parsed.target) ?? 0;
          const giveAmount = parsed.count === 'all'
            ? 'all'
            : (parsed.minDeliverCount ? Math.max(parsed.minDeliverCount, totalHave) : parsed.count);
          const given = await survival.giveToOwner(username, parsed.target, giveAmount, parentSignal, { isPaused });
          await say(`Đã đưa bạn ${given.count} ${given.name}.`, { kind: 'final' });
        } catch (err) {
          if (parentSignal?.aborted) throw err;
          await say(err.message, { kind: 'error' });
        } finally {
          if (!parentSignal && !combat.busy && !tasks.paused) tasks.active?.onResume?.();
        }
        return;
      }

      case 'cancel':
        if (state.pendingQuantity) {
          state.pendingQuantity = null;
          await say('Đã hủy yêu cầu chọn số lượng.', { kind: 'final' });
        } else if (state.pendingAction) {
          state.pendingAction = null;
          await say('Đã hủy yêu cầu đang chờ xác nhận.', { kind: 'final' });
        } else if (state.pendingBuild) {
          state.pendingBuild = null;
          await say('Đã hủy yêu cầu xây.', { kind: 'final' });
        } else {
          ctx.stopCurrentTask('Hủy bởi chủ');
          ctx.scratchpad?.clearAll?.();
          await say('Đã hủy tác vụ hiện tại.', { kind: 'final' });
        }
        return;

      default:
        await say('Tôi chưa hiểu lệnh này. Gõ "giúp" để xem các lệnh.', { kind: 'final' });
    }
  }

  return { dispatchParsedCommand };
}
