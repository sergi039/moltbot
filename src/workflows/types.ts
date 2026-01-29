/**
 * Multi-Agent Workflow Types
 *
 * Core type definitions for the workflow orchestration system.
 * See docs/architecture/multi-agent-workflow.md for full specification.
 */

// ============================================================================
// Security Policy
// ============================================================================

export interface WorkflowSecurityPolicy {
  /** Run agents in sandbox (default: true) */
  sandboxed: boolean;

  /** Require exec approvals for tool calls */
  execApprovalsRequired: boolean;

  /** Allowed tools whitelist (empty = all allowed tools) */
  allowedTools?: string[];

  /** Blocked tools blacklist */
  blockedTools?: string[];

  /** Filesystem scope (agents can only access these paths) */
  filesystemScope: {
    /** Workspace directory (always allowed) */
    workspace: string;
    /** Additional allowed paths (globs) */
    additionalPaths?: string[];
  };

  /** Network policy */
  network: {
    /** Allow outbound network (default: true for API calls) */
    allowOutbound: boolean;
    /** Blocked domains */
    blockedDomains?: string[];
  };
}

// ============================================================================
// Workspace Configuration
// ============================================================================

export type WorkspaceMode = "in-place" | "worktree" | "copy";

export interface InPlaceValidationOptions {
  /** Fail if untracked files exist in source dirs (default: false) */
  failOnUntracked?: boolean;
  /** Directories to check for untracked files (default: ["src/"]) */
  untrackedCheckPaths?: string[];
}

export interface WorkspaceConfig {
  mode: WorkspaceMode;
  targetRepo: string;
  /** For worktree mode */
  branch?: string;
  baseBranch?: string;
  /** For copy mode */
  shallow?: boolean;
  /** Validation options for in-place mode */
  validation?: InPlaceValidationOptions;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

// ============================================================================
// Workflow Definition
// ============================================================================

export interface WorkflowDefinition {
  /** Unique workflow type identifier */
  type: "dev-cycle" | "review-only" | "custom";

  /** Workflow metadata */
  name: string;
  description?: string;
  version: string;

  /** Phase configuration */
  phases: PhaseDefinition[];

  /** Global settings */
  settings: WorkflowSettings;

  /** Success criteria */
  successCriteria: SuccessCriteria;

  /** Security policy override */
  security?: Partial<WorkflowSecurityPolicy>;
}

export interface WorkflowSettings {
  /** Max total workflow duration (ms) */
  maxDurationMs: number;
  /** Max iterations for review loop */
  maxReviewIterations: number;
  /** Auto-commit after each phase */
  autoCommit: boolean;
  /** Notify user between phases */
  notifyOnPhaseComplete: boolean;
  /** Require elevated (non-sandboxed) execution */
  elevated?: boolean;
}

export interface PhaseDefinition {
  id: string;
  name: string;
  engine: "planner" | "executor" | "reviewer";

  /** Agent configuration for this phase */
  agent: AgentConfig;

  /** Input artifacts required from previous phases */
  inputArtifacts: string[];

  /** Output artifacts this phase must produce */
  outputArtifacts: string[];

  /** Phase-specific settings */
  settings: PhaseSettings;

  /** Optional: next phase override based on output */
  transitions?: PhaseTransition[];
}

export interface AgentConfig {
  type: "claude" | "codex";
  model?: string;
  flags?: string[];
}

export interface PhaseSettings {
  timeoutMs: number;
  retries: number;
  /** Condition to proceed to next phase (JSONPath expression) */
  proceedCondition?: string;
}

export interface PhaseTransition {
  condition: string;
  targetPhase: string;
}

export interface SuccessCriteria {
  /** All tests must pass */
  testsPass: boolean;
  /** Review score threshold (0-100) */
  minReviewScore?: number;
  /** Required artifacts */
  requiredArtifacts: string[];
  /** Custom validation function */
  customValidator?: string;
}

// ============================================================================
// Workflow State
// ============================================================================

export type WorkflowStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowInput {
  /** High-level task description */
  task: string;
  /** Target repository path */
  repoPath: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  definitionType: string;
  status: WorkflowStatus;

  /** Original input */
  input: WorkflowInput;

  /** Workspace configuration */
  workspace: WorkspaceConfig;

  /** Current phase */
  currentPhase: string | null;

  /** Phase execution history */
  phaseHistory: PhaseExecution[];

  /** Iteration count (for review loops) */
  iterationCount: number;

  /** Timestamps */
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;

  /** Error if failed */
  error?: WorkflowError;

  /** Final output location */
  outputPath?: string;
}

export interface WorkflowError {
  phase: string;
  message: string;
  stack?: string;
  recoverable: boolean;
}

export type PhaseStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface PhaseExecution {
  phaseId: string;
  iteration: number;
  status: PhaseStatus;

  /** Agent process info */
  agentProcess?: AgentProcessInfo;

  /** Artifacts produced */
  artifacts: string[];

  /** Metrics */
  metrics: PhaseMetrics;

  /** Logs */
  logPath: string;
}

export interface AgentProcessInfo {
  sessionId: string;
  pid: number;
  startedAt: number;
  completedAt?: number;
}

export interface PhaseMetrics {
  durationMs: number;
  tokensUsed?: number;
  cost?: number;
}

// ============================================================================
// Task Structure
// ============================================================================

export interface TaskList {
  version: string;
  projectName: string;
  createdAt: number;
  updatedAt: number;

  tasks: Task[];

  /** Summary stats */
  stats: TaskStats;
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  pending: number;
}

export type TaskType = "feature" | "bugfix" | "refactor" | "test" | "docs";
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked";

export interface Task {
  id: string;
  title: string;
  description: string;

  /** Task type */
  type: TaskType;

  /** Priority (1 = highest) */
  priority: number;

  /** Estimated complexity (1-5) */
  complexity: number;

  /** Dependencies (task IDs) */
  dependsOn: string[];

  /** Status */
  status: TaskStatus;

  /** Assigned agent */
  assignedAgent?: "claude" | "codex";

  /** Acceptance criteria */
  acceptanceCriteria: string[];

  /** Files to modify */
  targetFiles?: string[];

  /** Execution result */
  result?: TaskResult;
}

export interface TaskResult {
  completedAt: number;
  filesModified: string[];
  testsAdded: string[];
  testsPassed: boolean;
  notes?: string;
}

// ============================================================================
// Review Structure
// ============================================================================

export interface ReviewResult {
  version: string;
  reviewedAt: number;
  reviewer: "codex";

  /** Overall score (0-100) */
  overallScore: number;

  /** Category scores */
  scores: ReviewScores;

  /** Issues found */
  issues: ReviewIssue[];

  /** Recommendations */
  recommendations: Recommendation[];

  /** Approval status */
  approved: boolean;

  /** Summary */
  summary: string;
}

export interface ReviewScores {
  architecture: number;
  codeQuality: number;
  testCoverage: number;
  security: number;
  documentation: number;
}

export type IssueSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewIssue {
  id: string;
  severity: IssueSeverity;
  category: string;
  file?: string;
  line?: number;
  description: string;
  suggestion?: string;
}

export type RecommendationPriority = "must" | "should" | "could";

export interface Recommendation {
  id: string;
  priority: RecommendationPriority;
  description: string;
  rationale: string;
  /** Task to create if accepted */
  suggestedTask?: Partial<Task>;
}

// ============================================================================
// Agent Communication
// ============================================================================

export interface HandoffContext {
  workflowId: string;
  phase: string;
  iteration: number;
  previousPhase: string | null;
  projectContext: ProjectContext;
  relevantFiles: string[];
  changesInScope: ChangesInScope;
}

export interface ProjectContext {
  name: string;
  language: string;
  framework?: string;
}

export interface ChangesInScope {
  added: string[];
  modified: string[];
  deleted: string[];
}

// ============================================================================
// Events
// ============================================================================

export type WorkflowEventType =
  | "workflow:started"
  | "workflow:paused"
  | "workflow:resumed"
  | "workflow:completed"
  | "workflow:failed"
  | "workflow:cancelled"
  | "phase:started"
  | "phase:completed"
  | "phase:failed"
  | "artifact:created"
  | "iteration:started";

export interface WorkflowEvent {
  type: WorkflowEventType;
  workflowId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export type WorkflowEventHandler = (event: WorkflowEvent) => void | Promise<void>;

// ============================================================================
// Configuration
// ============================================================================

export interface WorkflowModuleConfig {
  enabled: boolean;
  storagePath: string;

  defaults: Partial<WorkflowSettings>;

  agents: {
    claude?: {
      model?: string;
      authProfileId?: string;
    };
    codex?: {
      model?: string;
      flags?: string[];
    };
  };

  definitions: Record<string, string>;

  retention: RetentionConfig;
}

export interface RetentionConfig {
  maxConcurrent: number;
  maxCompleted: number;
  maxDiskPerWorkflowMb: number;
  maxTotalDiskGb: number;
  logRetentionDays: number;
  failedLogRetentionDays: number;
  artifactRetentionDays: number;
}

// ============================================================================
// Recovery
// ============================================================================

export interface RecoveryStrategy {
  /** Retry the current phase */
  retry: {
    maxAttempts: number;
    backoffMs: number;
  };

  /** Fall back to different agent */
  fallback?: {
    agent: "claude" | "codex";
    model?: string;
  };

  /** Pause and wait for user */
  pauseOnFailure: boolean;

  /** Save partial progress */
  savePartialArtifacts: boolean;
}
