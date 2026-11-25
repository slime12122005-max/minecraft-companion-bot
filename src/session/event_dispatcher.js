import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { SESSION_STATES } from './state_machine.js';
import { configureMovements, formatError } from './task_helpers.js';
import { explainConnectionIssue, formatMinecraftReason } from './lan_discovery.js';
import { findSafeSleepBed, isSafeSleepDimension } from '../survival/index.js';
import { TASK_TIERS } from '../tasks.js';

export function bindSessionEvents(ctx) {
  const {
    bot,
    config,
    tasks,
    combat,
    equipment,
    survival,
    mining,
    memory,
    dashboard,
    externalDashboard,
    stateMachine,
    watchdog,
    logFor,
    warnFor,
    errorFor,
    state,
  } = ctx;

  let disposed = false;
  let recoveryTimer = null;

  const onFirstSpawn = () => {
    if (disposed) return;
    logFor('bot')(`✅ Bot ${bot.username} đã vào thế giới ${bot.version}`);
    const recoveryMsg = ctx.scratchpad?.formatRecoverySummary?.({ ownerName: config.owner });
    if (recoveryMsg) {
      logFor('scratchpad')(recoveryMsg);
      ctx.pushInbox?.({
        kind: 'alert',
        alertType: 'crash_recovery',
        role: 'SYSTEM',
        severity: 'info',
        username: bot.username,
        message: recoveryMsg,
        scratchpad: ctx.scratchpad.snapshot(),
      });
      const announce = () => {
        if (disposed || state.disconnected) return;
        bot.chat?.(recoveryMsg);
        ctx.pushChatHistory?.('assistant', recoveryMsg);
      };
      if (ctx.loadPlugins === false) {
        announce();
      } else {
        recoveryTimer = setTimeout(announce, 600);
        recoveryTimer.unref?.();
      }
    }
  };

  const onSpawn = () => {
    if (disposed) return;
    state.connected = true;
    state.disconnected = false;
    state.stayPut = false;
    state.idleGoalActive = false;
    ctx.pushInbox?.({
      kind: 'spawn',
      role: 'SYSTEM',
      username: bot.username,
      message: 'Bot đã vào thế giới',
    });
    stateMachine.sync({
      connected: true,
      alive: bot.isAlive !== false,
      sleeping: Boolean(bot.isSleeping),
      combatBusy: Boolean(combat.busy),
      retreating: combat.lastDecision?.action === 'retreat' && combat.busy,
      activeTask: Boolean(tasks.active && !tasks.paused),
    });
    configureMovements(bot, config);
    const rawDeath = memory.get('lastDeath');
    if (rawDeath && !tasks.active) {
      if (rawDeath.dimension && bot.game?.dimension && String(rawDeath.dimension) !== String(bot.game.dimension)) {
        const itemDespawnMs = config.survival?.itemDespawnMs ?? 300000;
        if (Date.now() - Number(rawDeath.diedAt ?? 0) >= itemDespawnMs) {
          survival.clearDeath();
        }
      } else {
        ctx.startDeathRecoveryTask(rawDeath, (msg) => {
          ctx.replyHuman(msg, { replyFn: (t) => bot.chat(t) }).catch(() => {});
        });
      }
    }
  };

  const onEnd = () => {
    if (disposed) return;
    state.connected = false;
    state.disconnected = true;
    stateMachine.sync({ connected: false });
  };

  const onDeath = () => {
    if (disposed) return;
    stateMachine.transition(SESSION_STATES.DEAD, 'Bot đã chết');
    survival.recordDeath(bot.entity, bot.game?.dimension);
    ctx.pushInbox?.({
      kind: 'death',
      role: 'SYSTEM',
      username: bot.username,
      message: 'Bot đã chết',
      position: bot.entity?.position ? {
        x: Math.round(bot.entity.position.x),
        y: Math.round(bot.entity.position.y),
        z: Math.round(bot.entity.position.z),
      } : null,
    });
    memory.flush().catch(() => {});
    ctx.stopCurrentTask('Bot đã chết');
  };

  const onEntitySleep = (entity) => {
    if (disposed) return;
    if (!entity || entity.username !== config.owner) return;
    if (combat.busy || bot.isSleeping) return;
    const bed = findSafeSleepBed(bot, entity, 16);
    if (!bed) return;
    if (isSafeSleepDimension(bot.game?.dimension)) {
      ctx.home?.autoSetFromBed?.(bed?.position ?? entity.position, bot.game?.dimension ?? 'overworld');
    }
    ctx.stopCurrentTask('Ngủ cùng chủ');
    const run = tasks.run({ name: 'ngu_cung_chu' }, async (signal) => {
      if (bot.entity?.position && bed.position && bot.entity.position.distanceTo(bed.position) > 3.5) {
        await ctx.gotoSafe(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z), signal);
      }
      await bot.sleep(bed);
    }, { onAbort: () => bot.pathfinder?.setGoal(null) });
    run?.promise?.catch(() => {});
  };

  const onChat = (username, message) => {
    if (disposed) return;
    const isOwner = username === config.owner;
    const inboxEntry = username !== bot.username
      ? ctx.pushInbox?.({
          kind: 'chat',
          role: isOwner ? 'OWNER_TRUSTED' : 'UNTRUSTED_PUBLIC_PLAYER',
          username,
          isOwner,
          viaWhisper: false,
          message,
        })
      : null;
    ctx.handleCommand(username, message, { viaWhisper: false, inboxEntry }).catch((err) => {
      errorFor('chat', formatError(err));
      ctx.reportRuntimeBug?.({ source: 'chat_handler', error: err, context: `chat: ${message}` });
    });
  };

  const onWhisper = (username, message) => {
    if (disposed) return;
    const isOwner = username === config.owner;
    const inboxEntry = username !== bot.username
      ? ctx.pushInbox?.({
          kind: 'whisper',
          role: isOwner ? 'OWNER_TRUSTED' : 'UNTRUSTED_PUBLIC_PLAYER',
          username,
          isOwner,
          viaWhisper: true,
          message,
        })
      : null;
    ctx.handleCommand(username, message, { viaWhisper: true, inboxEntry }).catch((err) => {
      errorFor('whisper', formatError(err));
      ctx.reportRuntimeBug?.({ source: 'whisper_handler', error: err, context: `whisper: ${message}` });
    });
  };

  const recentMobDeaths = [];
  const onEntityDead = (entity) => {
    if (disposed || !entity?.position || entity.type === 'player' || entity.username) return;
    const now = Date.now();
    recentMobDeaths.push({
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      at: now,
    });
    if (recentMobDeaths.length > 24) {
      recentMobDeaths.splice(0, recentMobDeaths.length - 24);
    }
  };

  const onEntitySpawn = (entity) => {
    if (disposed || !entity?.position) return;
    if (entity.name !== 'item' && entity.displayName !== 'Item' && entity.objectType !== 'Item') return;
    const now = Date.now();
    if (
      now - (equipment.lastDiscardAt ?? 0) < 4000 &&
      bot.entity?.position &&
      entity.position.distanceTo(bot.entity.position) <= 4
    ) {
      equipment.ignoreDroppedEntity?.(entity.id, { fromOwner: false, now });
      return;
    }
    if (now - lastDigActiveAt >= 1500) {
      const nearMobDeath = recentMobDeaths.some(
        (d) => now - d.at <= 1500 && Math.hypot(entity.position.x - d.x, entity.position.y - d.y, entity.position.z - d.z) <= 3.2
      );
      if (nearMobDeath) return;

      const ownerEnt = bot.players?.[config.owner]?.entity;
      if (ownerEnt?.position) {
        const horiz = Math.hypot(entity.position.x - ownerEnt.position.x, entity.position.z - ownerEnt.position.z);
        const vert = Math.abs(entity.position.y - ownerEnt.position.y);
        if (horiz <= 2.6 && vert <= 2.5) {
          let thrownTowardBot = false;
          if (bot.entity?.position && entity.velocity) {
            const dx = bot.entity.position.x - ownerEnt.position.x;
            const dz = bot.entity.position.z - ownerEnt.position.z;
            const dLen = Math.hypot(dx, dz);
            if (dLen > 0.3) {
              const vDot = ((entity.velocity.x ?? 0) * dx + (entity.velocity.z ?? 0) * dz) / dLen;
              if (vDot > 0.08) thrownTowardBot = true;
            }
          }
          if (!thrownTowardBot) {
            equipment.ignoreDroppedEntity?.(entity.id, { fromOwner: true, now });
          }
        }
      }
    }
  };

  bot.once('spawn', onFirstSpawn);
  bot.on('spawn', onSpawn);
  bot.on('end', onEnd);
  bot.on('death', onDeath);
  bot.on('entitySleep', onEntitySleep);
  bot.on('entityDead', onEntityDead);
  bot.on('entitySpawn', onEntitySpawn);
  bot.on('chat', onChat);
  bot.on('whisper', onWhisper);

  let combatTicking = false;
  let lastSlowMaintainAt = 0;
  let lastTrashPurgeAt = 0;
  let lastDigActiveAt = 0;
  let stationaryFollowSince = 0;
  let lastDangerAlertAt = 0;
  let jevSurvivalPending = false;
  let lastStuckStageHandled = 0;
  let lastStuckAlertAt = 0;
  let lastLowFoodAlertAt = 0;
  const lastLowDurAlertAt = new Map();

  const loop = setInterval(async () => {
    if (disposed || !bot.entity || bot.isAlive === false || combatTicking) return;
    combatTicking = true;
    const now = Date.now();
    try {
      if (bot.targetDigBlock) {
        lastDigActiveAt = now;
      }
      const isStationaryFollow = tasks.active?.task?.name === 'theo_chu' && !bot.pathfinder?.isMoving?.();
      if (
        isStationaryFollow &&
        !combat.busy &&
        !survival.busy &&
        ctx.companion?.enabledIdle &&
        (state.autoFarmEnabled ?? (config?.companion?.autoFarm !== false)) !== false
      ) {
        const followOwner = bot.players?.[config.owner]?.entity ?? null;
        const followDist = followOwner?.position ? bot.entity.position.distanceTo(followOwner.position) : null;
        if (followDist == null || followDist <= 10) {
          if (!stationaryFollowSince) {
            stationaryFollowSince = now;
          } else if (now - stationaryFollowSince >= 4000) {
            stationaryFollowSince = 0;
            ctx.stopCurrentTask('Chủ đứng gần, chuyển sang hộ tống tự động kết hợp tự làm việc');
          }
        } else {
          stationaryFollowSince = 0;
        }
      } else {
        stationaryFollowSince = 0;
      }
      const wdStatus = watchdog.recordTick(now, {
        pos: bot.entity.position,
        moving: Boolean(bot.pathfinder?.isMoving?.()),
        digging: Boolean(bot.targetDigBlock) || (now - lastDigActiveAt < 1800),
        sleeping: Boolean(bot.isSleeping),
        activeTask: Boolean(tasks.active && !tasks.paused && !isStationaryFollow),
        exempt: Boolean(state.aiPaused || combat.busy || survival.busy || bot.currentWindow || combat.shelterHoldPos),
      });

      if ((tasks.active || combat.busy || survival.busy) && state.idleGoalActive) {
        ctx.companion?.stopIdleMotion?.();
      }

      if (!state.aiPaused) {
        await survival.handleHazards();
        if (!combat.shieldActive && !combat.bowCharging && !survival.busy) {
          survival.emergencyHeal().catch(() => {});
        }

        const tickState = {
          health: bot.health,
          food: bot.food,
          position: bot.entity.position,
          inventory: bot.inventory?.items?.() ?? [],
          owner: config.owner,
          target: combat.targetId ? bot.entities?.[combat.targetId] : null,
        };
        await combat.tick(tickState);

        const jevTele = combat.lastJevTelemetry;
        const jevUrgent = (jevTele?.urgentRetreat ?? 0) >= 0.7 ||
          (combat.lastDecision?.action === 'retreat' && (jevTele?.danger ?? 0) >= 2);
        const criticalDanger = combat.busy && ((bot.health ?? 20) <= 8 || jevUrgent);
        if (criticalDanger && now - lastDangerAlertAt >= 10000) {
          lastDangerAlertAt = now;
          const curTaskName = tasks.status().active?.name ?? 'rảnh';
          ctx.pushInbox?.({
            kind: 'alert',
            alertType: 'combat_danger',
            role: 'SYSTEM',
            severity: (bot.health ?? 20) <= 6 || jevUrgent ? 'critical' : 'high',
            username: bot.username,
            message: `Cảnh báo nguy hiểm khi chiến đấu (máu ${Math.round(bot.health ?? 20)}/20)`,
            health: bot.health ?? 20,
            task: curTaskName,
            jev: jevTele ?? null,
          });
          if (
            ctx.llm?.isAvailable?.() &&
            typeof ctx.llm.chooseSurvivalAction === 'function' &&
            tasks.active &&
            !tasks.active.aborted &&
            jevUrgent &&
            !jevSurvivalPending
          ) {
            jevSurvivalPending = true;
            ctx.llm.chooseSurvivalAction({
              health: bot.health ?? 20,
              food: bot.food ?? 20,
              task: curTaskName,
              combatAction: combat.lastDecision?.action ?? 'retreat',
              danger: jevTele?.danger ?? null,
            }).then((decision) => {
              if (!disposed && decision && ((decision.abortTask ?? 0) >= 0.75 || decision.action === 'escalate_antigravity' || decision.action === 'return_home')) {
                ctx.stopCurrentTask('Jev phát hiện nguy hiểm cao');
                ctx.pushInbox?.({
                  kind: 'alert',
                  alertType: 'jev_abort',
                  role: 'SYSTEM',
                  severity: 'critical',
                  username: bot.username,
                  message: `Jev yêu cầu hủy tác vụ "${curTaskName}" (${decision.action}) để tránh nguy hiểm`,
                  jevSurvival: decision,
                });
              }
            }).catch(() => {}).finally(() => {
              jevSurvivalPending = false;
            });
          }
        }

        if (!combat.busy && !survival.busy && !bot.isSleeping && !bot.currentWindow) {
          if (!wdStatus.stuck) {
            lastStuckStageHandled = 0;
          } else if (wdStatus.recoveryStage > lastStuckStageHandled) {
            if (wdStatus.recoveryStage === 1) {
              lastStuckStageHandled = 1;
              warnFor('watchdog', `Phát hiện bot đứng kẹt (${Math.round(wdStatus.stuckMs / 1000)}s), thử nhích nhảy thoát kẹt.`);
              survival.unstuck?.({ stage: 1 }).catch?.(() => {});
            } else if (wdStatus.recoveryStage === 2) {
              lastStuckStageHandled = 2;
              warnFor('watchdog', `Bot vẫn kẹt (${Math.round(wdStatus.stuckMs / 1000)}s), thử lùi + tìm lại đường đi.`);
              await survival.unstuck?.({
                stage: 2,
                repath: true,
                onRepath: (prevGoal) => {
                  if (tasks.active?.onResume) {
                    tasks.active.onResume();
                  } else if (prevGoal && !tasks.active) {
                    bot.pathfinder?.setGoal?.(prevGoal);
                  }
                },
              });
            } else if (wdStatus.recoveryStage >= 3) {
              const curTaskName = tasks.status().active?.name ?? 'di_chuyen';
              const pos = bot.entity?.position;
              const position = pos ? {
                x: Math.round(pos.x),
                y: Math.round(pos.y),
                z: Math.round(pos.z),
              } : null;
              warnFor('watchdog', `Bot bị kẹt quá lâu (${Math.round(wdStatus.stuckMs / 1000)}s) khi đang làm "${curTaskName}", tự dừng để báo Antigravity.`);
              if (tasks.active) {
                ctx.stopCurrentTask('Bị kẹt quá lâu');
              } else {
                bot.pathfinder?.setGoal?.(null);
              }
              watchdog.resetStuck(now);
              lastStuckStageHandled = 0;
              if (now - lastStuckAlertAt >= 30000) {
                lastStuckAlertAt = now;
                memory?.recordEvent?.({
                  eventType: 'stuck',
                  summary: `Bị kẹt quá lâu (${Math.round(wdStatus.stuckMs / 1000)}s) khi làm ${curTaskName}`,
                  x: position?.x ?? null,
                  y: position?.y ?? null,
                  z: position?.z ?? null,
                });
                ctx.pushInbox?.({
                  kind: 'alert',
                  alertType: 'stuck',
                  role: 'SYSTEM',
                  severity: 'high',
                  username: bot.username,
                  message: `Bot bị kẹt quá lâu (${Math.round(wdStatus.stuckMs / 1000)}s) khi đang làm "${curTaskName}" nên đã tự dừng để chờ chỉ đạo`,
                  task: curTaskName,
                  stuckMs: wdStatus.stuckMs,
                  position,
                });
              }
            }
          }
        }
      }

      stateMachine.sync({
        connected: state.connected || Boolean(bot.entity),
        alive: bot.isAlive !== false,
        sleeping: Boolean(bot.isSleeping),
        combatBusy: Boolean(combat.busy),
        retreating: combat.lastDecision?.action === 'retreat' && combat.busy,
        activeTask: Boolean(tasks.active && !tasks.paused),
      });

      if (!state.aiPaused && now - lastSlowMaintainAt >= 1000) {
        lastSlowMaintainAt = now;
        const urgentFood = (bot.food ?? 20) <= 6 || (bot.health ?? 20) <= 10;
        if (!combat.busy && !combat.shieldActive && !survival.busy && !bot.currentWindow && (!bot.targetDigBlock || urgentFood)) {
          survival.autoEat().catch(() => {});
        }
        if (!survival.busy && !combat.busy && !combat.shieldActive && !combat.bowCharging && !bot.currentWindow) {
          await equipment.maintainArmorAndShield();
          const emptySlots = typeof bot.inventory?.emptySlotCount === 'function'
            ? bot.inventory.emptySlotCount()
            : 99;
          const blockStacks = config.inventory?.blockStacks ?? 2;
          const ownerEntity = bot.players?.[config.owner]?.entity ?? null;
          const gainGraceOk = now - (state.lastIntentionalItemGainAt ?? 0) >= 8000;
          const periodicTrash = now - lastTrashPurgeAt >= 4000 && Boolean(equipment.hasInventoryTrash?.({ blockStacks }));
          const isMovingNow =
            Boolean(bot.pathfinder?.isMoving?.()) ||
            Math.hypot(bot.entity?.velocity?.x ?? 0, bot.entity?.velocity?.z ?? 0) > 0.09;
          const canPurgeNow = (!isMovingNow && !tasks.active) || emptySlots <= 2;
          if (equipment.discardObsolete && !bot.targetDigBlock && gainGraceOk && canPurgeNow && (emptySlots <= 12 || periodicTrash)) {
            lastTrashPurgeAt = now;
            await equipment.discardObsoleteItems({ ownerEntity });
            if (typeof equipment.discardJunkItems === 'function') {
              await equipment.discardJunkItems({ blockStacks, ownerEntity });
            }
          }
        }
        ctx.humanizer?.updateIdleGaze?.(now, {
          ownerEntity: bot.players?.[config.owner]?.entity ?? null,
          busy: Boolean(tasks.active && !tasks.paused),
          combatBusy: Boolean(combat.busy || combat.shieldActive || combat.bowCharging),
          sleeping: Boolean(bot.isSleeping),
          digging: Boolean(bot.targetDigBlock),
          moving: Boolean(bot.pathfinder?.isMoving?.()),
          windowOpen: Boolean(bot.currentWindow),
        });
        const idleFarmOwner = bot.players?.[config.owner]?.entity ?? null;
        if (tasks.active?.task?.autoFarm && idleFarmOwner?.position) {
          const ownerDist = bot.entity.position.distanceTo(idleFarmOwner.position);
          if (ownerDist > 22 && ownerDist <= 80) {
            ctx.stopCurrentTask('Chủ di chuyển xa, tạm dừng tự farm để đi theo');
          }
        }
        if (!combat.busy && !survival.busy && !tasks.active && !bot.isSleeping && !bot.currentWindow) {
          await ctx.companion?.tickIdle?.(now);
        }
        for (const alert of survival.checkHealthAlerts({ ownerName: config.owner })) {
          bot.chat(alert);
          ctx.pushInbox?.({
            kind: 'alert',
            alertType: 'low_health',
            role: 'SYSTEM',
            severity: 'critical',
            username: bot.username,
            message: alert,
            health: bot.health ?? 20,
          });
        }
        const oreFindings = typeof mining.scanValuableOresDetailed === 'function'
          ? mining.scanValuableOresDetailed()
          : mining.scanValuableOres().map(message => ({ message }));
        for (const ore of oreFindings) {
          bot.chat(ore.message);
          if (ore.x != null && ore.y != null && ore.z != null) {
            memory?.upsertPoi?.({
              category: 'ore_vein',
              label: `${ore.name ?? 'rare_ore'}@${ore.x},${ore.y},${ore.z}`,
              dimension: String(bot.game?.dimension ?? 'overworld'),
              x: ore.x,
              y: ore.y,
              z: ore.z,
            });
          }
          ctx.pushInbox?.({
            kind: 'alert',
            alertType: 'rare_ore',
            role: 'SYSTEM',
            severity: 'info',
            username: bot.username,
            message: ore.message,
            ore: ore.name ?? null,
            position: ore.x != null ? { x: ore.x, y: ore.y, z: ore.z } : null,
          });
        }
        if (typeof equipment.getLowDurabilityItems === 'function') {
          const lowDur = equipment.getLowDurabilityItems(0.10);
          const freshLowDur = [];
          for (const item of lowDur) {
            const key = `${item.name}:${item.slot}`;
            const prevAt = lastLowDurAlertAt.get(key) ?? 0;
            if (now - prevAt >= 120000) {
              lastLowDurAlertAt.set(key, now);
              freshLowDur.push(item);
            }
          }
          if (freshLowDur.length > 0) {
            const summary = freshLowDur
              .map(i => `${i.name} (${Math.round((i.ratio ?? 0) * 100)}%)`)
              .join(', ');
            ctx.pushInbox?.({
              kind: 'alert',
              alertType: 'low_durability',
              role: 'SYSTEM',
              severity: 'medium',
              username: bot.username,
              message: `Trang bị/công cụ sắp hỏng (<10%): ${summary}`,
              items: freshLowDur,
            });
          }
        }
        const curFood = bot.food ?? 20;
        const hasFood = Boolean(typeof survival._bestFood === 'function' ? survival._bestFood() : null);
        if (curFood <= 10 && !hasFood && now - lastLowFoodAlertAt >= 60000) {
          lastLowFoodAlertAt = now;
          ctx.pushInbox?.({
            kind: 'alert',
            alertType: 'low_food',
            role: 'SYSTEM',
            severity: curFood <= 6 ? 'critical' : 'high',
            username: bot.username,
            message: `Bot đang đói (${Math.round(curFood)}/20) và đã hết thức ăn trong túi`,
            food: curFood,
            health: bot.health ?? 20,
          });
        }
        if (!combat.busy && !tasks.active) {
          if (!ctx.companion?.enabledIdle && !bot.pathfinder?.isMoving?.()) {
            survival.pickupNearbyItem({ stayPut: state.stayPut });
          }
          if (!survival.busy && ctx.smelting?.hasReadyJob?.({ maxDistance: 32 })) {
            const run = tasks.run(
              { name: 'thu_lo_nung' },
              (signal) => ctx.smelting.collectReadyOutputs(signal),
              { onAbort: () => bot.pathfinder?.setGoal?.(null), priority: TASK_TIERS.BACKGROUND }
            );
            run?.promise?.catch?.(() => {});
          }
          const ownerEntity = bot.players?.[config.owner]?.entity ?? null;
          const cond = survival.checkAutoReturnCondition({
            busy: combat.busy || !!tasks.active,
            ownerEntity,
          });
          if (cond) {
            bot.chat(`Tôi tự về nhà vì ${cond.reason}.`);
            ctx.startGoHomeTask((msg) => bot.chat(msg), { background: true });
          }
        }
      }
    } catch (err) {
      errorFor('loop', err.message);
      ctx.reportRuntimeBug?.({ source: 'loop', error: err });
    } finally {
      combatTicking = false;
    }
  }, 100);
  loop.unref?.();

  let lastFabricParseWarnAt = 0;
  const onError = (err) => {
    const errText = formatError(err);
    if (bot._fabricModded && /^Parse error for play\.toClient/i.test(errText)) {
      const now = Date.now();
      if (now - lastFabricParseWarnAt >= 30000) {
        lastFabricParseWarnAt = now;
        warnFor('fabric', `⚠️ Bỏ qua gói mod không chuẩn: ${errText}`);
      }
      return;
    }
    errorFor('bot', errText);
    const diag = explainConnectionIssue(err, config);
    if (diag) warnFor('bot', `💡 ${diag.hint}`);
  };
  const onKicked = (reason) => {
    if (disposed) return;
    const readableReason = formatMinecraftReason(reason);
    const diag = explainConnectionIssue(reason, config);
    ctx.pushInbox?.({
      kind: 'kicked',
      role: 'SYSTEM',
      username: bot.username,
      message: readableReason,
      ...(diag ? { issueCode: diag.code, hint: diag.hint } : {}),
    });
    warnFor('bot', `Bị kick: ${readableReason}`);
    if (diag) warnFor('bot', `💡 ${diag.hint}`);
  };

  bot.on('error', onError);
  bot.on('kicked', onKicked);

  async function cleanup() {
    disposed = true;
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
    clearInterval(loop);
    const detach = (event, fn) => {
      if (typeof bot.off === 'function') bot.off(event, fn);
      else if (typeof bot.removeListener === 'function') bot.removeListener(event, fn);
    };
    detach('spawn', onFirstSpawn);
    detach('spawn', onSpawn);
    detach('end', onEnd);
    detach('death', onDeath);
    detach('entitySleep', onEntitySleep);
    detach('entityDead', onEntityDead);
    detach('entitySpawn', onEntitySpawn);
    detach('chat', onChat);
    detach('whisper', onWhisper);
    detach('error', onError);
    detach('kicked', onKicked);
    combat.stop();
    ctx.fabricCompat?.detach?.();
    survival.stopUnstuck?.();
    ctx.companion?.dispose?.();
    ctx.humanizer?.dispose?.();
    ctx.stopCurrentTask('Ngắt kết nối', { clearQueue: true });
    if (!externalDashboard) {
      await dashboard.stop().catch(() => {});
    }
    await memory.flush().catch(() => {});
  }

  return { loop, cleanup };
}
