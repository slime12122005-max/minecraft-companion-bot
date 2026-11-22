import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const DEFAULT_CONFIG = {
  minecraft: {
    host: 'localhost',
    port: 55916,
    username: 'bot_dong_hanh',
    version: '1.21.1',
  },
  owner: 'araslime',
  llm: {
    provider: 'typesafe',
    model: 'jev-latest',
    baseUrl: 'https://api.typesafe.ai',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    jevIntervalMs: 4000,
  },
  chat: {
    enabled: true,
    humanReply: true,
    mcpChat: false,
    provider: 'crowllm',
    model: 'particle-1:free',
    fallbackModels: ['grok-4.7-fast:free'],
    baseUrl: 'https://crowllm.com/v1',
    apiKeyEnv: 'CROWLLM_API_KEY',
    maxRequestsPerMin: 30,
  },
  combat: {
    enabled: true,
    defendOwner: true,
    radius: 16,
    retreatHealth: 8,
    crit: true,
    bow: true,
    shieldAgainstCreeper: true,
    useCausality: true,
    minConfidence: 0.3,
  },
  inventory: {
    blockStacks: 1,
    keepFood: 16,
    discardObsolete: false,
  },
  building: {
    confirmTerrainChange: true,
    maxBlocksPerSession: 5000,
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
  },
  dashboard: {
    enabled: false,
    host: '127.0.0.1',
    port: 3000,
  },
};

const ConfigSchema = z.object({
  minecraft: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(16),
    version: z.string().min(1),
  }),
  owner: z.string().min(1),
  llm: z.object({
    provider: z.string().optional(),
    model: z.string().min(1),
    fallbackModels: z.array(z.string().min(1)).optional(),
    baseUrl: z.string().url().or(z.literal('')).optional(),
    apiKeyEnv: z.string().optional(),
    jevIntervalMs: z.number().int().positive(),
    maxRequestsPerMin: z.number().int().nonnegative().optional(),
  }),
  chat: z.object({
    enabled: z.boolean().optional(),
    humanReply: z.boolean().optional(),
    mcpChat: z.boolean().optional(),
    provider: z.string().optional(),
    model: z.string().min(1),
    fallbackModels: z.array(z.string().min(1)).optional(),
    baseUrl: z.string().url().or(z.literal('')).optional(),
    apiKeyEnv: z.string().optional(),
    maxRequestsPerMin: z.number().int().nonnegative().optional(),
  }).optional(),
  combat: z.object({
    enabled: z.boolean(),
    defendOwner: z.boolean(),
    radius: z.number().positive(),
    retreatHealth: z.number().nonnegative(),
    crit: z.boolean(),
    bow: z.boolean(),
    shieldAgainstCreeper: z.boolean(),
    useCausality: z.boolean().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    jevIntervalMs: z.number().int().positive().optional(),
  }),
  inventory: z.object({
    blockStacks: z.number().int().nonnegative(),
    keepFood: z.number().int().nonnegative(),
    discardObsolete: z.boolean(),
  }),
  building: z.object({
    confirmTerrainChange: z.boolean(),
    maxBlocksPerSession: z.number().int().positive(),
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
  }).optional(),
  dashboard: z.object({
    enabled: z.boolean(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    token: z.string().optional(),
  }).optional(),
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

  if (parsed?.chat?.provider && String(parsed.chat.provider).trim().toLowerCase() !== DEFAULT_CONFIG.chat.provider) {
    if (parsed.chat.fallbackModels === undefined) merged.chat.fallbackModels = [];
    if (parsed.chat.baseUrl === undefined) merged.chat.baseUrl = undefined;
    if (parsed.chat.apiKeyEnv === undefined) merged.chat.apiKeyEnv = undefined;
  }
  if (parsed?.llm?.provider && String(parsed.llm.provider).trim().toLowerCase() !== DEFAULT_CONFIG.llm.provider) {
    if (parsed.llm.fallbackModels === undefined) merged.llm.fallbackModels = [];
  }

  if (env) {
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
  }

  const validated = ConfigSchema.parse(merged);

  if (!validated.combat.jevIntervalMs) {
    validated.combat.jevIntervalMs = validated.llm.jevIntervalMs;
  }
  return validated;
}
