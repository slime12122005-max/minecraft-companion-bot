import { handleBasicCommand } from './command_handlers_basic.js';
import { handleComplexCommand } from './command_handlers_complex.js';

export function createCommandDispatcher(ctx) {
  const { bot, tasks, combat, survival, crafting, mining, state } = ctx;

  async function dispatchParsedCommand(parsed, username, reply, parentSignal = null, chatCtx = null) {
    const say = (text, { kind = 'final' } = {}) => {
      if (!text) return Promise.resolve();
      if (chatCtx?.onOutcome) {
        if (kind === 'start' && chatCtx.suppressStart) return Promise.resolve();
        if (kind === 'final' || kind === 'error') {
          chatCtx.onOutcome(text);
          return Promise.resolve();
        }
      }
      reply(text);
      return Promise.resolve();
    };
    const errorReply = (msg) => { say(msg, { kind: 'error' }).catch(() => {}); };

    const args = { username, reply, parentSignal, chatCtx, say, errorReply };
    if (await handleBasicCommand(ctx, parsed, args)) return;
    if (await handleComplexCommand(ctx, parsed, args)) return;

    switch (parsed.type) {
      case 'craft': {
        let done = false;
        say(`Đang chế tạo ${parsed.count} ${parsed.target}.`, { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'che_tao', reason: 'Lệnh chế tạo', target: parsed.target }, async (signal) => {
          try {
            const res = await crafting.craftItem(parsed.target, parsed.count, signal);
            done = true;
            await say(`Đã chế tạo xong ${res.count} ${res.name}.`, { kind: 'final' });
          } finally {
            done = true;
          }
        }, { onAbort: () => { done = true; bot.pathfinder?.setGoal?.(null); }, errPrefix: 'Không chế tạo được', onError: errorReply }, parentSignal, reply);
        return;
      }

      case 'smelt': {
        let done = false;
        say(`Đang nung ${parsed.count} ${parsed.target}.`, { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'nung_do', reason: 'Lệnh nung đồ', target: parsed.target }, async (signal) => {
          try {
            const res = await crafting.smeltItem(parsed.target, parsed.count, signal);
            done = true;
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
        say(`Bắt đầu đào hầm an toàn dài ${parsed.length} block.`, { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'dao_ham', reason: 'Lệnh đào hầm', length: parsed.length }, async (signal) => {
          try {
            const res = await mining.digTunnel(parsed.length, signal);
            done = true;
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
        let done = false;
        say('Đang đi thu hoạch và gieo lại ruộng.', { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'lam_ruong', reason: 'Lệnh làm ruộng' }, async (signal) => {
          try {
            const res = await mining.farmCrops(signal);
            done = true;
            await say(`Đã thu hoạch ${res.harvested} cây, gieo lại ${res.replanted} hạt.`, { kind: 'final' });
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

      case 'gather': {
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
        say(`Đang đi lấy ${parsed.count} ${parsed.target}.`, { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'lay_tai_nguyen', reason: 'Lệnh lấy tài nguyên', target: parsed.target, count: parsed.count }, async (signal) => {
          try {
            const got = await survival.gather(parsed.target, parsed.count, signal, {
              isPaused: ctx.isWorkPaused ?? (() => combat.busy || tasks.paused || survival.busy),
            });
            done = true;
            await say(got > 0 ? `Đã lấy xong ${got} ${parsed.target}.` : `Không tìm thấy ${parsed.target} gần đây.`, { kind: 'final' });
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
          errPrefix: `Lỗi khi lấy ${parsed.target}`,
          onError: errorReply,
        }, parentSignal, reply);
        return;
      }

      case 'give':
        try {
          const given = await survival.giveToOwner(username, parsed.target, parsed.count, parentSignal, {
            isPaused: ctx.isWorkPaused ?? (() => combat.busy || tasks.paused || survival.busy),
          });
          await say(`Đã đưa bạn ${given.count} ${given.name}.`, { kind: 'final' });
        } catch (err) {
          if (parentSignal?.aborted) throw err;
          await say(err.message, { kind: 'error' });
        } finally {
          if (!combat.busy && !tasks.paused) tasks.active?.onResume?.();
        }
        return;

      case 'cancel':
        if (state.pendingAction) {
          state.pendingAction = null;
          await say('Đã hủy yêu cầu đang chờ xác nhận.', { kind: 'final' });
        } else if (state.pendingBuild) {
          state.pendingBuild = null;
          await say('Đã hủy yêu cầu xây.', { kind: 'final' });
        } else {
          ctx.stopCurrentTask('Hủy bởi chủ');
          await say('Đã hủy tác vụ hiện tại.', { kind: 'final' });
        }
        return;

      default:
        await say('Tôi chưa hiểu lệnh này. Gõ "giúp" để xem các lệnh.', { kind: 'final' });
    }
  }

  return { dispatchParsedCommand };
}
