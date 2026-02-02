/**
 * Workflow Logger
 *
 * Structured event logging for workflow execution with redaction support.
 */

import { appendFile, readFile, writeFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  IWorkflowLogger,
  WorkflowEventBase,
  WorkflowRunSummary,
  WorkflowEventType,
} from "./types.js";
import { Redactor, createRedactor } from "../redaction/redactor.js";
import {
  DEFAULT_LOG_ROTATION_OPTIONS,
  type LogRotationOptions,
  type LogRotationResult,
} from "../retention/types.js";

// ============================================================================
// Constants
// ============================================================================

const EVENTS_FILE = "events.jsonl";
const SUMMARY_FILE = "run.json";

// ============================================================================
// WorkflowLogger
// ============================================================================

/**
 * Options for creating a WorkflowLogger.
 */
export interface WorkflowLoggerOptions {
  /** Run ID */
  runId: string;

  /** Workflow type */
  workflowType: string;

  /** Task description */
  task: string;

  /** Workspace path */
  workspacePath: string;

  /** Whether live mode is enabled */
  live: boolean;

  /** Artifacts directory */
  artifactsDir: string;

  /** Redactor instance (uses default if not provided) */
  redactor?: Redactor;

  /** Whether to enable redaction (default: true) */
  enableRedaction?: boolean;

  /** Log rotation options (default: enabled with DEFAULT_LOG_ROTATION_OPTIONS, set to null to disable) */
  logRotation?: LogRotationOptions | null;
}

/**
 * Logger that writes structured events to JSONL and maintains run summary.
 */
export class WorkflowLogger implements IWorkflowLogger {
  private runId: string;
  private artifactsDir: string;
  private eventsPath: string;
  private summaryPath: string;
  private redactor: Redactor;
  private enableRedaction: boolean;
  private summary: WorkflowRunSummary;
  private eventBuffer: string[] = [];
  private flushPromise: Promise<void> | null = null;
  private logRotation?: LogRotationOptions;

  constructor(options: WorkflowLoggerOptions) {
    this.runId = options.runId;
    this.artifactsDir = options.artifactsDir;
    this.eventsPath = join(options.artifactsDir, EVENTS_FILE);
    this.summaryPath = join(options.artifactsDir, SUMMARY_FILE);
    this.redactor = options.redactor ?? createRedactor();
    this.enableRedaction = options.enableRedaction ?? true;
    // Log rotation: undefined → enabled with defaults, null → disabled, object → custom
    this.logRotation =
      options.logRotation === null
        ? undefined
        : (options.logRotation ?? DEFAULT_LOG_ROTATION_OPTIONS);

    // Initialize summary
    this.summary = {
      version: "1.0",
      runId: options.runId,
      workflowType: options.workflowType,
      task: options.task,
      workspacePath: options.workspacePath,
      live: options.live,
      status: "running",
      startedAt: new Date().toISOString(),
      phases: {
        total: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
      },
      artifacts: [],
    };
  }

  /**
   * Initialize the logger (create files).
   */
  async init(): Promise<void> {
    // Ensure directory exists
    await mkdir(this.artifactsDir, { recursive: true });

    // Write initial summary
    await this.writeSummary();
  }

  /**
   * Log an event.
   */
  logEvent(event: Omit<WorkflowEventBase, "timestamp">): void {
    const fullEvent: WorkflowEventBase = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    // Redact sensitive data
    const eventToLog = this.enableRedaction ? this.redactor.redact(fullEvent) : fullEvent;

    // Add to buffer
    const line = JSON.stringify(eventToLog) + "\n";
    this.eventBuffer.push(line);

    // Trigger async flush
    this.scheduleFlush();
  }

  /**
   * Log an error.
   */
  logError(error: Error, context?: Record<string, unknown>): void {
    this.logEvent({
      runId: this.runId,
      type: "workflow.fail",
      payload: {
        error: error.message,
        stack: error.stack,
        ...context,
      },
    });
  }

  /**
   * Update run summary.
   */
  updateSummary(updates: Partial<WorkflowRunSummary>): void {
    this.summary = { ...this.summary, ...updates };
    this.scheduleFlush();
  }

  /**
   * Finalize the run (write final summary).
   */
  async finalize(): Promise<void> {
    // Wait for any pending flush
    if (this.flushPromise) {
      await this.flushPromise;
    }

    // Flush remaining events
    await this.flushEvents();

    // Update completion time
    if (!this.summary.completedAt) {
      this.summary.completedAt = new Date().toISOString();
      if (this.summary.startedAt) {
        this.summary.durationMs =
          new Date(this.summary.completedAt).getTime() - new Date(this.summary.startedAt).getTime();
      }
    }

    // Write final summary
    await this.writeSummary();
  }

  /**
   * Get current run summary.
   */
  getSummary(): WorkflowRunSummary {
    return { ...this.summary };
  }

  /**
   * Read events from log.
   */
  async readEvents(options?: { tail?: number }): Promise<WorkflowEventBase[]> {
    try {
      const content = await readFile(this.eventsPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      let events = lines.map((line) => JSON.parse(line) as WorkflowEventBase);

      // Apply tail if specified
      if (options?.tail && options.tail > 0) {
        events = events.slice(-options.tail);
      }

      return events;
    } catch {
      return [];
    }
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  /**
   * Log workflow start.
   */
  logWorkflowStart(): void {
    this.logEvent({
      runId: this.runId,
      type: "workflow.start",
      payload: {
        workflowType: this.summary.workflowType,
        task: this.summary.task,
        workspacePath: this.summary.workspacePath,
        live: this.summary.live,
      },
    });
  }

  /**
   * Log workflow completion.
   */
  logWorkflowComplete(success: boolean, error?: string): void {
    const type: WorkflowEventType = success ? "workflow.complete" : "workflow.fail";

    this.summary.status = success ? "completed" : "failed";
    if (error) {
      this.summary.error = error;
    }

    this.logEvent({
      runId: this.runId,
      type,
      payload: {
        status: this.summary.status,
        phasesCompleted: this.summary.phases.completed,
        phasesFailed: this.summary.phases.failed,
        error,
      },
    });
  }

  /**
   * Log phase start.
   */
  logPhaseStart(phaseId: string, phaseName: string, engineId: string): void {
    this.logEvent({
      runId: this.runId,
      phaseId,
      type: "phase.start",
      payload: {
        phaseName,
        engineId,
      },
    });
  }

  /**
   * Log phase completion.
   */
  logPhaseComplete(
    phaseId: string,
    phaseName: string,
    engineId: string,
    durationMs: number,
    artifacts: string[],
    success: boolean,
    error?: string,
  ): void {
    const type: WorkflowEventType = success ? "phase.complete" : "phase.fail";

    if (success) {
      this.summary.phases.completed++;
    } else {
      this.summary.phases.failed++;
    }

    // Add artifacts to summary
    for (const artifact of artifacts) {
      if (!this.summary.artifacts.includes(artifact)) {
        this.summary.artifacts.push(artifact);
      }
    }

    this.logEvent({
      runId: this.runId,
      phaseId,
      type,
      payload: {
        phaseName,
        engineId,
        durationMs,
        artifacts,
        success,
        error,
      },
    });
  }

  /**
   * Log agent start.
   */
  logAgentStart(phaseId: string, sessionId: string, model?: string, provider?: string): void {
    this.logEvent({
      runId: this.runId,
      phaseId,
      type: "agent.start",
      payload: {
        sessionId,
        model,
        provider,
      },
    });
  }

  /**
   * Log agent completion.
   */
  logAgentComplete(
    phaseId: string,
    sessionId: string,
    durationMs: number,
    tokens?: { input: number; output: number },
    success?: boolean,
    error?: string,
  ): void {
    const type: WorkflowEventType = success !== false ? "agent.complete" : "agent.fail";

    // Update token summary
    if (tokens) {
      if (!this.summary.tokens) {
        this.summary.tokens = { input: 0, output: 0 };
      }
      this.summary.tokens.input += tokens.input;
      this.summary.tokens.output += tokens.output;
    }

    this.logEvent({
      runId: this.runId,
      phaseId,
      type,
      payload: {
        sessionId,
        durationMs,
        tokens,
        success: success !== false,
        error,
      },
    });
  }

  /**
   * Log policy evaluation.
   */
  logPolicyEvaluate(
    phaseId: string,
    actionType: string,
    decision: "allow" | "deny" | "prompt",
    reason: string,
    ruleName?: string,
    details?: Record<string, unknown>,
  ): void {
    const typeMap: Record<string, WorkflowEventType> = {
      allow: "policy.allow",
      deny: "policy.deny",
      prompt: "policy.prompt",
    };

    this.logEvent({
      runId: this.runId,
      phaseId,
      type: typeMap[decision] ?? "policy.evaluate",
      payload: {
        actionType,
        decision,
        reason,
        ruleName,
        ...details,
      },
    });
  }

  /**
   * Log approval decision.
   */
  logApproval(
    phaseId: string,
    requestId: string,
    actionType: string,
    decision: "approved" | "denied" | "timeout",
    remember?: boolean,
  ): void {
    const typeMap: Record<string, WorkflowEventType> = {
      approved: "approval.approved",
      denied: "approval.denied",
      timeout: "approval.timeout",
    };

    // Update approval summary
    if (!this.summary.approvals) {
      this.summary.approvals = { total: 0, approved: 0, denied: 0, timeout: 0 };
    }
    this.summary.approvals.total++;
    this.summary.approvals[decision]++;

    this.logEvent({
      runId: this.runId,
      phaseId,
      type: typeMap[decision] ?? "approval.request",
      payload: {
        requestId,
        actionType,
        decision,
        remember,
      },
    });
  }

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  private scheduleFlush(): void {
    if (this.flushPromise) return;

    this.flushPromise = (async () => {
      // Small delay to batch events
      await new Promise((resolve) => setTimeout(resolve, 50));

      await this.flushEvents();
      await this.writeSummary();

      this.flushPromise = null;
    })();
  }

  private async flushEvents(): Promise<void> {
    if (this.eventBuffer.length === 0) return;

    const events = this.eventBuffer.splice(0, this.eventBuffer.length);
    const content = events.join("");

    try {
      // Check if rotation is needed before appending
      if (this.logRotation) {
        await this.checkAndRotateLog();
      }

      await appendFile(this.eventsPath, content, "utf-8");
    } catch (err) {
      // Re-add events to buffer if write failed
      this.eventBuffer.unshift(...events);
      throw err;
    }
  }

  /**
   * Check if log rotation is needed and perform rotation if so.
   */
  private async checkAndRotateLog(): Promise<LogRotationResult | null> {
    if (!this.logRotation) return null;

    try {
      const stats = await stat(this.eventsPath);
      const currentSize = stats.size;

      if (currentSize < this.logRotation.maxSizeBytes) {
        return {
          rotated: false,
          originalPath: this.eventsPath,
          originalSizeBytes: currentSize,
        };
      }

      // Rotate: shift existing rotated files
      // events.jsonl.2 -> events.jsonl.3
      // events.jsonl.1 -> events.jsonl.2
      // events.jsonl -> events.jsonl.1
      for (let i = this.logRotation.maxRotatedFiles; i >= 1; i--) {
        const oldPath = i === 1 ? this.eventsPath : `${this.eventsPath}.${i - 1}`;
        const newPath = `${this.eventsPath}.${i}`;

        try {
          if (i === this.logRotation.maxRotatedFiles) {
            // Delete oldest rotated file if it exists
            await unlink(newPath).catch(() => {});
          }
          await rename(oldPath, newPath);
        } catch {
          // File doesn't exist, that's ok
        }
      }

      return {
        rotated: true,
        originalPath: this.eventsPath,
        rotatedPath: `${this.eventsPath}.1`,
        originalSizeBytes: currentSize,
      };
    } catch {
      // File doesn't exist yet, no rotation needed
      return {
        rotated: false,
        originalPath: this.eventsPath,
        originalSizeBytes: 0,
      };
    }
  }

  private async writeSummary(): Promise<void> {
    // Redact summary if enabled
    const summaryToWrite = this.enableRedaction ? this.redactor.redact(this.summary) : this.summary;

    await writeFile(this.summaryPath, JSON.stringify(summaryToWrite, null, 2), "utf-8");
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a workflow logger.
 */
export async function createWorkflowLogger(
  options: WorkflowLoggerOptions,
): Promise<WorkflowLogger> {
  const logger = new WorkflowLogger(options);
  await logger.init();
  return logger;
}

/**
 * Load an existing run summary.
 */
export async function loadRunSummary(artifactsDir: string): Promise<WorkflowRunSummary | null> {
  try {
    const content = await readFile(join(artifactsDir, SUMMARY_FILE), "utf-8");
    return JSON.parse(content) as WorkflowRunSummary;
  } catch {
    return null;
  }
}

/**
 * Load events from a run.
 */
export async function loadRunEvents(
  artifactsDir: string,
  options?: { tail?: number },
): Promise<WorkflowEventBase[]> {
  try {
    const content = await readFile(join(artifactsDir, EVENTS_FILE), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    let events = lines.map((line) => JSON.parse(line) as WorkflowEventBase);

    if (options?.tail && options.tail > 0) {
      events = events.slice(-options.tail);
    }

    return events;
  } catch {
    return [];
  }
}
