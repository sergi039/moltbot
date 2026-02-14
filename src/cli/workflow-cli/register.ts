/**
 * Workflow CLI Commands
 *
 * Commands for managing multi-agent workflows.
 */

import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { formatDocsLink } from "../../terminal/links.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { createCliProgress } from "../progress.js";
import { promptYesNo } from "../prompt.js";

import {
  getOrchestrator,
  registerBuiltinWorkflows,
  listWorkflows,
  getGlobalEvents,
  type WorkflowSummary,
  type WorkflowRun,
  type GlobalCleanupEvent,
  type WorkflowEvent,
} from "../../workflows/index.js";
import { getWorkflowEvents } from "../../workflows/state/persistence.js";

import {
  runCleanup,
  getCleanupCandidates,
  getTotalDiskUsage,
  runPartialCleanup,
  formatCandidatesPreview,
  formatCleanupResult,
  formatDiskUsageReport,
  formatCleanupResultJson,
  formatCandidatesJson,
  type CleanupMode,
} from "../../workflows/retention/index.js";
import { workflowLogsCommand } from "../../workflows/cli/logs.js";

import { DEFAULT_RETENTION_CONFIG, DEFAULT_MAX_RETRIES } from "../../workflows/constants.js";
import { loadConfig } from "../../config/io.js";

// ============================================================================
// Helpers
// ============================================================================

function runWorkflowCommand(action: () => Promise<void>, label?: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  });
}

function formatStatus(status: string, rich: boolean): string {
  switch (status) {
    case "completed":
      return colorize(rich, theme.success, status);
    case "failed":
      return colorize(rich, theme.error, status);
    case "running":
      return colorize(rich, theme.accent, status);
    case "paused":
      return colorize(rich, theme.warn, status);
    case "cancelled":
      return colorize(rich, theme.muted, status);
    default:
      return status;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function formatAge(timestamp: number): string {
  const age = Date.now() - timestamp;
  if (age < 60000) return "just now";
  if (age < 3600000) return `${Math.floor(age / 60000)}m ago`;
  if (age < 86400000) return `${Math.floor(age / 3600000)}h ago`;
  return `${Math.floor(age / 86400000)}d ago`;
}

function formatBytesForCli(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ============================================================================
// Command Registration
// ============================================================================

export function registerWorkflowCli(program: Command) {
  const workflow = program
    .command("workflow")
    .description("Multi-agent workflow automation")
    .addHelpText(
      "after",
      `
Examples:
  moltbot workflow start --type dev-cycle --task "Add user auth" --repo ~/myproject
  moltbot workflow status
  moltbot workflow list
  moltbot workflow cancel wf-abc123
  moltbot workflow cleanup --dry-run
  moltbot workflow cleanup --force

${formatDocsLink("/workflows")}
`,
    )
    .action(() => {
      workflow.help({ error: true });
    });

  registerWorkflowStartCommand(workflow);
  registerWorkflowStatusCommand(workflow);
  registerWorkflowListCommand(workflow);
  registerWorkflowResumeCommand(workflow);
  registerWorkflowCancelCommand(workflow);
  registerWorkflowCleanupCommand(workflow);
  registerWorkflowLogsCommand(workflow);
}

// ============================================================================
// Start Command
// ============================================================================

function registerWorkflowStartCommand(workflow: Command) {
  workflow
    .command("start")
    .description("Start a new workflow")
    .requiredOption("-t, --type <type>", "Workflow type (dev-cycle, review-only)")
    .requiredOption("--task <description>", "Task description")
    .requiredOption("--repo <path>", "Target repository path")
    .option("--workspace-mode <mode>", "Workspace mode: in-place, worktree, copy", "in-place")
    .option("--branch <name>", "Branch name for worktree mode")
    .option("--base-branch <name>", "Base branch for worktree mode", "main")
    .option("--live", "Use real agents instead of stub mode")
    .option("--auto-approve", "Auto-approve all policy prompts (for testing)")
    .option("--no-execute", "Create workflow but don't execute (for debugging)")
    .action(async (opts) => {
      await runWorkflowCommand(async () => {
        const rich = isRich();
        const orchestrator = getOrchestrator();
        registerBuiltinWorkflows(orchestrator);

        // Validate workflow type
        const definition = orchestrator.getDefinition(opts.type);
        if (!definition) {
          const available = orchestrator.listDefinitions().map((d) => d.type);
          throw new Error(
            `Unknown workflow type: ${opts.type}. Available: ${available.join(", ")}`,
          );
        }

        console.log(colorize(rich, theme.heading, `Starting workflow: ${definition.name}`));
        console.log(`${colorize(rich, theme.muted, "Type:")} ${opts.type}`);
        console.log(`${colorize(rich, theme.muted, "Task:")} ${opts.task}`);
        console.log(`${colorize(rich, theme.muted, "Repo:")} ${opts.repo}`);
        console.log(`${colorize(rich, theme.muted, "Mode:")} ${opts.workspaceMode}`);
        if (opts.live) {
          console.log(
            `${colorize(rich, theme.muted, "Agents:")} ${colorize(rich, theme.warn, "LIVE")}`,
          );
        } else {
          console.log(
            `${colorize(rich, theme.muted, "Agents:")} stub (use --live for real agents)`,
          );
        }
        console.log();

        // Start workflow
        const run = await orchestrator.start(
          opts.type,
          {
            task: opts.task,
            repoPath: opts.repo,
            context: opts.live ? { live: true, autoApprove: opts.autoApprove ?? false } : undefined,
          },
          {
            mode: opts.workspaceMode,
            targetRepo: opts.repo,
            branch: opts.branch,
            baseBranch: opts.baseBranch,
          },
        );

        console.log(
          `${colorize(rich, theme.muted, "Workflow ID:")} ${colorize(rich, theme.accent, run.id)}`,
        );

        if (opts.execute === false) {
          console.log(
            colorize(rich, theme.warn, "\nWorkflow created but not executed (--no-execute)."),
          );
          console.log(`Run: moltbot workflow status ${run.id}`);
          return;
        }

        // Execute workflow
        console.log();
        const progress = createCliProgress({
          label: "Executing workflow...",
          indeterminate: true,
        });

        try {
          // Subscribe to events for progress updates
          orchestrator.onWorkflowEvent((event) => {
            if (event.workflowId !== run.id) return;

            const rawPhaseId = (event.data as Record<string, unknown> | undefined)?.phaseId;
            const phaseId = typeof rawPhaseId === "string" ? rawPhaseId : "unknown";
            switch (event.type) {
              case "phase:started":
                progress.setLabel(`Phase: ${phaseId}`);
                break;
              case "phase:completed":
                progress.setLabel(`Completed: ${phaseId}`);
                break;
              case "phase:failed":
                progress.setLabel(`Failed: ${phaseId}`);
                break;
            }
          });

          const result = await orchestrator.execute(run.id);
          progress.done();

          console.log();
          if (result.status === "completed") {
            console.log(colorize(rich, theme.success, "✓ Workflow completed successfully"));
          } else {
            console.log(colorize(rich, theme.error, `✗ Workflow ${result.status}`));
            if (result.error) {
              console.log(`${colorize(rich, theme.muted, "Error:")} ${result.error.message}`);
            }
          }

          // Show summary
          const duration = result.completedAt
            ? formatDuration(result.completedAt - (result.startedAt || result.createdAt))
            : "unknown";
          console.log(`${colorize(rich, theme.muted, "Duration:")} ${duration}`);
          console.log(`${colorize(rich, theme.muted, "Phases:")} ${result.phaseHistory.length}`);
          console.log(`${colorize(rich, theme.muted, "Iterations:")} ${result.iterationCount}`);
        } catch (err) {
          progress.done();
          throw err;
        }
      }, "workflow start");
    });
}

// ============================================================================
// Status Command
// ============================================================================

function registerWorkflowStatusCommand(workflow: Command) {
  workflow
    .command("status [id]")
    .description("Show workflow status")
    .option("--json", "Output as JSON")
    .option("-v, --verbose", "Show detailed failure and retry info")
    .action(async (id, opts) => {
      await runWorkflowCommand(async () => {
        const rich = isRich() && !opts.json;
        const orchestrator = getOrchestrator();
        registerBuiltinWorkflows(orchestrator);

        if (id) {
          // Show specific workflow
          const run = await orchestrator.getStatus(id);
          if (!run) {
            throw new Error(`Workflow not found: ${id}`);
          }

          if (opts.json) {
            console.log(JSON.stringify(run, null, 2));
            return;
          }

          printWorkflowStatus(run, rich, opts.verbose);
        } else {
          // Show running workflows
          const workflows = await listWorkflows();
          const running = workflows.filter((w) => w.status === "running" || w.status === "paused");

          if (running.length === 0) {
            console.log(colorize(rich, theme.muted, "No running workflows."));
            console.log(`Run: moltbot workflow list`);
            return;
          }

          console.log(colorize(rich, theme.heading, `Running workflows (${running.length}):`));
          console.log();

          for (const wf of running) {
            printWorkflowSummary(wf, rich);
          }
        }
      }, "workflow status");
    });
}

function printWorkflowStatus(run: WorkflowRun | null, rich: boolean, verbose = false) {
  if (!run) return;

  console.log(colorize(rich, theme.heading, `Workflow: ${run.id}`));
  console.log();
  console.log(`${colorize(rich, theme.muted, "Type:")} ${run.definitionType}`);
  console.log(`${colorize(rich, theme.muted, "Status:")} ${formatStatus(run.status, rich)}`);
  console.log(`${colorize(rich, theme.muted, "Task:")} ${run.input.task}`);

  if (run.currentPhase) {
    console.log(`${colorize(rich, theme.muted, "Current Phase:")} ${run.currentPhase}`);
  }

  if (run.startedAt) {
    const duration = (run.completedAt || Date.now()) - run.startedAt;
    console.log(`${colorize(rich, theme.muted, "Duration:")} ${formatDuration(duration)}`);
  }

  console.log(`${colorize(rich, theme.muted, "Iterations:")} ${run.iterationCount}`);

  // Show retry info
  if (run.retryCount !== undefined && run.retryCount > 0) {
    const maxRetries = run.maxRetries ?? DEFAULT_MAX_RETRIES;
    console.log(`${colorize(rich, theme.muted, "Retries:")} ${run.retryCount}/${maxRetries}`);
  }
  if (run.resumedAt) {
    console.log(`${colorize(rich, theme.muted, "Last resumed:")} ${formatAge(run.resumedAt)}`);
  }

  if (run.error) {
    console.log();
    console.log(colorize(rich, theme.error, "Error:"));
    console.log(`  Phase: ${run.error.phase}`);
    console.log(`  Message: ${run.error.message}`);
    if (verbose && run.error.recoverable !== undefined) {
      console.log(`  Recoverable: ${run.error.recoverable ? "yes" : "no"}`);
    }
    if (verbose && run.error.stack) {
      console.log();
      console.log(colorize(rich, theme.muted, "Stack trace:"));
      console.log(run.error.stack);
    }
  }

  if (run.phaseHistory.length > 0) {
    console.log();
    console.log(colorize(rich, theme.heading, "Phase History:"));
    for (const phase of run.phaseHistory) {
      const status = formatStatus(phase.status, rich);
      const duration = formatDuration(phase.metrics.durationMs);
      console.log(`  ${phase.iteration}. ${phase.phaseId} - ${status} (${duration})`);
    }
  }

  // Verbose: show resumable hint
  if (verbose && run.status === "failed" && run.error?.recoverable) {
    const retryCount = run.retryCount ?? 0;
    const maxRetries = run.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (retryCount < maxRetries) {
      console.log();
      console.log(colorize(rich, theme.accent, "Hint: This workflow can be resumed."));
      console.log(`  Run: moltbot workflow resume ${run.id}`);
    }
  }
}

function printWorkflowSummary(wf: WorkflowSummary, rich: boolean) {
  const status = formatStatus(wf.status, rich);
  const age = formatAge(wf.createdAt);
  console.log(`  ${colorize(rich, theme.accent, wf.id)} ${status} (${age})`);
  console.log(`    ${colorize(rich, theme.muted, "Type:")} ${wf.definitionType}`);
  if (wf.currentPhase) {
    console.log(`    ${colorize(rich, theme.muted, "Phase:")} ${wf.currentPhase}`);
  }
  console.log();
}

// ============================================================================
// List Command
// ============================================================================

function registerWorkflowListCommand(workflow: Command) {
  workflow
    .command("list")
    .description("List all workflows")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", "Limit results", "20")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      await runWorkflowCommand(async () => {
        const rich = isRich() && !opts.json;
        const limit = parseInt(opts.limit, 10) || 20;

        let workflows = await listWorkflows();

        // Filter by status
        if (opts.status) {
          workflows = workflows.filter((w) => w.status === opts.status);
        }

        // Sort by creation time (newest first) and limit
        workflows = workflows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);

        if (opts.json) {
          console.log(JSON.stringify(workflows, null, 2));
          return;
        }

        if (workflows.length === 0) {
          console.log(colorize(rich, theme.muted, "No workflows found."));
          return;
        }

        console.log(colorize(rich, theme.heading, `Workflows (${workflows.length}):`));
        console.log();

        for (const wf of workflows) {
          printWorkflowSummary(wf, rich);
        }
      }, "workflow list");
    });
}

// ============================================================================
// Resume Command
// ============================================================================

function registerWorkflowResumeCommand(workflow: Command) {
  workflow
    .command("resume <id>")
    .description("Resume a failed or paused workflow")
    .option("-f, --force", "Skip confirmation")
    .action(async (id, opts) => {
      await runWorkflowCommand(async () => {
        const rich = isRich();
        const orchestrator = getOrchestrator();
        registerBuiltinWorkflows(orchestrator);

        const run = await orchestrator.getStatus(id);
        if (!run) {
          throw new Error(`Workflow not found: ${id}`);
        }

        // Validate resumable status
        if (run.status !== "failed" && run.status !== "paused") {
          throw new Error(
            `Cannot resume workflow in status: ${run.status}. ` +
              `Only 'failed' or 'paused' workflows can be resumed.`,
          );
        }

        // Check max retries
        const maxRetries = run.maxRetries ?? DEFAULT_MAX_RETRIES;
        const currentRetries = run.retryCount ?? 0;

        if (run.status === "failed" && currentRetries >= maxRetries) {
          throw new Error(
            `Maximum retries (${maxRetries}) exceeded for this workflow. ` +
              `Last error: ${run.error?.message || "unknown"}`,
          );
        }

        // Show workflow info
        console.log(`Resuming workflow: ${colorize(rich, theme.accent, id)}`);
        console.log(`${colorize(rich, theme.muted, "Status:")} ${formatStatus(run.status, rich)}`);
        console.log(`${colorize(rich, theme.muted, "Phase:")} ${run.currentPhase || "none"}`);
        if (run.error) {
          console.log(`${colorize(rich, theme.muted, "Last error:")} ${run.error.message}`);
        }
        if (currentRetries > 0) {
          console.log(`${colorize(rich, theme.muted, "Retries:")} ${currentRetries}/${maxRetries}`);
        }
        console.log();

        // Confirm unless force
        if (!opts.force) {
          const confirmed = await promptYesNo("Resume this workflow?");
          if (!confirmed) {
            console.log(colorize(rich, theme.muted, "Cancelled."));
            return;
          }
        }

        // Resume workflow
        console.log();
        const progress = createCliProgress({
          label: "Resuming workflow...",
          indeterminate: true,
        });

        try {
          // Subscribe to events for progress updates
          orchestrator.onWorkflowEvent((event) => {
            if (event.workflowId !== run.id) return;

            const rawPhaseId = (event.data as Record<string, unknown> | undefined)?.phaseId;
            const phaseId = typeof rawPhaseId === "string" ? rawPhaseId : "unknown";
            switch (event.type) {
              case "phase:started":
                progress.setLabel(`Phase: ${phaseId}`);
                break;
              case "phase:completed":
                progress.setLabel(`Completed: ${phaseId}`);
                break;
              case "phase:failed":
                progress.setLabel(`Failed: ${phaseId}`);
                break;
            }
          });

          const result = await orchestrator.resume(id);
          progress.done();

          console.log();
          if (result.status === "completed") {
            console.log(colorize(rich, theme.success, "✓ Workflow completed successfully"));
          } else {
            console.log(colorize(rich, theme.error, `✗ Workflow ${result.status}`));
            if (result.error) {
              console.log(`${colorize(rich, theme.muted, "Error:")} ${result.error.message}`);
            }
          }

          // Show summary
          const duration = result.completedAt
            ? formatDuration(result.completedAt - (result.startedAt || result.createdAt))
            : "unknown";
          console.log(`${colorize(rich, theme.muted, "Duration:")} ${duration}`);
          console.log(
            `${colorize(rich, theme.muted, "Retries:")} ${result.retryCount ?? 0}/${maxRetries}`,
          );
        } catch (err) {
          progress.done();
          throw err;
        }
      }, "workflow resume");
    });
}

// ============================================================================
// Cancel Command
// ============================================================================

function registerWorkflowCancelCommand(workflow: Command) {
  workflow
    .command("cancel <id>")
    .description("Cancel a running workflow")
    .option("-f, --force", "Force cancel without confirmation")
    .action(async (id, opts) => {
      await runWorkflowCommand(async () => {
        const rich = isRich();
        const orchestrator = getOrchestrator();
        registerBuiltinWorkflows(orchestrator);

        const run = await orchestrator.getStatus(id);
        if (!run) {
          throw new Error(`Workflow not found: ${id}`);
        }

        if (run.status === "completed" || run.status === "cancelled") {
          console.log(colorize(rich, theme.warn, `Workflow already ${run.status}.`));
          return;
        }

        // Show workflow info and prompt for confirmation
        console.log(`Cancelling workflow: ${colorize(rich, theme.accent, id)}`);
        console.log(`${colorize(rich, theme.muted, "Status:")} ${formatStatus(run.status, rich)}`);
        console.log(`${colorize(rich, theme.muted, "Phase:")} ${run.currentPhase || "none"}`);
        console.log();

        if (!opts.force) {
          const confirmed = await promptYesNo("Are you sure you want to cancel this workflow?");
          if (!confirmed) {
            console.log(colorize(rich, theme.muted, "Cancelled."));
            return;
          }
        }

        await orchestrator.cancel(id);

        console.log(colorize(rich, theme.success, "✓ Workflow cancelled"));
      }, "workflow cancel");
    });
}

// ============================================================================
// Cleanup Command
// ============================================================================

function registerWorkflowCleanupCommand(workflow: Command) {
  workflow
    .command("cleanup")
    .description("Clean up old workflows based on retention policy")
    .option("-n, --dry-run", "Show what would be deleted without deleting")
    .option("-f, --force", "Skip confirmation prompts")
    .option("--json", "Output as JSON")
    .option("--older-than <days>", "Only clean workflows older than N days", parseInt)
    .option("--status <status>", "Only clean workflows with specific status (comma-separated)")
    .option("--max <count>", "Maximum number of workflows to delete", parseInt)
    .option("--disk-report", "Show disk usage report")
    .option("--artifacts-only", "Only delete artifacts, keep workflow state and logs")
    .option("--logs-only", "Only delete logs, keep workflow state and artifacts")
    .option("--full", "Full cleanup (delete entire workflow directories)")
    .action(async (opts) => {
      await runWorkflowCommand(async () => {
        const rich = isRich() && !opts.json;

        // Disk usage report mode
        if (opts.diskReport) {
          const usage = await getTotalDiskUsage();

          if (opts.json) {
            console.log(JSON.stringify(usage, null, 2));
          } else {
            console.log(formatDiskUsageReport(usage.totalBytes, usage.byWorkflow));
          }
          return;
        }

        // Load retention config: config.workflows.retention → DEFAULT_RETENTION_CONFIG
        const config = loadConfig();
        const configRetention = config.workflows?.retention ?? {};
        const retentionConfig = {
          maxCompleted: configRetention.maxCompleted ?? DEFAULT_RETENTION_CONFIG.maxCompleted,
          maxDiskPerWorkflowMb:
            configRetention.maxDiskPerWorkflowMb ?? DEFAULT_RETENTION_CONFIG.maxDiskPerWorkflowMb,
          maxTotalDiskGb: configRetention.maxTotalDiskGb ?? DEFAULT_RETENTION_CONFIG.maxTotalDiskGb,
          logRetentionDays:
            configRetention.logRetentionDays ?? DEFAULT_RETENTION_CONFIG.logRetentionDays,
          failedLogRetentionDays:
            configRetention.failedLogRetentionDays ??
            DEFAULT_RETENTION_CONFIG.failedLogRetentionDays,
          artifactRetentionDays:
            configRetention.artifactRetentionDays ?? DEFAULT_RETENTION_CONFIG.artifactRetentionDays,
        };

        // Parse status filter
        const statusFilter = opts.status
          ? opts.status.split(",").map((s: string) => s.trim())
          : undefined;

        // Determine cleanup mode from CLI flags
        let mode: CleanupMode = "full";
        if (opts.artifactsOnly) {
          mode = "artifacts";
        } else if (opts.logsOnly) {
          mode = "logs";
        }
        // --full is the default, explicit flag for clarity

        // Get cleanup candidates first
        const candidates = await getCleanupCandidates({
          retentionConfig,
          olderThanDays: opts.olderThan,
          status: statusFilter,
          maxToDelete: opts.max,
        });

        if (candidates.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ candidates: [], message: "No workflows to clean up" }));
          } else {
            console.log(colorize(rich, theme.success, "No workflows to clean up."));
          }
          return;
        }

        // Dry-run mode: show candidates and exit
        if (opts.dryRun) {
          const modeLabel = mode === "full" ? "" : ` (${mode} only)`;
          if (opts.json) {
            console.log(formatCandidatesJson(candidates));
          } else {
            console.log(formatCandidatesPreview(candidates, true));
            if (mode !== "full") {
              console.log(colorize(rich, theme.muted, `\nMode: ${mode} (partial cleanup)`));
            }
          }
          return;
        }

        // Show preview and confirm
        if (!opts.force && !opts.json) {
          console.log(formatCandidatesPreview(candidates, false));
          if (mode !== "full") {
            console.log(
              colorize(
                rich,
                theme.muted,
                `\nMode: ${mode} (partial cleanup - workflow state preserved)`,
              ),
            );
          }
          console.log();

          const actionDescription =
            mode === "full"
              ? `Delete ${candidates.length} workflow(s)?`
              : `Delete ${mode} from ${candidates.length} workflow(s)?`;
          const confirmed = await promptYesNo(`${actionDescription} This cannot be undone.`);
          if (!confirmed) {
            console.log(colorize(rich, theme.muted, "Cleanup cancelled."));
            return;
          }
        }

        // Execute cleanup based on mode
        if (mode === "full") {
          // Full cleanup: delete entire workflow directories
          const result = await runCleanup({
            retentionConfig,
            dryRun: false,
            force: true,
            olderThanDays: opts.olderThan,
            status: statusFilter,
            maxToDelete: opts.max,
          });

          if (opts.json) {
            console.log(formatCleanupResultJson(result));
          } else {
            console.log();
            console.log(formatCleanupResult(result, false));
          }
        } else {
          // Partial cleanup: artifacts or logs only
          const workflowIds = candidates.map((c) => c.workflow.id);
          const results = await runPartialCleanup(workflowIds, mode);

          // Format output
          if (opts.json) {
            console.log(JSON.stringify({ mode, results }, null, 2));
          } else {
            console.log();
            const successful = results.filter((r) => r.success);
            const failed = results.filter((r) => !r.success);
            const totalFreed = successful.reduce((sum, r) => sum + r.freedBytes, 0);

            console.log(colorize(rich, theme.heading, `Partial Cleanup Complete (${mode})`));
            console.log();
            console.log(`${colorize(rich, theme.muted, "Workflows processed:")} ${results.length}`);
            console.log(`${colorize(rich, theme.muted, "Successful:")} ${successful.length}`);
            if (failed.length > 0) {
              console.log(`${colorize(rich, theme.error, "Failed:")} ${failed.length}`);
            }
            console.log(
              `${colorize(rich, theme.muted, "Space freed:")} ${formatBytesForCli(totalFreed)}`,
            );

            if (failed.length > 0) {
              console.log();
              console.log(colorize(rich, theme.error, "Errors:"));
              for (const result of failed) {
                console.log(`  ${result.workflowId}: ${result.error}`);
              }
            }
          }
        }
      }, "workflow cleanup");
    });
}

// ============================================================================
// Logs Command
// ============================================================================

function registerWorkflowLogsCommand(workflow: Command) {
  workflow
    .command("logs [id]")
    .description("Show workflow events (observability, orchestrator, or global cleanup)")
    .option("--global", "Show global cleanup events")
    .option("--orchestrator", "Show orchestrator events instead of observability events")
    .option("--json", "Output as JSON")
    .option("-t, --tail <n>", "Number of events to show from the end")
    .option("--limit <n>", "Alias for --tail")
    .option("--type <type>", "Filter by event type")
    .option("-v, --verbose", "Show verbose output")
    .action(async (id, opts) => {
      await runWorkflowCommand(async () => {
        const rich = isRich() && !opts.json;
        // Support both --tail and --limit (--tail takes precedence)
        const limit = opts.tail
          ? parseInt(opts.tail, 10)
          : opts.limit
            ? parseInt(opts.limit, 10)
            : undefined;

        if (opts.global) {
          // Show global cleanup events
          await showGlobalCleanupEvents(rich, opts.json, limit);
        } else if (id) {
          if (opts.orchestrator) {
            // Show orchestrator events (workflow:started, phase:started, etc.)
            await showOrchestratorEvents(id, rich, opts.json, limit);
          } else {
            // Default: Show observability events (agent/policy/phase details from events.jsonl)
            await workflowLogsCommand(id, {
              tail: limit,
              json: opts.json,
              type: opts.type,
              verbose: opts.verbose,
            });
          }
        } else {
          // No ID and no --global: show help
          console.log(colorize(rich, theme.error, "Please specify a workflow ID or use --global"));
          console.log();
          console.log("Usage:");
          console.log(
            "  moltbot workflow logs <id>              Show observability events (default)",
          );
          console.log("  moltbot workflow logs <id> --orchestrator  Show orchestrator events");
          console.log("  moltbot workflow logs --global          Show global cleanup events");
        }
      }, "workflow logs");
    });
}

async function showGlobalCleanupEvents(
  rich: boolean,
  json: boolean,
  limit?: number,
): Promise<void> {
  const events = await getGlobalEvents();
  const sorted = events.sort((a, b) => b.timestamp - a.timestamp);
  const limited = limit ? sorted.slice(0, limit) : sorted;

  if (json) {
    console.log(JSON.stringify(limited, null, 2));
    return;
  }

  if (limited.length === 0) {
    console.log(colorize(rich, theme.muted, "No global cleanup events found."));
    return;
  }

  console.log(colorize(rich, theme.heading, `Global Cleanup Events (${limited.length}):`));
  console.log();

  for (const event of limited) {
    printGlobalEvent(event, rich);
  }
}

async function showOrchestratorEvents(
  runId: string,
  rich: boolean,
  json: boolean,
  limit?: number,
): Promise<void> {
  const events = await getWorkflowEvents(runId);
  const sorted = events.sort((a, b) => b.timestamp - a.timestamp);
  const limited = limit ? sorted.slice(0, limit) : sorted;

  if (json) {
    console.log(JSON.stringify(limited, null, 2));
    return;
  }

  if (limited.length === 0) {
    console.log(colorize(rich, theme.muted, `No orchestrator events found for workflow: ${runId}`));
    return;
  }

  console.log(
    colorize(rich, theme.heading, `Orchestrator Events for ${runId} (${limited.length}):`),
  );
  console.log();

  for (const event of limited) {
    printOrchestratorEvent(event, rich);
  }
}

function printOrchestratorEvent(event: WorkflowEvent, rich: boolean) {
  const time = new Date(event.timestamp).toISOString();
  const typeColor = getOrchestratorEventTypeColor(event.type);

  console.log(`${colorize(rich, theme.muted, time)} ${colorize(rich, typeColor, event.type)}`);

  if (event.data) {
    const dataStr = formatEventData(event.data);
    if (dataStr) {
      console.log(`  ${colorize(rich, theme.muted, dataStr)}`);
    }
  }
  console.log();
}

function printGlobalEvent(event: GlobalCleanupEvent, rich: boolean) {
  const time = new Date(event.timestamp).toISOString();
  const typeColor = getCleanupEventTypeColor(event.type);

  console.log(`${colorize(rich, theme.muted, time)} ${colorize(rich, typeColor, event.type)}`);

  if (event.data) {
    const dataStr = formatEventData(event.data);
    if (dataStr) {
      console.log(`  ${colorize(rich, theme.muted, dataStr)}`);
    }
  }
  console.log();
}

function getOrchestratorEventTypeColor(type: string): (typeof theme)[keyof typeof theme] {
  if (type.includes("completed") || type.includes("created")) return theme.success;
  if (type.includes("failed") || type.includes("error")) return theme.error;
  if (type.includes("started") || type.includes("start")) return theme.accent;
  if (type.includes("paused") || type.includes("cancelled")) return theme.warn;
  return theme.muted;
}

function getCleanupEventTypeColor(
  type: GlobalCleanupEvent["type"],
): (typeof theme)[keyof typeof theme] {
  switch (type) {
    case "cleanup:start":
      return theme.accent;
    case "cleanup:complete":
      return theme.success;
    case "cleanup:error":
      return theme.error;
  }
}

function formatEventData(data: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    // Skip large/verbose fields
    if (key === "stack" || key === "deletedWorkflows") continue;

    if (typeof value === "number") {
      if (key.includes("Bytes") || key === "freedBytes") {
        parts.push(`${key}: ${formatBytesForCli(value)}`);
      } else if (key.includes("Ms") || key === "durationMs") {
        parts.push(`${key}: ${formatDuration(value)}`);
      } else {
        parts.push(`${key}: ${value}`);
      }
    } else if (typeof value === "boolean") {
      parts.push(`${key}: ${value}`);
    } else if (typeof value === "string") {
      parts.push(`${key}: ${value}`);
    }
  }

  return parts.join(", ");
}
