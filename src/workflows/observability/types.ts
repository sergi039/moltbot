/**
 * Observability Types
 *
 * Types for structured workflow event logging and run summaries.
 */

// ============================================================================
// Event Types
// ============================================================================

/**
 * Types of events that can be logged during workflow execution.
 */
export type WorkflowEventType =
  // Workflow lifecycle
  | "workflow.start"
  | "workflow.complete"
  | "workflow.fail"
  | "workflow.abort"
  // Phase lifecycle
  | "phase.start"
  | "phase.complete"
  | "phase.fail"
  | "phase.skip"
  // Agent events
  | "agent.start"
  | "agent.progress"
  | "agent.complete"
  | "agent.fail"
  | "agent.timeout"
  // Policy events
  | "policy.evaluate"
  | "policy.allow"
  | "policy.deny"
  | "policy.prompt"
  | "policy.auto_approve"
  // Approval events
  | "approval.request"
  | "approval.approved"
  | "approval.denied"
  | "approval.timeout"
  // Artifact events
  | "artifact.save"
  | "artifact.load"
  // Task events
  | "task.start"
  | "task.complete"
  | "task.fail"
  | "task.skip"
  // Cleanup events
  | "cleanup.start"
  | "cleanup.complete"
  | "cleanup.error";

/**
 * Base structure for all workflow events.
 */
export interface WorkflowEventBase {
  /** ISO timestamp of the event */
  timestamp: string;

  /** Workflow run ID */
  runId: string;

  /** Phase ID (if applicable) */
  phaseId?: string;

  /** Iteration number (if applicable) */
  iteration?: number;

  /** Event type */
  type: WorkflowEventType;

  /** Event-specific payload */
  payload: Record<string, unknown>;
}

// ============================================================================
// Specific Event Payloads
// ============================================================================

/**
 * Workflow start event payload.
 */
export interface WorkflowStartPayload {
  workflowType: string;
  task: string;
  workspacePath: string;
  live: boolean;
}

/**
 * Workflow complete event payload.
 */
export interface WorkflowCompletePayload {
  status: "completed" | "failed" | "aborted";
  durationMs: number;
  phasesCompleted: number;
  phasesFailed: number;
}

/**
 * Phase start event payload.
 */
export interface PhaseStartPayload {
  phaseName: string;
  engineId: string;
}

/**
 * Phase complete event payload.
 */
export interface PhaseCompletePayload {
  phaseName: string;
  engineId: string;
  durationMs: number;
  artifacts: string[];
  success: boolean;
  error?: string;
}

/**
 * Agent event payloads.
 */
export interface AgentStartPayload {
  sessionId: string;
  model?: string;
  provider?: string;
}

export interface AgentCompletePayload {
  sessionId: string;
  durationMs: number;
  tokens?: { input: number; output: number };
  success: boolean;
  error?: string;
}

/**
 * Policy evaluation event payload.
 */
export interface PolicyEvaluatePayload {
  actionType: string;
  decision: "allow" | "deny" | "prompt";
  reason: string;
  ruleName?: string;
  targetPath?: string;
  command?: string;
}

/**
 * Approval event payload.
 */
export interface ApprovalEventPayload {
  requestId: string;
  actionType: string;
  decision?: "approved" | "denied" | "timeout";
  remember?: boolean;
}

/**
 * Artifact event payload.
 */
export interface ArtifactEventPayload {
  artifactName: string;
  size?: number;
}

/**
 * Task event payload.
 */
export interface TaskEventPayload {
  taskId: string;
  taskTitle: string;
  success?: boolean;
  error?: string;
}

// ============================================================================
// Run Summary
// ============================================================================

/**
 * Summary of a workflow run, stored in run.json.
 */
export interface WorkflowRunSummary {
  /** Schema version */
  version: "1.0";

  /** Unique run ID */
  runId: string;

  /** Workflow type */
  workflowType: string;

  /** Task description */
  task: string;

  /** Workspace path */
  workspacePath: string;

  /** Whether live mode was enabled */
  live: boolean;

  /** Run status */
  status: "running" | "completed" | "failed" | "aborted";

  /** Start timestamp (ISO) */
  startedAt: string;

  /** End timestamp (ISO), if complete */
  completedAt?: string;

  /** Total duration in milliseconds */
  durationMs?: number;

  /** Error message if failed */
  error?: string;

  /** Phase execution summary */
  phases: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
  };

  /** Token usage summary */
  tokens?: {
    input: number;
    output: number;
  };

  /** Artifacts produced */
  artifacts: string[];

  /** Approval summary */
  approvals?: {
    total: number;
    approved: number;
    denied: number;
    timeout: number;
  };
}

// ============================================================================
// Logger Interface
// ============================================================================

/**
 * Interface for workflow loggers.
 */
export interface IWorkflowLogger {
  /**
   * Log an event.
   */
  logEvent(event: Omit<WorkflowEventBase, "timestamp">): void;

  /**
   * Log an error.
   */
  logError(error: Error, context?: Record<string, unknown>): void;

  /**
   * Update run summary.
   */
  updateSummary(updates: Partial<WorkflowRunSummary>): void;

  /**
   * Finalize the run (write final summary).
   */
  finalize(): Promise<void>;

  /**
   * Get current run summary.
   */
  getSummary(): WorkflowRunSummary;

  /**
   * Read events from log.
   */
  readEvents(options?: { tail?: number }): Promise<WorkflowEventBase[]>;
}
