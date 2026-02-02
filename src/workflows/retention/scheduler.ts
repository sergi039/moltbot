/**
 * Cleanup Scheduler
 *
 * Automatic cleanup based on retention policies.
 * Runs on startup and at configurable intervals.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CleanupResult, RetentionConfigForCleanup } from "./types.js";
import { DEFAULT_RETENTION_CONFIG, DEFAULT_CLEANUP_INTERVAL_MINUTES } from "../constants.js";
import { getWorkflowStoragePath, logGlobalEvent } from "../state/persistence.js";
import { runCleanup } from "./cleanup.js";

// ============================================================================
// State
// ============================================================================

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// ============================================================================
// Types
// ============================================================================

export interface CleanupSchedulerOptions {
  /** Retention config to use */
  retentionConfig?: Partial<RetentionConfigForCleanup>;
  /** Interval in minutes between cleanup runs */
  intervalMinutes?: number;
  /** Run cleanup immediately on start */
  runImmediately?: boolean;
  /** Callback when cleanup completes */
  onCleanupComplete?: (result: CleanupResult) => void;
  /** Callback when cleanup errors */
  onCleanupError?: (error: Error) => void;
}

export interface CleanupSchedulerState {
  /** Whether scheduler is running */
  isActive: boolean;
  /** Last cleanup time (timestamp) */
  lastCleanupAt: number | null;
  /** Last cleanup result */
  lastResult: CleanupResult | null;
  /** Next scheduled cleanup time */
  nextCleanupAt: number | null;
  /** Interval in minutes */
  intervalMinutes: number;
}

// ============================================================================
// State Tracking
// ============================================================================

let lastCleanupAt: number | null = null;
let lastResult: CleanupResult | null = null;
let currentIntervalMinutes = DEFAULT_CLEANUP_INTERVAL_MINUTES;

// ============================================================================
// Scheduler Functions
// ============================================================================

/**
 * Start the cleanup scheduler.
 * Runs cleanup at the specified interval.
 */
export async function startCleanupScheduler(options: CleanupSchedulerOptions = {}): Promise<void> {
  // Stop existing scheduler if running
  stopCleanupScheduler();

  const intervalMinutes = options.intervalMinutes ?? DEFAULT_CLEANUP_INTERVAL_MINUTES;
  currentIntervalMinutes = intervalMinutes;

  const intervalMs = intervalMinutes * 60 * 1000;

  // Run immediately if requested
  if (options.runImmediately !== false) {
    await runScheduledCleanup(options);
  }

  // Start interval
  schedulerInterval = setInterval(() => {
    runScheduledCleanup(options).catch(async (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[cleanup-scheduler] Error during scheduled cleanup:", err);
      await emitCleanupError(error, { scheduled: true });
      if (options.onCleanupError) {
        options.onCleanupError(error);
      }
    });
  }, intervalMs);

  console.log(`[cleanup-scheduler] Started with ${intervalMinutes} minute interval`);
}

/**
 * Stop the cleanup scheduler.
 * Also resets scheduler state (lastCleanupAt, lastResult).
 */
export function stopCleanupScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[cleanup-scheduler] Stopped");
  }
  // Reset state for clean restart
  lastCleanupAt = null;
  lastResult = null;
}

/**
 * Check if the scheduler is active.
 */
export function isSchedulerActive(): boolean {
  return schedulerInterval !== null;
}

/**
 * Get current scheduler state.
 */
export function getSchedulerState(): CleanupSchedulerState {
  const now = Date.now();
  let nextCleanupAt: number | null = null;

  if (schedulerInterval && lastCleanupAt) {
    nextCleanupAt = lastCleanupAt + currentIntervalMinutes * 60 * 1000;
  }

  return {
    isActive: schedulerInterval !== null,
    lastCleanupAt,
    lastResult,
    nextCleanupAt,
    intervalMinutes: currentIntervalMinutes,
  };
}

/**
 * Run a scheduled cleanup.
 */
async function runScheduledCleanup(options: CleanupSchedulerOptions): Promise<void> {
  if (isRunning) {
    console.log("[cleanup-scheduler] Cleanup already in progress, skipping");
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  // Emit cleanup.start event
  await logCleanupEvent({
    type: "cleanup.start",
    timestamp: new Date().toISOString(),
    payload: {
      scheduled: true,
      intervalMinutes: currentIntervalMinutes,
    },
  });

  try {
    console.log("[cleanup-scheduler] Running scheduled cleanup...");

    const result = await runCleanup({
      retentionConfig: {
        maxCompleted:
          options.retentionConfig?.maxCompleted ?? DEFAULT_RETENTION_CONFIG.maxCompleted,
        maxDiskPerWorkflowMb:
          options.retentionConfig?.maxDiskPerWorkflowMb ??
          DEFAULT_RETENTION_CONFIG.maxDiskPerWorkflowMb,
        maxTotalDiskGb:
          options.retentionConfig?.maxTotalDiskGb ?? DEFAULT_RETENTION_CONFIG.maxTotalDiskGb,
        logRetentionDays:
          options.retentionConfig?.logRetentionDays ?? DEFAULT_RETENTION_CONFIG.logRetentionDays,
        failedLogRetentionDays:
          options.retentionConfig?.failedLogRetentionDays ??
          DEFAULT_RETENTION_CONFIG.failedLogRetentionDays,
        artifactRetentionDays:
          options.retentionConfig?.artifactRetentionDays ??
          DEFAULT_RETENTION_CONFIG.artifactRetentionDays,
      },
      dryRun: false,
      force: true,
    });

    lastCleanupAt = Date.now();
    lastResult = result;

    // Emit cleanup.complete event
    await logCleanupEvent({
      type: "cleanup.complete",
      timestamp: new Date().toISOString(),
      payload: {
        scheduled: true,
        durationMs: Date.now() - startTime,
        deletedCount: result.summary.deletedCount,
        freedBytes: result.summary.freedBytes,
        errorCount: result.summary.errorCount,
        deletedWorkflows: result.deleted.map((d) => d.workflowId),
      },
    });

    if (result.summary.deletedCount > 0) {
      console.log(
        `[cleanup-scheduler] Deleted ${result.summary.deletedCount} workflow(s), freed ${formatBytes(result.summary.freedBytes)}`,
      );
    } else {
      console.log("[cleanup-scheduler] No workflows to clean up");
    }

    if (options.onCleanupComplete) {
      options.onCleanupComplete(result);
    }
  } finally {
    isRunning = false;
  }
}

/**
 * Trigger an immediate cleanup (outside of schedule).
 */
export async function triggerCleanup(
  options: Omit<CleanupSchedulerOptions, "intervalMinutes" | "runImmediately"> = {},
): Promise<CleanupResult> {
  if (isRunning) {
    throw new Error("Cleanup already in progress");
  }

  isRunning = true;
  const startTime = Date.now();

  // Emit cleanup.start event
  await logCleanupEvent({
    type: "cleanup.start",
    timestamp: new Date().toISOString(),
    payload: {
      scheduled: false,
      manual: true,
    },
  });

  try {
    const result = await runCleanup({
      retentionConfig: {
        maxCompleted:
          options.retentionConfig?.maxCompleted ?? DEFAULT_RETENTION_CONFIG.maxCompleted,
        maxDiskPerWorkflowMb:
          options.retentionConfig?.maxDiskPerWorkflowMb ??
          DEFAULT_RETENTION_CONFIG.maxDiskPerWorkflowMb,
        maxTotalDiskGb:
          options.retentionConfig?.maxTotalDiskGb ?? DEFAULT_RETENTION_CONFIG.maxTotalDiskGb,
        logRetentionDays:
          options.retentionConfig?.logRetentionDays ?? DEFAULT_RETENTION_CONFIG.logRetentionDays,
        failedLogRetentionDays:
          options.retentionConfig?.failedLogRetentionDays ??
          DEFAULT_RETENTION_CONFIG.failedLogRetentionDays,
        artifactRetentionDays:
          options.retentionConfig?.artifactRetentionDays ??
          DEFAULT_RETENTION_CONFIG.artifactRetentionDays,
      },
      dryRun: false,
      force: true,
    });

    lastCleanupAt = Date.now();
    lastResult = result;

    // Emit cleanup.complete event
    await logCleanupEvent({
      type: "cleanup.complete",
      timestamp: new Date().toISOString(),
      payload: {
        scheduled: false,
        manual: true,
        durationMs: Date.now() - startTime,
        deletedCount: result.summary.deletedCount,
        freedBytes: result.summary.freedBytes,
        errorCount: result.summary.errorCount,
        deletedWorkflows: result.deleted.map((d) => d.workflowId),
      },
    });

    if (options.onCleanupComplete) {
      options.onCleanupComplete(result);
    }

    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await emitCleanupError(error, { scheduled: false, manual: true });
    if (options.onCleanupError) {
      options.onCleanupError(error);
    }
    throw err;
  } finally {
    isRunning = false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ============================================================================
// Cleanup Event Logging
// ============================================================================

/** Cleanup event log filename */
const CLEANUP_EVENTS_FILE = "cleanup-events.jsonl";

/** Cleanup event types */
type CleanupEventType = "cleanup.start" | "cleanup.complete" | "cleanup.error";

/** Cleanup event structure */
interface CleanupEvent {
  type: CleanupEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

/**
 * Map cleanup event type to global event type.
 */
function mapToGlobalEventType(
  type: CleanupEventType,
): "cleanup:start" | "cleanup:complete" | "cleanup:error" {
  switch (type) {
    case "cleanup.start":
      return "cleanup:start";
    case "cleanup.complete":
      return "cleanup:complete";
    case "cleanup.error":
      return "cleanup:error";
  }
}

/**
 * Log a cleanup event to the global cleanup events file.
 * Events are written to:
 * - ~/.clawdbot/workflows/cleanup-events.jsonl (dedicated cleanup log)
 * - ~/.clawdbot/workflows/orchestrator-events.jsonl (unified event log)
 */
async function logCleanupEvent(event: CleanupEvent): Promise<void> {
  try {
    const storagePath = getWorkflowStoragePath();
    await mkdir(storagePath, { recursive: true });

    // Write to dedicated cleanup events log
    const logPath = join(storagePath, CLEANUP_EVENTS_FILE);
    const line = JSON.stringify(event) + "\n";
    await appendFile(logPath, line, "utf-8");

    // Also write to global orchestrator events log for unified view
    await logGlobalEvent({
      type: mapToGlobalEventType(event.type),
      timestamp: Date.now(),
      data: event.payload,
    });
  } catch (err) {
    // Don't let logging failures break cleanup
    console.error("[cleanup-scheduler] Failed to log cleanup event:", err);
  }
}

/**
 * Emit a cleanup error event.
 */
export async function emitCleanupError(
  error: Error,
  context?: Record<string, unknown>,
): Promise<void> {
  await logCleanupEvent({
    type: "cleanup.error",
    timestamp: new Date().toISOString(),
    payload: {
      error: error.message,
      stack: error.stack,
      ...context,
    },
  });
}
