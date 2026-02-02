/**
 * Observability Module
 *
 * Exports workflow logging and event types.
 */

// Types
export type {
  WorkflowEventType,
  WorkflowEventBase,
  WorkflowStartPayload,
  WorkflowCompletePayload,
  PhaseStartPayload,
  PhaseCompletePayload,
  AgentStartPayload,
  AgentCompletePayload,
  PolicyEvaluatePayload,
  ApprovalEventPayload,
  ArtifactEventPayload,
  TaskEventPayload,
  WorkflowRunSummary,
  IWorkflowLogger,
} from "./types.js";

// Logger
export type { WorkflowLoggerOptions } from "./logger.js";
export { WorkflowLogger, createWorkflowLogger, loadRunSummary, loadRunEvents } from "./logger.js";

// Adapter
export type { ObservabilityAdapterOptions } from "./adapter.js";
export { ObservabilityAdapter, attachObservability } from "./adapter.js";
