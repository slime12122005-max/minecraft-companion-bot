import path from 'node:path';
import { downloadSchematic } from '../building/index.js';
import { formatError } from './task_helpers.js';

export async function handleComplexCommand(ctx, parsed, { username, reply, parentSignal, chatCtx, say, errorReply }) {
  const { bot, builder, state } = ctx;

  switch (parsed.type) {
    case 'download_schematic':
      try {
        const urlPath = new URL(parsed.url).pathname;
        const rawName = parsed.filename || path.basename(urlPath) || 'downloaded.schem';
        const safeName = path.basename(rawName);
        if (!safeName || safeName === '.' || safeName === '..' || !/\.(?:schem|schematic)$/i.test(safeName)) {
          throw new Error('Tên file đích phải có đuôi .schem hoặc .schematic');
        }
        const schemDir = path.resolve('schematics');
        const dest = path.resolve(schemDir, safeName);
        if (!dest.startsWith(schemDir + path.sep)) {
          throw new Error('Đường dẫn lưu schematic không hợp lệ');
        }
        const res = await downloadSchematic(parsed.url, dest);
        await say(`Đã tải ${safeName} (${res.bytes} bytes). Gõ "xây schematics/${safeName}" để xem trước.`, { kind: 'prompt' });
      } catch (err) {
        await say(`Không tải được schematic: ${formatError(err)}`, { kind: 'error' });
      }
      return true;

    case 'prepare': {
      try {
        const info = await builder.inspect(parsed.file);
        if (!bot.entity?.position) { await say('Bot chưa vào thế giới.', { kind: 'error' }); return true; }
        const origin = {
          x: Math.round(bot.entity.position.x) + 2,
          y: Math.round(bot.entity.position.y),
          z: Math.round(bot.entity.position.z) + 2,
        };
        state.pendingAction = null;
        state.pendingBuild = { mode: 'prepare', file: parsed.file, rotation: parsed.rotation, ...origin, confirmed: true };
        await say(`Chuẩn bị dọn mặt bằng cho ${parsed.file} (${info.blockCount} block) tại ${origin.x},${origin.y},${origin.z}. Gõ "xác nhận" để bắt đầu hoặc "hủy".`, { kind: 'prompt' });
      } catch (err) {
        await say(`Không đọc được schematic: ${err.message}`, { kind: 'error' });
      }
      return true;
    }

    case 'build': {
      try {
        const info = await builder.inspect(parsed.file);
        if (!bot.entity?.position) { await say('Bot chưa vào thế giới.', { kind: 'error' }); return true; }
        const origin = {
          x: Math.round(bot.entity.position.x) + 2,
          y: Math.round(bot.entity.position.y),
          z: Math.round(bot.entity.position.z) + 2,
        };
        state.pendingAction = null;
        state.pendingBuild = { mode: 'build', file: parsed.file, rotation: parsed.rotation, ...origin };
        const topMats = Object.entries(info.materials).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(', ');
        await say(`Mẫu ${parsed.file} (${info.blockCount} block, cần ${topMats}) tại ${origin.x},${origin.y},${origin.z}. Gõ "xác nhận" để xây hoặc "hủy".`, { kind: 'prompt' });
      } catch (err) {
        await say(`Không đọc được schematic: ${err.message}`, { kind: 'error' });
      }
      return true;
    }

    case 'confirm': {
      if (state.pendingAction) {
        const action = state.pendingAction;
        state.pendingAction = null;
        if (Date.now() > action.expiresAt) {
          await say('Yêu cầu chờ xác nhận đã hết hạn.', { kind: 'error' });
          return true;
        }
        await ctx.dispatchParsedCommand(action.parsed, action.username ?? username, reply, parentSignal, {
          ...(action.chatCtx ?? {}),
          ignoreFood: true,
        });
        return true;
      }
      if (!state.pendingBuild) { await say('Không có yêu cầu nào đang chờ xác nhận.', { kind: 'error' }); return true; }
      const spec = state.pendingBuild;
      state.pendingBuild = null;
      if (spec.mode === 'prepare') {
        let done = false;
        say(`Bắt đầu dọn mặt bằng cho ${spec.file} tại ${spec.x}, ${spec.y}, ${spec.z}.`, { kind: 'start', isStale: () => done });
        await ctx.runStepTask({ name: 'don_mat_bang', reason: 'Xác nhận dọn mặt bằng', file: spec.file }, async (signal) => {
          try {
            const res = await builder.prepare(spec, signal);
            done = true;
            await say(`Đã dọn mặt bằng xong (${res.bounds} ô: dọn ${res.cleared}, lấp ${res.filled}, giữ ${res.protected}).`, { kind: 'final' });
          } finally {
            done = true;
          }
        }, { onAbort: () => { done = true; bot.pathfinder?.setGoal?.(null); }, errPrefix: 'Dừng dọn mặt bằng', onError: errorReply }, parentSignal, reply);
        return true;
      }
      let done = false;
      say(`Bắt đầu xây ${spec.file} tại ${spec.x}, ${spec.y}, ${spec.z}.`, { kind: 'start', isStale: () => done });
      await ctx.runStepTask({ name: 'xay_dung', reason: 'Xác nhận xây dựng', file: spec.file }, async (signal) => {
        try {
          await ctx.restockBuildMaterials(spec, signal, reply);
          const res = await builder.build(spec, signal);
          done = true;
          await say(`Đã xây xong ${res.placed}/${res.total} block.`, { kind: 'final' });
        } finally {
          done = true;
        }
      }, { onAbort: () => { done = true; bot.pathfinder?.setGoal?.(null); }, errPrefix: 'Dừng xây', onError: errorReply }, parentSignal, reply);
      return true;
    }

    case 'chain': {
      const steps = parsed.steps ?? [];
      if (steps.length === 0) return true;
      const outcomes = [];
      if (!chatCtx?.onOutcome) {
        reply(`Bắt đầu chuỗi ${steps.length} bước.`);
      }

      await ctx.runStepTask({ name: 'chuoi_nhiem_vu', reason: 'Lệnh chuỗi nhiều bước', steps: steps.length }, async (signal) => {
        const stepCtx = chatCtx?.onOutcome
          ? {
              ...(chatCtx ?? {}),
              suppressStart: true,
              ignoreFood: Boolean(chatCtx?.ignoreFood),
              onOutcome: (t) => {
                outcomes.push(t);
                chatCtx.onOutcome(t);
              },
            }
          : {
              ...(chatCtx ?? {}),
              ignoreFood: Boolean(chatCtx?.ignoreFood),
            };

        for (let i = 0; i < steps.length; i++) {
          if (signal.aborted) break;
          const step = steps[i];
          if (!step || step.type === 'unknown' || step.type === 'chain') continue;
          try {
            await ctx.dispatchParsedCommand(step, username, reply, signal, stepCtx);
          } catch (err) {
            if (err?.name === 'ReadinessBlocked') {
              if (!err.hard) {
                const remainingSteps = steps.slice(i);
                state.pendingBuild = null;
                state.pendingAction = {
                  parsed: remainingSteps.length === 1 ? remainingSteps[0] : { type: 'chain', steps: remainingSteps },
                  username,
                  chatCtx: { userMessage: chatCtx?.userMessage ?? '', ignoreFood: true },
                  expiresAt: Date.now() + 120000,
                };
              }
              await say(err.message, { kind: err.hard ? 'error' : 'prompt' });
              return;
            }
            throw err;
          }
        }
        if (!signal.aborted && !chatCtx?.onOutcome) {
          reply('Đã hoàn thành chuỗi nhiệm vụ.');
        }
      }, {
        onAbort: () => {
          bot.collectBlock?.cancelTask?.().catch?.(() => {});
          bot.stopDigging?.();
          bot.pathfinder?.setGoal?.(null);
        },
        errPrefix: 'Dừng chuỗi nhiệm vụ',
        onError: errorReply,
      }, parentSignal, reply);
      return true;
    }

    default:
      return false;
  }
}
