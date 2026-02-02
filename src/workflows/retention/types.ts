/**
 * Retention Types
 *
 * Types for workflow cleanup and retention management.
 */

import type { WorkflowSummary } from "../state/persistence.js";

// ============================================================================
// Cleanup Modes
// ============================================================================

/**
 * Cleanup mode determines what gets deleted.
 */
export type CleanupMode =
  | "full" // Delete entire workflow directory
  | "artifacts" // Delete only artifacts and sessions, keep state/summary
  | "logs"; // Delete only event logs, keep state/summary

// ============================================================================
// Cleanup Reasons
// ============================================================================

/**
 * Reason why a workflow was selected for cleanup.
 */
export type CleanupReason =
  | "age_exceeded" // logRetentionDays or failedLogRetentionDays exceeded
  | "artifact_age_exceeded" // artifactRetentionDays exceeded
  | "count_limit" // maxCompleted exceeded
  | "disk_limit_per_workflow" // maxDiskPerWorkflowMb exceeded
  | "disk_limit_total"; // maxTotalDiskGb exceeded

/**
 * Details about why a workflow was selected for cleanup.
 */
export interface CleanupReasonDetail {
  reason: CleanupReason;
  /** Human-readable description */
  description: string;
  /** Additional context (e.g., age in days, disk usage in MB) */
  context?: {
    ageInDays?: number;
    diskUsageMb?: number;
    limit?: number | string;
  };
}

// ============================================================================
// Cleanup Candidates
// ============================================================================

/**
 * A workflow that's been identified as a cleanup candidate.
 */
export interface CleanupCandidate {
  /** Workflow summary */
  workflow: WorkflowSummary;
  /** Reasons for cleanup (may have multiple) */
  reasons: CleanupReasonDetail[];
  /** Disk usage in bytes */
  diskUsageBytes: number;
}

// ============================================================================
// Cleanup Results
// ============================================================================

/**
 * Result of a cleanup operation.
 */
export interface CleanupResult {
  /** Workflows that were deleted */
  deleted: CleanupCandidateResult[];
  /** Workflows that were skipped (e.g., currently running) */
  skipped: CleanupCandidateResult[];
  /** Errors that occurred during cleanup */
  errors: CleanupError[];
  /** Summary statistics */
  summary: CleanupSummary;
}

/**
 * Result for a single cleanup candidate.
 */
export interface CleanupCandidateResult {
  workflowId: string;
  status: WorkflowSummary["status"];
  createdAt: number;
  reasons: CleanupReasonDetail[];
  diskUsageBytes: number;
  /** Cleanup mode used for this candidate (full, artifacts, or logs) */
  cleanupMode?: CleanupMode;
}

/**
 * Error that occurred during cleanup.
 */
export interface CleanupError {
  workflowId: string;
  error: string;
  diskUsageBytes?: number;
}

/**
 * Summary statistics for a cleanup operation.
 */
export interface CleanupSummary {
  /** Total workflows scanned */
  totalScanned: number;
  /** Workflows identified as candidates */
  candidatesFound: number;
  /** Workflows successfully deleted */
  deletedCount: number;
  /** Workflows skipped */
  skippedCount: number;
  /** Errors encountered */
  errorCount: number;
  /** Total bytes freed */
  freedBytes: number;
  /** Breakdown by reason */
  byReason: Record<CleanupReason, number>;
  /** Time taken in ms */
  durationMs: number;
}

// ============================================================================
// Cleanup Options
// ============================================================================

/**
 * Options for running cleanup.
 */
export interface CleanupOptions {
  /** Only show what would be deleted, don't actually delete */
  dryRun?: boolean;
  /** Skip confirmation prompts */
  force?: boolean;
  /** Custom retention config (uses default if not provided) */
  retentionConfig?: Partial<RetentionConfigForCleanup>;
  /** Only clean workflows older than this many days */
  olderThanDays?: number;
  /** Only clean workflows with specific status */
  status?: WorkflowSummary["status"][];
  /** Maximum number of workflows to delete in one run */
  maxToDelete?: number;
  /** Cleanup mode: full (default), artifacts, or logs */
  mode?: CleanupMode;
}

/**
 * Result of a partial cleanup operation (artifacts or logs only).
 */
export interface PartialCleanupResult {
  /** Workflow ID */
  workflowId: string;
  /** What was cleaned */
  mode: "artifacts" | "logs";
  /** Bytes freed */
  freedBytes: number;
  /** Files/directories deleted */
  deletedPaths: string[];
  /** Whether successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Retention config subset used for cleanup logic.
 */
export interface RetentionConfigForCleanup {
  maxCompleted: number;
  maxDiskPerWorkflowMb: number;
  maxTotalDiskGb: number;
  logRetentionDays: number;
  failedLogRetentionDays: number;
  artifactRetentionDays: number;
}

// ============================================================================
// Log Rotation
// ============================================================================

/**
 * Options for log rotation.
 */
export interface LogRotationOptions {
  /** Maximum log file size in bytes before rotation */
  maxSizeBytes: number;
  /** Maximum number of rotated files to keep */
  maxRotatedFiles: number;
}

/**
 * Result of a log rotation operation.
 */
export interface LogRotationResult {
  /** Whether rotation was performed */
  rotated: boolean;
  /** Original file path */
  originalPath: string;
  /** New rotated file path (if rotated) */
  rotatedPath?: string;
  /** Original file size in bytes */
  originalSizeBytes: number;
}

/**
 * Default log rotation options.
 */
export const DEFAULT_LOG_ROTATION_OPTIONS: LogRotationOptions = {
  maxSizeBytes: 10 * 1024 * 1024, // 10 MB
  maxRotatedFiles: 3,
};
