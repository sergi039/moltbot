/**
 * Retention Module
 *
 * Workflow cleanup and retention management.
 */

// Types
export type {
  CleanupMode,
  CleanupReason,
  CleanupReasonDetail,
  CleanupCandidate,
  CleanupResult,
  CleanupCandidateResult,
  CleanupError,
  CleanupSummary,
  CleanupOptions,
  RetentionConfigForCleanup,
  PartialCleanupResult,
  LogRotationOptions,
  LogRotationResult,
} from "./types.js";

export { DEFAULT_LOG_ROTATION_OPTIONS } from "./types.js";

// Cleanup logic
export {
  runCleanup,
  findCleanupCandidates,
  getCleanupCandidates,
  getTotalDiskUsage,
  // Partial cleanup
  cleanupArtifacts,
  cleanupLogs,
  runPartialCleanup,
  getCleanupMode,
  determineCleanupModeForCandidate,
} from "./cleanup.js";

// Report formatting
export {
  formatBytes,
  formatAge,
  formatStatus,
  formatReason,
  formatCandidatesPreview,
  formatCleanupResult,
  formatDiskUsageReport,
  formatCleanupResultJson,
  formatCandidatesJson,
} from "./report.js";

// Scheduler
export {
  startCleanupScheduler,
  stopCleanupScheduler,
  isSchedulerActive,
  getSchedulerState,
  triggerCleanup,
  emitCleanupError,
  type CleanupSchedulerOptions,
  type CleanupSchedulerState,
} from "./scheduler.js";
