/**
 * Cleanup Report Formatting
 *
 * Formats cleanup results for CLI output.
 */

import type { CleanupResult, CleanupCandidate, CleanupReason } from "./types.js";
import { theme } from "../../terminal/theme.js";

// ============================================================================
// Constants
// ============================================================================

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * 1024 * 1024;

const REASON_LABELS: Record<CleanupReason, string> = {
  age_exceeded: "Age limit",
  artifact_age_exceeded: "Artifact age",
  count_limit: "Count limit",
  disk_limit_per_workflow: "Workflow disk limit",
  disk_limit_total: "Total disk limit",
};

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Format bytes to human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GB) {
    return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
  }
  if (bytes >= BYTES_PER_MB) {
    return `${(bytes / BYTES_PER_MB).toFixed(2)} MB`;
  }
  if (bytes >= BYTES_PER_KB) {
    return `${(bytes / BYTES_PER_KB).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Format timestamp to relative time.
 */
export function formatAge(timestamp: number): string {
  const age = Date.now() - timestamp;
  const days = Math.floor(age / (24 * 60 * 60 * 1000));

  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

/**
 * Format workflow status with color.
 */
export function formatStatus(status: string): string {
  switch (status) {
    case "completed":
      return theme.success(status);
    case "failed":
      return theme.error(status);
    case "cancelled":
      return theme.warn(status);
    case "running":
    case "paused":
      return theme.accent(status);
    default:
      return theme.muted(status);
  }
}

/**
 * Format cleanup reason.
 */
export function formatReason(reason: CleanupReason): string {
  return REASON_LABELS[reason] ?? reason;
}

// ============================================================================
// Report Formatting
// ============================================================================

/**
 * Format cleanup candidates for preview (dry-run).
 */
export function formatCandidatesPreview(candidates: CleanupCandidate[], dryRun: boolean): string {
  const lines: string[] = [];

  if (candidates.length === 0) {
    lines.push(theme.muted("No workflows found for cleanup."));
    return lines.join("\n");
  }

  const header = dryRun
    ? theme.warn(`Would delete ${candidates.length} workflow(s):`)
    : theme.heading(`Cleanup candidates (${candidates.length}):`);

  lines.push(header);
  lines.push("");

  for (const candidate of candidates) {
    const { workflow, reasons, diskUsageBytes } = candidate;
    const age = formatAge(workflow.createdAt);
    const size = formatBytes(diskUsageBytes);
    const status = formatStatus(workflow.status);

    lines.push(`  ${theme.accent(workflow.id)}`);
    lines.push(`    Status: ${status} | Age: ${theme.muted(age)} | Size: ${theme.muted(size)}`);
    lines.push(
      `    Task: ${theme.muted(workflow.task.slice(0, 60))}${workflow.task.length > 60 ? "..." : ""}`,
    );
    lines.push(`    Reasons: ${reasons.map((r) => formatReason(r.reason)).join(", ")}`);
    lines.push("");
  }

  const totalSize = candidates.reduce((sum, c) => sum + c.diskUsageBytes, 0);
  lines.push(theme.muted(`Total to free: ${formatBytes(totalSize)}`));

  return lines.join("\n");
}

/**
 * Format cleanup result (after execution).
 */
export function formatCleanupResult(result: CleanupResult, dryRun: boolean): string {
  const lines: string[] = [];

  if (dryRun) {
    lines.push(theme.warn("DRY RUN - No workflows were deleted"));
    lines.push("");
  }

  // Summary header
  lines.push(theme.heading("Cleanup Summary"));
  lines.push("");

  // Statistics
  const { summary } = result;
  lines.push(`  Scanned:  ${summary.totalScanned} workflows`);
  lines.push(`  Found:    ${summary.candidatesFound} candidates`);
  lines.push(
    `  ${dryRun ? "Would delete" : "Deleted"}:  ${theme.success(String(summary.deletedCount))}`,
  );

  if (summary.skippedCount > 0) {
    lines.push(`  Skipped:  ${theme.warn(String(summary.skippedCount))}`);
  }

  if (summary.errorCount > 0) {
    lines.push(`  Errors:   ${theme.error(String(summary.errorCount))}`);
  }

  lines.push(`  Freed:    ${theme.accent(formatBytes(summary.freedBytes))}`);
  lines.push(`  Duration: ${summary.durationMs}ms`);
  lines.push("");

  // By reason breakdown
  const activeReasons = Object.entries(summary.byReason).filter(([, count]) => count > 0);
  if (activeReasons.length > 0) {
    lines.push(theme.heading("By Reason:"));
    for (const [reason, count] of activeReasons) {
      lines.push(`  ${formatReason(reason as CleanupReason)}: ${count}`);
    }
    lines.push("");
  }

  // Deleted workflows
  if (result.deleted.length > 0 && result.deleted.length <= 20) {
    lines.push(theme.heading(`${dryRun ? "Would Delete" : "Deleted"}:`));
    for (const item of result.deleted) {
      const age = formatAge(item.createdAt);
      const size = formatBytes(item.diskUsageBytes);
      lines.push(`  ${theme.muted("•")} ${item.workflowId} (${age}, ${size})`);
    }
    lines.push("");
  } else if (result.deleted.length > 20) {
    lines.push(theme.muted(`${result.deleted.length} workflows deleted (list truncated)`));
    lines.push("");
  }

  // Skipped workflows
  if (result.skipped.length > 0) {
    lines.push(theme.heading("Skipped (running/paused):"));
    for (const item of result.skipped) {
      lines.push(`  ${theme.warn("•")} ${item.workflowId} (${formatStatus(item.status)})`);
    }
    lines.push("");
  }

  // Errors
  if (result.errors.length > 0) {
    lines.push(theme.heading("Errors:"));
    for (const err of result.errors) {
      lines.push(`  ${theme.error("•")} ${err.workflowId}: ${err.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format disk usage report.
 */
export function formatDiskUsageReport(
  totalBytes: number,
  byWorkflow: Array<{ id: string; bytes: number }>,
): string {
  const lines: string[] = [];

  lines.push(theme.heading("Disk Usage Report"));
  lines.push("");
  lines.push(`  Total: ${theme.accent(formatBytes(totalBytes))}`);
  lines.push(`  Workflows: ${byWorkflow.length}`);
  lines.push("");

  // Sort by size (largest first)
  const sorted = [...byWorkflow].sort((a, b) => b.bytes - a.bytes);

  // Top 10 largest
  if (sorted.length > 0) {
    lines.push(theme.heading("Largest Workflows:"));
    for (const item of sorted.slice(0, 10)) {
      const percent = totalBytes > 0 ? Math.round((item.bytes / totalBytes) * 100) : 0;
      lines.push(`  ${formatBytes(item.bytes).padStart(10)} (${percent}%) ${theme.muted(item.id)}`);
    }

    if (sorted.length > 10) {
      const remaining = sorted.slice(10).reduce((sum, w) => sum + w.bytes, 0);
      lines.push(`  ${formatBytes(remaining).padStart(10)} (+${sorted.length - 10} more)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format as JSON for --json output.
 */
export function formatCleanupResultJson(result: CleanupResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format candidates as JSON for --json output.
 */
export function formatCandidatesJson(candidates: CleanupCandidate[]): string {
  return JSON.stringify(candidates, null, 2);
}
