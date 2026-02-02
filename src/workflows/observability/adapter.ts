/**
 * Observability Adapter
 *
 * Connects WorkflowOrchestrator events to WorkflowLogger.
 * Provides non-invasive integration for structured logging.
 */

import { join } from "node:path";
import type { WorkflowOrchestrator } from "../orchestrator.js";
import type { LogRotationOptions } from "../retention/types.js";
import type { WorkflowEvent, WorkspaceMode } from "../types.js";
import { WORKSPACE_DIR } from "../constants.js";
import { getWorkflowDir, loadWorkflowState } from "../state/persistence.js";
import { WorkflowLogger, createWorkflowLogger } from "./logger.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating an observability adapter.
 */
export interface ObservabilityAdapterOptions {
  /** Orchestrator to observe */
  orchestrator: WorkflowOrchestrator;

  /** Whether to enable redaction (default: true) */
  enableRedaction?: boolean;

  /** Log rotation options (default: enabled, set to null to disable) */
  logRotation?: LogRotationOptions | null;
}

/**
 * Active logger tracking.
 */
interface ActiveLogger {
  logger: WorkflowLogger;
  startTime: number;
  /** Track phase start times for duration calculation */
  phaseStartTimes: Map<string, number>;
}

// ============================================================================
// Adapter
// ============================================================================

/**
 * Adapter that listens to orchestrator events and writes to WorkflowLogger.
 */
export class ObservabilityAdapter {
  private orchestrator: WorkflowOrchestrator;
  private enableRedaction: boolean;
  private logRotation: LogRotationOptions | null | undefined;
  private activeLoggers: Map<string, ActiveLogger> = new Map();

  constructor(options: ObservabilityAdapterOptions) {
    this.orchestrator = options.orchestrator;
    this.enableRedaction = options.enableRedaction ?? true;
    this.logRotation = options.logRotation;
  }

  /**
   * Start observing the orchestrator.
   */
  attach(): void {
    this.orchestrator.onWorkflowEvent((event) => {
      this.handleEvent(event).catch((err) => {
        console.error("[observability] Error handling event:", err);
      });
    });
  }

  /**
   * Get logger for a workflow run.
   */
  getLogger(runId: string): WorkflowLogger | undefined {
    return this.activeLoggers.get(runId)?.logger;
  }

  /**
   * Finalize all active loggers.
   */
  async finalizeAll(): Promise<void> {
    for (const [runId, active] of this.activeLoggers) {
      await active.logger.finalize();
      this.activeLoggers.delete(runId);
    }
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  private async handleEvent(event: WorkflowEvent): Promise<void> {
    switch (event.type) {
      case "workflow:started":
        await this.handleWorkflowStarted(event);
        break;

      case "workflow:completed":
        await this.handleWorkflowCompleted(event, true);
        break;

      case "workflow:failed":
        await this.handleWorkflowCompleted(event, false);
        break;

      case "workflow:cancelled":
        await this.handleWorkflowCancelled(event);
        break;

      case "phase:started":
        this.handlePhaseStarted(event);
        break;

      case "phase:completed":
        this.handlePhaseCompleted(event, true);
        break;

      case "phase:failed":
        this.handlePhaseCompleted(event, false);
        break;

      case "iteration:started":
        this.handleIterationStarted(event);
        break;

      default:
        // Log other events generically
        this.handleGenericEvent(event);
    }
  }

  private async handleWorkflowStarted(event: WorkflowEvent): Promise<void> {
    const data = event.data as {
      definitionType: string;
      input: { task: string; repoPath?: string; context?: { live?: boolean } };
    };

    const workflowDir = getWorkflowDir(event.workflowId);

    // Compute actual workspace path based on workspace mode
    // For worktree/copy modes, the workspace is under the workflow directory
    // For in-place mode, it's the original repoPath
    const workspacePath = await this.computeWorkspacePath(
      event.workflowId,
      workflowDir,
      data.input.repoPath,
    );

    const logger = await createWorkflowLogger({
      runId: event.workflowId,
      workflowType: data.definitionType,
      task: data.input.task,
      workspacePath,
      live: data.input.context?.live ?? false,
      artifactsDir: workflowDir,
      enableRedaction: this.enableRedaction,
      logRotation: this.logRotation,
    });

    this.activeLoggers.set(event.workflowId, {
      logger,
      startTime: event.timestamp,
      phaseStartTimes: new Map(),
    });

    logger.logWorkflowStart();
  }

  /**
   * Compute the actual workspace path based on workspace mode.
   * For worktree/copy modes, returns the workspace directory under workflow dir.
   * For in-place mode, returns the original repoPath.
   */
  private async computeWorkspacePath(
    workflowId: string,
    workflowDir: string,
    repoPath?: string,
  ): Promise<string> {
    // Try to load the workflow state to get the workspace mode
    const run = await loadWorkflowState(workflowId);

    if (run?.workspace) {
      const mode: WorkspaceMode = run.workspace.mode;
      // For worktree and copy modes, workspace is under workflow directory
      if (mode === "worktree" || mode === "copy") {
        return join(workflowDir, WORKSPACE_DIR);
      }
    }

    // For in-place mode or fallback, use the original repoPath
    return repoPath ?? workflowDir;
  }

  private async handleWorkflowCompleted(event: WorkflowEvent, success: boolean): Promise<void> {
    const active = this.activeLoggers.get(event.workflowId);
    if (!active) return;

    const error = success
      ? undefined
      : (event.data as { error?: { message: string } })?.error?.message;

    active.logger.logWorkflowComplete(success, error);
    await active.logger.finalize();

    this.activeLoggers.delete(event.workflowId);
  }

  private async handleWorkflowCancelled(event: WorkflowEvent): Promise<void> {
    const active = this.activeLoggers.get(event.workflowId);
    if (!active) return;

    active.logger.updateSummary({ status: "aborted" });
    active.logger.logEvent({
      runId: event.workflowId,
      type: "workflow.abort",
      payload: {},
    });

    await active.logger.finalize();
    this.activeLoggers.delete(event.workflowId);
  }

  private handlePhaseStarted(event: WorkflowEvent): void {
    const active = this.activeLoggers.get(event.workflowId);
    if (!active) return;

    const data = event.data as { phaseId: string; iteration: number };

    // Track phase start time for duration calculation
    const phaseKey = `${data.phaseId}-${data.iteration}`;
    active.phaseStartTimes.set(phaseKey, event.timestamp);

    active.logger.logPhaseStart(
      data.phaseId,
      data.phaseId, // Use phaseId as name for now
      "unknown", // Engine ID not available in event
    );

    // Update phase count in summary
    const summary = active.logger.getSummary();
    active.logger.updateSummary({
      phases: {
        ...summary.phases,
        total: summary.phases.total + 1,
      },
    });
  }

  private handlePhaseCompleted(event: WorkflowEvent, success: boolean): void {
    const active = this.activeLoggers.get(event.workflowId);
    if (!active) return;

    const data = event.data as {
      phaseId: string;
      iteration: number;
      error?: string;
    };

    // Calculate duration from phase start (not workflow start)
    const phaseKey = `${data.phaseId}-${data.iteration}`;
    const phaseStartTime = active.phaseStartTimes.get(phaseKey) ?? event.timestamp;
    const durationMs = event.timestamp - phaseStartTime;

    // Clean up phase start time
    active.phaseStartTimes.delete(phaseKey);

    active.logger.logPhaseComplete(
      data.phaseId,
      data.phaseId,
      "unknown",
      durationMs,
      [],
      success,
      data.error,
    );
  }

  private handleIterationStarted(event: WorkflowEvent): void {
    const active = this.activeLoggers.get(event.workflowId);
    if (!active) return;

    const data = event.data as {
      fromPhase: string;
      toPhase: string;
      iteration: number;
    };

    active.logger.logEvent({
      runId: event.workflowId,
      type: "phase.start",
      payload: {
        fromPhase: data.fromPhase,
        toPhase: data.toPhase,
        iteration: data.iteration,
        isTransition: true,
      },
    });
  }

  private handleGenericEvent(event: WorkflowEvent): void {
    const active = this.activeLoggers.get(event.workflowId);
    if (!active) return;

    // Map orchestrator event type to workflow event type
    const typeMap: Record<string, string> = {
      "workflow:paused": "workflow.abort",
      "workflow:resumed": "workflow.start",
    };

    active.logger.logEvent({
      runId: event.workflowId,
      type: (typeMap[event.type] ?? "workflow.start") as "workflow.start",
      payload: {
        originalType: event.type,
        ...(typeof event.data === "object" ? event.data : {}),
      },
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Options for attachObservability factory function.
 */
export interface AttachObservabilityOptions {
  /** Whether to enable redaction (default: true) */
  enableRedaction?: boolean;
  /** Log rotation options (default: enabled, set to null to disable) */
  logRotation?: LogRotationOptions | null;
}

/**
 * Create and attach an observability adapter to an orchestrator.
 */
export function attachObservability(
  orchestrator: WorkflowOrchestrator,
  options?: AttachObservabilityOptions,
): ObservabilityAdapter {
  const adapter = new ObservabilityAdapter({
    orchestrator,
    enableRedaction: options?.enableRedaction,
    logRotation: options?.logRotation,
  });

  adapter.attach();
  return adapter;
}
