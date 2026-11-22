import { createBot } from 'mineflayer';
import pf from 'mineflayer-pathfinder';
const { pathfinder } = pf;
import collectblockPkg from 'mineflayer-collectblock';
const collectblock = collectblockPkg.plugin ?? collectblockPkg.collectblock ?? collectblockPkg;
import toolPkg from 'mineflayer-tool';
const tool = toolPkg.plugin ?? toolPkg.tool ?? toolPkg;
import { CombatController } from '../combat.js';
import { EquipmentManager } from '../equipment.js';
import { HomeManager } from '../home.js';
import { Builder } from '../building/index.js';
import { SurvivalManager } from '../survival/index.js';
import { CraftManager } from '../crafting.js';
import { SmeltingManager } from '../smelting.js';
import { MacroRunner, createSessionMacroHandlers } from '../skills/macro_runner.js';
import { MiningFarmingManager } from '../mining_farming.js';
import { DashboardServer } from '../dashboard.js';
import { BotStateMachine } from './state_machine.js';
import { HealthWatchdog } from './health_watchdog.js';
import { createTaskHelpers } from './task_helpers.js';
import { createCommandDispatcher } from './command_dispatcher.js';
import { createChatHandler } from './chat_handler.js';
import { bindSessionEvents } from './event_dispatcher.js';
import { createDashboardBridge } from './dashboard_bridge.js';

export function createBotSession(config, { llm, chatLlm = null, memory, tasks, router, logger = null, createBotFn = createBot, loadPlugins = true, onConnect = null, externalDashboard = null, inboxState = null } = {}) {
  const logFor = (tag) => (logger ? logger.scoped(tag) : (...a) => console.log(`[${tag}]`, ...a));
  const warnFor = (tag, ...a) => (logger ? logger.warn(tag, ...a) : console.warn(`[${tag}]`, ...a));
  const errorFor = (tag, ...a) => (logger ? logger.error(tag, ...a) : console.error(`[${tag}]`, ...a));

  const bot = createBotFn({
    host: config.minecraft.host,
    port: config.minecraft.port,
    username: String(config.minecraft.username || 'bot_dong_hanh').slice(0, 16),
    version: config.minecraft.version,
  });

  if (loadPlugins) {
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(tool);
  }

  const state = {
    connected: false,
    disconnected: false,
    aiPaused: false,
    mcpLeaseUntil: 0,
    lastCombatEndedAt: 0,
    pendingBuild: null,
    pendingAction: null,
    chatGen: 0,
  };

  const stateMachine = new BotStateMachine();
  const watchdog = new HealthWatchdog();
  const equipment = new EquipmentManager(bot, config, { log: logFor('equipment') });
  const home = new HomeManager(bot, config, { memory, log: logFor('home') });
  const isWorkPaused = () => Boolean(combat.busy || tasks.paused || survival.busy);
  const isWorkInterrupted = () => Boolean(combat.busy || tasks.paused || survival.busy || (Date.now() - state.lastCombatEndedAt < 500));
  const crafting = new CraftManager(bot, config, {
    log: logFor('craft'),
    isPaused: isWorkPaused,
    isInterrupted: isWorkInterrupted,
    home,
  });
  const smelting = new SmeltingManager(bot, config, {
    memory,
    crafting,
    log: logFor('smelt'),
    isPaused: isWorkPaused,
    isInterrupted: isWorkInterrupted,
  });
  const survival = new SurvivalManager(bot, config, { memory, home, crafting, log: logFor('survival') });
  const mining = new MiningFarmingManager(bot, config, {
    log: logFor('work'),
    ensurePickaxe: (tier, sig) => survival.ensurePickaxe(tier, sig),
    isPaused: isWorkPaused,
    isInterrupted: isWorkInterrupted,
  });

  const combat = new CombatController(bot, config, {
    jev: llm?.apiKey ? {
      chooseCombat: async (jevState) => {
        const questions = {
          tactic: {
            type: 'choice',
            instructions: 'Chọn chiến thuật combat phù hợp nhất hiện tại.',
            criteria: {
              melee: 'Tấn công cận chiến bằng kiếm/rìu khi ở gần và an toàn.',
              shield: 'Giơ khiên chặn nguy hiểm, đặc biệt creeper ở gần (< 4 block) hoặc bị bắn xa.',
              bow: 'Bắn cung từ khoảng cách xa (> 4 block) khi có cung và tên.',
              retreat: 'Rút lui khi máu thấp hoặc bị đông quái bao vây.',
              idle: 'Không hành động, quan sát.',
            },
          },
          focus: {
            type: 'choice',
            instructions: 'Nên ưu tiên xử lý mối đe dọa nào trước?',
            criteria: {
              creeper: 'Creeper ở gần sắp nổ.',
              ranged: 'Quái bắn xa như skeleton, pillager, blaze.',
              hurting_owner: 'Quái đang đứng gần hoặc tấn công chủ nhân.',
              closest: 'Quái đứng gần bot nhất.',
            },
          },
          danger: {
            type: 'score',
            instructions: 'Đánh giá mức độ nguy hiểm hiện tại của bot.',
            criteria: ['low', 'medium', 'high', 'critical'],
          },
          urgentRetreat: {
            type: 'noul',
            instructions: 'Tình huống có quá nguy hiểm đến mức phải rút lui ngay lập tức không?',
            criteria: { true: 'Rất nguy hiểm, cần rút lui.', false: 'Vẫn kiểm soát được.' },
          },
        };
        try {
          const res = await llm.ask({ state: jevState, questions });
          return {
            action: res.answers?.tactic?.choice ?? 'melee',
            confidence: res.answers?.tactic?.confidence ?? null,
            probabilities: res.answers?.tactic?.probabilities ?? null,
            focus: res.answers?.focus?.choice ?? null,
            danger: res.answers?.danger?.score ?? null,
            urgentRetreat: res.answers?.urgentRetreat?.noul ?? null,
          };
        } catch (err) {
          errorFor('jev', err.message);
          return { action: 'melee' };
        }
      },
    } : null,
    equipment,
    isEating: () => survival.eating,
    onBusyChange: ({ busy }) => {
      if (busy) {
        tasks.pause();
      } else {
        state.lastCombatEndedAt = Date.now();
        tasks.resume();
      }
    },
    log: logFor('combat'),
  });

  const builder = new Builder(bot, config, {
    log: logFor('building'),
    equipment,
    memory,
    isPaused: isWorkPaused,
    isInterrupted: isWorkInterrupted,
  });

  combat.start();

  const inbox = inboxState ?? { seq: 0, items: [] };
  const pushInbox = (entry) => {
    inbox.seq += 1;
    const item = { id: inbox.seq, time: Date.now(), ...entry };
    inbox.items.push(item);
    if (inbox.items.length > 100) {
      inbox.items.splice(0, inbox.items.length - 100);
    }
    return item;
  };

  const ctx = {
    bot,
    config,
    llm,
    chatLlm,
    memory,
    tasks,
    router,
    logger,
    equipment,
    home,
    crafting,
    smelting,
    survival,
    mining,
    combat,
    builder,
    macros: null,
    stateMachine,
    watchdog,
    externalDashboard,
    dashboard: null,
    isWorkPaused,
    logFor,
    warnFor,
    errorFor,
    nonOwnerRepliedAt: new Map(),
    chatHistory: [],
    inboxState: inbox,
    pushInbox,
    state,
  };

  Object.assign(ctx, createTaskHelpers(ctx));
  const macros = new MacroRunner(createSessionMacroHandlers(ctx), { log: logFor('macro') });
  ctx.macros = macros;
  Object.assign(ctx, createChatHandler(ctx));
  Object.assign(ctx, createCommandDispatcher(ctx));

  const bridge = createDashboardBridge(ctx);
  const getDashboardState = bridge.getDashboardState;
  const onDashboardCmd = bridge.onCommand;

  const dashboard = externalDashboard ?? new DashboardServer({
    host: config.dashboard?.host ?? '127.0.0.1',
    port: config.dashboard?.port ?? 3000,
    authToken: config.dashboard?.token ?? null,
    log: logFor('web'),
    getState: getDashboardState,
    onCommand: onDashboardCmd,
    onConnect,
    onControl: bridge.onControl,
    onInventoryAction: bridge.onInventoryAction,
    onGetNearby: bridge.getNearby,
    getInbox: bridge.getInbox,
    onSay: bridge.onSay,
    onMacro: bridge.onMacro,
    onMcpActivity: bridge.touchMcpLease,
  });
  ctx.dashboard = dashboard;

  if (externalDashboard) {
    externalDashboard.getState = getDashboardState;
    externalDashboard.onCommand = onDashboardCmd;
    externalDashboard.onControl = bridge.onControl;
    externalDashboard.onInventoryAction = bridge.onInventoryAction;
    externalDashboard.onGetNearby = bridge.getNearby;
    externalDashboard.getInbox = bridge.getInbox;
    externalDashboard.onSay = bridge.onSay;
    externalDashboard.onMacro = bridge.onMacro;
    externalDashboard.onMcpActivity = bridge.touchMcpLease;
    if (onConnect) externalDashboard.onConnect = onConnect;
  } else if (config.dashboard?.enabled && loadPlugins !== false) {
    dashboard.start().catch(err => errorFor('web', err.message));
  }

  const { cleanup } = bindSessionEvents(ctx);

  return {
    bot,
    cleanup,
    survival,
    combat,
    equipment,
    home,
    builder,
    crafting,
    smelting,
    macros,
    mining,
    dashboard,
    stateMachine,
    watchdog,
    onCommand: onDashboardCmd,
  };
}
