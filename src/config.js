import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isE4mcHost, parseServerAddress } from './session/lan_discovery.js';

export const DEFAULT_CONFIG = {
  minecraft: {
    host: 'localhost',
    port: 55916,
    username: 'bot_dong_hanh',
    version: '1.21.1',
    autoDiscoverLan: false,
  },
  owner: 'araslime',
  llm: {
    provider: 'typesafe',
    model: 'jev-latest',
    baseUrl: 'https://api.typesafe.ai',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    jevIntervalMs: 4000,
    timeoutMs: 2500,
    maxRequestsPerMin: 30,
  },
  combat: {
    enabled: true,
    defendOwner: true,
    radius: 16,
    maxVerticalDistance: 5,
    retreatHealth: 8,
    crit: true,
    bow: true,
    shieldAgainstCreeper: true,
    useCausality: true,
    useThreatScore: true,
    alwaysUseJev: false,
    minConfidence: 0.3,
  },
  inventory: {
    blockStacks: 2,
    keepFood: 16,
    discardObsolete: false,
    maxDiamonds: 64,
  },
  building: {
    confirmTerrainChange: true,
    autoScaffold: true,
    maxPrepareBlocks: 1000,
    maxBlocksPerSession: 5000,
    maxBlocks: 50000,
    maxSchematicBytes: 33554432,
    keepWater: false,
  },
  home: {
    setOnCommand: true,
    autoReturn: true,
    storageChest: null,
  },
  survival: {
    requireFood: true,
    minFoodPoints: 20,
    maxDeathRecoverDistance: 350,
    itemDespawnMs: 300000,
  },
  humanizer: {
    enabled: true,
    smoothLook: true,
    lookSteps: 5,
    lookStepMs: 22,
    lookJitterRad: 0.025,
    idleGaze: true,
    socialGestures: true,
    gestureStepMs: 115,
    chatTypingDelay: true,
    typingBaseMs: 220,
    typingMsPerChar: 26,
    maxChatDelayMs: 1600,
    personalSpace: 3,
    combatStrafe: true,
    strafeDurationMs: 200,
    strafeCooldownMs: 650,
    attackJitterMs: 55,
  },
  dashboard: {
    enabled: true,
    host: '127.0.0.1',
    port: 3000,
  },
  companion: {
    agentModel: 'gemini-4-hydrogen-low',
    devAgentModel: 'gemini-4-carbon-high',
    devAgentProfile: 'orchestrator',
    autoDevTab: true,
    devGlobalCooldownMs: 180000,
    naturalChat: true,
    chatFallbackDelayMs: 550,
    mcpGraceMs: 18000,
    idleLife: false,
    idleFollowRange: 6.5,
    idleWanderIntervalMs: 14000,
    ambientChatter: true,
    autoUpgrade: true,
    autoFarm: true,
  },
};

export function resolveMineflayerVersion(version) {
  if (version === false) return false;
  const v = String(version ?? '').trim();
  if (!v || v.toLowerCase() === 'auto' || v.toLowerCase() === 'false') return false;
  return v;
}

const ConfigSchema = z.object({
  minecraft: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(120),
    version: z.union([z.string().min(1), z.literal(false)]),
    auth: z.enum(['offline', 'microsoft']).optional(),
    profilesFolder: z.string().min(1).optional(),
    autoDiscoverLan: z.boolean().optional(),
    worldName: z.string().nullable().optional(),
  }).refine(
    (mc) => mc.auth === 'microsoft' || mc.username.length <= 16,
    { message: 'Username tối đa 16 ký tự ở chế độ offline', path: ['username'] }
  ),
  owner: z.string().min(1),
  llm: z.object({
    provider: z.string().optional(),
    model: z.string().min(1),
    baseUrl: z.string().url().or(z.literal('')).optional(),
    apiKeyEnv: z.string().optional(),
    jevIntervalMs: z.number().int().positive(),
    timeoutMs: z.number().int().positive().optional(),
    maxRequestsPerMin: z.number().int().nonnegative().optional(),
  }),
  combat: z.object({
    enabled: z.boolean(),
    defendOwner: z.boolean(),
    radius: z.number().positive(),
    maxVerticalDistance: z.number().positive().optional(),
    retreatHealth: z.number().nonnegative(),
    crit: z.boolean(),
    bow: z.boolean(),
    shieldAgainstCreeper: z.boolean(),
    useCausality: z.boolean().optional(),
    useThreatScore: z.boolean().optional(),
    alwaysUseJev: z.boolean().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    jevIntervalMs: z.number().int().positive().optional(),
  }),
  inventory: z.object({
    blockStacks: z.number().int().nonnegative(),
    keepFood: z.number().int().nonnegative(),
    discardObsolete: z.boolean(),
    maxDiamonds: z.number().int().positive().optional(),
  }),
  building: z.object({
    confirmTerrainChange: z.boolean(),
    autoScaffold: z.boolean().optional(),
    maxPrepareBlocks: z.number().int().positive().optional(),
    maxBlocksPerSession: z.number().int().positive(),
    maxBlocks: z.number().int().positive().optional(),
    maxSchematicBytes: z.number().int().positive().optional(),
    maxPlacementAttempts: z.number().int().positive().optional(),
    keepWater: z.boolean().optional(),
  }),
  home: z.object({
    setOnCommand: z.boolean(),
    autoReturn: z.boolean(),
    storageChest: z.any().nullable().optional(),
  }),
  survival: z.object({
    requireFood: z.boolean().optional(),
    minFoodPoints: z.number().int().nonnegative().optional(),
    maxDeathRecoverDistance: z.number().positive().optional(),
    itemDespawnMs: z.number().int().positive().optional(),
  }).optional(),
  humanizer: z.object({
    enabled: z.boolean(),
    smoothLook: z.boolean(),
    lookSteps: z.number().int().min(1),
    lookStepMs: z.number().int().nonnegative(),
    lookJitterRad: z.number().nonnegative(),
    idleGaze: z.boolean(),
    socialGestures: z.boolean(),
    gestureStepMs: z.number().int().nonnegative(),
    chatTypingDelay: z.boolean(),
    typingBaseMs: z.number().int().nonnegative(),
    typingMsPerChar: z.number().nonnegative(),
    maxChatDelayMs: z.number().int().nonnegative(),
    personalSpace: z.number().int().min(1).max(6),
    combatStrafe: z.boolean(),
    strafeDurationMs: z.number().int().nonnegative(),
    strafeCooldownMs: z.number().int().nonnegative(),
    attackJitterMs: z.number().int().nonnegative(),
    preserveTestDelays: z.boolean(),
  }).partial().optional(),
  dashboard: z.object({
    enabled: z.boolean(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    token: z.string().optional(),
  }).optional(),
  companion: z.object({
    agentModel: z.string().min(1),
    devAgentModel: z.string().min(1),
    devAgentProfile: z.string().min(1),
    autoDevTab: z.boolean(),
    devGlobalCooldownMs: z.number().int().nonnegative(),
    naturalChat: z.boolean(),
    chatFallbackDelayMs: z.number().int().nonnegative(),
    mcpGraceMs: z.number().int().nonnegative(),
    idleLife: z.boolean(),
    idleFollowRange: z.number().positive(),
    idleWanderIntervalMs: z.number().int().positive(),
    ambientChatter: z.boolean(),
    autoUpgrade: z.boolean(),
    autoFarm: z.boolean(),
    preserveInTests: z.boolean(),
  }).partial().optional(),
}).passthrough();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base)) return override;
  const result = { ...base };
  if (!isPlainObject(override)) return result;
  for (const [key, val] of Object.entries(override)) {
    if (isPlainObject(val) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], val);
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

export function loadConfig(configPath = 'config.json', { env = process.env } = {}) {
  let parsed = {};
  try {
    const raw = readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Không đọc được ${configPath}: ${err.message}`);
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, parsed);

  const hasExplicitEnvPort = Boolean(
    env &&
    env.MINECRAFT_PORT != null &&
    String(env.MINECRAFT_PORT).trim() !== '' &&
    Number.isInteger(Number(env.MINECRAFT_PORT)) &&
    Number(env.MINECRAFT_PORT) >= 1 &&
    Number(env.MINECRAFT_PORT) <= 65535
  );
  const hasExplicitFilePort = parsed?.minecraft?.port != null;

  if (env) {
    merged.minecraft = merged.minecraft ?? { ...DEFAULT_CONFIG.minecraft };
    const envAuth = env.MINECRAFT_AUTH != null ? String(env.MINECRAFT_AUTH).trim().toLowerCase() : '';
    if (envAuth === 'offline' || envAuth === 'microsoft') {
      merged.minecraft.auth = envAuth;
    }
    if (env.MINECRAFT_HOST && String(env.MINECRAFT_HOST).trim()) {
      merged.minecraft.host = String(env.MINECRAFT_HOST).trim();
    }
    if (hasExplicitEnvPort) {
      merged.minecraft.port = Number(env.MINECRAFT_PORT);
    }
    if (env.MINECRAFT_USERNAME && String(env.MINECRAFT_USERNAME).trim()) {
      const maxLen = merged.minecraft.auth === 'microsoft' ? 120 : 16;
      merged.minecraft.username = String(env.MINECRAFT_USERNAME).trim().slice(0, maxLen);
    }
    if (env.MINECRAFT_VERSION && String(env.MINECRAFT_VERSION).trim()) {
      merged.minecraft.version = String(env.MINECRAFT_VERSION).trim();
    }
    const envAutoLan = env.MINECRAFT_AUTO_DISCOVER_LAN != null
      ? String(env.MINECRAFT_AUTO_DISCOVER_LAN).trim().toLowerCase()
      : '';
    if (envAutoLan === 'true' || envAutoLan === '1') merged.minecraft.autoDiscoverLan = true;
    else if (envAutoLan === 'false' || envAutoLan === '0') merged.minecraft.autoDiscoverLan = false;
    if (env.MINECRAFT_OWNER && String(env.MINECRAFT_OWNER).trim()) {
      merged.owner = String(env.MINECRAFT_OWNER).trim().slice(0, 16);
    }

    merged.dashboard = merged.dashboard ?? { ...DEFAULT_CONFIG.dashboard };
    const envEnabled = env.DASHBOARD_ENABLED != null ? String(env.DASHBOARD_ENABLED).trim().toLowerCase() : '';
    if (envEnabled === 'true' || envEnabled === '1') merged.dashboard.enabled = true;
    else if (envEnabled === 'false' || envEnabled === '0') merged.dashboard.enabled = false;

    if (env.DASHBOARD_HOST && String(env.DASHBOARD_HOST).trim()) {
      merged.dashboard.host = String(env.DASHBOARD_HOST).trim();
    }
    if (env.DASHBOARD_PORT != null && String(env.DASHBOARD_PORT).trim() !== '') {
      const envPort = Number(env.DASHBOARD_PORT);
      if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) {
        merged.dashboard.port = envPort;
      }
    }
    if (env.DASHBOARD_TOKEN && String(env.DASHBOARD_TOKEN).trim()) {
      merged.dashboard.token = String(env.DASHBOARD_TOKEN).trim();
    }
    if (env.BOT_AGENT_MODEL && String(env.BOT_AGENT_MODEL).trim()) {
      merged.companion = merged.companion ?? { ...DEFAULT_CONFIG.companion };
      merged.companion.agentModel = String(env.BOT_AGENT_MODEL).trim();
    }
  }

  const normalizedAddr = parseServerAddress(merged.minecraft.host, {
    defaultPort: merged.minecraft.port || 25565,
  });
  if (normalizedAddr?.host) {
    merged.minecraft.host = normalizedAddr.host;
    if (normalizedAddr.explicitPort && !hasExplicitEnvPort) {
      merged.minecraft.port = normalizedAddr.port;
    } else if (
      normalizedAddr.isE4mc &&
      !hasExplicitEnvPort &&
      (!hasExplicitFilePort || (env?.MINECRAFT_HOST && !isE4mcHost(parsed?.minecraft?.host)))
    ) {
      merged.minecraft.port = 25565;
    }
  }

  const validated = ConfigSchema.parse(merged);

  if (!validated.combat.jevIntervalMs) {
    validated.combat.jevIntervalMs = validated.llm.jevIntervalMs;
  }
  return validated;
}
