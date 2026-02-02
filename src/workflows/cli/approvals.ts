/**
 * Workflow Approvals CLI Command
 *
 * Display approval decisions from workflow runs.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalRecord } from "../policy/types.js";
import { theme } from "../../terminal/theme.js";
import { loadRunSummary } from "../observability/logger.js";
import { getWorkflowDir, loadWorkflowState } from "../state/persistence.js";

// ============================================================================
// Constants
// ============================================================================

const APPROVALS_FILE = "approvals.jsonl";

// ============================================================================
// Types
// ============================================================================

export interface WorkflowApprovalsOptions {
  /** Output as JSON */
  json?: boolean;

  /** Filter by decision */
  decision?: "approved" | "denied" | "timeout";

  /** Show verbose output */
  verbose?: boolean;
}

// ============================================================================
// Command
// ============================================================================

/**
 * Display workflow approval decisions.
 */
export async function workflowApprovalsCommand(
  runId: string,
  options: WorkflowApprovalsOptions = {},
): Promise<void> {
  // Validate run exists
  const workflowDir = getWorkflowDir(runId);
  const summary = await loadRunSummary(workflowDir);

  if (!summary) {
    const state = await loadWorkflowState(runId);
    if (!state) {
      console.error(theme.error(`Workflow not found: ${runId}`));
      return;
    }
  }

  // Load approvals
  let approvals = await loadApprovals(workflowDir);

  // Filter by decision if specified
  if (options.decision) {
    approvals = approvals.filter((a) => a.decision === options.decision);
  }

  // Output
  if (options.json) {
    console.log(JSON.stringify(approvals, null, 2));
    return;
  }

  // Human-readable output
  console.log();
  console.log(theme.heading(`Approvals: ${runId}`));
  console.log();

  if (approvals.length === 0) {
    console.log(theme.muted("No approvals found."));
    return;
  }

  // Summary stats
  const stats = {
    total: approvals.length,
    approved: approvals.filter((a) => a.decision === "approved").length,
    denied: approvals.filter((a) => a.decision === "denied").length,
    timeout: approvals.filter((a) => a.decision === "timeout").length,
  };

  console.log(
    `  Total: ${stats.total} | ` +
      `${theme.success(String(stats.approved))} approved | ` +
      `${theme.error(String(stats.denied))} denied | ` +
      `${theme.warn(String(stats.timeout))} timeout`,
  );
  console.log();

  // List approvals
  for (const approval of approvals) {
    printApproval(approval, options.verbose);
  }
}

// ============================================================================
// Loading
// ============================================================================

async function loadApprovals(workflowDir: string): Promise<ApprovalRecord[]> {
  const filePath = join(workflowDir, APPROVALS_FILE);

  try {
    const content = await readFile(filePath, "utf-8");
    // Parse JSONL format
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as ApprovalRecord);
  } catch {
    return [];
  }
}

// ============================================================================
// Formatting
// ============================================================================

function printApproval(approval: ApprovalRecord, verbose?: boolean): void {
  const time = formatTime(approval.decidedAt);
  const decision = formatDecision(approval.decision);
  const action = theme.accent(approval.request.action.actionType);

  // Target info
  let target = "";
  if (approval.request.action.targetPath) {
    target = theme.muted(approval.request.action.targetPath);
  } else if (approval.request.action.command) {
    const cmd = approval.request.action.command;
    target = theme.muted(cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd);
  } else if (approval.request.action.url) {
    target = theme.muted(approval.request.action.url);
  }

  console.log(`${theme.muted(time)} ${decision} ${action}`);

  if (target) {
    console.log(`  ${target}`);
  }

  if (verbose) {
    console.log(`  Reason: ${theme.muted(approval.request.reason)}`);
    if (approval.remember) {
      console.log(`  Remember: ${theme.accent(approval.rememberScope ?? "run")}`);
    }
    if (approval.comment) {
      console.log(`  Comment: ${theme.muted(approval.comment)}`);
    }
  }

  console.log();
}

function formatDecision(decision: string): string {
  switch (decision) {
    case "approved":
      return theme.success("✓ APPROVED".padEnd(12));
    case "denied":
      return theme.error("✗ DENIED".padEnd(12));
    case "timeout":
      return theme.warn("⏱ TIMEOUT".padEnd(12));
    default:
      return theme.muted(decision.padEnd(12));
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", { hour12: false });
}
