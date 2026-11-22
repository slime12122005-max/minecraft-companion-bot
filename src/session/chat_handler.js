import { summarizeReadiness } from '../readiness.js';
import { formatError } from './task_helpers.js';

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
        reply(`Xin chào ${username}, tôi chỉ nghe lệnh của ${config.owner}.`);
      }
      return;
    }

    const routed = router.route
      ? router.route(message)
      : { command: router.parseChain ? router.parseChain(message) : router.parse(message), confidence: 1, tier: 'exact' };
    const parsed = routed?.command;
    if (!parsed) return;
    if (routed?.tier === 'fuzzy') {
      logFor('router')(`fuzzy "${message}" -> ${parsed.type} (${Math.round((routed.confidence ?? 0) * 100)}%)`);
    }
    logFor(viaWhisper ? 'whisper' : 'chat')(`${username}: ${message}`);
    state.chatGen += 1;

    const isDirectCommand = parsed.type !== 'unknown' && parsed.type !== 'greet' && parsed.type !== 'ack';
    if (inboxEntry) {
      inboxEntry.parsedType = parsed.type;
      inboxEntry.handledByBot = isDirectCommand;
    }

    // Natural chat, greetings, and acknowledgements go straight to Antigravity (MCP System 2)
    if (!fromApi && !isDirectCommand) {
      pushChatHistory('user', message);
      logFor('antigravity')(`Chuyển "${message}" (${parsed.type}) sang Antigravity MCP.`);
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
    canHumanChat: () => false,
    replyHuman,
    getBotStateSnapshot,
    handleCommand,
  };
}
