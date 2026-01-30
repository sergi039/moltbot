/**
 * Workflow State Persistence
 *
 * Handles saving and loading workflow state to/from disk.
 * State is persisted after every significant event to enable recovery.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile, rename, rm, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import os from "node:os";

import type { WorkflowRun, WorkflowEvent, RetentionConfig } from "../types.js";
import {
  DEFAULT_WORKFLOWS_DIR,
  WORKFLOW_STATE_FILE,
  WORKFLOW_INPUT_FILE,
  PHASES_DIR,
  DEFAULT_RETENTION_CONFIG,
  WORKFLOW_ID_PREFIX,
} from "../constants.js";

// ============================================================================
// Storage Path Resolution
// ============================================================================

let customStoragePath: string | null = null;

export function setWorkflowStoragePath(path: string): void {
  customStoragePath = path;
}

export function getWorkflowStoragePath(): string {
  if (customStoragePath) return customStoragePath;
  return join(os.homedir(), ".clawdbot", DEFAULT_WORKFLOWS_DIR);
}

export function getWorkflowDir(runId: string): string {
  return join(getWorkflowStoragePath(), runId);
}

export function getPhaseDir(runId: string, phaseId: string, iteration: number): string {
  const phaseDirName = `${String(iteration).padStart(2, "0")}-${phaseId}`;
  return join(getWorkflowDir(runId), PHASES_DIR, phaseDirName);
}

// ============================================================================
// State Persistence
// ============================================================================

export async function saveWorkflowState(run: WorkflowRun): Promise<void> {
  const workflowDir = getWorkflowDir(run.id);
  const statePath = join(workflowDir, WORKFLOW_STATE_FILE);

  // Ensure directory exists
  mkdirSync(dirname(statePath), { recursive: true });

  // Write state atomically: write to temp, then rename
  // On Windows, rename() fails if target exists, so we unlink first on error
  const tempPath = `${statePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(run, null, 2), "utf-8");

  try {
    await rename(tempPath, statePath);
  } catch (err) {
    // Windows: EPERM/EEXIST when target exists; unlink and retry
    if (isWindowsRenameError(err)) {
      await unlink(statePath);
      await rename(tempPath, statePath);
    } else {
      throw err;
    }
  }
}

function isWindowsRenameError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EEXIST";
}

export async function loadWorkflowState(runId: string): Promise<WorkflowRun | null> {
  const statePath = join(getWorkflowDir(runId), WORKFLOW_STATE_FILE);

  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const content = await readFile(statePath, "utf-8");
    return JSON.parse(content) as WorkflowRun;
  } catch (err) {
    console.error(`[workflows] Failed to load state for ${runId}:`, err);
    return null;
  }
}

export async function saveWorkflowInput(runId: string, input: WorkflowRun["input"]): Promise<void> {
  const workflowDir = getWorkflowDir(runId);
  const inputPath = join(workflowDir, WORKFLOW_INPUT_FILE);

  mkdirSync(workflowDir, { recursive: true });
  await writeFile(inputPath, JSON.stringify(input, null, 2), "utf-8");
}

// ============================================================================
// Workflow Discovery
// ============================================================================

export interface WorkflowSummary {
  id: string;
  definitionType: string;
  status: WorkflowRun["status"];
  createdAt: number;
  task: string;
  currentPhase: string | null;
  diskUsageBytes?: number;
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const storagePath = getWorkflowStoragePath();

  if (!existsSync(storagePath)) {
    return [];
  }

  const entries = readdirSync(storagePath, { withFileTypes: true });
  const workflows: WorkflowSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(WORKFLOW_ID_PREFIX)) continue;

    const state = await loadWorkflowState(entry.name);
    if (!state) continue;

    workflows.push({
      id: state.id,
      definitionType: state.definitionType,
      status: state.status,
      createdAt: state.createdAt,
      task: state.input.task.slice(0, 100),
      currentPhase: state.currentPhase,
    });
  }

  // Sort by creation time, newest first
  workflows.sort((a, b) => b.createdAt - a.createdAt);

  return workflows;
}

export async function listRunningWorkflows(): Promise<WorkflowSummary[]> {
  const all = await listWorkflows();
  return all.filter((w) => w.status === "running" || w.status === "paused");
}

// ============================================================================
// Event Logging
// ============================================================================

export async function logWorkflowEvent(event: WorkflowEvent): Promise<void> {
  const workflowDir = getWorkflowDir(event.workflowId);
  const logPath = join(workflowDir, "events.jsonl");

  mkdirSync(workflowDir, { recursive: true });

  const line = JSON.stringify(event) + "\n";

  // Append to log file
  const { appendFile } = await import("node:fs/promises");
  await appendFile(logPath, line, "utf-8");
}

export async function getWorkflowEvents(runId: string): Promise<WorkflowEvent[]> {
  const logPath = join(getWorkflowDir(runId), "events.jsonl");

  if (!existsSync(logPath)) {
    return [];
  }

  const content = await readFile(logPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  return lines.map((line) => JSON.parse(line) as WorkflowEvent);
}

// ============================================================================
// Cleanup
// ============================================================================

export async function deleteWorkflow(runId: string): Promise<void> {
  const workflowDir = getWorkflowDir(runId);

  if (!existsSync(workflowDir)) {
    return;
  }

  await rm(workflowDir, { recursive: true, force: true });
}

export async function calculateDiskUsage(runId: string): Promise<number> {
  const workflowDir = getWorkflowDir(runId);

  if (!existsSync(workflowDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        try {
          totalSize += statSync(fullPath).size;
        } catch {
          // Ignore stat errors
        }
      }
    }
  }

  walkDir(workflowDir);
  return totalSize;
}

export interface CleanupResult {
  deletedWorkflows: string[];
  freedBytes: number;
  errors: string[];
}

export async function cleanupOldWorkflows(
  config: RetentionConfig = DEFAULT_RETENTION_CONFIG,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    deletedWorkflows: [],
    freedBytes: 0,
    errors: [],
  };

  const workflows = await listWorkflows();
  const now = Date.now();

  // Separate by status
  const completed = workflows.filter((w) => w.status === "completed");
  const failed = workflows.filter((w) => w.status === "failed");
  const cancelled = workflows.filter((w) => w.status === "cancelled");

  // Delete completed workflows over limit
  if (completed.length > config.maxCompleted) {
    const toDelete = completed.slice(config.maxCompleted);
    for (const wf of toDelete) {
      try {
        const size = await calculateDiskUsage(wf.id);
        await deleteWorkflow(wf.id);
        result.deletedWorkflows.push(wf.id);
        result.freedBytes += size;
      } catch (err) {
        result.errors.push(`Failed to delete ${wf.id}: ${String(err)}`);
      }
    }
  }

  // Delete old failed/cancelled workflows
  const logRetentionMs = config.failedLogRetentionDays * 24 * 60 * 60 * 1000;
  const oldWorkflows = [...failed, ...cancelled].filter((w) => now - w.createdAt > logRetentionMs);

  for (const wf of oldWorkflows) {
    try {
      const size = await calculateDiskUsage(wf.id);
      await deleteWorkflow(wf.id);
      result.deletedWorkflows.push(wf.id);
      result.freedBytes += size;
    } catch (err) {
      result.errors.push(`Failed to delete ${wf.id}: ${String(err)}`);
    }
  }

  return result;
}

// ============================================================================
// State Checksum (for tampering detection)
// ============================================================================

export function computeStateChecksum(run: WorkflowRun): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const content = JSON.stringify(run);
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function verifyStateChecksum(runId: string): Promise<boolean> {
  const state = await loadWorkflowState(runId);
  if (!state) return false;

  const checksumPath = join(getWorkflowDir(runId), "state.checksum");
  if (!existsSync(checksumPath)) return true; // No checksum = not tamper-checked

  try {
    const storedChecksum = await readFile(checksumPath, "utf-8");
    const currentChecksum = computeStateChecksum(state);
    return storedChecksum.trim() === currentChecksum;
  } catch {
    return false;
  }
}

export async function saveStateWithChecksum(run: WorkflowRun): Promise<void> {
  await saveWorkflowState(run);

  const checksum = computeStateChecksum(run);
  const checksumPath = join(getWorkflowDir(run.id), "state.checksum");
  await writeFile(checksumPath, checksum, "utf-8");
}
