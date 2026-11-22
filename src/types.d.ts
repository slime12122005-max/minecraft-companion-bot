export interface LLMConfig {
  provider?: string;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  jevIntervalMs: number;
  timeoutMs?: number;
  maxRequestsPerMin?: number;
}

export interface BotConfig {
  minecraft: {
    host: string;
    port: number;
    username: string;
    version: string;
  };
  owner: string;
  llm: LLMConfig;
  combat: {
    enabled: boolean;
    defendOwner: boolean;
    radius: number;
    retreatHealth: number;
    crit: boolean;
    bow: boolean;
    shieldAgainstCreeper: boolean;
    useCausality?: boolean;
    minConfidence?: number;
    jevIntervalMs?: number;
  };
  inventory: {
    blockStacks: number;
    keepFood: number;
    discardObsolete: boolean;
  };
  building: {
    confirmTerrainChange: boolean;
    maxBlocksPerSession: number;
    keepWater?: boolean;
  };
  home: {
    setOnCommand: boolean;
    autoReturn: boolean;
    storageChest?: any;
  };
  survival?: {
    requireFood?: boolean;
    minFoodPoints?: number;
  };
  dashboard?: {
    enabled: boolean;
    host: string;
    port: number;
  };
}

export interface TaskMeta {
  name: string;
  reason?: string;
  priority?: number;
  [key: string]: any;
}

export interface TaskSnapshot {
  name?: string;
  progress?: Record<string, any>;
  savedAt: number;
}

export interface ThreatSummary {
  count: number;
  closest: { name: string; distance: number; id: any } | null;
  nearestCreeper: { name: string; distance: number; id: any } | null;
  ownerThreat: { name: string; distance: number; id: any } | null;
  dangerLevel: 'none' | 'low' | 'medium' | 'high';
  hostiles: Array<{ id: any; name: string; distance: number }>;
}

export interface WatchdogStatus {
  healthy: boolean;
  stuck: boolean;
  stuckMs: number;
  lagDetected: boolean;
  lastTickGapMs: number;
  maxTickLagMs: number;
  lastTickAt: number | null;
}

export type SessionStateName =
  | 'DISCONNECTED'
  | 'IDLE'
  | 'BUSY'
  | 'COMBAT'
  | 'RETREATING'
  | 'SLEEPING'
  | 'DEAD';

export interface SessionStateSnapshot {
  state: SessionStateName;
  previousState: SessionStateName | null;
  changedAt: number;
  reason: string;
  history: Array<{ from: SessionStateName; to: SessionStateName; reason: string; at: number }>;
}

export interface LogEntry {
  ts: string;
  level: string;
  tag: string;
  msg: string;
  line: string;
}
