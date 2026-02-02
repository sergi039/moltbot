/**
 * Multi-Agent Workflow Module
 *
 * Public API for the workflow orchestration system.
 * See docs/architecture/multi-agent-workflow.md for full specification.
 *
 * @example
 * ```typescript
 * import { getOrchestrator, registerDevCycleWorkflow } from "./workflows";
 *
 * const orchestrator = getOrchestrator();
 * registerDevCycleWorkflow(orchestrator);
 *
 * const run = await orchestrator.start("dev-cycle", {
 *   task: "Build a REST API for todo management",
 *   repoPath: "~/projects/todo-api",
 * }, {
 *   mode: "in-place",
 *   targetRepo: "~/projects/todo-api",
 * });
 *
 * await orchestrator.execute(run.id);
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export type {
  // Security
  WorkflowSecurityPolicy,

  // Workspace
  WorkspaceMode,
  WorkspaceConfig,
  InPlaceValidationOptions,
  ValidationResult,

  // Definition
  WorkflowDefinition,
  WorkflowSettings,
  PhaseDefinition,
  AgentConfig,
  PhaseSettings,
  PhaseTransition,
  SuccessCriteria,

  // State
  WorkflowStatus,
  WorkflowInput,
  WorkflowRun,
  WorkflowError,
  PhaseStatus,
  PhaseExecution,
  AgentProcessInfo,
  PhaseMetrics,

  // Tasks
  TaskList,
  TaskStats,
  TaskType,
  TaskStatus,
  Task,
  TaskResult,

  // Review
  ReviewResult,
  ReviewScores,
  IssueSeverity,
  ReviewIssue,
  RecommendationPriority,
  Recommendation,

  // Communication
  HandoffContext,
  ProjectContext,
  ChangesInScope,

  // Events
  WorkflowEventType,
  WorkflowEvent,
  WorkflowEventHandler,

  // Configuration
  WorkflowModuleConfig,
  RetentionConfig,
  RecoveryStrategy,
} from "./types.js";

// ============================================================================
// Orchestrator
// ============================================================================

export { WorkflowOrchestrator, getOrchestrator, resetOrchestrator } from "./orchestrator.js";

// ============================================================================
// State Management
// ============================================================================

export {
  // Persistence
  setWorkflowStoragePath,
  getWorkflowStoragePath,
  getWorkflowDir,
  getPhaseDir,
  saveWorkflowState,
  loadWorkflowState,
  listWorkflows,
  listRunningWorkflows,
  deleteWorkflow,
  cleanupOldWorkflows,
  getGlobalEvents,
  type WorkflowSummary,
  type CleanupResult,
} from "./state/persistence.js";

export {
  // Transitions
  canTransitionWorkflow,
  canTransitionPhase,
  assertWorkflowTransition,
  assertPhaseTransition,
  buildPhaseDependencyGraph,
  getExecutablePhases,
  topologicalSort,
  validatePhaseTransition,
  getCurrentIteration,
  hasExceededMaxIterations,
  getPhaseExecutionHistory,
} from "./state/transitions.js";

export {
  // Workspace
  setupWorkspace,
  cleanupWorkspace,
  validateInPlaceWorkspace,
  validateWorktreeWorkspace,
  isGitRepo,
  getCurrentBranch,
  sanitizeBranchName,
  type WorkspaceSetupResult,
} from "./state/workspace.js";

// ============================================================================
// Artifacts
// ============================================================================

export {
  // Store
  getArtifactsDir,
  getLogsDir,
  getOutputDir,
  saveArtifact,
  loadArtifact,
  loadArtifactJson,
  copyArtifactToOutput,
  listArtifacts,
  listAllArtifacts,
  artifactExists,
  generateManifest,
  saveManifest,
  deleteArtifacts,
  redactSecrets,
  type ArtifactMetadata,
  type ArtifactManifest,
} from "./artifacts/store.js";

export {
  // Validation
  validatePhaseOutput,
  validateTaskList,
  validateReviewResult,
  evaluateCondition,
} from "./artifacts/validator.js";

// ============================================================================
// Agents
// ============================================================================

export { createHandoffPackage, loadHandoffContext, type HandoffPackage } from "./agents/handoff.js";

// ============================================================================
// Engines
// ============================================================================

export {
  // Types
  type WorkflowEngine,
  type EngineContext,
  type EngineResult,
  type EngineProgressUpdate,
  type EngineMetrics,
  type PlannerOutput,
  type ExecutorOutput,
  type ExecutionReport,
  type ReviewerOutput,
  type PlannerOptions,
  type ExecutorOptions,
  type ReviewerOptions,

  // Engines
  PlannerEngine,
  ExecutorEngine,
  ReviewerEngine,
  createPlannerEngine,
  createExecutorEngine,
  createReviewerEngine,
  getEngine,
  createEngines,
} from "./engines/index.js";

// ============================================================================
// Constants
// ============================================================================

export {
  // Paths
  DEFAULT_WORKFLOWS_DIR,
  WORKFLOW_STATE_FILE,
  WORKFLOW_INPUT_FILE,
  PHASES_DIR,
  WORKSPACE_DIR,
  OUTPUT_DIR,
  ARTIFACTS_DIR,
  LOGS_DIR,
  HANDOFF_DIR,

  // Timeouts
  DEFAULT_WORKFLOW_TIMEOUT_MS,
  DEFAULT_PHASE_TIMEOUT_MS,
  DEFAULT_AGENT_STARTUP_TIMEOUT_MS,
  ORCHESTRATION_OVERHEAD_TARGET_MS,

  // Limits
  DEFAULT_MAX_REVIEW_ITERATIONS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_CONCURRENT_WORKFLOWS,
  DEFAULT_MAX_COMPLETED_WORKFLOWS,

  // Defaults
  DEFAULT_WORKFLOW_SETTINGS,
  DEFAULT_SECURITY_POLICY,
  DEFAULT_RETENTION_CONFIG,
  DEFAULT_UNTRACKED_CHECK_PATHS,

  // Artifacts
  PLAN_FILE,
  TASKS_FILE,
  REVIEW_FILE,
  EXECUTION_REPORT_FILE,
  RECOMMENDATIONS_FILE,
  FINAL_REPORT_FILE,
  CHANGELOG_FILE,

  // Handoff
  HANDOFF_CONTEXT_FILE,
  HANDOFF_INSTRUCTIONS_FILE,
  HANDOFF_EXPECTATIONS_FILE,

  // Events
  PERSISTENCE_EVENTS,

  // Security
  REDACTION_PATTERNS,
  BLOCKED_FILE_PATTERNS,

  // IDs
  WORKFLOW_ID_PREFIX,
  generateWorkflowId,

  // Phase IDs
  PHASE_PLANNING,
  PHASE_PLAN_REVIEW,
  PHASE_EXECUTION,
  PHASE_CODE_REVIEW,
  PHASE_FINALIZE,
} from "./constants.js";

// ============================================================================
// Workflow Definitions
// ============================================================================

import type { WorkflowDefinition } from "./types.js";
import {
  DEFAULT_WORKFLOW_TIMEOUT_MS,
  DEFAULT_MAX_REVIEW_ITERATIONS,
  PLAN_FILE,
  TASKS_FILE,
  REVIEW_FILE,
  EXECUTION_REPORT_FILE,
  RECOMMENDATIONS_FILE,
  FINAL_REPORT_FILE,
  CHANGELOG_FILE,
  PHASE_PLANNING,
  PHASE_PLAN_REVIEW,
  PHASE_EXECUTION,
  PHASE_CODE_REVIEW,
  PHASE_FINALIZE,
} from "./constants.js";
import { WorkflowOrchestrator } from "./orchestrator.js";

/**
 * Standard Dev Cycle workflow definition.
 * Planning -> Plan Review -> Execution -> Code Review -> Finalize
 */
export const DEV_CYCLE_WORKFLOW: WorkflowDefinition = {
  type: "dev-cycle",
  name: "Standard Development Cycle",
  description:
    "Full development workflow with planning, execution, and review phases. " +
    "Claude handles planning and execution, Codex handles reviews.",
  version: "1.0.0",

  phases: [
    {
      id: PHASE_PLANNING,
      name: "Project Planning",
      engine: "planner",
      agent: {
        type: "claude",
        model: "claude-sonnet-4",
      },
      inputArtifacts: [],
      outputArtifacts: [PLAN_FILE, TASKS_FILE],
      settings: {
        timeoutMs: 300000, // 5 min
        retries: 1,
      },
    },
    {
      id: PHASE_PLAN_REVIEW,
      name: "Plan Review",
      engine: "reviewer",
      agent: {
        type: "codex",
        flags: ["--full-auto"],
      },
      inputArtifacts: [PLAN_FILE, TASKS_FILE],
      outputArtifacts: ["plan-review.json"],
      settings: {
        timeoutMs: 180000, // 3 min
        retries: 1,
      },
      transitions: [
        {
          condition: "$.planReview.approved == false",
          targetPhase: PHASE_PLANNING,
        },
      ],
    },
    {
      id: PHASE_EXECUTION,
      name: "Task Execution",
      engine: "executor",
      agent: {
        type: "claude",
        model: "claude-sonnet-4",
      },
      inputArtifacts: [TASKS_FILE],
      outputArtifacts: [TASKS_FILE, EXECUTION_REPORT_FILE],
      settings: {
        timeoutMs: 1800000, // 30 min
        retries: 2,
      },
    },
    {
      id: PHASE_CODE_REVIEW,
      name: "Code Review",
      engine: "reviewer",
      agent: {
        type: "codex",
        flags: ["review", "--base", "main"],
      },
      inputArtifacts: [TASKS_FILE, EXECUTION_REPORT_FILE],
      outputArtifacts: [REVIEW_FILE, RECOMMENDATIONS_FILE],
      settings: {
        timeoutMs: 300000, // 5 min
        retries: 1,
      },
      transitions: [
        {
          condition: "$.review.issues[?(@.severity=='critical')].length > 0",
          targetPhase: PHASE_EXECUTION,
        },
      ],
    },
    {
      id: PHASE_FINALIZE,
      name: "Finalize",
      engine: "executor",
      agent: {
        type: "claude",
      },
      inputArtifacts: [REVIEW_FILE],
      outputArtifacts: [FINAL_REPORT_FILE, CHANGELOG_FILE],
      settings: {
        timeoutMs: 120000, // 2 min
        retries: 1,
      },
    },
  ],

  settings: {
    maxDurationMs: DEFAULT_WORKFLOW_TIMEOUT_MS,
    maxReviewIterations: DEFAULT_MAX_REVIEW_ITERATIONS,
    autoCommit: false,
    notifyOnPhaseComplete: true,
  },

  successCriteria: {
    testsPass: true,
    minReviewScore: 70,
    requiredArtifacts: [TASKS_FILE, REVIEW_FILE, FINAL_REPORT_FILE],
  },
};

/**
 * Review-only workflow definition.
 * Just Code Review phase, no planning or execution.
 */
export const REVIEW_ONLY_WORKFLOW: WorkflowDefinition = {
  type: "review-only",
  name: "Code Review Only",
  description: "Review existing code changes without planning or execution.",
  version: "1.0.0",

  phases: [
    {
      id: PHASE_CODE_REVIEW,
      name: "Code Review",
      engine: "reviewer",
      agent: {
        type: "codex",
        flags: ["review", "--base", "main"],
      },
      inputArtifacts: [],
      outputArtifacts: [REVIEW_FILE, RECOMMENDATIONS_FILE],
      settings: {
        timeoutMs: 300000, // 5 min
        retries: 1,
      },
    },
  ],

  settings: {
    maxDurationMs: 600000, // 10 min
    maxReviewIterations: 1,
    autoCommit: false,
    notifyOnPhaseComplete: true,
  },

  successCriteria: {
    testsPass: false,
    requiredArtifacts: [REVIEW_FILE],
  },
};

/**
 * Register the standard dev cycle workflow with an orchestrator.
 */
export function registerDevCycleWorkflow(orchestrator: WorkflowOrchestrator): void {
  orchestrator.registerDefinition(DEV_CYCLE_WORKFLOW);
}

/**
 * Register the review-only workflow with an orchestrator.
 */
export function registerReviewOnlyWorkflow(orchestrator: WorkflowOrchestrator): void {
  orchestrator.registerDefinition(REVIEW_ONLY_WORKFLOW);
}

/**
 * Register all built-in workflows with an orchestrator.
 */
export function registerBuiltinWorkflows(orchestrator: WorkflowOrchestrator): void {
  registerDevCycleWorkflow(orchestrator);
  registerReviewOnlyWorkflow(orchestrator);
}
