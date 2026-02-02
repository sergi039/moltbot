import type { AgentBinding, AgentsConfig } from "./types.agents.js";
import type { ApprovalsConfig } from "./types.approvals.js";
import type { AuthConfig } from "./types.auth.js";
import type { DiagnosticsConfig, LoggingConfig, SessionConfig, WebConfig } from "./types.base.js";
import type { BrowserConfig } from "./types.browser.js";
import type { ChannelsConfig } from "./types.channels.js";
import type { CronConfig } from "./types.cron.js";
import type {
  CanvasHostConfig,
  DiscoveryConfig,
  GatewayConfig,
  TalkConfig,
} from "./types.gateway.js";
import type { HooksConfig } from "./types.hooks.js";
import type {
  AudioConfig,
  BroadcastConfig,
  CommandsConfig,
  MessagesConfig,
} from "./types.messages.js";
import type { ModelsConfig } from "./types.models.js";
import type { NodeHostConfig } from "./types.node-host.js";
import type { PluginsConfig } from "./types.plugins.js";
import type { SkillsConfig } from "./types.skills.js";
import type { ToolsConfig } from "./types.tools.js";

export type OpenClawConfig = {
  meta?: {
    /** Last OpenClaw version that wrote this config. */
    lastTouchedVersion?: string;
    /** ISO timestamp when this config was last written. */
    lastTouchedAt?: string;
  };
  auth?: AuthConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (exec `$SHELL -l -c 'env -0'`). */
    shellEnv?: {
      enabled?: boolean;
      /** Timeout for the login shell exec (ms). Default: 15000. */
      timeoutMs?: number;
    };
    /** Inline env vars to apply when not already present in the process env. */
    vars?: Record<string, string>;
    /** Sugar: allow env vars directly under env (string values only). */
    [key: string]:
      | string
      | Record<string, string>
      | { enabled?: boolean; timeoutMs?: number }
      | undefined;
  };
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };
  diagnostics?: DiagnosticsConfig;
  logging?: LoggingConfig;
  update?: {
    /** Update channel for git + npm installs ("stable", "beta", or "dev"). */
    channel?: "stable" | "beta" | "dev";
    /** Check for updates on gateway start (npm installs only). */
    checkOnStart?: boolean;
  };
  browser?: BrowserConfig;
  ui?: {
    /** Accent color for OpenClaw UI chrome (hex). */
    seamColor?: string;
    assistant?: {
      /** Assistant display name for UI surfaces. */
      name?: string;
      /** Assistant avatar (emoji, short text, or image URL/data URI). */
      avatar?: string;
    };
  };
  skills?: SkillsConfig;
  plugins?: PluginsConfig;
  models?: ModelsConfig;
  nodeHost?: NodeHostConfig;
  agents?: AgentsConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  messages?: MessagesConfig;
  commands?: CommandsConfig;
  approvals?: ApprovalsConfig;
  session?: SessionConfig;
  web?: WebConfig;
  channels?: ChannelsConfig;
  cron?: CronConfig;
  hooks?: HooksConfig;
  discovery?: DiscoveryConfig;
  canvasHost?: CanvasHostConfig;
  talk?: TalkConfig;
  gateway?: GatewayConfig;
  workflows?: WorkflowsConfig;
  /** Facts memory system configuration. */
  factsMemory?: FactsMemoryConfig;
};

export type FactsMemoryConfig = {
  /** Whether the facts memory system is enabled. */
  enabled?: boolean;
  /** Path to SQLite database file. */
  dbPath?: string;
  /** Path to markdown files directory. */
  markdownPath?: string;
  /** Batch size for extraction. */
  batchSize?: number;
  /** Extraction settings. */
  extraction?: {
    /** Whether extraction is enabled. */
    enabled?: boolean;
    /** Provider for LLM extraction. */
    provider?: string;
    /** Model for LLM extraction. */
    model?: string;
  };
  /** Scheduler settings for memory consolidation. */
  scheduler?: {
    /** Enable daily consolidation. */
    dailyEnabled?: boolean;
    /** Daily cron expression. */
    dailyCron?: string;
    /** Enable weekly consolidation. */
    weeklyEnabled?: boolean;
    /** Weekly cron expression. */
    weeklyCron?: string;
    /** Timezone for cron expressions. */
    timezone?: string;
  };
  /** Embeddings settings for semantic search. */
  embeddings?: {
    /** Whether embeddings are enabled. */
    enabled?: boolean;
    /** Provider for embeddings (e.g., "openai"). */
    provider?: string;
    /** Model for embeddings. */
    model?: string;
    /** Enable fallback to stub embeddings when API unavailable. */
    fallbackEnabled?: boolean;
  };
  /** Retention settings for cleanup. */
  retention?: {
    /** Maximum age in days for memories (older are deleted). */
    maxAgeDays?: number;
    /** Maximum database size in MB. */
    maxSizeMb?: number;
    /** Prune memories with low importance. */
    pruneLowImportance?: boolean;
    /** Minimum importance threshold (memories below are pruned). */
    minImportance?: number;
    /** Days after which daily/weekly summaries are truncated. */
    truncateSummariesDays?: number;
  };
  /** Rate limits and guardrails. */
  limits?: {
    /** Maximum messages per extraction batch. */
    maxMessages?: number;
    /** Maximum facts per extraction. */
    maxFacts?: number;
    /** Maximum token budget per extraction. */
    maxTokens?: number;
    /** Cooldown between extractions in milliseconds. */
    cooldownMs?: number;
  };
  /** Redaction settings for export and display. */
  redaction?: {
    /** Whether redaction is enabled by default. */
    enabled?: boolean;
    /** Redaction pattern types to apply. */
    patterns?: (
      | "EMAIL"
      | "PHONE"
      | "API_KEY"
      | "JWT"
      | "BEARER"
      | "URL_CREDS"
      | "IP_ADDRESS"
      | "CREDIT_CARD"
      | "SSN"
    )[];
  };
  /** Access control settings for role-based visibility. */
  access?: {
    /** Whether access control is enabled. */
    enabled?: boolean;
    /** Default role when none specified. */
    defaultRole?: "admin" | "operator" | "analyst" | "guest";
    /** Custom role configurations. */
    roles?: {
      admin?: FactsMemoryRoleConfig;
      operator?: FactsMemoryRoleConfig;
      analyst?: FactsMemoryRoleConfig;
      guest?: FactsMemoryRoleConfig;
    };
  };
  /** Alert thresholds for health monitoring. */
  alerts?: {
    /** Maximum database size in MB before alert. */
    maxDbSizeMb?: number;
    /** Maximum extraction errors per day before alert. */
    maxErrorsPerDay?: number;
    /** Maximum days without extraction before stale alert. */
    maxStaleDays?: number;
    /** Whether to run daily health checks. */
    healthCheckEnabled?: boolean;
    /** Cron expression for health checks (default: "0 6 * * *" - 06:00 daily). */
    healthCheckCron?: string;
  };
};

export type FactsMemoryRoleConfig = {
  /** Memory types this role can access. */
  allowedTypes?: ("fact" | "preference" | "decision" | "event" | "todo")[];
  /** Whether this role can see superseded entries. */
  canSeeSuperseded?: boolean;
  /** Whether this role can export data. */
  canExport?: boolean;
  /** Whether this role can see unredacted data. */
  canSeeUnredacted?: boolean;
};

export type WorkflowsConfig = {
  /** Whether workflows module is enabled. */
  enabled?: boolean;
  /** Custom storage path for workflow data. */
  storagePath?: string;
  /** Policy settings for workflow security. */
  policy?: {
    /** Timeout in milliseconds for approval prompts (default: 60000). */
    approvalTimeoutMs?: number;
  };
  /** Intent routing settings for natural language workflow invocation. */
  routing?: {
    /** Whether intent routing is enabled. Default: false. */
    enabled?: boolean;
    /** Minimum confidence score (0-1) for intent detection. Default: 0.7. */
    minConfidence?: number;
    /** Auto-start workflow without confirmation. Default: false. */
    autoStart?: boolean;
  };
  /** Retention settings for workflow cleanup. */
  retention?: {
    /** Maximum number of completed workflows to keep. */
    maxCompleted?: number;
    /** Maximum disk space per workflow in MB. */
    maxDiskPerWorkflowMb?: number;
    /** Maximum total disk space for all workflows in GB. */
    maxTotalDiskGb?: number;
    /** Days to keep logs for completed workflows. */
    logRetentionDays?: number;
    /** Days to keep logs for failed workflows. */
    failedLogRetentionDays?: number;
    /** Days to keep artifacts. */
    artifactRetentionDays?: number;
    /** Log rotation settings. Set to null to disable rotation. */
    logRotation?: {
      /** Maximum log file size in bytes before rotation. */
      maxSizeBytes?: number;
      /** Maximum number of rotated files to keep. */
      maxRotatedFiles?: number;
    } | null;
    /** Enable automatic cleanup on startup and at intervals. */
    autoCleanup?: boolean;
    /** Interval in minutes between auto-cleanup runs (default: 60). */
    cleanupIntervalMinutes?: number;
  };
};

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type LegacyConfigIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  valid: boolean;
  config: OpenClawConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
