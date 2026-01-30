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

// Runner types and implementations
export type { EngineAgentRunner, EngineAgentRunParams, EngineAgentRunResult } from "./runner.js";
export {
  StubRunner,
  LiveRunner,
  createRunner,
  generateSessionId,
  mapAgentConfigToRunnerParams,
} from "./runner.js";

// Engines
export { PlannerEngine, createPlannerEngine } from "./planner.js";
export { ExecutorEngine, createExecutorEngine } from "./executor.js";
export { ReviewerEngine, createReviewerEngine } from "./reviewer.js";

// ============================================================================
// Engine Registry
// ============================================================================

import type { WorkflowEngine } from "./types.js";
import type { EngineAgentRunner } from "./runner.js";
import { PlannerEngine } from "./planner.js";
import { ExecutorEngine } from "./executor.js";
import { ReviewerEngine } from "./reviewer.js";

/**
 * Options for creating engines.
 */
export interface GetEngineOptions {
  /** Optional runner to use for agent execution */
  runner?: EngineAgentRunner;
}

/**
 * Get an engine instance by type.
 */
export function getEngine(
  type: "planner" | "executor" | "reviewer",
  options?: GetEngineOptions,
): WorkflowEngine {
  const runner = options?.runner;

  switch (type) {
    case "planner":
      return new PlannerEngine({}, runner);
    case "executor":
      return new ExecutorEngine({}, runner);
    case "reviewer":
      return new ReviewerEngine({}, runner);
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown engine type: ${_exhaustive as string}`);
    }
  }
}

/**
 * Create all engines with shared options.
 */
export function createEngines(options?: GetEngineOptions): {
  planner: PlannerEngine;
  executor: ExecutorEngine;
  reviewer: ReviewerEngine;
} {
  const runner = options?.runner;

  return {
    planner: new PlannerEngine({}, runner),
    executor: new ExecutorEngine({}, runner),
    reviewer: new ReviewerEngine({}, runner),
  };
}
