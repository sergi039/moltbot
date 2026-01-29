/**
 * Workflow Engines
 *
 * Engine implementations for workflow phases.
 * Each engine wraps the existing agent infrastructure for workflow-specific tasks.
 */

// Types
export type {
  WorkflowEngine,
  EngineContext,
  EngineResult,
  EngineProgressUpdate,
  EngineMetrics,
  PlannerOutput,
  ExecutorOutput,
  ExecutionReport,
  ReviewerOutput,
  PlannerOptions,
  ExecutorOptions,
  ReviewerOptions,
} from "./types.js";

// Engines
export { PlannerEngine, createPlannerEngine } from "./planner.js";
export { ExecutorEngine, createExecutorEngine } from "./executor.js";
export { ReviewerEngine, createReviewerEngine } from "./reviewer.js";

// ============================================================================
// Engine Registry
// ============================================================================

import type { WorkflowEngine } from "./types.js";
import { PlannerEngine } from "./planner.js";
import { ExecutorEngine } from "./executor.js";
import { ReviewerEngine } from "./reviewer.js";

/**
 * Get an engine instance by type.
 */
export function getEngine(type: "planner" | "executor" | "reviewer"): WorkflowEngine {
  switch (type) {
    case "planner":
      return new PlannerEngine();
    case "executor":
      return new ExecutorEngine();
    case "reviewer":
      return new ReviewerEngine();
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown engine type: ${_exhaustive as string}`);
    }
  }
}

/**
 * Create all engines with shared options.
 */
export function createEngines(): {
  planner: PlannerEngine;
  executor: ExecutorEngine;
  reviewer: ReviewerEngine;
} {
  return {
    planner: new PlannerEngine(),
    executor: new ExecutorEngine(),
    reviewer: new ReviewerEngine(),
  };
}
