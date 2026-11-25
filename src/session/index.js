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
import { MotorHumanizer } from '../humanizer.js';
import { DashboardServer } from '../dashboard.js';
import { BotStateMachine } from './state_machine.js';
import { HealthWatchdog } from './health_watchdog.js';
import { createTaskHelpers } from './task_helpers.js';
import { createCommandDispatcher } from './command_dispatcher.js';
import { createChatHandler } from './chat_handler.js';
import { bindSessionEvents } from './event_dispatcher.js';
import { resolveMineflayerVersion } from '../config.js';
import { createDashboardBridge } from './dashboard_bridge.js';
import { CompanionManager } from '../companion.js';
import { WorkScratchpad } from '../scratchpad.js';
import { attachFabricModCompat } from './fabric_compat.js';
import { resolveCandidateNames } from '../survival/index.js';

export function createBotSession(config, { llm, memory, tasks, router, logger = null, createBotFn = createBot, loadPlugins = true, onConnect = null, externalDashboard = null, inboxState = null, sessionId = null } = {}) {
  const logFor = (tag) => (logger ? logger.scoped(tag) : (...a) => console.log(`[${tag}]`, ...a));
  const warnFor = (tag, ...a) => (logger ? logger.warn(tag, ...a) : console.warn(`[${tag}]`, ...a));
  const errorFor = (tag, ...a) => (logger ? logger.error(tag, ...a) : console.error(`[${tag}]`, ...a));

  const authMode = config.minecraft?.auth === 'microsoft' ? 'microsoft' : 'offline';
  const rawUsername = String(config.minecraft.username || 'bot_dong_hanh');
  const botOptions = {
    host: config.minecraft.host,
    port: config.minecraft.port,
    username: authMode === 'microsoft' ? rawUsername.slice(0, 120) : rawUsername.slice(0, 16),
    version: resolveMineflayerVersion(config.minecraft.version),
  };
  if (authMode === 'microsoft') {
    botOptions.auth = 'microsoft';
    botOptions.profilesFolder = config.minecraft.profilesFolder || 'data/auth-cache';
    botOptions.onMsaCode = (data) => {
      logFor('auth')(`🔐 Đăng nhập Microsoft cho bot: mở ${data?.verification_uri || 'https://www.microsoft.com/link'} và nhập mã ${data?.user_code || ''}`);
    };
  }
  const bot = createBotFn(botOptions);
  const fabricCompat = attachFabricModCompat(bot, { log: logFor('fabric') });

  if (loadPlugins) {
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(tool);
  }

  const state = {
    sessionId: sessionId ? String(sessionId) : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    connected: false,
    disconnected: false,
    aiPaused: false,
    activePlan: null,
    planSeq: 0,
    lastCombatEndedAt: 0,
    pendingBuild: null,
    pendingAction: null,
    pendingQuantity: null,
    chatGen: 0,
    stayPut: false,
    idleGoalActive: false,
    autoFarmEnabled: config.companion?.autoFarm !== false,
    lastMcpPollAt: 0,
    lastSidecarPollAt: 0,
    lastApiActionAt: 0,
    lastIntentionalItemGainAt: 0,
  };

  const stateMachine = new BotStateMachine();
  const watchdog = new HealthWatchdog();
  const isTemporarilyNeeded = (itemName) => {
    const activeTask = tasks?.active?.task;
    if (!activeTask) return false;
    const n = String(itemName ?? '').toLowerCase();
    if (!n) return false;
    if (activeTask.name === 'lam_ruong' || activeTask.name === 'thu_hoach_ruong') {
      return n === 'wheat_seeds' || n === 'beetroot_seeds' || n === 'carrot' || n === 'potato' || n === 'wheat' || n === 'beetroot';
    }
    if ((activeTask.name === 'lay_tai_nguyen' || activeTask.name === 'kiem_va_dua') && activeTask.target) {
      if (!activeTask._targetSet) {
        activeTask._targetSet = new Set(resolveCandidateNames(activeTask.target).map((s) => String(s).toLowerCase()));
      }
      return activeTask._targetSet.has(n) || n.includes(String(activeTask.target).toLowerCase());
    }
    return false;
  };
  const equipment = new EquipmentManager(bot, config, { log: logFor('equipment'), isTemporarilyNeeded });
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

  const humanizerOverrides = (loadPlugins === false && !config.humanizer?.preserveTestDelays)
    ? {
        lookStepMs: 0,
        gestureStepMs: 0,
        typingBaseMs: 0,
        typingMsPerChar: 0,
        maxChatDelayMs: 0,
        attackJitterMs: 0,
        strafeDurationMs: 0,
      }
    : {};
  const humanizer = new MotorHumanizer(bot, config, { overrides: humanizerOverrides });

  const combat = new CombatController(bot, config, {
    jev: (llm?.isAvailable?.() || llm?.apiKey) ? {
      chooseCombat: async (jevState) => {
        try {
          if (typeof llm.chooseCombat === 'function') {
            return await llm.chooseCombat(jevState);
          }
          const res = await llm.ask({ state: jevState, questions: {} });
          return {
            action: res?.answers?.tactic?.choice ?? 'melee',
            confidence: res?.answers?.tactic?.confidence ?? null,
            probabilities: res?.answers?.tactic?.probabilities ?? null,
            focus: res?.answers?.focus?.choice ?? null,
            danger: res?.answers?.danger?.score ?? null,
            urgentRetreat: res?.answers?.urgentRetreat?.noul ?? null,
          };
        } catch (err) {
          errorFor('jev', err.message);
          return { action: 'melee' };
        }
      },
    } : null,
    equipment,
    humanizer,
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

  mining.setShelterHold = (pos) => { combat.shelterHoldPos = pos; };

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

  const scratchpad = new WorkScratchpad(memory, { sessionId: state.sessionId });
  scratchpad.adoptCrashState(state.sessionId);

  const ctx = {
    bot,
    config,
    llm,
    memory,
    scratchpad,
    loadPlugins: Boolean(loadPlugins),
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
    humanizer,
    builder,
    macros: null,
    stateMachine,
    watchdog,
    fabricCompat,
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
  const companion = new CompanionManager(ctx, {
    enabledChat: Boolean(config.companion?.naturalChat !== false && (loadPlugins !== false || config.companion?.preserveInTests)),
    enabledIdle: Boolean(config.companion?.idleLife && (loadPlugins !== false || config.companion?.preserveInTests)),
  });
  ctx.companion = companion;

  const bridge = createDashboardBridge(ctx);
  ctx.dashboardBridge = bridge;
  ctx.reportRuntimeBug = bridge.reportRuntimeBug;
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
    onPlanExecute: bridge.onPlanExecute,
    onSmelt: bridge.onSmelt,
    onScratchpad: bridge.onScratchpad,
    onOpenDevTab: bridge.onOpenDevTab,
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
    externalDashboard.onPlanExecute = bridge.onPlanExecute;
    externalDashboard.onSmelt = bridge.onSmelt;
    externalDashboard.onScratchpad = bridge.onScratchpad;
    externalDashboard.onOpenDevTab = bridge.onOpenDevTab;
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
    humanizer,
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
    companion,
    scratchpad,
    state,
    onCommand: onDashboardCmd,
  };
}
