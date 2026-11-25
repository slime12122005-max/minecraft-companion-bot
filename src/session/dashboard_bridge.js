import { getDurabilityRatio } from '../equipment.js';
import { summarizeReadiness } from '../readiness.js';
import { BUILTIN_MACROS } from '../skills/macro_runner.js';

const NOTABLE_STATION_BLOCKS = new Set([
  'ancient_debris',
  'crafting_table',
  'furnace',
  'blast_furnace',
  'smoker',
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest',
  'enchanting_table',
  'anvil',
  'chipped_anvil',
  'damaged_anvil',
]);

function isNotableBlockName(name) {
  const n = String(name ?? '').toLowerCase();
  if (!n) return false;
  if (NOTABLE_STATION_BLOCKS.has(n)) return true;
  return n.endsWith('_ore') || n.endsWith('_bed') || n.endsWith('_log') || n.endsWith('_stem');
}

function splitChatChunks(msg, maxLen = 240) {
  const chunks = [];
  let remaining = String(msg ?? '').trim();
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf(', ', maxLen);
    if (cut < 80) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut < 40) cut = maxLen;
    else if (remaining[cut] === ',') cut += 1;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function formatSlotEntry(item) {
  if (!item) return null;
  return {
    name: item.name,
    durabilityRatio: Number(getDurabilityRatio(item).toFixed(3)),
  };
}

function resolveEquipDestination(itemName) {
  const n = String(itemName || '').toLowerCase();
  if (n.endsWith('_helmet')) return 'head';
  if (n.endsWith('_chestplate') || n === 'elytra') return 'torso';
  if (n.endsWith('_leggings')) return 'legs';
  if (n.endsWith('_boots')) return 'feet';
  if (n === 'shield' || n === 'totem_of_undying') return 'off-hand';
  return 'hand';
}

export function createDashboardBridge(ctx) {
  const {
    bot,
    config,
    llm,
    memory,
    tasks,
    equipment,
    home,
    combat,
    stateMachine,
    watchdog,
    logger,
    logFor,
    state,
  } = ctx;

  function buildCompactNearbySummary() {
    const posRaw = bot.entity?.position;
    if (!posRaw) return null;
    try {
      const blockHighlights = new Set();
      if (typeof bot.findBlocks === 'function' && bot.registry?.blocksByName) {
        const notableIds = [];
        for (const [bName, info] of Object.entries(bot.registry.blocksByName)) {
          if (info?.id && (isNotableBlockName(bName) || bName === 'stone' || bName === 'water')) {
            notableIds.push(info.id);
          }
        }
        if (notableIds.length > 0) {
          const hits = bot.findBlocks({ matching: notableIds, maxDistance: 18, count: 32 }) ?? [];
          for (const hp of hits) {
            const blk = bot.blockAt?.(hp);
            if (blk?.name) blockHighlights.add(blk.name);
            if (blockHighlights.size >= 8) break;
          }
        }
      }

      const mobCounts = new Map();
      for (const e of Object.values(bot.entities ?? {})) {
        if (!e?.position || e === bot.entity || e.type === 'player' || e.name === 'item') continue;
        const d = Math.hypot(e.position.x - posRaw.x, e.position.y - posRaw.y, e.position.z - posRaw.z);
        if (d > 20 || !e.name) continue;
        mobCounts.set(e.name, (mobCounts.get(e.name) ?? 0) + 1);
      }

      const ownerEnt = bot.players?.[config.owner]?.entity ?? null;
      const ownerDist = ownerEnt?.position
        ? Math.round(Math.hypot(ownerEnt.position.x - posRaw.x, ownerEnt.position.y - posRaw.y, ownerEnt.position.z - posRaw.z))
        : null;

      return {
        ownerDistance: ownerDist,
        blocks: [...blockHighlights].slice(0, 8),
        entities: [...mobCounts.entries()].slice(0, 6).map(([name, count]) => `${name}x${count}`),
      };
    } catch {
      return null;
    }
  }

  function getDashboardState() {
    const slots = bot.inventory?.slots ?? [];
    const rawItems = bot.inventory?.items?.() ?? [];
    const timeOfDay = bot.time?.timeOfDay ?? null;
    const isDay = bot.time?.isDay ?? (timeOfDay != null ? timeOfDay < 12000 : null);
    const jevAvailable = Boolean(llm?.isAvailable?.() || llm?.apiKey);

    return {
      sessionId: state.sessionId,
      username: bot.username,
      connected: state.connected,
      aiPaused: Boolean(state.aiPaused),
      state: stateMachine.snapshot().state,
      watchdog: watchdog.status(),
      lan: {
        host: config.minecraft.host,
        port: config.minecraft.port,
        owner: config.owner,
        version: bot.version || (config.minecraft.version === false ? 'auto' : config.minecraft.version),
        worldName: config.minecraft.worldName ?? null,
      },
      health: bot.health ?? 20,
      food: bot.food ?? 20,
      xp: {
        level: bot.experience?.level ?? 0,
        progress: Number((bot.experience?.progress ?? 0).toFixed(3)),
        points: bot.experience?.points ?? 0,
      },
      timeOfDay,
      isDay,
      position: bot.entity?.position ? {
        x: Math.round(bot.entity.position.x),
        y: Math.round(bot.entity.position.y),
        z: Math.round(bot.entity.position.z),
      } : null,
      task: tasks.status().active?.name ?? 'rảnh',
      taskQueue: tasks.status(),
      equipped: equipment.status().equipped,
      equipmentSlots: {
        head: formatSlotEntry(slots[5] ?? null),
        torso: formatSlotEntry(slots[6] ?? null),
        legs: formatSlotEntry(slots[7] ?? null),
        feet: formatSlotEntry(slots[8] ?? null),
        offHand: formatSlotEntry(slots[45] ?? null),
        hand: formatSlotEntry(bot.heldItem ?? null),
      },
      armorMitigation: typeof equipment.armorMitigation === 'function' ? equipment.armorMitigation() : 0,
      lowDurability: typeof equipment.getLowDurabilityItems === 'function' ? equipment.getLowDurabilityItems(0.10) : [],
      inventory: rawItems.slice(0, 36).map(i => ({
        name: i.name,
        count: i.count,
        slot: i.slot ?? null,
        durabilityRatio: Number(getDurabilityRatio(i).toFixed(3)),
      })),
      readiness: summarizeReadiness(rawItems, { minFoodPoints: config.survival?.minFoodPoints ?? 20 }),
      chests: home.listChestInventory(),
      nearbySummary: buildCompactNearbySummary(),
      recentChat: Array.isArray(ctx.chatHistory) ? ctx.chatHistory.slice(-5) : [],
      pois: typeof memory?.queryPois === 'function' ? memory.queryPois({ limit: 40 }) : [],
      smeltingJobs: Object.fromEntries(ctx.smelting?.activeJobs ?? []),
      activePlan: state.activePlan ?? null,
      scratchpad: ctx.scratchpad?.snapshot?.() ?? null,
      ownerStyle: ctx.companion?.getOwnerPronounStyle?.() ?? null,
      brains: {
        planner: 'Antigravity (MCP)',
        agentModel: config.companion?.agentModel ?? 'gemini-4-hydrogen-low',
        tacticalSupport: jevAvailable ? `Jev (${llm.model ?? 'jev-latest'})` : 'Local Reflex',
        system1: jevAvailable ? `jev/${llm.model ?? 'jev-latest'}` : 'local-reflex',
        system2: 'antigravity-mcp',
      },
      aiStats: typeof llm?.stats === 'function' ? llm.stats() : null,
      jev: combat.lastJevTelemetry,
      threat: combat.lastThreatAssessment ?? null,
      logs: logger ? logger.recent(40) : [],
    };
  }

  async function onCommand(cmd) {
    state.lastApiActionAt = Date.now();
    const routed = ctx.router?.route ? ctx.router.route(cmd) : null;
    await ctx.handleCommand(config.owner, cmd, { viaWhisper: false, fromApi: true });
    return {
      parsedType: routed?.command?.type ?? 'unknown',
      tier: routed?.tier ?? null,
      activeTask: tasks.status().active?.name ?? 'rảnh',
    };
  }

  function getNearby({ radius = 24 } = {}) {
    const r = Math.max(1, Math.min(64, Number(radius) || 24));
    const posRaw = bot?.entity?.position;
    const hasPos = posRaw
      && Number.isFinite(posRaw.x)
      && Number.isFinite(posRaw.y)
      && Number.isFinite(posRaw.z);

    if (!hasPos) {
      return {
        connected: Boolean(state.connected),
        position: null,
        dimension: bot?.game?.dimension ?? null,
        ownerPosition: null,
        players: [],
        mobs: [],
        items: [],
        blocks: {},
      };
    }

    const pos = {
      x: Math.round(posRaw.x),
      y: Math.round(posRaw.y),
      z: Math.round(posRaw.z),
    };

    const players = [];
    const mobs = [];
    const items = [];
    let ownerPosition = null;

    for (const e of Object.values(bot.entities ?? {})) {
      if (!e || e === bot.entity || (e.username && e.username === bot.username)) continue;
      const ep = e.position;
      if (!ep || !Number.isFinite(ep.x) || !Number.isFinite(ep.y) || !Number.isFinite(ep.z)) continue;
      const rawDist = Math.hypot(ep.x - posRaw.x, ep.y - posRaw.y, ep.z - posRaw.z);
      if (rawDist > r) continue;

      const rounded = {
        x: Math.round(ep.x),
        y: Math.round(ep.y),
        z: Math.round(ep.z),
      };
      const distance = Number(rawDist.toFixed(1));

      if (e.type === 'player') {
        const username = e.username ?? e.name ?? 'player';
        players.push({ username, position: rounded, distance });
        if (username === config.owner) {
          ownerPosition = rounded;
        }
      } else if (
        e.type === 'object' ||
        e.name === 'item' ||
        String(e.displayName ?? '').toLowerCase() === 'item'
      ) {
        items.push({ name: e.displayName ?? e.name ?? 'item', position: rounded, distance });
      } else {
        mobs.push({
          name: e.name ?? e.displayName ?? 'entity',
          type: e.type ?? 'mob',
          kind: e.kind ?? null,
          position: rounded,
          distance,
        });
      }
    }

    players.sort((a, b) => a.distance - b.distance);
    mobs.sort((a, b) => a.distance - b.distance);
    items.sort((a, b) => a.distance - b.distance);

    const blocks = {};
    if (typeof bot.findBlocks === 'function' && typeof bot.blockAt === 'function') {
      try {
        const found = bot.findBlocks({
          matching: (b) => Boolean(b && isNotableBlockName(b.name)),
          maxDistance: Math.min(r, 32),
          count: 128,
        }) ?? [];
        for (const bp of found) {
          if (!bp || !Number.isFinite(bp.x) || !Number.isFinite(bp.y) || !Number.isFinite(bp.z)) continue;
          const blk = bot.blockAt(bp);
          if (!blk?.name) continue;
          const bd = Number(Math.hypot(bp.x - posRaw.x, bp.y - posRaw.y, bp.z - posRaw.z).toFixed(1));
          const existing = blocks[blk.name];
          const nearestCandidate = {
            x: Math.round(bp.x),
            y: Math.round(bp.y),
            z: Math.round(bp.z),
            distance: bd,
          };
          if (!existing) {
            blocks[blk.name] = { count: 1, nearest: nearestCandidate };
          } else {
            existing.count += 1;
            if (bd < existing.nearest.distance) {
              existing.nearest = nearestCandidate;
            }
          }
        }
      } catch {}
    }

    return {
      connected: Boolean(state.connected || bot.entity),
      position: pos,
      dimension: bot.game?.dimension ?? null,
      ownerPosition,
      players: players.slice(0, 20),
      mobs: mobs.slice(0, 25),
      items: items.slice(0, 15),
      blocks,
    };
  }

  function getInbox({ sinceId = 0, limit = 30, source = null } = {}) {
    state.lastMcpPollAt = Date.now();
    if (source === 'sidecar') {
      state.lastSidecarPollAt = Date.now();
    }
    const inbox = ctx.inboxState ?? { seq: 0, items: [] };
    const rawSince = Number(sinceId);
    const cleanSince = Number.isInteger(rawSince) && rawSince >= 0 ? rawSince : 0;
    const rawLimit = Number(limit);
    const cleanLimit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.max(1, Math.min(100, Math.floor(rawLimit)))
      : 30;
    const messages = (inbox.items ?? [])
      .filter(item => item.id > cleanSince)
      .slice(-cleanLimit)
      .map((item) => {
        if (item.role) return item;
        const isChat = item.kind === 'chat' || item.kind === 'whisper';
        const role = isChat
          ? (item.isOwner ? 'OWNER_TRUSTED' : 'UNTRUSTED_PUBLIC_PLAYER')
          : 'SYSTEM';
        return { ...item, role };
      });
    return {
      sessionId: state.sessionId,
      latestId: inbox.seq ?? 0,
      messages,
    };
  }

  async function onSay({ message, whisperTo = null, instant = false } = {}) {
    const text = String(message ?? '').trim();
    if (!text) {
      return { ok: false, status: 400, error: 'message required' };
    }
    const canSend = !state.disconnected && (state.connected || Boolean(bot.entity));
    if (!canSend) {
      return { ok: false, status: 409, error: 'Bot chưa kết nối vào server' };
    }
    state.lastApiActionAt = Date.now();
    if (!instant && ctx.humanizer?.waitTypingDelay) {
      await ctx.humanizer.waitTypingDelay(text, {
        urgent: Boolean(combat?.busy),
        ownerEntity: bot.players?.[config.owner]?.entity ?? null,
        canMoveHead: !combat?.busy && !bot.targetDigBlock && !bot.currentWindow,
      });
    }
    const target = whisperTo ? String(whisperTo).trim().slice(0, 16) : null;
    const chunks = splitChatChunks(text, 240);
    for (const chunk of chunks) {
      if (target) bot.whisper?.(target, chunk);
      else bot.chat?.(chunk);
    }
    ctx.pushChatHistory?.('assistant', text);
    logFor?.('mcp-say')?.(target ? `-> ${target}: ${text}` : text);
    return {
      ok: true,
      sent: chunks,
      whisperTo: target || null,
    };
  }

  async function onControl({ action }) {
    const webLog = logFor?.('web') ?? (() => {});
    if (action === 'toggle_ai' || action === 'pause_ai' || action === 'resume_ai') {
      const nextPaused = action === 'pause_ai'
        ? true
        : (action === 'resume_ai' ? false : !state.aiPaused);
      state.aiPaused = nextPaused;
      if (nextPaused) {
        tasks.pause('Emergency AI Pause');
        combat.stop();
        bot.pathfinder?.setGoal?.(null);
        webLog('⏸ AI đã được tạm dừng từ Dashboard.');
      } else {
        combat.start();
        tasks.resume();
        webLog('▶ AI đã được kích hoạt lại từ Dashboard.');
      }
      return { aiPaused: state.aiPaused };
    }

    if (action === 'recall_home') {
      if (state.aiPaused) {
        state.aiPaused = false;
        combat.start();
      }
      const started = ctx.startGoHomeTask((msg) => bot.chat?.(msg));
      webLog('🏠 Đã kích hoạt lệnh về nhà khẩn cấp từ Dashboard.');
      return { started };
    }

    if (action === 'safe_disconnect') {
      ctx.stopCurrentTask('Safe disconnect', { clearQueue: true });
      combat.stop();
      await memory?.flush?.().catch(() => {});
      webLog('🔌 Ngắt kết nối an toàn từ Dashboard.');
      bot.quit?.('Safe disconnect');
      return { disconnected: true };
    }

    return { ok: false };
  }

  async function onInventoryAction({ action, itemName, slot = null }) {
    const items = bot.inventory?.items?.() ?? [];
    const target = (slot != null ? items.find(i => i.slot === slot && i.name === itemName) : null)
      ?? items.find(i => i.name === itemName);
    if (!target) {
      return { ok: false, message: 'Không tìm thấy vật phẩm' };
    }

    if (action === 'equip') {
      const dest = resolveEquipDestination(target.name);
      await bot.equip?.(target, dest);
      return { ok: true, equipped: target.name, destination: dest };
    }

    if (action === 'drop') {
      if (typeof bot.tossStack === 'function') {
        await bot.tossStack(target);
      } else if (typeof bot.toss === 'function') {
        await bot.toss(target.type, null, target.count);
      }
      return { ok: true, dropped: target.name, count: target.count };
    }

    return { ok: false, message: 'Thao tác không hợp lệ' };
  }

  async function onMacro({ macro, wait = true, resumingRecovery = false } = {}) {
    state.lastApiActionAt = Date.now();
    const name = String(macro ?? '').trim();
    if (!BUILTIN_MACROS[name]) {
      return { ok: false, status: 400, error: `Unknown macro: ${name}` };
    }
    if (!ctx.macros?.run) {
      return { ok: false, status: 503, error: 'Macro runner chưa sẵn sàng' };
    }
    ctx.stopCurrentTask?.(`Macro ${name}`);
    ctx.scratchpad?.startMacro?.({ macro: name, resumingRecovery: Boolean(resumingRecovery) });
    const run = tasks.run(
      { name: `macro_${name}`, reason: `Macro ${name}` },
      async (signal) => {
        const res = await ctx.macros.run(name, signal);
        if (!signal.aborted && res?.ok) {
          ctx.scratchpad?.completeActive?.();
        }
        return res;
      },
      { onAbort: () => bot.pathfinder?.setGoal?.(null) }
    );
    if (!run) {
      return { ok: false, status: 409, error: 'Không thể khởi chạy macro vì tác vụ hiện tại đang bận' };
    }
    if (wait === false) {
      run.promise.catch(() => {});
      return { ok: true, status: 'ACCEPTED', macro: name };
    }
    const res = await run.promise;
    return { ok: Boolean(res?.ok), macro: name, ...res };
  }

  async function onPlanExecute({ goal = '', steps = [], onDanger = 'pause_and_resume', wait = true, resumingRecovery = false } = {}) {
    state.lastApiActionAt = Date.now();
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 10) {
      return { ok: false, status: 400, error: 'steps must be an array with 1..10 items' };
    }
    const validTypes = new Set(['command', 'macro', 'smelt', 'say']);
    for (const s of steps) {
      if (!s || typeof s !== 'object' || !validTypes.has(s.type)) {
        return { ok: false, status: 400, error: `Invalid plan step type: ${s?.type ?? 'unknown'}` };
      }
    }

    state.planSeq = (state.planSeq || 0) + 1;
    const planId = `plan_${state.planSeq}`;
    const cleanGoal = String(goal ?? '').trim();
    const dangerMode = onDanger === 'abort_and_notify' ? 'abort_and_notify' : 'pause_and_resume';

    ctx.stopCurrentTask?.(`Kế hoạch Antigravity: ${cleanGoal || planId}`);
    ctx.scratchpad?.startPlan?.({
      goal: cleanGoal || planId,
      steps,
      resumingRecovery: Boolean(resumingRecovery),
    });
    const run = tasks.run(
      { name: `plan_${planId}`, reason: cleanGoal || 'Kế hoạch Antigravity' },
      async (signal) => {
        const completedSteps = [];
        state.activePlan = {
          id: planId,
          goal: cleanGoal,
          totalSteps: steps.length,
          currentStep: 0,
          status: 'running',
          startedAt: Date.now(),
        };
        try {
          for (let i = 0; i < steps.length; i++) {
            if (signal.aborted) {
              const abortedRes = { ok: false, planId, goal: cleanGoal, failedStep: i, reason: 'ABORTED', completedSteps };
              ctx.pushInbox?.({ kind: 'plan_failed', role: 'SYSTEM', username: bot.username, message: `Kế hoạch ${planId} bị hủy`, ...abortedRes });
              return abortedRes;
            }
            if (dangerMode === 'abort_and_notify' && combat.busy && (bot.health ?? 20) <= 10) {
              const dangerRes = { ok: false, planId, goal: cleanGoal, failedStep: i, reason: 'DANGER_ABORT', completedSteps };
              ctx.pushInbox?.({ kind: 'alert', role: 'SYSTEM', severity: 'critical', username: bot.username, message: `Dừng kế hoạch ${planId} vì nguy hiểm (máu ${Math.round(bot.health ?? 20)}/20)`, planId });
              ctx.pushInbox?.({ kind: 'plan_failed', role: 'SYSTEM', username: bot.username, message: `Kế hoạch ${planId} dừng vì nguy hiểm`, ...dangerRes });
              return dangerRes;
            }

            state.activePlan.currentStep = i + 1;
            const step = steps[i];

            if (step.type === 'command') {
              const cmdText = String(step.command ?? '').trim();
              if (!cmdText) {
                const badRes = { ok: false, planId, goal: cleanGoal, failedStep: i, reason: 'EMPTY_COMMAND', completedSteps };
                ctx.pushInbox?.({ kind: 'plan_failed', role: 'SYSTEM', username: bot.username, message: `Kế hoạch ${planId} lỗi bước #${i}: lệnh rỗng`, ...badRes });
                return badRes;
              }
              const parsed = ctx.router?.parseChain ? ctx.router.parseChain(cmdText) : ctx.router?.parse?.(cmdText);
              if (!parsed || parsed.type === 'unknown') {
                const badRes = { ok: false, planId, goal: cleanGoal, failedStep: i, reason: `UNKNOWN_COMMAND: ${cmdText}`, completedSteps };
                ctx.pushInbox?.({ kind: 'plan_failed', role: 'SYSTEM', username: bot.username, message: `Kế hoạch ${planId} không hiểu lệnh "${cmdText}"`, ...badRes });
                return badRes;
              }
              const notes = [];
              await ctx.dispatchParsedCommand(parsed, config.owner, (t) => notes.push(t), signal, {
                userMessage: cmdText,
                fromApi: true,
                suppressStart: true,
                onOutcome: (t) => notes.push(t),
              });
              completedSteps.push({ step: i, type: 'command', command: cmdText, notes });
              if (!signal.aborted) ctx.scratchpad?.markPlanStepDone?.(i);
            } else if (step.type === 'macro') {
              const macroRes = await ctx.macros?.run?.(step.macro, signal);
              if (!macroRes?.ok) {
                const failRes = { ok: false, planId, goal: cleanGoal, failedStep: i, reason: macroRes?.reason || macroRes?.error || 'MACRO_FAILED', completedSteps };
                ctx.pushInbox?.({ kind: 'plan_failed', role: 'SYSTEM', username: bot.username, message: `Kế hoạch ${planId} dừng ở macro ${step.macro}: ${failRes.reason}`, ...failRes });
                return failRes;
              }
              completedSteps.push({ step: i, type: 'macro', macro: step.macro, detail: macroRes });
              if (!signal.aborted) ctx.scratchpad?.markPlanStepDone?.(i);
            } else if (step.type === 'smelt') {
              if (!ctx.smelting) {
                const failRes = { ok: false, planId, goal: cleanGoal, failedStep: i, reason: 'SMELTING_UNAVAILABLE', completedSteps };
                ctx.pushInbox?.({ kind: 'plan_failed', role: 'SYSTEM', username: bot.username, message: `Kế hoạch ${planId} thiếu SmeltingManager`, ...failRes });
                return failRes;
              }
              const smeltRes = step.action === 'collect'
                ? await ctx.smelting.collectReadyOutputs(signal, { force: Boolean(step.force) })
                : await ctx.smelting.startSmelting(step.target, step.count ?? 1, signal);
              if (smeltRes?.ok === false) {
                const failRes = { ok: false, planId, goal: cleanGoal, failedStep: i, reason: smeltRes.reason || 'SMELT_FAILED', completedSteps };
                ctx.pushInbox?.({ kind: 'plan_failed', role: 'SYSTEM', username: bot.username, message: `Kế hoạch ${planId} lỗi nung: ${failRes.reason}`, ...failRes });
                return failRes;
              }
              completedSteps.push({ step: i, type: 'smelt', action: step.action || 'start', detail: smeltRes });
              if (!signal.aborted) ctx.scratchpad?.markPlanStepDone?.(i);
            } else if (step.type === 'say') {
              const sayRes = await onSay({ message: step.message, whisperTo: step.whisperTo ?? null });
              completedSteps.push({ step: i, type: 'say', detail: sayRes });
              if (!signal.aborted) ctx.scratchpad?.markPlanStepDone?.(i);
            }
          }

          if (!signal.aborted) ctx.scratchpad?.completeActive?.();
          const doneRes = { ok: true, planId, goal: cleanGoal, completedSteps };
          ctx.pushInbox?.({
            kind: 'plan_completed',
            role: 'SYSTEM',
            username: bot.username,
            message: `Hoàn thành kế hoạch ${planId}${cleanGoal ? `: ${cleanGoal}` : ''}`,
            ...doneRes,
          });
          return doneRes;
        } finally {
          state.activePlan = null;
        }
      },
      { onAbort: () => bot.pathfinder?.setGoal?.(null) }
    );

    if (!run) {
      return { ok: false, status: 409, error: 'Không thể chạy kế hoạch vì tác vụ hiện tại đang bận' };
    }
    if (wait === false) {
      run.promise.catch(() => {});
      return { ok: true, status: 'ACCEPTED', planId, goal: cleanGoal, totalSteps: steps.length };
    }
    return await run.promise;
  }

  async function onSmelt({ action = 'status', target = '', count = 1, force = false } = {}) {
    state.lastApiActionAt = Date.now();
    if (!ctx.smelting) {
      return { ok: false, status: 503, error: 'Smelting manager chưa sẵn sàng' };
    }
    const act = String(action || 'status').trim();
    if (act === 'status') {
      const jobs = [...ctx.smelting.activeJobs.entries()].map(([posKey, job]) => ({ posKey, ...job }));
      return { ok: true, action: 'status', jobs };
    }
    if (act === 'collect') {
      const res = await ctx.smelting.collectReadyOutputs(null, { force: Boolean(force) });
      return { ok: true, action: 'collect', ...res };
    }
    if (act === 'start') {
      const cleanTarget = String(target ?? '').trim();
      if (!cleanTarget) {
        return { ok: false, status: 400, error: 'target required for smelt start' };
      }
      const res = await ctx.smelting.startSmelting(cleanTarget, Math.max(1, Number(count) || 1));
      return { ok: Boolean(res?.ok), action: 'start', ...res };
    }
    return { ok: false, status: 400, error: `Invalid smelt action: ${act}` };
  }

  async function onScratchpad({ action = 'get', goal = '', steps = [], note = '' } = {}) {
    const act = String(action || 'get').trim();
    if (act === 'get') {
      return {
        ok: true,
        action: 'get',
        scratchpad: ctx.scratchpad?.snapshot?.() ?? null,
        summary: ctx.scratchpad?.formatRecoverySummary?.({ ownerName: config.owner }) ?? null,
      };
    }
    state.lastApiActionAt = Date.now();
    if (act === 'set') {
      const snap = ctx.scratchpad?.setManualTask?.({ goal, steps, note }) ?? null;
      return { ok: true, action: 'set', scratchpad: snap };
    }
    if (act === 'clear') {
      const snap = ctx.scratchpad?.clearAll?.() ?? null;
      return { ok: true, action: 'clear', scratchpad: snap };
    }
    if (act === 'resume') {
      const hadRecovery = Boolean(ctx.scratchpad?.hasRecovery?.());
      const notes = [];
      await ctx.dispatchParsedCommand?.(
        { type: 'scratchpad_resume' },
        config.owner,
        (t) => notes.push(t),
        null,
        { fromApi: true }
      );
      return {
        ok: true,
        action: 'resume',
        resumed: hadRecovery,
        notes,
        scratchpad: ctx.scratchpad?.snapshot?.() ?? null,
      };
    }
    return { ok: false, status: 400, error: `Invalid scratchpad action: ${act}` };
  }

  const devBugCooldown = new Map();
  let pendingDevTaskCount = 0;

  async function onOpenDevTab({
    action = 'open',
    status = 'passed',
    kind = 'add_local_js',
    title = '',
    summary = '',
    userPhrase = '',
    errorDetail = '',
    targetFiles = [],
  } = {}) {
    if (action === 'complete') {
      pendingDevTaskCount = Math.max(0, pendingDevTaskCount - 1);
      const devStatus = status === 'failed' ? 'failed' : 'passed';
      const cleanSummary = String(summary ?? 'done').trim().slice(0, 600);
      const shouldSelfDelete = devStatus === 'passed' && pendingDevTaskCount === 0;
      ctx.pushInbox?.({
        kind: 'dev_task_done',
        role: 'SYSTEM',
        username: bot.username,
        devStatus,
        remainingTasks: pendingDevTaskCount,
        summary: cleanSummary,
        message: `[Auto-Dev complete: ${devStatus}] ${cleanSummary}`.trim(),
      });
      logFor?.('antigravity')?.(
        `✅ Tab Orchestrator báo xong (${devStatus}, còn ${pendingDevTaskCount} việc${shouldSelfDelete ? ', tự xóa tab' : ''}).`
      );
      return {
        ok: true,
        completed: true,
        status: devStatus,
        remainingTasks: pendingDevTaskCount,
        shouldSelfDelete,
      };
    }

    const cleanKind = kind === 'fix_bug' ? 'fix_bug' : 'add_local_js';
    const cleanTitle = String(title ?? '').trim().slice(0, 140);
    const cleanSummary = String(summary ?? '').trim().slice(0, 1200);
    if (!cleanTitle || !cleanSummary) {
      return { ok: false, status: 400, error: 'title and summary required' };
    }
    const cleanPhrase = String(userPhrase ?? '').trim().slice(0, 300) || null;
    const cleanError = String(errorDetail ?? '').trim().slice(0, 600) || null;
    const cleanFiles = Array.isArray(targetFiles)
      ? targetFiles.slice(0, 8).map(f => String(f ?? '').trim()).filter(Boolean)
      : [];
    const signature = `${cleanKind}:${cleanTitle.toLowerCase()}`;
    const now = Date.now();
    const prevAt = devBugCooldown.get(signature) ?? 0;
    if (now - prevAt < 600000) {
      return { ok: true, queued: false, deduplicated: true, signature };
    }
    if (pendingDevTaskCount >= 5) {
      return { ok: true, queued: false, throttled: true, reason: 'queue_full', signature };
    }
    devBugCooldown.set(signature, now);
    pendingDevTaskCount += 1;

    ctx.pushInbox?.({
      kind: 'dev_task',
      devKind: cleanKind,
      role: 'SYSTEM',
      username: bot.username,
      title: cleanTitle,
      summary: cleanSummary,
      userPhrase: cleanPhrase,
      errorDetail: cleanError,
      targetFiles: cleanFiles,
      signature,
      message: `[Auto-Dev ${cleanKind}] ${cleanTitle}: ${cleanSummary}`,
    });
    logFor?.('antigravity')?.(`🛠️ Đã xếp hàng vào tab Orchestrator (${cleanKind}): ${cleanTitle}`);
    return {
      ok: true,
      queued: true,
      devKind: cleanKind,
      signature,
      pendingTasks: pendingDevTaskCount,
      model: config.companion?.devAgentModel ?? 'gemini-4-carbon-high',
      profile: config.companion?.devAgentProfile ?? 'orchestrator',
    };
  }

  function reportRuntimeBug({ source = 'runtime', error = null, context = '' } = {}) {
    if (config.companion?.autoDevTab === false || ctx.loadPlugins === false) return false;
    const errMsg = String(error?.message ?? error ?? '').trim();
    const errName = String(error?.name ?? '').trim();
    if (!errMsg) return false;

    // Skip expected transient/operational conditions
    if (
      /^(?:Đã hủy|Timeout|NoPath|GoalChanged|PathStopped|ECONNREFUSED|ECONNRESET|ETIMEDOUT)/i.test(errMsg) ||
      /^(?:Timeout|NoPath|GoalChanged|PathStopped)$/i.test(errName) ||
      /Không có nguyên liệu|Thiếu nguyên liệu|Chưa có công cụ|Không thấy|Không tìm thấy/i.test(errMsg)
    ) {
      return false;
    }

    const isInternalJsBug =
      source === 'loop' ||
      ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'].includes(errName) ||
      /Cannot read propert|is not a function|is not defined|Maximum call stack/i.test(errMsg);
    if (!isInternalJsBug) return false;
    if (pendingDevTaskCount >= 5) return false;

    const signature = `fix_bug:${source}:${errName}:${errMsg.slice(0, 80).toLowerCase()}`;
    const now = Date.now();
    const prevAt = devBugCooldown.get(signature) ?? 0;
    if (now - prevAt < 900000) return false;
    devBugCooldown.set(signature, now);
    pendingDevTaskCount += 1;

    const stackSnippet = String(error?.stack ?? '').split(/\r?\n/).slice(0, 5).join(' | ');
    ctx.pushInbox?.({
      kind: 'dev_task',
      devKind: 'fix_bug',
      role: 'SYSTEM',
      username: bot.username,
      title: `Sửa lỗi runtime ở ${source}: ${errName || 'Error'}`,
      summary: `Phát hiện lỗi JS trong ${source}${context ? ` (${context})` : ''}: ${errMsg}. Hãy kiểm tra nguyên nhân gốc, sửa code an toàn và thêm unit test.`,
      errorDetail: stackSnippet || errMsg,
      targetFiles: ['bot/src'],
      signature,
      message: `[Auto-Dev fix_bug] ${source}: ${errMsg}`,
    });
    logFor?.('antigravity')?.(`🐛 Tự động gửi lỗi "${errName || 'Error'}" ở ${source} sang tab Orchestrator để sửa.`);
    return true;
  }

  return {
    getDashboardState,
    onCommand,
    onControl,
    onInventoryAction,
    getNearby,
    getInbox,
    onSay,
    onMacro,
    onPlanExecute,
    onSmelt,
    onScratchpad,
    onOpenDevTab,
    reportRuntimeBug,
  };
}
