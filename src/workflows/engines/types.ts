/**
 * Workflow Engine Types
 *
 * Interfaces for workflow phase engines (planner, executor, reviewer).
 * Engines wrap the existing agent infrastructure for workflow-specific tasks.
 */

import type { WorkflowRun, PhaseDefinition, TaskList, ReviewResult } from "../types.js";

// ============================================================================
// Engine Context
// ============================================================================

/**
 * Context passed to all engines during execution.
 */
export interface EngineContext {
  /** Workflow run state */
  run: WorkflowRun;

  /** Current phase definition */
  phase: PhaseDefinition;

  /** Current iteration number (1-based) */
  iteration: number;

  /** Absolute path to workflow directory */
  workflowDir: string;

  /** Absolute path to phase artifacts directory */
  artifactsDir: string;

  /** Absolute path to workspace (target repo) */
  workspacePath: string;

  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;

  /** Callback for progress updates */
  onProgress?: (update: EngineProgressUpdate) => void;
}

/**
 * Progress update emitted during engine execution.
 */
export interface EngineProgressUpdate {
  /** Progress type */
  type: "status" | "artifact" | "task" | "error";

  /** Human-readable message */
  message: string;

  /** Optional structured data */
  data?: Record<string, unknown>;
}

// ============================================================================
// Engine Result
// ============================================================================

/**
 * Result returned by engine execution.
 */
export interface EngineResult {
  /** Whether execution succeeded */
  success: boolean;

  /** List of artifacts produced */
  artifacts: string[];

  /** Error message if failed */
  error?: string;

  /** Execution metrics */
  metrics: EngineMetrics;

  /** Optional structured output (engine-specific) */
  output?: unknown;
}

/**
 * Execution metrics collected by engines.
 */
export interface EngineMetrics {
  /** Total duration in milliseconds */
  durationMs: number;

  /** Token usage (if available) */
  tokens?: {
    input: number;
    output: number;
  };

  /** Number of tool calls made */
  toolCalls?: number;

  /** Model used */
  model?: string;

  /** Provider used */
  provider?: string;
}

// ============================================================================
// Engine Interface
// ============================================================================

/**
 * Base interface for all workflow engines.
 */
export interface WorkflowEngine {
  /** Engine identifier */
  readonly id: "planner" | "executor" | "reviewer";

  /** Human-readable name */
  readonly name: string;

  /**
   * Execute the engine for a workflow phase.
   */
  execute(context: EngineContext): Promise<EngineResult>;

  /**
   * Validate that required inputs are available.
   */
  validateInputs(context: EngineContext): Promise<{ valid: boolean; errors: string[] }>;
}

// ============================================================================
// Engine-Specific Types
// ============================================================================

/**
 * Planner engine output.
 */
export interface PlannerOutput {
  /** Generated plan markdown */
  plan: string;

  /** Generated task list */
  tasks: TaskList;
}

/**
 * Executor engine output.
 */
export interface ExecutorOutput {
  /** Updated task list with completion status */
  tasks: TaskList;

  /** Execution report */
  report: ExecutionReport;
}

/**
 * Execution report from executor engine.
 */
export interface ExecutionReport {
  version: "1.0";
  executedAt: number;
  summary: string;
  tasksCompleted: number;
  tasksFailed: number;
  tasksSkipped: number;
  filesChanged: string[];
  testsRun?: {
    passed: number;
    failed: number;
    skipped: number;
  };
  errors: Array<{
    taskId: string;
    message: string;
    stack?: string;
  }>;
}

/**
 * Reviewer engine output.
 */
export interface ReviewerOutput {
  /** Review result */
  review: ReviewResult;

  /** Recommendations list */
  recommendations: ReviewResult["recommendations"];
}

// ============================================================================
// Engine Options
// ============================================================================

/**
 * Options for planner engine.
 */
export interface PlannerOptions {
  /** Model override (defaults to workflow definition) */
  model?: string;

  /** Maximum tokens for plan generation */
  maxTokens?: number;

  /** Include existing codebase analysis */
  analyzeCodebase?: boolean;

  /** Custom planning instructions */
  instructions?: string;
}

/**
 * Options for executor engine.
 */
export interface ExecutorOptions {
  /** Model override */
  model?: string;

  /** Maximum tokens per task */
  maxTokensPerTask?: number;

  /** Run tests after each task */
  runTestsAfterTask?: boolean;

  /** Commit after each task */
  commitAfterTask?: boolean;

  /** Continue on task failure */
  continueOnFailure?: boolean;
}

/**
 * Options for reviewer engine.
 */
export interface ReviewerOptions {
  /** Base branch for diff (defaults to "main") */
  baseBranch?: string;

  /** Review depth: "quick" | "standard" | "thorough" */
  depth?: "quick" | "standard" | "thorough";

  /** Focus areas for review */
  focusAreas?: Array<"security" | "performance" | "architecture" | "tests" | "docs">;

  /** Minimum score threshold for approval */
  minScore?: number;
}
