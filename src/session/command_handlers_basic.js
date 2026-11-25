import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { Vec3 } from 'vec3';
import { findSafeSleepBed, isSafeSleepDimension } from '../survival/index.js';

const CHEST_BLOCK_NAMES = new Set(['chest', 'trapped_chest', 'barrel']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function handleBasicCommand(ctx, parsed, { username, reply, parentSignal, chatCtx, say, errorReply }) {
  const { bot, tasks, router, combat, equipment, home, survival, memory, dashboard, state } = ctx;

  async function canOpenNearbyChest() {
    if (parentSignal) {
      while ((combat.busy || tasks.paused || survival.busy) && !parentSignal.aborted) {
        await sleep(200);
      }
      if (parentSignal.aborted) throw new Error('Đã hủy');
    }
    if (combat.busy) {
      return { ok: false, error: 'Đang chiến đấu nên tạm chưa mở rương được.' };
    }
    if (bot.currentWindow) {
      return { ok: false, error: 'Đang mở một cửa sổ khác, hãy thử lại sau.' };
    }
    return { ok: true };
  }

  switch (parsed.type) {
    case 'scratchpad_status': {
      const summary = ctx.scratchpad?.formatRecoverySummary?.({ ownerName: ctx.config?.owner });
      if (summary) {
        await say(summary, { kind: 'final' });
        return true;
      }
      const active = ctx.scratchpad?.getActive?.();
      if (active) {
        await say(`Bộ nhớ tạm đang theo dõi việc đang chạy: ${active.goal}.`, { kind: 'final' });
        return true;
      }
      await say('Bộ nhớ tạm đang trống, không còn việc gì dở hết nha!', { kind: 'final' });
      return true;
    }

    case 'scratchpad_clear': {
      ctx.scratchpad?.clearRecovery?.();
      if (!chatCtx?.alreadyAcked) {
        await say('Ok đã xóa việc dở trong bộ nhớ tạm rồi nha!', { kind: 'final' });
      }
      return true;
    }

    case 'scratchpad_note': {
      ctx.scratchpad?.setManualTask?.({ goal: parsed.note, note: parsed.note });
      await say(`Ok đã lưu vào bộ nhớ tạm: "${parsed.note}". Khi nào xong hoặc bảo "bỏ việc cũ" mình sẽ xóa nha!`, { kind: 'final' });
      return true;
    }

    case 'scratchpad_resume': {
      const rec = ctx.scratchpad?.getRecovery?.();
      const manualNote = ctx.scratchpad?.getManualNote?.();
      if (!rec && !manualNote) {
        if (!chatCtx?.alreadyAcked) {
          await say('Hiện không có việc cũ nào đang dở trong bộ nhớ tạm đâu nha!', { kind: 'final' });
        }
        return true;
      }
      if (rec?.buildSpec) {
        if (!chatCtx?.alreadyAcked) {
          await say(`Ok làm tiếp việc cũ: ${rec.goal}.`, { kind: 'start' });
        }
        await ctx.dispatchParsedCommand(
          { type: rec.buildSpec.mode, file: rec.buildSpec.file, rotation: rec.buildSpec.rotation ?? 0 },
          username,
          reply,
          parentSignal,
          { ...(chatCtx ?? {}), buildSpec: rec.buildSpec, resumingRecovery: true }
        );
        return true;
      }
      if (rec?.kind === 'plan' && Array.isArray(rec.planSteps) && rec.planSteps.length > 0 && ctx.dashboardBridge?.onPlanExecute) {
        if (!chatCtx?.alreadyAcked) {
          await say(`Ok làm tiếp kế hoạch dở: ${rec.goal}!`, { kind: 'final' });
        }
        await ctx.dashboardBridge.onPlanExecute({
          goal: rec.goal,
          steps: rec.planSteps,
          wait: false,
          resumingRecovery: true,
        });
        return true;
      }
      if (rec?.kind === 'macro' && rec.macroName && ctx.dashboardBridge?.onMacro) {
        if (!chatCtx?.alreadyAcked) {
          await say(`Ok chạy tiếp macro dở: ${rec.macroName}!`, { kind: 'final' });
        }
        await ctx.dashboardBridge.onMacro({
          macro: rec.macroName,
          wait: false,
          resumingRecovery: true,
        });
        return true;
      }
      if (rec?.resumeCommand) {
        const resumedParsed = ctx.router?.parseChain
          ? ctx.router.parseChain(rec.resumeCommand)
          : ctx.router?.parse?.(rec.resumeCommand);
        if (resumedParsed && resumedParsed.type !== 'unknown') {
          await ctx.dispatchParsedCommand(resumedParsed, username, reply, parentSignal, {
            ...(chatCtx ?? {}),
            userMessage: rec.resumeCommand,
            resumingRecovery: true,
          });
          return true;
        }
      }
      if (!chatCtx?.alreadyAcked) {
        await say(`Trong bộ nhớ tạm đang ghi chú: "${rec?.goal || manualNote}". Bảo mình làm cụ thể hơn hoặc nhắn "bỏ việc cũ" để xóa nha!`, { kind: 'final' });
      }
      return true;
    }

    case 'help':
      await say(router.helpText(), { kind: 'final' });
      return true;

    case 'ack':
      await say('Có gì đâu, đồng đội mà! Cần phụ gì cứ hú nha.', { kind: 'final' });
      return true;

    case 'greet': {
      await say(`Chào ${username} nha! Đang sẵn sàng đi cùng bạn nè.`, { kind: 'final' });
      return true;
    }

    case 'inventory': {
      const counts = new Map();
      for (const item of bot.inventory?.items?.() ?? []) {
        if (item?.name) counts.set(item.name, (counts.get(item.name) ?? 0) + (item.count ?? 1));
      }
      const entries = [...counts.entries()].slice(0, 12).map(([n, c]) => `${n}:${c}`);
      await say(entries.length ? `Trong túi mình đang có: ${entries.join(', ')}` : 'Túi đồ của mình đang trống.', { kind: 'final' });
      return true;
    }

    case 'follow': {
      state.stayPut = false;
      ctx.companion?.stopIdleMotion?.();
      const player = bot.players[username]?.entity;
      if (!player) { await say('Tôi không thấy bạn.', { kind: 'error' }); return true; }
      const followRange = Math.max(2, Math.min(6, Math.round(ctx.config?.humanizer?.personalSpace ?? 3)));
      const setFollowGoal = () => {
        const current = bot.players[username]?.entity;
        if (current && bot.pathfinder) {
          bot.pathfinder.setGoal(new goals.GoalFollow(current, followRange), true);
        }
      };
      ctx.humanizer?.expressGesture?.('nod', { unsafe: Boolean(combat.busy || bot.isSleeping) }).catch(() => {});
      if (parentSignal) {
        setFollowGoal();
        if (!chatCtx?.alreadyAcked) await say('Được, tôi đi theo bạn.', { kind: 'final' });
        return true;
      }
      ctx.stopCurrentTask('Lệnh mới: theo bạn');
      tasks.start({ name: 'theo_chu', owner: username }, {
        onAbort: () => bot.pathfinder?.setGoal(null),
        onResume: setFollowGoal,
      });
      setFollowGoal();
      if (!chatCtx?.alreadyAcked) await say('Được, tôi đi theo bạn.', { kind: 'final' });
      return true;
    }

    case 'stay':
      state.stayPut = true;
      state.pendingQuantity = null;
      ctx.companion?.stopIdleMotion?.();
      if (parentSignal) {
        if (bot.pathfinder) bot.pathfinder.setGoal(null);
      } else {
        state.pendingBuild = null;
        state.pendingAction = null;
        ctx.stopCurrentTask('Lệnh dừng');
      }
      if (!chatCtx?.alreadyAcked) await say('Được, tôi đứng yên đây.', { kind: 'final' });
      return true;

    case 'come': {
      state.stayPut = false;
      ctx.companion?.stopIdleMotion?.();
      const player = bot.players[username]?.entity;
      if (!player?.position) { await say('Tôi không thấy bạn.', { kind: 'error' }); return true; }
      const p = player.position;
      let done = false;
      if (!chatCtx?.alreadyAcked) {
        say('Đang chạy lại chỗ bạn.', { kind: 'start', isStale: () => done });
      }
      await ctx.runStepTask({ name: 'lai_day', reason: 'Lệnh lại đây' }, async (signal) => {
        try {
          await ctx.gotoSafe(new goals.GoalNear(p.x, p.y, p.z, 2), signal);
        } finally {
          done = true;
        }
      }, { onAbort: () => { done = true; bot.pathfinder?.setGoal?.(null); }, errPrefix: 'Không chạy lại được', onError: errorReply }, parentSignal, reply);
      return true;
    }

    case 'goto': {
      state.stayPut = false;
      ctx.companion?.stopIdleMotion?.();
      const { x, y, z } = parsed;
      let done = false;
      if (!parentSignal) {
        ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
      }
      say(`Đang đi tới ${x}, ${y}, ${z}.`, { kind: 'start', isStale: () => done });
      await ctx.runStepTask({ name: 'di_toi', reason: 'Lệnh đi tới tọa độ', x, y, z }, async (signal) => {
        try {
          await ctx.gotoSafe(new goals.GoalNear(x, y, z, 2), signal);
          done = true;
          if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
          await say(`Đã tới gần ${x}, ${y}, ${z}.`, { kind: 'final' });
        } finally {
          done = true;
        }
      }, { onAbort: () => { done = true; bot.pathfinder?.setGoal?.(null); }, errPrefix: 'Không đi tới được', onError: errorReply }, parentSignal, reply);
      return true;
    }

    case 'save_waypoint': {
      if (!bot.entity?.position) { await say('Bot chưa sẵn sàng.', { kind: 'error' }); return true; }
      const pt = survival.saveWaypoint(parsed.name, bot.entity.position);
      await memory.flush();
      await say(`Đã lưu điểm "${parsed.name}" tại ${pt.x}, ${pt.y}, ${pt.z}.`, { kind: 'final' });
      return true;
    }

    case 'list_waypoints': {
      const list = survival.listWaypoints();
      await say(list.length ? `Các điểm đã lưu: ${list.join(', ')}` : 'Chưa có điểm nào được lưu.', { kind: 'final' });
      return true;
    }

    case 'goto_waypoint': {
      state.stayPut = false;
      ctx.companion?.stopIdleMotion?.();
      const pt = survival.getWaypoint(parsed.name);
      if (!pt) { await say(`Không tìm thấy điểm "${parsed.name}".`, { kind: 'error' }); return true; }
      let done = false;
      if (!parentSignal) {
        ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
      }
      say(`Đang đi tới "${parsed.name}" (${pt.x}, ${pt.y}, ${pt.z}).`, { kind: 'start', isStale: () => done });
      await ctx.runStepTask({ name: 'di_toi_diem', reason: 'Lệnh đi tới điểm đã lưu', target: parsed.name }, async (signal) => {
        try {
          await ctx.gotoSafe(new goals.GoalNear(pt.x, pt.y, pt.z, 2), signal);
          done = true;
          if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
          await say(`Đã tới "${parsed.name}".`, { kind: 'final' });
        } finally {
          done = true;
        }
      }, { onAbort: () => { done = true; bot.pathfinder?.setGoal?.(null); }, errPrefix: 'Không đi tới được', onError: errorReply }, parentSignal, reply);
      return true;
    }

    case 'goto_missing':
      await say('Bạn chỉ rõ tọa độ hoặc tên điểm, ví dụ: đi tới 100 64 -50 hoặc đi tới mỏ.', { kind: 'final' });
      return true;

    case 'set_home':
      if (ctx.config?.home?.setOnCommand === false) {
        await say('Cấu hình hiện tại không cho phép đặt nhà bằng lệnh.', { kind: 'error' });
        return true;
      }
      home.set(bot.entity);
      await memory.flush();
      await say('Đã lưu nơi này làm nhà.', { kind: 'final' });
      return true;

    case 'set_chest': {
      const nearChest = bot.findBlock({
        matching: block => block && CHEST_BLOCK_NAMES.has(block.name),
        maxDistance: 6,
      });
      if (!nearChest) { await say('Không thấy rương gần đây để lưu.', { kind: 'error' }); return true; }
      const saved = home.setStorageChest(nearChest.position);
      await memory.flush();
      await say(`Đã lưu rương nhà tại ${saved.x}, ${saved.y}, ${saved.z}.`, { kind: 'final' });
      return true;
    }

    case 'go_home': {
      state.stayPut = false;
      ctx.companion?.stopIdleMotion?.();
      const target = home.get();
      if (!target) { await say('Chưa có nhà nào được đặt.', { kind: 'error' }); return true; }
      let done = false;
      if (!parentSignal) {
        ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
      }
      say('Đang về nhà.', { kind: 'start', isStale: () => done });
      await ctx.runStepTask({ name: 've_nha', reason: 'Lệnh về nhà' }, async (signal) => {
        try {
          await ctx.gotoSafe(new goals.GoalNear(target.x, target.y, target.z, 2), signal);
          done = true;
          if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
          await say('Đã về tới nhà.', { kind: 'final' });
        } finally {
          done = true;
        }
      }, { onAbort: () => { done = true; bot.pathfinder?.setGoal?.(null); }, errPrefix: 'Không về nhà được', onError: errorReply }, parentSignal, reply);
      return true;
    }

    case 'store': {
      let chest = bot.findBlock({
        matching: block => block && CHEST_BLOCK_NAMES.has(block.name),
        maxDistance: 6,
      });
      if (!chest) {
        const savedChest = home.getStorageChest();
        if (savedChest) {
          let done = false;
          if (!parentSignal) {
            ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
          }
          say(`Đang chạy tới rương nhà (${savedChest.x}, ${savedChest.y}, ${savedChest.z}) để cất đồ.`, { kind: 'start', isStale: () => done });
          await ctx.runStepTask({ name: 'cat_do', reason: 'Đi tới rương nhà cất đồ' }, async (signal) => {
            try {
              await ctx.gotoSafe(new goals.GoalGetToBlock(savedChest.x, savedChest.y, savedChest.z), signal);
              const block = bot.blockAt(new Vec3(savedChest.x, savedChest.y, savedChest.z));
              if (!block || !CHEST_BLOCK_NAMES.has(block.name)) {
                done = true;
                if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
                await say('Không thấy rương tại tọa độ đã lưu.', { kind: 'error' });
                return;
              }
              const stored = await home.storeSurplus(block);
              done = true;
              if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
              await say(stored ? 'Đã cất đồ dư vào rương nhà.' : 'Không có đồ dư để cất.', { kind: 'final' });
            } finally {
              done = true;
            }
          }, { onAbort: () => { done = true; bot.pathfinder?.setGoal?.(null); }, errPrefix: 'Không thể cất đồ', onError: errorReply }, parentSignal, reply);
          return true;
        }
        await say('Không thấy rương gần đây (hãy đứng cạnh rương gõ "đây là rương" để lưu).', { kind: 'error' });
        return true;
      }
      const chestGuard = await canOpenNearbyChest();
      if (!chestGuard.ok) {
        await say(chestGuard.error, { kind: 'error' });
        return true;
      }
      try {
        if (chest.position) {
          home.setStorageChest(chest.position);
        }
        const stored = await home.storeSurplus(chest);
        if (!parentSignal && chatCtx?.resumingRecovery) ctx.scratchpad?.completeActive();
        await say(stored ? 'Đã cất đồ dư vào rương nhà.' : 'Không có đồ dư để cất.', { kind: 'final' });
      } catch (err) {
        await say(`Không thể cất đồ: ${err.message}`, { kind: 'error' });
      } finally {
        if (!parentSignal && !combat.busy && !tasks.paused) tasks.active?.onResume?.();
      }
      return true;
    }

    case 'sleep': {
      state.stayPut = false;
      ctx.companion?.stopIdleMotion?.();
      if (!isSafeSleepDimension(bot.game?.dimension)) {
        await say('Không được dùng giường ở Nether/End vì sẽ phát nổ!', { kind: 'error' });
        return true;
      }
      const ownerEntity = bot.players?.[ctx.config?.owner]?.entity ?? null;
      const bed = findSafeSleepBed(bot, ownerEntity, 8);
      if (!bed) { await say('Không thấy giường trống gần đây.', { kind: 'error' }); return true; }
      await ctx.runStepTask({ name: 'ngu', reason: 'Lệnh đi ngủ' }, async (signal) => {
        if (bot.entity?.position && bed.position && bot.entity.position.distanceTo(bed.position) > 3.5) {
          await ctx.gotoSafe(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z), signal);
        }
        await bot.sleep(bed);
        await say('Đang ngủ.', { kind: 'final' });
      }, { errPrefix: 'Không thể ngủ', onError: errorReply }, parentSignal, reply);
      return true;
    }

    case 'recover_death': {
      state.stayPut = false;
      ctx.companion?.stopIdleMotion?.();
      const rawDeath = memory.get('lastDeath');
      if (!rawDeath) {
        await say('Không có vị trí chết nào còn đồ để nhặt (hoặc đã quá xa/quá 5 phút tự biến mất).', { kind: 'error' });
        return true;
      }
      const started = ctx.startDeathRecoveryTask(rawDeath, (msg) => { say(msg, { kind: 'final' }).catch(() => {}); });
      if (started && !parentSignal) {
        ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
      }
      return true;
    }

    case 'list_chests': {
      const totals = home.listChestInventory();
      const entries = Object.entries(totals).slice(0, 12).map(([n, c]) => `${n}:${c}`);
      await say(entries.length ? `Trong rương nhớ có: ${entries.join(', ')}` : 'Chưa nhớ món nào trong rương (hãy dùng "cất đồ" để quét rương).', { kind: 'final' });
      return true;
    }

    case 'take_from_chest': {
      let targetChest = bot.findBlock({
        matching: block => block && CHEST_BLOCK_NAMES.has(block.name),
        maxDistance: 6,
      });
      if (!targetChest) {
        const hits = home.findInChests(parsed.target);
        const posHint = hits[0] ?? home.getStorageChest();
        if (!posHint) { await say(`Không tìm thấy rương nào chứa "${parsed.target}".`, { kind: 'error' }); return true; }
        if (!parentSignal) {
          ctx.scratchpad?.startSingleCommand(parsed, { resumingRecovery: Boolean(chatCtx?.resumingRecovery) });
        }
        await ctx.runStepTask({ name: 'lay_tu_ruong', reason: 'Lấy đồ từ rương', target: parsed.target }, async (signal) => {
          await ctx.gotoSafe(new goals.GoalGetToBlock(posHint.x, posHint.y, posHint.z), signal);
          const block = bot.blockAt(new Vec3(posHint.x, posHint.y, posHint.z));
          if (!block || !CHEST_BLOCK_NAMES.has(block.name)) {
            if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
            await say('Không thấy rương tại tọa độ đã nhớ.', { kind: 'error' });
            return;
          }
          const res = await home.takeFromChest(block, parsed.target, parsed.count);
          if (res?.count > 0) state.lastIntentionalItemGainAt = Date.now();
          if (!signal.aborted && !parentSignal) ctx.scratchpad?.completeActive();
          await memory.flush();
          await say(res.count > 0 ? `Đã lấy ${res.count} ${res.name} từ rương.` : `Trong rương không còn ${parsed.target}.`, { kind: 'final' });
        }, { errPrefix: 'Không lấy được từ rương', onError: errorReply }, parentSignal, reply);
        return true;
      }
      const chestGuard = await canOpenNearbyChest();
      if (!chestGuard.ok) {
        await say(chestGuard.error, { kind: 'error' });
        return true;
      }
      try {
        const res = await home.takeFromChest(targetChest, parsed.target, parsed.count);
        await memory.flush();
        await say(res.count > 0 ? `Đã lấy ${res.count} ${res.name} từ rương.` : `Trong rương không có ${parsed.target}.`, { kind: 'final' });
      } catch (err) {
        await say(`Không lấy được từ rương: ${err.message}`, { kind: 'error' });
      } finally {
        if (!parentSignal && !combat.busy && !tasks.paused) tasks.active?.onResume?.();
      }
      return true;
    }

    case 'dashboard_on':
      try {
        const addr = await dashboard.start();
        await say(`Web Dashboard đang chạy tại http://${addr.host}:${addr.port}`, { kind: 'final' });
      } catch (err) {
        await say(`Không bật được dashboard: ${err.message}`, { kind: 'error' });
      }
      return true;

    case 'dashboard_off':
      await dashboard.stop();
      await say('Đã tắt Web Dashboard.', { kind: 'final' });
      return true;

    case 'gear':
      await equipment.maintain();
      await equipment.discardObsoleteItems();
      await say('Đã kiểm tra trang bị.', { kind: 'final' });
      return true;

    case 'combat_off':
      combat.config.enabled = false;
      combat.stop();
      await say('Đã tắt tự động đánh (chế độ hòa bình).', { kind: 'final' });
      return true;

    case 'combat_on':
      combat.config.enabled = true;
      combat.start();
      await say('Đã bật lại chế độ tự vệ và chiến đấu.', { kind: 'final' });
      return true;

    case 'auto_farm_on':
      state.autoFarmEnabled = true;
      state.stayPut = false;
      await say('Đã bật chế độ tự farm đồ khi rảnh!', { kind: 'final' });
      ctx.companion?.tickSurvivalAutonomy?.(Date.now(), { force: true }).catch?.(() => {});
      return true;

    case 'auto_farm_off':
      state.autoFarmEnabled = false;
      if (tasks.active?.task?.autoFarm) {
        ctx.stopCurrentTask('Tắt tự farm');
      }
      await say('Đã tắt chế độ tự farm khi rảnh.', { kind: 'final' });
      return true;

    case 'eat': {
      const ate = await survival.autoEat({ force: true });
      await say(ate ? 'Đã ăn hồi đói.' : 'Mình đang no hoặc chưa có đồ ăn trong túi.', { kind: 'final' });
      return true;
    }

    case 'drop_junk': {
      const obsolete = await equipment.discardObsoleteItems({ force: true });
      const junk = typeof equipment.discardJunkItems === 'function'
        ? await equipment.discardJunkItems({ force: true })
        : [];
      const dropped = [...obsolete, ...junk];
      await say(dropped.length ? `Đã vứt đồ thừa/cấp thấp: ${dropped.join(', ')}.` : 'Túi gọn rồi, không có đồ thừa nào để vứt.', { kind: 'final' });
      return true;
    }

    case 'status': {
      const status = equipment.status();
      const activeTask = tasks.status().active?.name ?? 'rảnh';
      const jevT = combat.lastJevTelemetry;
      const jevStr = jevT ? `, jev=${jevT.action}(${Math.round((jevT.confidence ?? 1) * 100)}%)` : '';
      const combatStr = combat.config.enabled ? 'bật' : 'tắt';
      await say(`Máu ${Math.round(bot.health ?? 20)}/20, đói ${Math.round(bot.food ?? 20)}/20, đánh: ${combatStr}, việc: ${activeTask}${jevStr}, đồ: ${JSON.stringify(status.equipped)}`, { kind: 'final' });
      return true;
    }

    default:
      return false;
  }
}
