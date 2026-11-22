import { summarizeReadiness } from '../readiness.js';
import { classifyIntent } from '../jev_intent.js';
import { formatError } from './task_helpers.js';

export function createChatHandler(ctx) {
  const {
    bot,
    config,
    llm,
    chatLlm,
    tasks,
    router,
    equipment,
    home,
    survival,
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

  const canHumanChat = () => Boolean(
    config.chat?.enabled !== false &&
    config.chat?.humanReply !== false &&
    !state.disconnected &&
    (state.connected || Boolean(bot.entity)) &&
    chatLlm?.isAvailable?.() &&
    chatLlm.provider !== 'typesafe' &&
    typeof chatLlm.humanizeReply === 'function'
  );

  async function replyHuman(rawText, { userMessage = '', replyFn = () => {}, isStale = null } = {}) {
    const fallback = String(rawText ?? '').trim();
    if (!fallback) return;
    if (!canHumanChat()) {
      replyFn(fallback);
      return;
    }
    try {
      const res = await chatLlm.humanizeReply({
        userMessage,
        rawEvent: fallback,
        botState: getBotStateSnapshot(),
        history: chatHistory.slice(-6),
      });
      if (isStale?.()) return;
      const finalText = res?.reply || fallback;
      logFor('chat-llm')(`reply: "${finalText}"`);
      replyFn(finalText);
      pushChatHistory('assistant', finalText);
    } catch (err) {
      errorFor('chat-llm', err.message);
      if (isStale?.()) return;
      replyFn(fallback);
      pushChatHistory('assistant', fallback);
    }
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

  function isValidChatCommandStep(step) {
    if (!step || step.type === 'unknown' || step.type === 'chain') return false;
    if (step.type === 'goto_waypoint' && !survival.getWaypoint(step.name)) {
      logFor('chat-llm')(`Bỏ qua lệnh "đi tới ${step.name}" vì điểm này chưa được lưu.`);
      return false;
    }
    if (step.type === 'go_home' && !home.get()) {
      logFor('chat-llm')('Bỏ qua lệnh "về nhà" vì chưa đặt tọa độ nhà.');
      return false;
    }
    return true;
  }

  function parseChatCommands(rawCommands) {
    if (!Array.isArray(rawCommands)) return [];
    const steps = [];
    for (const entry of rawCommands) {
      const text = String(entry ?? '').trim();
      if (!text) continue;
      const p = router.parseChain ? router.parseChain(text) : router.parse(text);
      if (!p || p.type === 'unknown') continue;
      if (p.type === 'chain') {
        for (const sub of p.steps ?? []) {
          if (isValidChatCommandStep(sub)) steps.push(sub);
        }
      } else if (isValidChatCommandStep(p)) {
        steps.push(p);
      }
      if (steps.length >= 5) break;
    }
    return steps.slice(0, 5);
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
    const myChatGen = ++state.chatGen;

    const hasMcpLease = !fromApi && Date.now() < (state.mcpLeaseUntil || 0);
    const isMcpChatMode = Boolean((config.chat?.mcpChat || hasMcpLease) && !fromApi);
    if (inboxEntry) {
      inboxEntry.parsedType = parsed.type;
      inboxEntry.handledByBot = parsed.type !== 'unknown'
        && !(isMcpChatMode && (parsed.type === 'greet' || parsed.type === 'ack'));
    }

    if (isMcpChatMode && (parsed.type === 'greet' || parsed.type === 'ack' || parsed.type === 'unknown')) {
      pushChatHistory('user', message);
      logFor('mcp-chat')(`Chuyển "${message}" (${parsed.type}) sang Antigravity MCP.`);
      return;
    }

    if (canHumanChat() && (parsed.type === 'greet' || parsed.type === 'ack')) {
      try {
        const chatRes = await chatLlm.interpretChat({
          message,
          botState: getBotStateSnapshot(),
          history: chatHistory.slice(-6),
        });
        if (chatRes?.reply) {
          logFor('chat-llm')(`reply: "${chatRes.reply}"`);
          reply(chatRes.reply);
          pushChatHistory('user', message);
          pushChatHistory('assistant', chatRes.reply);
          return;
        }
      } catch (err) {
        errorFor('chat-llm', err.message);
      }
    }

    if (parsed.type === 'unknown') {
      let chatLlmFailed = false;
      if (config.chat?.enabled !== false && chatLlm?.isAvailable?.() && chatLlm.provider !== 'typesafe') {
        const startedAt = Date.now();
        try {
          const chatRes = await chatLlm.interpretChat({
            message: parsed.raw,
            botState: getBotStateSnapshot(),
            history: chatHistory.slice(-6),
          });
          if (chatRes?.commands?.length > 0) {
            logFor('chat-llm')(`"${parsed.raw}" -> [${chatRes.commands.join(' ; ')}]`);
          }
          if (chatRes?.reply) {
            logFor('chat-llm')(`reply: "${chatRes.reply}"`);
          }
          if (myChatGen !== state.chatGen) {
            if (chatRes?.commands?.length > 0) {
              logFor('chat-llm')(`Bỏ qua lệnh trễ từ "${parsed.raw}" vì đã có tin nhắn mới hơn.`);
            }
            if (chatRes?.reply && Date.now() - startedAt <= 8000) {
              reply(chatRes.reply);
              pushChatHistory('user', parsed.raw);
              pushChatHistory('assistant', chatRes.reply);
            }
            return;
          }
          let handled = false;
          if (chatRes?.reply) {
            reply(chatRes.reply);
            handled = true;
          }
          const validSteps = parseChatCommands(chatRes?.commands);
          if (validSteps.length > 0) {
            const planned = validSteps.length === 1 ? validSteps[0] : { type: 'chain', steps: validSteps };
            await ctx.dispatchParsedCommand(planned, username, reply, null, {
              userMessage: parsed.raw,
              alreadyAcked: Boolean(chatRes?.reply),
            });
            handled = true;
          } else if ((chatRes?.commands?.length ?? 0) > 0 && !chatRes?.reply) {
            reply('Chưa có điểm hoặc nhà đó được lưu nên mình chưa đi được nha.');
            handled = true;
          }
          if (handled) {
            if (inboxEntry) inboxEntry.handledByBot = true;
            pushChatHistory('user', parsed.raw);
            pushChatHistory('assistant', chatRes?.reply || (chatRes?.commands ?? []).join('; '));
            return;
          }
        } catch (err) {
          errorFor('chat-llm', err.message);
          chatLlmFailed = true;
          if (myChatGen !== state.chatGen) return;
        }
      }

      if (llm?.apiKey && config.combat?.useCausality !== false) {
        try {
          const classified = await classifyIntent(llm, parsed.raw);
          if (myChatGen !== state.chatGen) {
            if (classified?.command) {
              logFor('jev-intent')(`Bỏ qua lệnh trễ từ "${parsed.raw}" vì đã có tin nhắn mới hơn.`);
            }
            return;
          }
          if (classified?.command) {
            if (inboxEntry) {
              inboxEntry.handledByBot = true;
              inboxEntry.parsedType = classified.command.type;
            }
            logFor('jev-intent')(`"${parsed.raw}" -> ${classified.command.type} (${Math.round(classified.confidence * 100)}%)`);
            await ctx.dispatchParsedCommand(classified.command, username, reply, null, {
              userMessage: parsed.raw,
              alreadyAcked: false,
            });
            return;
          }
        } catch (err) {
          errorFor('jev-intent', err.message);
        }
      }

      if (chatLlmFailed && canHumanChat()) {
        reply('Mạng mình hơi lag xíu, bạn nhắn lại giúp mình nha.');
        return;
      }
    }

    if (parsed.type !== 'unknown') {
      pushChatHistory('user', message);
    }
    await ctx.dispatchParsedCommand(parsed, username, reply, null, {
      userMessage: message,
      alreadyAcked: false,
      fromApi,
    });
  }

  return {
    pushChatHistory,
    canHumanChat,
    replyHuman,
    getBotStateSnapshot,
    isValidChatCommandStep,
    parseChatCommands,
    handleCommand,
  };
}
