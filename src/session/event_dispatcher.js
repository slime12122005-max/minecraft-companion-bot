import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { SESSION_STATES } from './state_machine.js';
import { configureMovements, formatError } from './task_helpers.js';
import { findSafeSleepBed } from '../survival/index.js';
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

  const onFirstSpawn = () => {
    if (disposed) return;
    logFor('bot')(`✅ Bot ${bot.username} đã vào thế giới ${bot.version}`);
  };

  const onSpawn = () => {
    if (disposed) return;
    state.connected = true;
    state.disconnected = false;
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
    configureMovements(bot);
    const death = survival.getPendingDeathRecovery({ currentDimension: bot.game?.dimension });
    if (death && !tasks.active) {
      ctx.startDeathRecoveryTask(death, (msg) => {
        ctx.replyHuman(msg, { replyFn: (t) => bot.chat(t) }).catch(() => {});
      });
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
    ctx.handleCommand(username, message, { viaWhisper: false, inboxEntry }).catch(err => errorFor('chat', formatError(err)));
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
    ctx.handleCommand(username, message, { viaWhisper: true, inboxEntry }).catch(err => errorFor('whisper', formatError(err)));
  };

  bot.once('spawn', onFirstSpawn);
  bot.on('spawn', onSpawn);
  bot.on('end', onEnd);
  bot.on('death', onDeath);
  bot.on('entitySleep', onEntitySleep);
  bot.on('chat', onChat);
  bot.on('whisper', onWhisper);

  let combatTicking = false;
  let lastSlowMaintainAt = 0;

  const loop = setInterval(async () => {
    if (disposed || !bot.entity || bot.isAlive === false || combatTicking) return;
    combatTicking = true;
    const now = Date.now();
    try {
      watchdog.recordTick(now, {
        pos: bot.entity.position,
        moving: Boolean(bot.pathfinder?.isMoving?.()),
        digging: Boolean(bot.targetDigBlock),
        sleeping: Boolean(bot.isSleeping),
        activeTask: Boolean(tasks.active && !tasks.paused),
      });

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
          if (
            equipment.discardObsolete &&
            typeof bot.inventory?.emptySlotCount === 'function' &&
            bot.inventory.emptySlotCount() <= 3
          ) {
            await equipment.discardObsoleteItems();
          }
        }
        for (const alert of survival.checkHealthAlerts({ ownerName: config.owner })) {
          bot.chat(alert);
        }
        for (const oreAlert of mining.scanValuableOres()) {
          bot.chat(oreAlert);
        }
        if (!combat.busy && !tasks.active) {
          survival.pickupNearbyItem();
          if (!survival.busy && ctx.smelting?.hasReadyJob?.({ maxDistance: 32 })) {
            const run = tasks.run(
              { name: 'thu_lo_nung' },
              (signal) => ctx.smelting.collectReadyOutputs(signal),
              { onAbort: () => bot.pathfinder?.setGoal?.(null), priority: TASK_TIERS.BACKGROUND }
            );
            run?.promise?.catch?.(() => {});
          }
          const cond = survival.checkAutoReturnCondition({ busy: combat.busy || !!tasks.active });
          if (cond) {
            bot.chat(`Tôi tự về nhà vì ${cond.reason}.`);
            ctx.startGoHomeTask((msg) => bot.chat(msg), { background: true });
          }
        }
      }
    } catch (err) {
      errorFor('loop', err.message);
    } finally {
      combatTicking = false;
    }
  }, 250);
  loop.unref?.();

  const onError = err => errorFor('bot', formatError(err));
  const onKicked = reason => {
    if (disposed) return;
    ctx.pushInbox?.({
      kind: 'kicked',
      role: 'SYSTEM',
      username: bot.username,
      message: typeof reason === 'string' ? reason : JSON.stringify(reason),
    });
    warnFor('bot', 'Bị kick:', reason);
  };

  bot.on('error', onError);
  bot.on('kicked', onKicked);

  async function cleanup() {
    disposed = true;
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
    detach('chat', onChat);
    detach('whisper', onWhisper);
    detach('error', onError);
    detach('kicked', onKicked);
    combat.stop();
    ctx.stopCurrentTask('Ngắt kết nối', { clearQueue: true });
    if (!externalDashboard) {
      await dashboard.stop().catch(() => {});
    }
    await memory.flush().catch(() => {});
  }

  return { loop, cleanup };
}
