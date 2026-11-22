import dotenv from 'dotenv';
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { deepMerge, loadConfig } from './config.js';
import { Memory } from './memory.js';
import { LLMClient } from './llm.js';
import { TaskCoordinator } from './tasks.js';
import { CommandRouter } from './commands.js';
import { Logger } from './logger.js';
import { DashboardServer } from './dashboard.js';
import { createBotSession } from './session.js';
import { ConnectionManager } from './session/connection_manager.js';

export { createBotSession };

dotenv.config();

function loadDshCredentials() {
  try {
    const credPath = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    if (!existsSync(credPath)) return;
    const raw = readFileSync(credPath, 'utf8');
    let inRefs = false;
    for (const line of raw.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (inRefs) {
        if (/^\S/.test(line)) { inRefs = false; continue; }
        const m = line.match(/^\s{2}([A-Z0-9_]+):\s*(.+?)\s*$/);
        if (m) {
          const key = m[1];
          const val = m[2].replace(/^['"]|['"]$/g, '');
          if (val && !process.env[key]) process.env[key] = val;
        }
      }
    }
  } catch {}
}

loadDshCredentials();

const DEFAULT_API_KEY_ENVS = {
  typesafe: 'TYPESAFE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  crowllm: 'CROWLLM_API_KEY',
  chatfree: 'CHATFREE_API_KEY',
};

export function resolveApiKeyEnv(llmCfg = {}) {
  const provider = String(llmCfg.provider || 'typesafe').toLowerCase();
  if (llmCfg.apiKeyEnv && (provider === 'typesafe' || llmCfg.apiKeyEnv !== 'TYPESAFE_API_KEY')) {
    return llmCfg.apiKeyEnv;
  }
  return DEFAULT_API_KEY_ENVS[provider] ?? llmCfg.apiKeyEnv ?? 'TYPESAFE_API_KEY';
}

async function runDoctor() {
  let ok = true;
  console.log('=== KIỂM TRA HỆ THỐNG BOT ===');
  if (existsSync('config.json')) {
    console.log('OK: tìm thấy config.json');
  } else {
    console.log('WARN: chưa có config.json, đang dùng cấu hình mặc định');
  }

  let config;
  try {
    config = loadConfig();
    console.log(`OK: config hợp lệ (${config.minecraft.host}:${config.minecraft.port}, owner=${config.owner})`);
  } catch (err) {
    console.error(`ERR: config lỗi: ${err.message}`);
    ok = false;
  }

  try {
    await mkdir('data', { recursive: true });
    accessSync('data', constants.W_OK);
    console.log('OK: thư mục data/ có quyền ghi');
  } catch (err) {
    console.error(`ERR: không ghi được data/: ${err.message}`);
    ok = false;
  }

  const apiKeyEnv = resolveApiKeyEnv(config?.llm);
  if (apiKeyEnv) {
    if (process.env[apiKeyEnv]) {
      console.log(`OK: System 1 (Jev xác suất) - ${config.llm.model} (${apiKeyEnv} OK)`);
    } else {
      console.log(`WARN: System 1 (Jev xác suất) - chưa đặt ${apiKeyEnv} (bot dùng phản xạ chiến đấu cục bộ)`);
    }
  }

  if (config?.chat?.enabled !== false && config?.chat) {
    const chatProvider = String(config.chat.provider || 'crowllm').toLowerCase();
    const chatKeyEnv = resolveApiKeyEnv(config.chat);
    const fallbacks = Array.isArray(config.chat.fallbackModels) && config.chat.fallbackModels.length > 0
      ? ` (fallback: ${config.chat.fallbackModels.join(', ')})`
      : '';
    if (chatProvider === 'ollama') {
      console.log(`OK: System 2 (Chat ngôn ngữ tự nhiên) - ollama/${config.chat.model}${fallbacks} (local)`);
    } else if (chatKeyEnv && process.env[chatKeyEnv]) {
      console.log(`OK: System 2 (Chat ngôn ngữ tự nhiên) - ${chatProvider}/${config.chat.model}${fallbacks} (${chatKeyEnv} OK)`);
    } else {
      console.log(`INFO: System 2 (Chat ngôn ngữ tự nhiên) - chưa đặt ${chatKeyEnv ?? 'API key'} (đang dùng lệnh chuẩn + fallback Jev)`);
    }
  } else if (config?.chat) {
    console.log('INFO: System 2 (Chat ngôn ngữ tự nhiên) - đã tắt (chat.enabled=false; dùng lệnh chuẩn / Antigravity MCP)');
  }

  if (config?.dashboard?.enabled) {
    console.log(`OK: Dashboard/MCP API - http://${config.dashboard.host}:${config.dashboard.port}`);
  }

  process.exit(ok ? 0 : 1);
}

export function parseCliPort(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && i + 1 < argv.length) {
      const p = Number(argv[i + 1]);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
    }
    if (arg.startsWith('--port=')) {
      const p = Number(arg.slice('--port='.length));
      if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
    }
  }
  return null;
}

export function persistLanConfig(config, configPath = 'config.json') {
  let existing = {};
  try {
    if (existsSync(configPath)) {
      existing = JSON.parse(readFileSync(configPath, 'utf8'));
    }
  } catch {}
  const updated = deepMerge(existing, {
    minecraft: {
      ...(existing.minecraft ?? {}),
      host: config.minecraft.host,
      port: config.minecraft.port,
      username: config.minecraft.username,
      version: config.minecraft.version,
    },
    owner: config.owner,
  });
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

async function main() {
  if (process.argv.includes('--doctor')) {
    await runDoctor();
    return;
  }

  const logger = new Logger({ file: 'data/bot.log' });
  const config = loadConfig();
  const cliPort = parseCliPort();
  if (cliPort) {
    config.minecraft.port = cliPort;
    try { persistLanConfig(config); } catch {}
  }

  const apiKeyEnv = resolveApiKeyEnv(config.llm);
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  const llm = new LLMClient({
    provider: config.llm.provider,
    model: config.llm.model,
    fallbackModels: config.llm.fallbackModels,
    baseUrl: config.llm.baseUrl,
    apiKey,
  });

  const chatCfg = config.chat ?? {};
  const chatProvider = String(chatCfg.provider || 'crowllm').toLowerCase();
  const chatKeyEnv = chatProvider === 'ollama' ? null : resolveApiKeyEnv(chatCfg);
  const chatApiKey = chatKeyEnv ? process.env[chatKeyEnv] : undefined;
  const chatLlm = chatCfg.enabled === false ? null : new LLMClient({
    provider: chatCfg.provider,
    model: chatCfg.model,
    fallbackModels: chatCfg.fallbackModels,
    baseUrl: chatCfg.baseUrl,
    apiKey: chatApiKey,
    maxRequestsPerMin: chatCfg.maxRequestsPerMin,
  });

  const memory = new Memory({ dbPath: 'data/bot_memory.db', legacyJsonPath: 'data/memory.json' });
  await memory.load();
  const tasks = new TaskCoordinator({ log: logger.scoped('task') });
  const router = new CommandRouter();

  let stopping = false;
  const connMgr = new ConnectionManager({ baseDelayMs: 3000, maxDelayMs: 30000 });
  let reconnectTimer = null;
  let activeSession = null;
  const inboxState = { seq: 0, items: [] };

  const dashboard = new DashboardServer({
    host: config.dashboard?.host ?? '127.0.0.1',
    port: config.dashboard?.port ?? 3000,
    authToken: config.dashboard?.token ?? null,
    log: logger.scoped('web'),
    getState: () => ({
      username: config.minecraft.username,
      connected: false,
      lan: {
        host: config.minecraft.host,
        port: config.minecraft.port,
        owner: config.owner,
      },
      health: 0,
      food: 0,
      task: 'đang chờ kết nối',
      logs: logger.recent(40),
    }),
    onConnect: handleReconnectRequest,
    onGetNearby: () => ({
      connected: false,
      position: null,
      dimension: null,
      ownerPosition: null,
      players: [],
      mobs: [],
      items: [],
      blocks: {},
    }),
    getInbox: ({ sinceId = 0, limit = 30 } = {}) => ({
      latestId: inboxState.seq,
      messages: inboxState.items.filter(item => item.id > sinceId).slice(-limit),
    }),
    onSay: () => ({ ok: false, status: 409, error: 'Bot chưa kết nối vào server' }),
  });

  async function handleReconnectRequest({ host, port, owner }) {
    if (host) {
      const cleanHost = String(host).trim();
      if (!/^[a-zA-Z0-9._:-]{1,253}$/.test(cleanHost)) {
        throw new Error('Host không hợp lệ');
      }
      config.minecraft.host = cleanHost;
    }
    config.minecraft.port = port;
    if (owner) config.owner = String(owner).trim().slice(0, 16);
    try { persistLanConfig(config); } catch (err) {
      logger.warn('config', `Không lưu được config.json: ${err.message}`);
    }
    logger.write('INFO', 'bot', `🔄 Chuyển kết nối LAN sang ${config.minecraft.host}:${config.minecraft.port} (owner=${config.owner})...`);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connMgr.resetBackoff();
    const oldSession = activeSession;
    activeSession = null;
    if (oldSession) {
      oldSession._manualRestart = true;
      await oldSession.cleanup().catch(() => {});
      try { oldSession.bot.quit?.(); } catch {}
    }
    connect();
  }

  if (config.dashboard?.enabled) {
    try {
      const addr = await dashboard.start();
      console.log(`🌐 Web Dashboard: http://${addr.host}:${addr.port}`);
    } catch (err) {
      logger.warn('web', `Không mở được web dashboard: ${err.message}`);
    }
  }

  let rl = null;
  if (process.stdin.isTTY) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!cliPort && !process.argv.includes('--no-prompt')) {
      const entered = await new Promise((resolve) => {
        rl.question(`Nhập cổng LAN Minecraft (Enter để dùng ${config.minecraft.port}): `, resolve);
      });
      const trimmed = String(entered ?? '').trim();
      if (trimmed) {
        const parsedPort = Number(trimmed);
        if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
          config.minecraft.port = parsedPort;
          try { persistLanConfig(config); } catch {}
        } else {
          console.log(`⚠️ Cổng "${trimmed}" không hợp lệ, giữ cổng ${config.minecraft.port}.`);
        }
      }
    }
    console.log('💡 Đang chạy trong CMD — gõ số cổng LAN mới (vd: 54321) để đổi server, hoặc gõ thẳng lệnh bot (vd: theo tôi).');
    rl.on('line', (line) => {
      const text = String(line ?? '').trim();
      if (!text) return;
      if (/^\d{1,5}$/.test(text)) {
        const nextPort = Number(text);
        if (nextPort >= 1 && nextPort <= 65535) {
          handleReconnectRequest({ port: nextPort }).catch(err => logger.error('cmd', err.message));
          return;
        }
      }
      if (activeSession?.onCommand) {
        Promise.resolve(activeSession.onCommand(text)).catch(err => logger.error('cmd', err.message));
      } else {
        console.log('⚠️ Bot chưa kết nối vào server.');
      }
    });
  }

  function connect() {
    if (stopping) return;
    logger.write('INFO', 'bot', `🔌 Đang kết nối tới ${config.minecraft.host}:${config.minecraft.port}...`);
    const session = createBotSession(config, {
      llm,
      chatLlm,
      memory,
      tasks,
      router,
      logger,
      onConnect: handleReconnectRequest,
      externalDashboard: dashboard,
      inboxState,
    });
    activeSession = session;

    session.bot.once('spawn', () => {
      connMgr.markConnected();
    });

    session.bot.on('kicked', (reason) => {
      connMgr.markKicked(reason);
    });

    session.bot.once('end', async () => {
      if (session._manualRestart) return;
      if (activeSession === session) activeSession = null;
      connMgr.markDisconnected();
      logger.warn('bot', '🔌 Bot đã ngắt kết nối.');
      await session.cleanup();
      if (!stopping) {
        const delayMs = connMgr.nextReconnectDelayMs();
        logger.write('INFO', 'bot', `🔄 Thử kết nối lại sau ${delayMs / 1000}s...`);
        reconnectTimer = setTimeout(connect, delayMs);
        reconnectTimer.unref?.();
      }
    });
  }

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    rl?.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (activeSession) {
      await activeSession.cleanup();
      activeSession.bot.quit?.();
    }
    await dashboard.stop().catch(() => {});
    await memory.flush?.().catch(() => {});
    memory.close?.();
    process.exit(0);
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  rl?.once('SIGINT', shutdown);

  connect();
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch(err => {
    console.error('[fatal]', err);
    process.exit(1);
  });
}
