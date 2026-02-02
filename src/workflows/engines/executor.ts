/**
 * Executor Engine
 *
 * Executes tasks from the task list using Claude.
 * Processes tasks in dependency order, tracking progress and results.
 * Produces:
 * - tasks.json: Updated task list with completion status
 * - execution-report.json: Detailed execution report
 */

import type { TaskList, Task } from "../types.js";
import type {
  WorkflowEngine,
  EngineContext,
  EngineResult,
  ExecutorOutput,
  ExecutorOptions,
  ExecutionReport,
} from "./types.js";
import { loadArtifactJson, saveArtifact } from "../artifacts/store.js";
import { TASKS_FILE, EXECUTION_REPORT_FILE, PLAN_FILE } from "../constants.js";
import {
  type EngineAgentRunner,
  StubRunner,
  createRunner,
  generateSessionId,
  mapAgentConfigToRunnerParams,
} from "./runner.js";

// ============================================================================
// Executor Engine
// ============================================================================

export class ExecutorEngine implements WorkflowEngine {
  readonly id = "executor" as const;
  readonly name = "Task Executor";

  private options: ExecutorOptions;
  private runner: EngineAgentRunner;

  constructor(options: ExecutorOptions = {}, runner?: EngineAgentRunner) {
    this.options = {
      continueOnFailure: true,
      ...options,
    };
    this.runner = runner ?? new StubRunner();
  }

  /**
   * Check if live mode is enabled via workflow input context.
   */
  private isLiveMode(context: EngineContext): boolean {
    const inputContext = context.run.input.context as Record<string, unknown> | undefined;
    return inputContext?.live === true;
  }

  async validateInputs(context: EngineContext): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Executor needs tasks.json from planner - find the latest completed planning execution
    const plannerExec = this.findLatestPlannerExecution(context);
    if (!plannerExec) {
      errors.push(
        `Missing required input artifact: ${TASKS_FILE} (no completed planning phase found)`,
      );
      return { valid: false, errors };
    }

    const tasks = await loadArtifactJson<TaskList>(
      context.run.id,
      plannerExec.phaseId,
      plannerExec.iteration,
      TASKS_FILE,
    );

    if (!tasks) {
      errors.push(`Missing required input artifact: ${TASKS_FILE}`);
    } else if (!Array.isArray(tasks.tasks) || tasks.tasks.length === 0) {
      errors.push(`${TASKS_FILE} contains no tasks`);
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(context: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();
    const filesChanged = new Set<string>();
    const errors: ExecutionReport["errors"] = [];

    try {
      // Load task list
      const taskList = await this.loadTaskList(context);
      if (!taskList) {
        throw new Error(`Failed to load ${TASKS_FILE}`);
      }

      context.onProgress?.({
        type: "status",
        message: `Loaded ${taskList.tasks.length} tasks for execution`,
      });

      // Sort tasks by dependency order
      const sortedTasks = this.topologicalSort(taskList.tasks);

      // Execute tasks
      let completed = 0;
      let failed = 0;
      let skipped = 0;

      for (const task of sortedTasks) {
        // Check abort signal
        if (context.abortSignal?.aborted) {
          skipped += sortedTasks.length - completed - failed;
          break;
        }

        // Skip already completed tasks
        if (task.status === "completed") {
          completed++;
          continue;
        }

        // Check dependencies
        const blockedBy = this.getBlockingDependencies(task, taskList.tasks);
        if (blockedBy.length > 0) {
          task.status = "blocked";
          skipped++;
          context.onProgress?.({
            type: "task",
            message: `Skipped task "${task.title}" (blocked by: ${blockedBy.join(", ")})`,
            data: { taskId: task.id, status: "blocked" },
          });
          continue;
        }

        // Execute task
        context.onProgress?.({
          type: "task",
          message: `Executing task: ${task.title}`,
          data: { taskId: task.id, status: "in_progress" },
        });

        task.status = "in_progress";

        try {
          const result = await this.executeTask(task, context);

          if (result.success) {
            task.status = "completed";
            task.result = {
              completedAt: Date.now(),
              filesModified: result.filesChanged,
              testsAdded: [],
              testsPassed: true,
              notes: result.summary,
            };
            result.filesChanged.forEach((f) => filesChanged.add(f));
            completed++;

            context.onProgress?.({
              type: "task",
              message: `Completed task: ${task.title}`,
              data: { taskId: task.id, status: "completed" },
            });
          } else {
            task.status = "failed";
            task.result = {
              completedAt: Date.now(),
              filesModified: [],
              testsAdded: [],
              testsPassed: false,
              notes: result.error || "Task failed",
            };
            failed++;
            errors.push({
              taskId: task.id,
              message: result.error || "Unknown error",
            });

            context.onProgress?.({
              type: "error",
              message: `Failed task: ${task.title} - ${result.error}`,
              data: { taskId: task.id, status: "failed", error: result.error },
            });

            if (!this.options.continueOnFailure) {
              skipped = sortedTasks.length - completed - failed;
              break;
            }
          }
        } catch (err) {
          task.status = "failed";
          const errorMsg = err instanceof Error ? err.message : String(err);
          task.result = {
            completedAt: Date.now(),
            filesModified: [],
            testsAdded: [],
            testsPassed: false,
            notes: errorMsg,
          };
          failed++;
          errors.push({
            taskId: task.id,
            message: errorMsg,
            stack: err instanceof Error ? err.stack : undefined,
          });

          context.onProgress?.({
            type: "error",
            message: `Task error: ${task.title} - ${errorMsg}`,
            data: { taskId: task.id, status: "failed", error: errorMsg },
          });

          if (!this.options.continueOnFailure) {
            skipped = sortedTasks.length - completed - failed;
            break;
          }
        }
      }

      // Update task list stats
      taskList.stats = {
        total: taskList.tasks.length,
        pending: taskList.tasks.filter(
          (t) => t.status === "pending" || t.status === "in_progress" || t.status === "blocked",
        ).length,
        completed,
        failed,
      };

      // Create execution report
      const report: ExecutionReport = {
        version: "1.0",
        executedAt: Date.now(),
        summary: this.generateSummary(completed, failed, skipped),
        tasksCompleted: completed,
        tasksFailed: failed,
        tasksSkipped: skipped,
        filesChanged: Array.from(filesChanged),
        errors,
      };

      // Save artifacts
      await saveArtifact(
        context.run.id,
        context.phase.id,
        context.iteration,
        TASKS_FILE,
        JSON.stringify(taskList, null, 2),
      );

      context.onProgress?.({
        type: "artifact",
        message: `Saved ${TASKS_FILE}`,
        data: { artifact: TASKS_FILE },
      });

      await saveArtifact(
        context.run.id,
        context.phase.id,
        context.iteration,
        EXECUTION_REPORT_FILE,
        JSON.stringify(report, null, 2),
      );

      context.onProgress?.({
        type: "artifact",
        message: `Saved ${EXECUTION_REPORT_FILE}`,
        data: { artifact: EXECUTION_REPORT_FILE },
      });

      const output: ExecutorOutput = { tasks: taskList, report };

      return {
        success: failed === 0,
        artifacts: [TASKS_FILE, EXECUTION_REPORT_FILE],
        output,
        error: failed > 0 ? `${failed} task(s) failed` : undefined,
        metrics: {
          durationMs: Date.now() - startTime,
        },
      };
    } catch (err) {
      return {
        success: false,
        artifacts: [],
        error: err instanceof Error ? err.message : String(err),
        metrics: {
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  // ==========================================================================
  // Task Loading
  // ==========================================================================

  private async loadTaskList(context: EngineContext): Promise<TaskList | null> {
    // Find the latest completed planning execution
    const plannerExec = this.findLatestPlannerExecution(context);

    if (plannerExec) {
      const tasks = await loadArtifactJson<TaskList>(
        context.run.id,
        plannerExec.phaseId,
        plannerExec.iteration,
        TASKS_FILE,
      );
      if (tasks) return tasks;
    }

    // Fallback: check current phase (shouldn't normally happen)
    return loadArtifactJson<TaskList>(
      context.run.id,
      context.phase.id,
      context.iteration,
      TASKS_FILE,
    );
  }

  /**
   * Find the latest completed planning phase execution that produced tasks.json.
   * This correctly handles plan-review loops where planning may have multiple iterations.
   *
   * Prefers planning phases (which produce both plan.md and tasks.json) over execution
   * phases (which only produce tasks.json). This ensures we always get the original
   * task list from planning, not the updated one from execution.
   */
  private findLatestPlannerExecution(
    context: EngineContext,
  ): { phaseId: string; iteration: number } | null {
    const completedWithTasks = context.run.phaseHistory.filter(
      (p) => p.artifacts.includes(TASKS_FILE) && p.status === "completed",
    );

    if (completedWithTasks.length === 0) {
      return null;
    }

    // Prefer planning phases (produce both PLAN_FILE and TASKS_FILE)
    const planningExecutions = completedWithTasks
      .filter((p) => p.artifacts.includes(PLAN_FILE))
      .sort((a, b) => b.iteration - a.iteration);

    if (planningExecutions.length > 0) {
      const latest = planningExecutions[0];
      return { phaseId: latest.phaseId, iteration: latest.iteration };
    }

    // Fallback: any phase that produced tasks.json (e.g., if plan.md wasn't in artifacts)
    const fallback = completedWithTasks.sort((a, b) => b.iteration - a.iteration)[0];
    return { phaseId: fallback.phaseId, iteration: fallback.iteration };
  }

  // ==========================================================================
  // Task Execution
  // ==========================================================================

  private async executeTask(task: Task, context: EngineContext): Promise<TaskExecutionResult> {
    // Use live mode if enabled
    if (this.isLiveMode(context)) {
      return this.executeTaskLive(task, context);
    }

    // Stub mode: simulate task execution with a delay
    await this.simulateWork(500 + Math.random() * 500);

    return {
      success: true,
      summary: `Completed: ${task.title}`,
      filesChanged: [],
    };
  }

  /**
   * Execute a task using real agent in live mode.
   */
  private async executeTaskLive(task: Task, context: EngineContext): Promise<TaskExecutionResult> {
    // Use injected runner if available, otherwise create one for live mode
    const runner =
      this.runner instanceof StubRunner
        ? createRunner({ live: true, artifactsDir: context.artifactsDir })
        : this.runner;

    // Build task-specific prompt
    const prompt = this.buildTaskPrompt(task, context);

    // Get agent config from phase
    const agentParams = mapAgentConfigToRunnerParams(context.phase.agent);

    // Generate session ID (include task id for uniqueness)
    const sessionId = `${generateSessionId(context.run.id, context.phase.id, context.iteration)}-${task.id}`;

    context.onProgress?.({
      type: "status",
      message: `Running live agent for task: ${task.title}`,
    });

    // Run the agent
    const result = await runner.run({
      sessionId,
      prompt,
      workspacePath: context.workspacePath,
      timeoutMs: context.phase.settings.timeoutMs,
      ...agentParams,
      abortSignal: context.abortSignal,
      onProgress: (msg) => {
        context.onProgress?.({
          type: "status",
          message: msg.slice(0, 100),
        });
      },
    });

    if (!result.success) {
      return {
        success: false,
        summary: `Failed: ${task.title}`,
        filesChanged: [],
        error: result.error,
      };
    }

    // Parse the result to extract files changed
    const filesChanged = this.parseFilesChanged(result.output);

    return {
      success: true,
      summary: `Completed: ${task.title}`,
      filesChanged,
    };
  }

  /**
   * Build prompt for task execution.
   */
  private buildTaskPrompt(task: Task, context: EngineContext): string {
    const acceptanceCriteria = task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

    const targetFiles = task.targetFiles?.length
      ? `\n## Target Files\n${task.targetFiles.map((f) => `- ${f}`).join("\n")}`
      : "";

    return `# Execute Task: ${task.title}

## Task ID
${task.id}

## Description
${task.description}

## Type
${task.type}

## Acceptance Criteria
${acceptanceCriteria}
${targetFiles}

## Workspace
${context.workspacePath}

## Instructions

1. Implement the task as described
2. Follow existing code patterns and conventions
3. Add appropriate error handling
4. Write tests if this is a feature or bugfix
5. Ensure TypeScript compiles without errors

When complete, summarize what was done and list any files that were modified.

Format your summary as:
--- SUMMARY ---
<brief description of changes>
--- FILES CHANGED ---
- path/to/file1.ts
- path/to/file2.ts
--- END ---
`;
  }

  /**
   * Parse files changed from agent output.
   */
  private parseFilesChanged(output: string): string[] {
    const filesMatch = output.match(/---\s*FILES CHANGED\s*---\n?([\s\S]*?)---\s*END\s*---/i);

    if (filesMatch) {
      return filesMatch[1]
        .split("\n")
        .map((line) => line.replace(/^-\s*/, "").trim())
        .filter((line) => line.length > 0);
    }

    // Fallback: look for file paths in the output
    const filePatterns = output.match(
      /(?:modified|created|updated|changed):\s*([^\s,]+\.[a-z]+)/gi,
    );
    if (filePatterns) {
      return filePatterns.map((p) => p.split(/:\s*/)[1]);
    }

    return [];
  }

  private simulateWork(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // Dependency Management
  // ==========================================================================

  private topologicalSort(tasks: Task[]): Task[] {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const visited = new Set<string>();
    const result: Task[] = [];

    const visit = (task: Task): void => {
      if (visited.has(task.id)) return;
      visited.add(task.id);

      for (const depId of task.dependsOn) {
        const dep = taskMap.get(depId);
        if (dep) visit(dep);
      }

      result.push(task);
    };

    // Sort by priority first, then visit
    const sortedByPriority = [...tasks].sort((a, b) => a.priority - b.priority);
    for (const task of sortedByPriority) {
      visit(task);
    }

    return result;
  }

  private getBlockingDependencies(task: Task, allTasks: Task[]): string[] {
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const blocking: string[] = [];

    for (const depId of task.dependsOn) {
      const dep = taskMap.get(depId);
      if (dep && dep.status !== "completed") {
        blocking.push(dep.title);
      }
    }

    return blocking;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private generateSummary(completed: number, failed: number, skipped: number): string {
    const parts: string[] = [];

    if (completed > 0) parts.push(`${completed} completed`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (skipped > 0) parts.push(`${skipped} skipped`);

    if (parts.length === 0) return "No tasks executed";

    return `Tasks: ${parts.join(", ")}`;
  }
}

// ============================================================================
// Types
// ============================================================================

interface TaskExecutionResult {
  success: boolean;
  summary: string;
  filesChanged: string[];
  error?: string;
}

// ============================================================================
// Factory
// ============================================================================

export function createExecutorEngine(options?: ExecutorOptions): ExecutorEngine {
  return new ExecutorEngine(options);
}
