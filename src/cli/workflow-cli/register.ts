/**
 * Workflow CLI Commands
 *
 * Commands for managing multi-agent workflows.
 */

import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import {
  getOrchestrator,
  registerBuiltinWorkflows,
  listWorkflows,
  type WorkflowSummary,
  type WorkflowRun,
} from "../../workflows/index.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { createCliProgress } from "../progress.js";
import { promptYesNo } from "../prompt.js";

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

${formatDocsLink("/workflows")}
`,
    )
    .action(() => {
      workflow.help({ error: true });
    });

  registerWorkflowStartCommand(workflow);
  registerWorkflowStatusCommand(workflow);
  registerWorkflowListCommand(workflow);
  registerWorkflowCancelCommand(workflow);
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
            context: opts.live ? { live: true } : undefined,
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

          printWorkflowStatus(run, rich);
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

function printWorkflowStatus(run: WorkflowRun | null, rich: boolean) {
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

  if (run.error) {
    console.log();
    console.log(colorize(rich, theme.error, "Error:"));
    console.log(`  Phase: ${run.error.phase}`);
    console.log(`  Message: ${run.error.message}`);
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
