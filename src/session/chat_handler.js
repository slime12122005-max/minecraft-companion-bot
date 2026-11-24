import { summarizeReadiness } from '../readiness.js';
import { formatError } from './task_helpers.js';
import { cleanTargetPhrase, normalizeText, parseQuantityAnswer } from '../commands.js';

function applyQuantityAnswer(parsed, count) {
  if (!parsed) return parsed;
  if (parsed.type === 'chain') {
    const steps = (parsed.steps ?? []).map((step) => {
      if (!step) return step;
      if (step.needsCount) {
        const concreteCount = count === 'all' && step.type !== 'give' ? 64 : count;
        const { needsCount: _drop, ...rest } = step;
        return { ...rest, count: concreteCount };
      }
      if (step.type === 'give' && count !== 'all') {
        return { ...step, minDeliverCount: count };
      }
      return step;
    });
    const { needsCount: _dropChain, ...restChain } = parsed;
    return { ...restChain, steps };
  }
  const { needsCount: _drop, ...rest } = parsed;
  const concreteCount = count === 'all' && parsed.type !== 'give' ? 64 : count;
  if (parsed.type === 'give') {
    return {
      ...rest,
      count: concreteCount,
      ...(typeof concreteCount === 'number' ? { minDeliverCount: concreteCount } : {}),
    };
  }
  if (parsed.type === 'gather') {
    return {
      ...rest,
      count: concreteCount,
      autoDeliver: parsed.autoDeliver ?? true,
    };
  }
  return { ...rest, count: concreteCount };
}

export function createChatHandler(ctx) {
  const {
    bot,
    config,
    tasks,
    router,
    equipment,
    home,
    survival,
    smelting,
    memory,
    logFor,
    errorFor,
    nonOwnerRepliedAt,
    chatHistory,
    state,
  } = ctx;

  const pushChatHistory = (role, text) => {
    const clean = String(text ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (!clean) return;
    chatHistory.push({ role, text: clean });
    if (chatHistory.length > 6) chatHistory.splice(0, chatHistory.length - 6);
  };

  function replyHuman(rawText, { replyFn = () => {}, isStale = null } = {}) {
    const text = String(rawText ?? '').trim();
    if (!text || isStale?.()) return Promise.resolve();
    replyFn(text);
    pushChatHistory('assistant', text);
    return Promise.resolve();
  }

  function getBotStateSnapshot() {
    const items = bot.inventory?.items?.() ?? [];
    const snap = {
      health: bot.health ?? 20,
      food: bot.food ?? 20,
      position: bot.entity?.position ? {
        x: Math.round(bot.entity.position.x),
        y: Math.round(bot.entity.position.y),
        z: Math.round(bot.entity.position.z),
      } : null,
      task: tasks.status().active?.name ?? 'rảnh',
      equipped: equipment.status().equipped,
      inventory: items.slice(0, 20).map(i => ({ name: i.name, count: i.count })),
      readiness: summarizeReadiness(items, { minFoodPoints: config.survival?.minFoodPoints ?? 20 }),
      home: home.get() ?? null,
      chests: home.listChestInventory(),
      waypoints: survival.listWaypoints(),
      smeltingJobs: Object.fromEntries(smelting?.activeJobs ?? []),
    };
    const recentEvents = memory?.recentEvents?.({ limit: 3 });
    if (Array.isArray(recentEvents) && recentEvents.length > 0) {
      snap.recentEvents = recentEvents;
    }
    const pois = memory?.queryPois?.({ limit: 6 });
    if (Array.isArray(pois) && pois.length > 0) {
      snap.pois = pois;
    }
    return snap;
  }

  async function handleCommand(username, message, { viaWhisper = false, inboxEntry = null, fromApi = false } = {}) {
    if (username === bot.username) return;
    memory?.upsertPlayerProfile?.(username, {
      role: username === config.owner ? 'owner' : undefined,
      lastSeenAt: Date.now(),
    });

    const reply = (text) => {
      const msg = String(text ?? '');
      const send = (chunk) => {
        const canSendInGame = !state.disconnected && (state.connected || Boolean(bot.entity));
        if (!canSendInGame) {
          logFor('bot')(chunk);
          return;
        }
        try {
          if (viaWhisper) bot.whisper(username, chunk);
          else bot.chat(chunk);
        } catch (err) {
          errorFor('bot', formatError(err));
        }
      };
      if (msg.length <= 240) {
        send(msg);
        return;
      }
      let remaining = msg;
      while (remaining.length > 240) {
        let cut = remaining.lastIndexOf(', ', 240);
        if (cut < 80) cut = remaining.lastIndexOf(' ', 240);
        if (cut < 40) cut = 240;
        else if (remaining[cut] === ',') cut += 1;
        send(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
      }
      if (remaining) send(remaining);
    };

    if (username !== config.owner) {
      const now = Date.now();
      const last = nonOwnerRepliedAt.get(username) ?? 0;
      if (viaWhisper || now - last > 60000) {
        nonOwnerRepliedAt.set(username, now);
        const guestType = router.parse?.(message)?.type ?? 'unknown';
        const nonOwnerMsg = ctx.companion?.buildNonOwnerReply?.(username, message, guestType)
          ?? `Xin chào ${username}, tôi chỉ nghe lệnh của ${config.owner}.`;
        reply(nonOwnerMsg);
      }
      return;
    }

    if (state.pendingQuantity && Date.now() > state.pendingQuantity.expiresAt) {
      state.pendingQuantity = null;
    }

    const routed = router.route
      ? router.route(message)
      : { command: router.parseChain ? router.parseChain(message) : router.parse(message), confidence: 1, tier: 'exact' };
    let parsed = routed?.command;
    if (!parsed) return;
    if (routed?.tier === 'fuzzy') {
      logFor('router')(`fuzzy "${message}" -> ${parsed.type} (${Math.round((routed.confidence ?? 0) * 100)}%)`);
    }
    logFor(viaWhisper ? 'whisper' : 'chat')(`${username}: ${message}`);
    state.chatGen += 1;

    if (state.pendingQuantity) {
      const quickNorm = normalizeText(message).replace(/[?!.,~]+$/g, '').trim();
      if (['huy', 'thoi', 'khoi', 'thoi khoi', 'bo', 'cancel'].includes(quickNorm)) {
        state.pendingQuantity = null;
        if (inboxEntry) {
          inboxEntry.parsedType = 'cancel';
          inboxEntry.handledByBot = true;
        }
        pushChatHistory('user', message);
        reply('Đã hủy yêu cầu.');
        return;
      }
      if (parsed.type === 'unknown') {
        const qtyAns = parseQuantityAnswer(message);
        if (qtyAns) {
          const pending = state.pendingQuantity;
          state.pendingQuantity = null;
          if (inboxEntry) {
            inboxEntry.parsedType = 'quantity_reply';
            inboxEntry.handledByBot = true;
          }
          pushChatHistory('user', message);
          const resolvedParsed = applyQuantityAnswer(pending.parsed, qtyAns.count);
          await ctx.dispatchParsedCommand(resolvedParsed, username, reply, null, {
            ...(pending.chatCtx ?? {}),
            userMessage: message,
            fromApi,
          });
          return;
        }
      } else if (!parsed.needsCount && parsed.type !== 'cancel') {
        const pending = state.pendingQuantity;
        state.pendingQuantity = null;
        const hadPendingDeliver = Boolean(
          pending.parsed?.autoDeliver ||
          (pending.parsed?.type === 'chain' && pending.parsed.steps?.some(s => s?.type === 'give'))
        );
        const pendingTarget = pending.parsed?.target ?? pending.parsed?.steps?.find(s => s?.target)?.target;
        if (
          parsed.type === 'gather' &&
          hadPendingDeliver &&
          cleanTargetPhrase(normalizeText(parsed.target)) === cleanTargetPhrase(normalizeText(pendingTarget))
        ) {
          parsed = { ...parsed, autoDeliver: true };
        }
      }
    }

    const isDirectCommand = parsed.type !== 'unknown' && parsed.type !== 'greet' && parsed.type !== 'ack';
    if (inboxEntry) {
      inboxEntry.parsedType = parsed.type;
      inboxEntry.handledByBot = isDirectCommand;
    }

    // Natural chat, greetings, and acknowledgements go straight to Antigravity (MCP System 2)
    if (!fromApi && !isDirectCommand) {
      pushChatHistory('user', message);
      if (parsed.type === 'greet' || parsed.type === 'ack') {
        const unsafeGesture = Boolean(ctx.combat?.busy || bot.isSleeping || ctx.survival?.busy);
        ctx.humanizer?.expressGesture?.('crouch_greet', { unsafe: unsafeGesture }).catch(() => {});
        const ownerPos = bot.players?.[config.owner]?.entity?.position;
        if (!unsafeGesture && ownerPos) {
          ctx.humanizer?.smoothLookAt?.(
            { x: ownerPos.x, y: ownerPos.y + 1.62, z: ownerPos.z },
            { steps: 3 }
          ).catch(() => {});
        }
      }
      logFor('antigravity')(`Chuyển "${message}" (${parsed.type}) sang Antigravity MCP.`);
      ctx.companion?.scheduleChatFallback?.({
        username,
        message,
        parsed,
        reply,
        inboxEntry,
        myChatGen: state.chatGen,
        receivedAt: Date.now(),
      });
      return;
    }

    if (parsed.type !== 'unknown') {
      pushChatHistory('user', message);
    }
    await ctx.dispatchParsedCommand(parsed, username, reply, null, {
      userMessage: message,
      fromApi,
    });
  }

  return {
    pushChatHistory,
    canHumanChat: () => Boolean(ctx.companion?.enabledChat),
    replyHuman,
    getBotStateSnapshot,
    handleCommand,
  };
}
