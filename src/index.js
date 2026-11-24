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
import {
  LanDiscovery,
  explainConnectionIssue,
  isE4mcHost,
  isLocalHostAddress,
  isSameHost,
  parseConsoleConnectInput,
  parseServerAddress,
  probeMinecraftServer,
  probeTcpPort,
  resolveWorldDbPath,
} from './session/lan_discovery.js';

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

export function resolveApiKeyEnv(llmCfg = {}) {
  const custom = String(llmCfg?.apiKeyEnv || '').trim();
  return custom || 'TYPESAFE_API_KEY';
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
    console.log(`OK: config hợp lệ (${config.minecraft.host}:${config.minecraft.port}, version=${config.minecraft.version}, autoDiscoverLan=${Boolean(config.minecraft.autoDiscoverLan)}, owner=${config.owner})`);
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
  if (process.env[apiKeyEnv]) {
    console.log(`OK: System 1 (Jev hỗ trợ phản ứng nhanh) - ${config.llm.model} (${apiKeyEnv} OK)`);
  } else {
    console.log(`WARN: System 1 (Jev hỗ trợ phản ứng nhanh) - chưa đặt ${apiKeyEnv} (dùng phản xạ cục bộ)`);
  }

  if (config?.dashboard?.enabled) {
    console.log(`OK: System 2 (Não chính Antigravity MCP) - http://${config.dashboard.host}:${config.dashboard.port}`);
    console.log(`OK: Model giao tiếp Antigravity mặc định - ${config?.companion?.agentModel ?? 'gemini-4-hydrogen-low'}`);
  } else {
    console.log('WARN: System 2 (Não chính Antigravity MCP) - dashboard.enabled=false (MCP không kết nối được)');
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

export function parseCliHost(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--host' || arg === '--connect' || arg === '--e4mc') && i + 1 < argv.length) {
      const h = String(argv[i + 1]).trim();
      if (h) return h;
    }
    for (const prefix of ['--host=', '--connect=', '--e4mc=']) {
      if (arg.startsWith(prefix)) {
        const h = arg.slice(prefix.length).trim();
        if (h) return h;
      }
    }
  }
  return null;
}

export function parseCliAuth(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--auth' && i + 1 < argv.length) {
      const a = String(argv[i + 1]).trim().toLowerCase();
      if (a === 'offline' || a === 'microsoft') return a;
    }
    if (arg.startsWith('--auth=')) {
      const a = arg.slice('--auth='.length).trim().toLowerCase();
      if (a === 'offline' || a === 'microsoft') return a;
    }
  }
  return null;
}

export function parseCliVersion(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' && i + 1 < argv.length) {
      const v = String(argv[i + 1]).trim();
      if (v) return v;
    }
    if (arg.startsWith('--version=')) {
      const v = arg.slice('--version='.length).trim();
      if (v) return v;
    }
  }
  return null;
}

export function hasAutoLanFlag(argv = process.argv) {
  return argv.includes('--auto-lan');
}

export function persistLanConfig(config, configPath = 'config.json') {
  let existing = {};
  try {
    if (existsSync(configPath)) {
      existing = JSON.parse(readFileSync(configPath, 'utf8'));
    }
  } catch {}
  const persistedVersion = existing?.minecraft?.version === 'auto'
    ? 'auto'
    : config.minecraft.version;
  const extraMinecraft = {};
  if (existing?.minecraft?.autoDiscoverLan !== undefined) {
    extraMinecraft.autoDiscoverLan = existing.minecraft.autoDiscoverLan;
  } else if (config.minecraft.autoDiscoverLan !== undefined) {
    extraMinecraft.autoDiscoverLan = config.minecraft.autoDiscoverLan;
  }
  if (config.minecraft.auth !== undefined) {
    extraMinecraft.auth = config.minecraft.auth;
  } else if (existing?.minecraft?.auth !== undefined) {
    extraMinecraft.auth = existing.minecraft.auth;
  }
  if (config.minecraft.profilesFolder !== undefined) {
    extraMinecraft.profilesFolder = config.minecraft.profilesFolder;
  } else if (existing?.minecraft?.profilesFolder !== undefined) {
    extraMinecraft.profilesFolder = existing.minecraft.profilesFolder;
  }
  const updated = deepMerge(existing, {
    minecraft: {
      ...(existing.minecraft ?? {}),
      host: config.minecraft.host,
      port: config.minecraft.port,
      username: config.minecraft.username,
      version: persistedVersion,
      ...extraMinecraft,
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
  const cliHostRaw = parseCliHost();
  const cliPort = parseCliPort();
  const cliVersion = parseCliVersion();
  const cliAuth = parseCliAuth();
  if (cliHostRaw) {
    const parsedCli = parseServerAddress(cliHostRaw, { defaultPort: cliPort ?? 25565 });
    if (parsedCli?.host) {
      config.minecraft.host = parsedCli.host;
      if (parsedCli.explicitPort && !cliPort) {
        config.minecraft.port = parsedCli.port;
      } else if (!cliPort && isE4mcHost(parsedCli.host)) {
        config.minecraft.port = 25565;
      }
    }
  }
  if (cliPort) {
    config.minecraft.port = cliPort;
  }
  if (isE4mcHost(config.minecraft.host) && !cliPort && !cliHostRaw && config.minecraft.port !== 25565) {
    logger.write('INFO', 'bot', `ℹ️ Host e4mc (${config.minecraft.host}) dùng cổng 25565 (tự chỉnh từ ${config.minecraft.port}).`);
    config.minecraft.port = 25565;
  }
  if (cliVersion) {
    config.minecraft.version = cliVersion;
  }
  if (cliAuth) {
    config.minecraft.auth = cliAuth;
  }
  if (cliHostRaw || cliPort || cliVersion || cliAuth) {
    try { persistLanConfig(config); } catch {}
  }
  const autoLanEnabled = !cliPort && !cliHostRaw && Boolean(config.minecraft.autoDiscoverLan || hasAutoLanFlag());

  const apiKeyEnv = resolveApiKeyEnv(config.llm);
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  const llm = new LLMClient({
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
    apiKey,
    timeoutMs: config.llm.timeoutMs,
    maxRequestsPerMin: config.llm.maxRequestsPerMin,
  });

  let currentDbPath = resolveWorldDbPath(config.minecraft.worldName);
  let memory = new Memory({ dbPath: currentDbPath, legacyJsonPath: 'data/memory.json' });
  await memory.load();
  const tasks = new TaskCoordinator({ log: logger.scoped('task') });
  const router = new CommandRouter();

  let stopping = false;
  let waitingForLan = false;
  let connectingNow = false;
  let lanDiscovery = null;
  let reconnectInFlightKey = null;
  const connMgr = new ConnectionManager({ baseDelayMs: 3000, maxDelayMs: 30000 });
  let reconnectTimer = null;
  let activeSession = null;
  let sidecarPolled = false;
  let gameSessionSeq = 1;
  let currentGameSessionId = `game_${Date.now()}_${gameSessionSeq}`;
  const inboxState = { seq: 0, items: [] };

  const fallbackGetState = () => ({
    sessionId: null,
    username: config.minecraft.username,
    connected: false,
    lan: {
      host: config.minecraft.host,
      port: config.minecraft.port,
      owner: config.owner,
      version: config.minecraft.version === false ? 'auto' : config.minecraft.version,
      worldName: config.minecraft.worldName ?? null,
    },
    health: 0,
    food: 0,
    task: waitingForLan ? 'đang chờ mở mạng LAN' : 'đang chờ kết nối',
    logs: logger.recent(40),
  });

  const dashboard = new DashboardServer({
    host: config.dashboard?.host ?? '127.0.0.1',
    port: config.dashboard?.port ?? 3000,
    authToken: config.dashboard?.token ?? null,
    log: logger.scoped('web'),
    getState: fallbackGetState,
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
    getInbox: ({ sinceId = 0, limit = 30, source = null } = {}) => {
      if (source === 'sidecar') sidecarPolled = true;
      return {
        sessionId: null,
        latestId: inboxState.seq,
        messages: inboxState.items.filter(item => item.id > sinceId).slice(-limit),
      };
    },
    onSay: () => ({ ok: false, status: 409, error: 'Bot chưa kết nối vào server' }),
  });

  async function switchWorldMemory(worldName) {
    const cleanName = worldName != null ? String(worldName).trim() : '';
    config.minecraft.worldName = cleanName || null;
    const nextDbPath = resolveWorldDbPath(config.minecraft.worldName);
    if (nextDbPath === currentDbPath) return;
    await memory.flush?.().catch(() => {});
    memory.close?.();
    memory = new Memory({ dbPath: nextDbPath });
    await memory.load();
    currentDbPath = nextDbPath;
    logger.write('INFO', 'memory', `💾 Dùng bộ nhớ riêng cho thế giới "${config.minecraft.worldName || 'mặc định'}" (${nextDbPath})`);
  }

  async function handleReconnectRequest({ host, port, owner, version, auth, worldName } = {}) {
    let parsedHostAddr = null;
    if (host) {
      parsedHostAddr = parseServerAddress(host, { defaultPort: port != null ? Number(port) : 25565 });
      if (!parsedHostAddr || !parsedHostAddr.host) {
        throw new Error('Host không hợp lệ');
      }
      config.minecraft.host = parsedHostAddr.host;
      if (port == null) {
        config.minecraft.port = parsedHostAddr.port;
      }
    }
    if (port != null) {
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        throw new Error('Cổng không hợp lệ');
      }
      config.minecraft.port = parsedHostAddr?.isE4mc && parsedHostAddr.explicitPort
        ? parsedHostAddr.port
        : portNum;
      if (!host && !isLocalHostAddress(config.minecraft.host)) {
        config.minecraft.host = '127.0.0.1';
      }
    }
    if (owner) config.owner = String(owner).trim().slice(0, 16);
    if (version != null && String(version).trim()) {
      config.minecraft.version = String(version).trim().slice(0, 32);
    }
    if (auth === 'offline' || auth === 'microsoft') {
      config.minecraft.auth = auth;
    }
    waitingForLan = false;
    try { persistLanConfig(config); } catch (err) {
      logger.warn('config', `Không lưu được config.json: ${err.message}`);
    }
    const worldLabel = worldName ? ` [${worldName}]` : '';
    const authLabel = config.minecraft.auth === 'microsoft' ? ', auth=microsoft' : '';
    logger.write('INFO', 'bot', `🔄 Chuyển kết nối LAN/Server sang ${config.minecraft.host}:${config.minecraft.port}${worldLabel} (version=${config.minecraft.version}, owner=${config.owner}${authLabel})...`);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connMgr.resetBackoff();
    gameSessionSeq += 1;
    currentGameSessionId = `game_${Date.now()}_${gameSessionSeq}`;
    const oldSession = activeSession;
    activeSession = null;
    if (oldSession) {
      oldSession._manualRestart = true;
      await oldSession.cleanup().catch(() => {});
      try { oldSession.bot.quit?.(); } catch {}
    }
    if (worldName !== undefined) {
      await switchWorldMemory(worldName);
    }
    connect();
  }

  if (config.dashboard?.enabled) {
    try {
      const addr = await dashboard.start();
      console.log(`🌐 Web Dashboard: http://${addr.host}:${addr.port}`);
      const sidecarHintTimer = setTimeout(() => {
        if (!stopping && !sidecarPolled && !(activeSession?.state?.lastSidecarPollAt > 0)) {
          const modelSlug = config.companion?.agentModel ?? 'gemini-4-hydrogen-low';
          logger.write(
            'INFO',
            'antigravity',
            `💡 Chế độ chat người thật tại chỗ đang bật. Để nối thêm não ${modelSlug}, hãy bật plugin "Minecraft Bot Companion" trong Antigravity!`
          );
        }
      }, 4500);
      sidecarHintTimer.unref?.();
    } catch (err) {
      logger.warn('web', `Không mở được web dashboard: ${err.message}`);
    }
  }

  let rl = null;
  if (process.stdin.isTTY) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!cliPort && !cliHostRaw && !autoLanEnabled && !process.argv.includes('--no-prompt')) {
      const entered = await new Promise((resolve) => {
        rl.question(`Nhập cổng LAN hoặc domain e4mc (Enter để dùng ${config.minecraft.host}:${config.minecraft.port}): `, resolve);
      });
      const trimmed = String(entered ?? '').trim();
      if (trimmed) {
        const parsedPrompt = parseServerAddress(trimmed, { defaultPort: 25565 });
        if (parsedPrompt) {
          if (parsedPrompt.host) config.minecraft.host = parsedPrompt.host;
          config.minecraft.port = parsedPrompt.port;
          try { persistLanConfig(config); } catch {}
        } else {
          console.log(`⚠️ Địa chỉ "${trimmed}" không hợp lệ, giữ ${config.minecraft.host}:${config.minecraft.port}.`);
        }
      }
    }
    console.log('💡 Đang chạy trong CMD — gõ cổng LAN (vd: 54321) hoặc domain e4mc (vd: xxx.e4mc.link) để đổi server, hoặc gõ thẳng lệnh bot (vd: theo tôi).');
    rl.on('line', (line) => {
      const text = String(line ?? '').trim();
      if (!text) return;
      const target = parseConsoleConnectInput(text);
      if (target) {
        const req = { port: target.port };
        if (target.host) req.host = target.host;
        handleReconnectRequest(req).catch(err => logger.error('cmd', err.message));
        return;
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
    waitingForLan = false;
    connectingNow = true;
    const authTag = config.minecraft.auth === 'microsoft' ? ', auth=microsoft' : '';
    logger.write('INFO', 'bot', `🔌 Đang kết nối tới ${config.minecraft.host}:${config.minecraft.port} (version=${config.minecraft.version}${authTag})...`);
    let lastIssueCode = null;
    const session = createBotSession(config, {
      llm,
      memory,
      tasks,
      router,
      logger,
      onConnect: handleReconnectRequest,
      externalDashboard: dashboard,
      inboxState,
      sessionId: currentGameSessionId,
    });
    activeSession = session;

    session.bot.once('spawn', () => {
      lastIssueCode = null;
      connectingNow = false;
      connMgr.markConnected();
    });

    session.bot.on('kicked', (reason) => {
      connMgr.markKicked(reason);
      lastIssueCode = explainConnectionIssue(reason, config)?.code ?? lastIssueCode;
    });

    session.bot.on('error', (err) => {
      lastIssueCode = explainConnectionIssue(err, config)?.code ?? lastIssueCode;
    });

    session.bot.once('end', async () => {
      if (session._manualRestart) return;
      connectingNow = false;
      if (activeSession === session) {
        activeSession = null;
        dashboard.getState = fallbackGetState;
      }
      connMgr.markDisconnected();
      logger.warn('bot', '🔌 Bot đã ngắt kết nối.');
      await session.cleanup();
      if (!stopping) {
        if (autoLanEnabled && isLocalHostAddress(config.minecraft.host)) {
          const reachable = await probeTcpPort(config.minecraft.host, config.minecraft.port, 500);
          if (!reachable) {
            waitingForLan = true;
            gameSessionSeq += 1;
            currentGameSessionId = `game_${Date.now()}_${gameSessionSeq}`;
            connMgr.resetBackoff();
            logger.write('INFO', 'bot', `📡 Thế giới LAN (${config.minecraft.port}) đã đóng. Đang chờ thế giới tiếp theo...`);
            return;
          }
        }
        const rawDelayMs = connMgr.nextReconnectDelayMs();
        const delayMs = (
          lastIssueCode === 'online_mode_required' ||
          lastIssueCode === 'e4mc_domain_inactive' ||
          lastIssueCode === 'modded_client_required'
        )
          ? Math.max(rawDelayMs, 20000)
          : rawDelayMs;
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
    lanDiscovery?.stop?.();
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

  if (autoLanEnabled) {
    let resolveInitialLanWait = null;
    lanDiscovery = new LanDiscovery({
      log: logger.scoped('lan'),
      onWorld: (entry, activeList) => {
        if (stopping) return;
        const ownerLower = String(config.owner || '').toLowerCase();
        const matchesOwner = Boolean(entry.ownerHint && entry.ownerHint.toLowerCase() === ownerLower);
        const anyOwnerActive = activeList.some(
          (w) => w.ownerHint && w.ownerHint.toLowerCase() === ownerLower
        );
        if (anyOwnerActive && !matchesOwner) return;
        if (!matchesOwner && !isSameHost(entry.host, '127.0.0.1')) return;

        resolveInitialLanWait?.();
        resolveInitialLanWait = null;

        const sameTarget = isSameHost(config.minecraft.host, entry.host) && config.minecraft.port === entry.port;
        const targetKey = `${entry.host}:${entry.port}`;
        const shouldSwitch =
          waitingForLan ||
          (!activeSession && !connectingNow) ||
          (entry.isNew && !sameTarget && (matchesOwner || !connMgr.connected));

        if (!shouldSwitch || reconnectInFlightKey === targetKey) return;
        reconnectInFlightKey = targetKey;
        logger.write(
          'INFO',
          'lan',
          `📡 Phát hiện LAN "${entry.worldName || entry.motd}" tại ${entry.host}:${entry.port}${entry.ownerHint ? ` (${entry.ownerHint})` : ''}`
        );
        handleReconnectRequest({
          host: entry.host,
          port: entry.port,
          version: 'auto',
          worldName: entry.worldName,
        })
          .catch((err) => logger.warn('lan', `Không kết nối được ${targetKey}: ${err.message}`))
          .finally(() => {
            if (reconnectInFlightKey === targetKey) reconnectInFlightKey = null;
          });
      },
    });
    lanDiscovery.start();

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolveInitialLanWait = null;
        clearTimeout(timer);
        resolve();
      };
      resolveInitialLanWait = done;
      const timer = setTimeout(done, 1800);
      timer.unref?.();
    });

    if (!stopping && !activeSession && !connectingNow && !reconnectInFlightKey) {
      if (!isLocalHostAddress(config.minecraft.host)) {
        connect();
      } else {
        const reachable = await probeMinecraftServer(config.minecraft.host, config.minecraft.port, 600);
        if (reachable) {
          connect();
        } else {
          waitingForLan = true;
          logger.write('INFO', 'bot', '📡 Đang tự động chờ bạn bấm "Open to LAN" trong bất kỳ bản Minecraft nào (hoặc gõ cổng / domain e4mc vào CMD)...');
        }
      }
    }
  } else {
    connect();
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch(err => {
    console.error('[fatal]', err);
    process.exit(1);
  });
}
