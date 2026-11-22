import pf from 'mineflayer-pathfinder';
const { goals } = pf;
import { SESSION_STATES } from './state_machine.js';
import { configureMovements, formatError } from './task_helpers.js';

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

  bot.once('spawn', () => {
    logFor('bot')(`✅ Bot ${bot.username} đã vào thế giới ${bot.version}`);
  });

  bot.on('spawn', () => {
    state.connected = true;
    state.disconnected = false;
    ctx.pushInbox?.({
      kind: 'spawn',
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
  });

  bot.on('end', () => {
    state.connected = false;
    state.disconnected = true;
    stateMachine.sync({ connected: false });
  });

  bot.on('death', () => {
    stateMachine.transition(SESSION_STATES.DEAD, 'Bot đã chết');
    survival.recordDeath(bot.entity, bot.game?.dimension);
    ctx.pushInbox?.({
      kind: 'death',
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
  });

  bot.on('entitySleep', (entity) => {
    if (!entity || entity.username !== config.owner) return;
    if (combat.busy || bot.isSleeping) return;
    const bed = bot.findBlock({
      matching: b => b && bot.isABed(b) && !bot.parseBedMetadata?.(b)?.occupied,
      maxDistance: 16,
    });
    if (!bed) return;
    ctx.stopCurrentTask('Ngủ cùng chủ');
    const run = tasks.run({ name: 'ngu_cung_chu' }, async (signal) => {
      if (bot.entity?.position && bed.position && bot.entity.position.distanceTo(bed.position) > 3.5) {
        await ctx.gotoSafe(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z), signal);
      }
      await bot.sleep(bed);
    }, { onAbort: () => bot.pathfinder?.setGoal(null) });
    run?.promise?.catch(() => {});
  });

  bot.on('chat', (username, message) => {
    const inboxEntry = username !== bot.username
      ? ctx.pushInbox?.({
          kind: 'chat',
          username,
          isOwner: username === config.owner,
          viaWhisper: false,
          message,
        })
      : null;
    ctx.handleCommand(username, message, { viaWhisper: false, inboxEntry }).catch(err => errorFor('chat', formatError(err)));
  });
  bot.on('whisper', (username, message) => {
    const inboxEntry = username !== bot.username
      ? ctx.pushInbox?.({
          kind: 'whisper',
          username,
          isOwner: username === config.owner,
          viaWhisper: true,
          message,
        })
      : null;
    ctx.handleCommand(username, message, { viaWhisper: true, inboxEntry }).catch(err => errorFor('whisper', formatError(err)));
  });

  let combatTicking = false;
  let lastSlowMaintainAt = 0;

  const loop = setInterval(async () => {
    if (!bot.entity || bot.isAlive === false || combatTicking) return;
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
        if (!combat.shieldActive) {
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
        if (!survival.busy && !bot.currentWindow) {
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

  async function cleanup() {
    clearInterval(loop);
    combat.stop();
    ctx.stopCurrentTask('Ngắt kết nối', { clearQueue: true });
    if (!externalDashboard) {
      await dashboard.stop().catch(() => {});
    }
    await memory.flush().catch(() => {});
  }

  bot.on('error', err => errorFor('bot', formatError(err)));
  bot.on('kicked', reason => {
    ctx.pushInbox?.({
      kind: 'kicked',
      username: bot.username,
      message: typeof reason === 'string' ? reason : JSON.stringify(reason),
    });
    warnFor('bot', 'Bị kick:', reason);
  });

  return { loop, cleanup };
}
