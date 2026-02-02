/**
 * Workflow Cleanup
 *
 * Implements retention policies for workflow cleanup.
 * Handles age-based, count-based, and disk-based cleanup.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  CleanupOptions,
  CleanupResult,
  CleanupCandidate,
  CleanupCandidateResult,
  CleanupError,
  CleanupSummary,
  CleanupReason,
  CleanupReasonDetail,
  RetentionConfigForCleanup,
  CleanupMode,
  PartialCleanupResult,
} from "./types.js";
import {
  DEFAULT_RETENTION_CONFIG,
  PHASES_DIR,
  ARTIFACTS_DIR,
  LOGS_DIR,
  OUTPUT_DIR,
} from "../constants.js";
import {
  listWorkflows,
  deleteWorkflow,
  calculateDiskUsage,
  getWorkflowDir,
  type WorkflowSummary,
} from "../state/persistence.js";

// ============================================================================
// Constants
// ============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * 1024 * 1024;

// ============================================================================
// Main Cleanup Function
// ============================================================================

/**
 * Run cleanup based on retention policies.
 */
export async function runCleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
  const startTime = Date.now();

  const config: RetentionConfigForCleanup = {
    maxCompleted: options.retentionConfig?.maxCompleted ?? DEFAULT_RETENTION_CONFIG.maxCompleted,
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
  };

  // Load all workflows
  const allWorkflows = await listWorkflows();

  // Filter by status if specified
  let workflows = options.status
    ? allWorkflows.filter((w) => options.status!.includes(w.status))
    : allWorkflows;

  // Filter by age if specified
  if (options.olderThanDays !== undefined) {
    const cutoffTime = Date.now() - options.olderThanDays * MS_PER_DAY;
    workflows = workflows.filter((w) => w.createdAt < cutoffTime);
  }

  // Calculate disk usage for all workflows
  const workflowsWithDisk = await Promise.all(
    workflows.map(async (w) => ({
      workflow: w,
      diskUsageBytes: await calculateDiskUsage(w.id),
    })),
  );

  // Find cleanup candidates
  const candidates = findCleanupCandidates(workflowsWithDisk, config);

  // Limit number of deletions if specified
  const toDelete = options.maxToDelete ? candidates.slice(0, options.maxToDelete) : candidates;

  // Perform cleanup (or simulate for dry-run)
  const result = await executeCleanup(toDelete, options.dryRun ?? false);

  // Build summary
  const summary = buildSummary(
    allWorkflows.length,
    candidates,
    result.deleted,
    result.skipped,
    result.errors,
    Date.now() - startTime,
  );

  return {
    deleted: result.deleted,
    skipped: result.skipped,
    errors: result.errors,
    summary,
  };
}

// ============================================================================
// Candidate Selection
// ============================================================================

/**
 * Find workflows that should be cleaned up based on retention policies.
 */
export function findCleanupCandidates(
  workflows: Array<{ workflow: WorkflowSummary; diskUsageBytes: number }>,
  config: RetentionConfigForCleanup,
): CleanupCandidate[] {
  const candidates: Map<string, CleanupCandidate> = new Map();
  const now = Date.now();

  // Helper to add or update candidate
  const addCandidate = (
    workflow: WorkflowSummary,
    diskUsageBytes: number,
    reason: CleanupReasonDetail,
  ) => {
    const existing = candidates.get(workflow.id);
    if (existing) {
      existing.reasons.push(reason);
    } else {
      candidates.set(workflow.id, {
        workflow,
        reasons: [reason],
        diskUsageBytes,
      });
    }
  };

  // 1. Age-based cleanup (completed/running workflows)
  const logRetentionMs = config.logRetentionDays * MS_PER_DAY;
  for (const { workflow, diskUsageBytes } of workflows) {
    if (workflow.status === "completed" || workflow.status === "running") {
      const ageMs = now - workflow.createdAt;
      if (ageMs > logRetentionMs) {
        const ageInDays = Math.floor(ageMs / MS_PER_DAY);
        addCandidate(workflow, diskUsageBytes, {
          reason: "age_exceeded",
          description: `Workflow is ${ageInDays} days old (limit: ${config.logRetentionDays} days)`,
          context: { ageInDays, limit: config.logRetentionDays },
        });
      }
    }
  }

  // 2. Age-based cleanup (failed/cancelled workflows)
  const failedRetentionMs = config.failedLogRetentionDays * MS_PER_DAY;
  for (const { workflow, diskUsageBytes } of workflows) {
    if (workflow.status === "failed" || workflow.status === "cancelled") {
      const ageMs = now - workflow.createdAt;
      if (ageMs > failedRetentionMs) {
        const ageInDays = Math.floor(ageMs / MS_PER_DAY);
        addCandidate(workflow, diskUsageBytes, {
          reason: "age_exceeded",
          description: `Failed/cancelled workflow is ${ageInDays} days old (limit: ${config.failedLogRetentionDays} days)`,
          context: { ageInDays, limit: config.failedLogRetentionDays },
        });
      }
    }
  }

  // 3. Artifact age-based cleanup
  const artifactRetentionMs = config.artifactRetentionDays * MS_PER_DAY;
  for (const { workflow, diskUsageBytes } of workflows) {
    const ageMs = now - workflow.createdAt;
    if (ageMs > artifactRetentionMs && diskUsageBytes > 0) {
      const ageInDays = Math.floor(ageMs / MS_PER_DAY);
      // Only add if not already marked for age_exceeded
      if (!candidates.has(workflow.id)) {
        addCandidate(workflow, diskUsageBytes, {
          reason: "artifact_age_exceeded",
          description: `Artifacts are ${ageInDays} days old (limit: ${config.artifactRetentionDays} days)`,
          context: { ageInDays, limit: config.artifactRetentionDays },
        });
      }
    }
  }

  // 4. Count-based cleanup (maxCompleted)
  const completedWorkflows = workflows
    .filter((w) => w.workflow.status === "completed")
    .sort((a, b) => b.workflow.createdAt - a.workflow.createdAt); // Newest first

  if (completedWorkflows.length > config.maxCompleted) {
    const toRemove = completedWorkflows.slice(config.maxCompleted);
    for (const { workflow, diskUsageBytes } of toRemove) {
      addCandidate(workflow, diskUsageBytes, {
        reason: "count_limit",
        description: `Exceeds max completed limit (${completedWorkflows.length} > ${config.maxCompleted})`,
        context: { limit: config.maxCompleted },
      });
    }
  }

  // 5. Per-workflow disk limit
  const maxDiskBytes = config.maxDiskPerWorkflowMb * BYTES_PER_MB;
  for (const { workflow, diskUsageBytes } of workflows) {
    if (diskUsageBytes > maxDiskBytes) {
      const diskUsageMb = Math.round(diskUsageBytes / BYTES_PER_MB);
      addCandidate(workflow, diskUsageBytes, {
        reason: "disk_limit_per_workflow",
        description: `Disk usage ${diskUsageMb}MB exceeds limit (${config.maxDiskPerWorkflowMb}MB)`,
        context: { diskUsageMb, limit: config.maxDiskPerWorkflowMb },
      });
    }
  }

  // 6. Total disk limit
  const maxTotalBytes = config.maxTotalDiskGb * BYTES_PER_GB;
  const totalDiskUsage = workflows.reduce((sum, w) => sum + w.diskUsageBytes, 0);

  if (totalDiskUsage > maxTotalBytes) {
    // Sort by age (oldest first) and add until we're under the limit
    const sortedByAge = [...workflows].sort((a, b) => a.workflow.createdAt - b.workflow.createdAt);

    let currentTotal = totalDiskUsage;
    for (const { workflow, diskUsageBytes } of sortedByAge) {
      if (currentTotal <= maxTotalBytes) break;

      // Skip running workflows
      if (workflow.status === "running" || workflow.status === "paused") continue;

      const totalDiskGb = Math.round((totalDiskUsage / BYTES_PER_GB) * 100) / 100;
      addCandidate(workflow, diskUsageBytes, {
        reason: "disk_limit_total",
        description: `Total disk ${totalDiskGb}GB exceeds limit (${config.maxTotalDiskGb}GB)`,
        context: {
          diskUsageMb: Math.round(diskUsageBytes / BYTES_PER_MB),
          limit: `${config.maxTotalDiskGb}GB`,
        },
      });

      currentTotal -= diskUsageBytes;
    }
  }

  // Filter out running/paused workflows (can't delete these)
  const deletableCandidates = Array.from(candidates.values()).filter(
    (c) => c.workflow.status !== "running" && c.workflow.status !== "paused",
  );

  // Sort by creation time (oldest first)
  return deletableCandidates.sort((a, b) => a.workflow.createdAt - b.workflow.createdAt);
}

// ============================================================================
// Cleanup Execution
// ============================================================================

/**
 * Determine the cleanup mode for a candidate based on its reasons.
 *
 * Rules:
 * - ONLY artifact_age_exceeded → "artifacts" (partial cleanup)
 * - ONLY age_exceeded → "logs" (partial cleanup)
 * - count_limit, disk_limit_*, or multiple reasons → "full" (delete entire workflow)
 */
export function determineCleanupModeForCandidate(candidate: CleanupCandidate): CleanupMode {
  const reasons = candidate.reasons.map((r) => r.reason);

  // If any "hard" reason is present, use full cleanup
  const hardReasons: CleanupReason[] = [
    "count_limit",
    "disk_limit_per_workflow",
    "disk_limit_total",
  ];
  if (reasons.some((r) => hardReasons.includes(r))) {
    return "full";
  }

  // If only artifact_age_exceeded, use artifacts cleanup
  if (reasons.length === 1 && reasons[0] === "artifact_age_exceeded") {
    return "artifacts";
  }

  // If only age_exceeded, use logs cleanup
  if (reasons.length === 1 && reasons[0] === "age_exceeded") {
    return "logs";
  }

  // Multiple soft reasons or combinations → full cleanup
  return "full";
}

/**
 * Execute cleanup (or simulate for dry-run).
 * Uses per-candidate cleanup mode based on reasons.
 */
async function executeCleanup(
  candidates: CleanupCandidate[],
  dryRun: boolean,
): Promise<{
  deleted: CleanupCandidateResult[];
  skipped: CleanupCandidateResult[];
  errors: CleanupError[];
}> {
  const deleted: CleanupCandidateResult[] = [];
  const skipped: CleanupCandidateResult[] = [];
  const errors: CleanupError[] = [];

  for (const candidate of candidates) {
    const result: CleanupCandidateResult = {
      workflowId: candidate.workflow.id,
      status: candidate.workflow.status,
      createdAt: candidate.workflow.createdAt,
      reasons: candidate.reasons,
      diskUsageBytes: candidate.diskUsageBytes,
    };

    // Skip running/paused workflows
    if (candidate.workflow.status === "running" || candidate.workflow.status === "paused") {
      skipped.push(result);
      continue;
    }

    // Determine cleanup mode for this candidate
    const mode = determineCleanupModeForCandidate(candidate);

    if (dryRun) {
      // In dry-run mode, just mark as would-be-deleted
      // Add the determined mode to the result for transparency
      (result as CleanupCandidateResult & { cleanupMode?: CleanupMode }).cleanupMode = mode;
      deleted.push(result);
    } else {
      try {
        // Execute appropriate cleanup based on mode
        switch (mode) {
          case "artifacts": {
            const partialResult = await cleanupArtifacts(candidate.workflow.id);
            if (!partialResult.success) {
              throw new Error(partialResult.error ?? "Artifact cleanup failed");
            }
            // Update actual freed bytes from partial cleanup
            result.diskUsageBytes = partialResult.freedBytes;
            break;
          }
          case "logs": {
            const partialResult = await cleanupLogs(candidate.workflow.id);
            if (!partialResult.success) {
              throw new Error(partialResult.error ?? "Log cleanup failed");
            }
            // Update actual freed bytes from partial cleanup
            result.diskUsageBytes = partialResult.freedBytes;
            break;
          }
          case "full":
          default:
            await deleteWorkflow(candidate.workflow.id);
            break;
        }

        // Add the mode to the result
        (result as CleanupCandidateResult & { cleanupMode?: CleanupMode }).cleanupMode = mode;
        deleted.push(result);
      } catch (err) {
        errors.push({
          workflowId: candidate.workflow.id,
          error: err instanceof Error ? err.message : String(err),
          diskUsageBytes: candidate.diskUsageBytes,
        });
      }
    }
  }

  return { deleted, skipped, errors };
}

// ============================================================================
// Summary Building
// ============================================================================

/**
 * Build cleanup summary statistics.
 */
function buildSummary(
  totalScanned: number,
  candidates: CleanupCandidate[],
  deleted: CleanupCandidateResult[],
  skipped: CleanupCandidateResult[],
  errors: CleanupError[],
  durationMs: number,
): CleanupSummary {
  const byReason: Record<CleanupReason, number> = {
    age_exceeded: 0,
    artifact_age_exceeded: 0,
    count_limit: 0,
    disk_limit_per_workflow: 0,
    disk_limit_total: 0,
  };

  // Count reasons from deleted workflows
  for (const result of deleted) {
    for (const reason of result.reasons) {
      byReason[reason.reason]++;
    }
  }

  const freedBytes = deleted.reduce((sum, r) => sum + r.diskUsageBytes, 0);

  return {
    totalScanned,
    candidatesFound: candidates.length,
    deletedCount: deleted.length,
    skippedCount: skipped.length,
    errorCount: errors.length,
    freedBytes,
    byReason,
    durationMs,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get cleanup candidates without deleting (for preview).
 */
export async function getCleanupCandidates(
  options: Omit<CleanupOptions, "dryRun" | "force"> = {},
): Promise<CleanupCandidate[]> {
  const config: RetentionConfigForCleanup = {
    maxCompleted: options.retentionConfig?.maxCompleted ?? DEFAULT_RETENTION_CONFIG.maxCompleted,
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
  };

  const allWorkflows = await listWorkflows();

  let workflows = options.status
    ? allWorkflows.filter((w) => options.status!.includes(w.status))
    : allWorkflows;

  if (options.olderThanDays !== undefined) {
    const cutoffTime = Date.now() - options.olderThanDays * MS_PER_DAY;
    workflows = workflows.filter((w) => w.createdAt < cutoffTime);
  }

  const workflowsWithDisk = await Promise.all(
    workflows.map(async (w) => ({
      workflow: w,
      diskUsageBytes: await calculateDiskUsage(w.id),
    })),
  );

  const candidates = findCleanupCandidates(workflowsWithDisk, config);

  // Apply maxToDelete limit to match actual cleanup behavior
  return options.maxToDelete ? candidates.slice(0, options.maxToDelete) : candidates;
}

/**
 * Calculate total disk usage for all workflows.
 */
export async function getTotalDiskUsage(): Promise<{
  totalBytes: number;
  byWorkflow: Array<{ id: string; bytes: number }>;
}> {
  const workflows = await listWorkflows();

  const byWorkflow = await Promise.all(
    workflows.map(async (w) => ({
      id: w.id,
      bytes: await calculateDiskUsage(w.id),
    })),
  );

  const totalBytes = byWorkflow.reduce((sum, w) => sum + w.bytes, 0);

  return { totalBytes, byWorkflow };
}

// ============================================================================
// Partial Cleanup Functions
// ============================================================================

/**
 * Directories considered as "artifacts" for partial cleanup.
 */
const ARTIFACT_DIRS = [ARTIFACTS_DIR, PHASES_DIR, OUTPUT_DIR, "sessions"];

/**
 * Files/patterns considered as "logs" for partial cleanup.
 */
const LOG_PATTERNS = ["events.jsonl", "orchestrator-events.jsonl"];

/**
 * Clean only artifacts from a workflow (keep state and summary).
 * Deletes: artifacts/, phases/, output/, sessions/
 * Keeps: workflow.json, run.json, input.json, events.jsonl
 */
export async function cleanupArtifacts(workflowId: string): Promise<PartialCleanupResult> {
  const workflowDir = getWorkflowDir(workflowId);
  const result: PartialCleanupResult = {
    workflowId,
    mode: "artifacts",
    freedBytes: 0,
    deletedPaths: [],
    success: true,
  };

  if (!existsSync(workflowDir)) {
    result.success = false;
    result.error = "Workflow directory not found";
    return result;
  }

  try {
    for (const dirName of ARTIFACT_DIRS) {
      const dirPath = join(workflowDir, dirName);
      if (existsSync(dirPath)) {
        const sizeBytes = calculateDirectorySize(dirPath);
        await rm(dirPath, { recursive: true, force: true });
        result.freedBytes += sizeBytes;
        result.deletedPaths.push(dirName);
      }
    }
  } catch (err) {
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * Clean only logs from a workflow (keep state, summary, and artifacts).
 * Deletes: events.jsonl, events.jsonl.1, events.jsonl.2, orchestrator-events.jsonl
 * Keeps: workflow.json, run.json, input.json, artifacts/, phases/
 */
export async function cleanupLogs(workflowId: string): Promise<PartialCleanupResult> {
  const workflowDir = getWorkflowDir(workflowId);
  const result: PartialCleanupResult = {
    workflowId,
    mode: "logs",
    freedBytes: 0,
    deletedPaths: [],
    success: true,
  };

  if (!existsSync(workflowDir)) {
    result.success = false;
    result.error = "Workflow directory not found";
    return result;
  }

  try {
    const entries = readdirSync(workflowDir);

    for (const entry of entries) {
      // Match log files and their rotations
      const isLogFile = LOG_PATTERNS.some(
        (pattern) => entry === pattern || entry.startsWith(`${pattern}.`),
      );

      if (isLogFile) {
        const filePath = join(workflowDir, entry);
        try {
          const stats = statSync(filePath);
          if (stats.isFile()) {
            await rm(filePath);
            result.freedBytes += stats.size;
            result.deletedPaths.push(entry);
          }
        } catch {
          // Ignore individual file errors
        }
      }
    }
  } catch (err) {
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * Run partial cleanup on multiple workflows.
 */
export async function runPartialCleanup(
  workflowIds: string[],
  mode: "artifacts" | "logs",
): Promise<PartialCleanupResult[]> {
  const results: PartialCleanupResult[] = [];

  for (const workflowId of workflowIds) {
    const result =
      mode === "artifacts" ? await cleanupArtifacts(workflowId) : await cleanupLogs(workflowId);
    results.push(result);
  }

  return results;
}

/**
 * Calculate directory size recursively.
 */
function calculateDirectorySize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;

  let totalSize = 0;

  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      totalSize += calculateDirectorySize(fullPath);
    } else {
      try {
        totalSize += statSync(fullPath).size;
      } catch {
        // Ignore stat errors
      }
    }
  }

  return totalSize;
}

/**
 * Get cleanup mode from options (defaults to "full").
 */
export function getCleanupMode(options: CleanupOptions): CleanupMode {
  return options.mode ?? "full";
}
