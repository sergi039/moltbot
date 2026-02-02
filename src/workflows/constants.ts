/**
 * Multi-Agent Workflow Constants
 *
 * Default values and configuration constants for the workflow system.
 */

import type { RetentionConfig, WorkflowSecurityPolicy, WorkflowSettings } from "./types.js";

// ============================================================================
// Paths
// ============================================================================

export const DEFAULT_WORKFLOWS_DIR = "workflows";
export const WORKFLOW_STATE_FILE = "workflow.json";
export const WORKFLOW_INPUT_FILE = "input.json";
export const PHASES_DIR = "phases";
export const WORKSPACE_DIR = "workspace";
export const OUTPUT_DIR = "output";
export const ARTIFACTS_DIR = "artifacts";
export const LOGS_DIR = "logs";
export const HANDOFF_DIR = "handoff";

// ============================================================================
// Timeouts (ms)
// ============================================================================

export const DEFAULT_WORKFLOW_TIMEOUT_MS = 3600000; // 1 hour
export const DEFAULT_PHASE_TIMEOUT_MS = 300000; // 5 minutes
export const DEFAULT_AGENT_STARTUP_TIMEOUT_MS = 30000; // 30 seconds
export const ORCHESTRATION_OVERHEAD_TARGET_MS = 500; // NF1 target

// ============================================================================
// Limits
// ============================================================================

export const DEFAULT_MAX_REVIEW_ITERATIONS = 3;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_CONCURRENT_WORKFLOWS = 5;
export const DEFAULT_MAX_COMPLETED_WORKFLOWS = 20;
export const DEFAULT_MAX_TASKS = 50;
export const DEFAULT_MAX_AGENT_RUNS = 100;

// ============================================================================
// Default Settings
// ============================================================================

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  maxDurationMs: DEFAULT_WORKFLOW_TIMEOUT_MS,
  maxReviewIterations: DEFAULT_MAX_REVIEW_ITERATIONS,
  autoCommit: false,
  notifyOnPhaseComplete: true,
  elevated: false,
};

export const DEFAULT_SECURITY_POLICY: WorkflowSecurityPolicy = {
  sandboxed: true,
  execApprovalsRequired: true,
  blockedTools: [],
  filesystemScope: {
    workspace: "", // Set at runtime
    additionalPaths: [],
  },
  network: {
    allowOutbound: true,
    blockedDomains: [],
  },
};

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  maxConcurrent: 5,
  maxCompleted: 20,
  maxDiskPerWorkflowMb: 500,
  maxTotalDiskGb: 5,
  logRetentionDays: 7,
  failedLogRetentionDays: 30,
  artifactRetentionDays: 30,
};

/** Default interval for cleanup scheduler (in minutes) */
export const DEFAULT_CLEANUP_INTERVAL_MINUTES = 60;

// ============================================================================
// Validation
// ============================================================================

export const DEFAULT_UNTRACKED_CHECK_PATHS = ["src/"];

// ============================================================================
// Artifact Files
// ============================================================================

export const PLAN_FILE = "plan.md";
export const TASKS_FILE = "tasks.json";
export const REVIEW_FILE = "review.json";
export const EXECUTION_REPORT_FILE = "execution-report.json";
export const RECOMMENDATIONS_FILE = "recommendations.json";
export const FINAL_REPORT_FILE = "final-report.md";
export const CHANGELOG_FILE = "changelog.md";

// ============================================================================
// Handoff Files
// ============================================================================

export const HANDOFF_CONTEXT_FILE = "context.json";
export const HANDOFF_INSTRUCTIONS_FILE = "instructions.md";
export const HANDOFF_EXPECTATIONS_FILE = "expectations.json";

// ============================================================================
// State Persistence Events
// ============================================================================

export const PERSISTENCE_EVENTS = [
  "phase:started",
  "phase:completed",
  "phase:failed",
  "artifact:created",
  "iteration:started",
  "workflow:paused",
  "workflow:resumed",
] as const;

// ============================================================================
// Secret Redaction Patterns
// ============================================================================

export const REDACTION_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9-]{20,}/g, // OpenAI keys (includes sk-proj- format)
  /sk-ant-[a-zA-Z0-9-]{40,}/g, // Anthropic keys
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub PAT
  /AKIA[0-9A-Z]{16}/g, // AWS Access Key
  /-----BEGIN [A-Z]+ KEY-----/g, // Private keys
  /Bearer [a-zA-Z0-9._-]+/gi, // Bearer tokens
  /password["']?\s*[:=]\s*["'][^"']+["']/gi, // Password assignments
];

// ============================================================================
// Blocked File Patterns (for artifact storage)
// ============================================================================

export const BLOCKED_FILE_PATTERNS = [
  ".env",
  ".env.*",
  "*credentials*",
  "*secrets*",
  "*.pem",
  "*.key",
  "*.p12",
  "id_rsa",
  "id_ed25519",
];

// ============================================================================
// Workflow Run ID
// ============================================================================

export const WORKFLOW_ID_PREFIX = "wf_";

export function generateWorkflowId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${WORKFLOW_ID_PREFIX}${timestamp}${random}`;
}

// ============================================================================
// Phase IDs (Standard Dev Cycle)
// ============================================================================

export const PHASE_PLANNING = "planning";
export const PHASE_PLAN_REVIEW = "plan-review";
export const PHASE_EXECUTION = "execution";
export const PHASE_CODE_REVIEW = "code-review";
export const PHASE_FINALIZE = "finalize";

// ============================================================================
// Intent Routing Defaults
// ============================================================================

export const DEFAULT_INTENT_MIN_CONFIDENCE = 0.7;
export const DEFAULT_INTENT_ROUTING_ENABLED = false;
export const DEFAULT_INTENT_AUTO_START = false;
