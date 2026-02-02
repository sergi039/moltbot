/**
 * Workflow Logs CLI Command
 *
 * Display events from workflow run logs.
 */

import type { WorkflowEventBase, WorkflowRunSummary } from "../observability/types.js";
import { theme } from "../../terminal/theme.js";
import { loadRunEvents, loadRunSummary } from "../observability/logger.js";
import { getWorkflowDir, loadWorkflowState } from "../state/persistence.js";

// ============================================================================
// Types
// ============================================================================

export interface WorkflowLogsOptions {
  /** Number of events to show from the end */
  tail?: number;

  /** Output as JSON */
  json?: boolean;

  /** Filter by event type */
  type?: string;

  /** Show verbose output */
  verbose?: boolean;
}

// ============================================================================
// Command
// ============================================================================

/**
 * Display workflow run logs.
 */
export async function workflowLogsCommand(
  runId: string,
  options: WorkflowLogsOptions = {},
): Promise<void> {
  // Validate run exists
  const workflowDir = getWorkflowDir(runId);
  const summary = await loadRunSummary(workflowDir);

  if (!summary) {
    // Try loading from state as fallback
    const state = await loadWorkflowState(runId);
    if (!state) {
      console.error(theme.error(`Workflow not found: ${runId}`));
      return;
    }
    // State exists but no observability logs
    console.log(theme.warn("No observability logs found for this workflow."));
    console.log(theme.muted("This workflow may have run before logging was enabled."));
    return;
  }

  // Load events
  let events = await loadRunEvents(workflowDir, { tail: options.tail });

  // Filter by type if specified
  if (options.type) {
    events = events.filter((e) => e.type.includes(options.type!));
  }

  // Output
  if (options.json) {
    console.log(JSON.stringify({ summary, events }, null, 2));
    return;
  }

  // Human-readable output
  printHeader(summary);

  if (events.length === 0) {
    console.log(theme.muted("No events found."));
    return;
  }

  console.log();
  console.log(theme.heading("Events"));
  console.log();

  for (const event of events) {
    printEvent(event, options.verbose);
  }

  console.log();
  console.log(theme.muted(`Showing ${events.length} events`));
}

// ============================================================================
// Formatting
// ============================================================================

function printHeader(summary: WorkflowRunSummary): void {
  console.log();
  console.log(theme.heading(`Workflow: ${summary.runId}`));
  console.log();

  const statusColor = getStatusColor(summary.status);
  console.log(`  Type:      ${summary.workflowType}`);
  console.log(`  Status:    ${statusColor(summary.status)}`);
  console.log(`  Live:      ${summary.live ? theme.success("yes") : theme.muted("no")}`);
  console.log(`  Started:   ${formatTime(summary.startedAt)}`);

  if (summary.completedAt) {
    console.log(`  Completed: ${formatTime(summary.completedAt)}`);
  }

  if (summary.durationMs) {
    console.log(`  Duration:  ${formatDuration(summary.durationMs)}`);
  }

  if (summary.error) {
    console.log(`  Error:     ${theme.error(summary.error)}`);
  }

  // Phase stats
  console.log();
  console.log(`  Phases:    ${summary.phases.completed}/${summary.phases.total} completed`);
  if (summary.phases.failed > 0) {
    console.log(`             ${theme.error(String(summary.phases.failed))} failed`);
  }

  // Token stats
  if (summary.tokens) {
    console.log();
    console.log(
      `  Tokens:    ${summary.tokens.input.toLocaleString()} input, ${summary.tokens.output.toLocaleString()} output`,
    );
  }

  // Approval stats
  if (summary.approvals) {
    console.log();
    console.log(`  Approvals: ${summary.approvals.approved}/${summary.approvals.total} approved`);
  }
}

function printEvent(event: WorkflowEventBase, verbose?: boolean): void {
  const time = formatTime(event.timestamp);
  const typeColor = getEventTypeColor(event.type);
  const type = typeColor(event.type.padEnd(20));

  // Phase prefix if available
  const phase = event.phaseId ? theme.muted(`[${event.phaseId}]`) + " " : "";

  console.log(`${theme.muted(time)} ${type} ${phase}${formatPayload(event.payload, verbose)}`);
}

function formatPayload(payload: Record<string, unknown>, verbose?: boolean): string {
  if (!payload || Object.keys(payload).length === 0) {
    return "";
  }

  if (verbose) {
    return theme.muted(JSON.stringify(payload));
  }

  // Show key fields only
  const keyFields = ["error", "decision", "reason", "success", "durationMs", "sessionId", "taskId"];
  const parts: string[] = [];

  for (const key of keyFields) {
    if (key in payload) {
      const value = payload[key];
      if (key === "error") {
        parts.push(theme.error(String(value)));
      } else if (key === "success") {
        parts.push(value ? theme.success("success") : theme.error("failed"));
      } else if (key === "decision") {
        const decisionColor =
          value === "allow" || value === "approved"
            ? theme.success
            : value === "deny" || value === "denied"
              ? theme.error
              : theme.warn;
        parts.push(decisionColor(String(value)));
      } else if (key === "durationMs") {
        parts.push(theme.muted(formatDuration(value as number)));
      } else {
        parts.push(theme.muted(String(value)));
      }
    }
  }

  return parts.join(" ");
}

function getStatusColor(status: string): (s: string) => string {
  switch (status) {
    case "completed":
      return theme.success;
    case "running":
      return theme.accent;
    case "failed":
      return theme.error;
    case "aborted":
      return theme.warn;
    default:
      return theme.muted;
  }
}

function getEventTypeColor(type: string): (s: string) => string {
  if (type.includes("fail") || type.includes("deny") || type.includes("error")) {
    return theme.error;
  }
  if (type.includes("complete") || type.includes("allow") || type.includes("approved")) {
    return theme.success;
  }
  if (type.includes("start")) {
    return theme.accent;
  }
  if (type.includes("prompt") || type.includes("warn")) {
    return theme.warn;
  }
  return theme.muted;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString("en-US", { hour12: false });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
