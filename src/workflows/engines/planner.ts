/**
 * Planner Engine
 *
 * Generates project plans and task breakdowns using Claude.
 * Analyzes the codebase and user requirements to produce:
 * - plan.md: High-level implementation plan
 * - tasks.json: Structured task list for execution
 */

import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

import type {
  WorkflowEngine,
  EngineContext,
  EngineResult,
  PlannerOutput,
  PlannerOptions,
} from "./types.js";
import type { TaskList, Task, PhaseDefinition } from "../types.js";
import { saveArtifact } from "../artifacts/store.js";
import { PLAN_FILE, TASKS_FILE } from "../constants.js";
import { createHandoffPackage } from "../agents/handoff.js";
import {
  type EngineAgentRunner,
  StubRunner,
  createRunner,
  generateSessionId,
  mapAgentConfigToRunnerParams,
} from "./runner.js";

// ============================================================================
// Planner Engine
// ============================================================================

export class PlannerEngine implements WorkflowEngine {
  readonly id = "planner" as const;
  readonly name = "Project Planner";

  private options: PlannerOptions;
  private runner: EngineAgentRunner;

  constructor(options: PlannerOptions = {}, runner?: EngineAgentRunner) {
    this.options = options;
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

    // Planner needs: task description from workflow input
    if (!context.run.input.task) {
      errors.push("Missing task description in workflow input");
    }

    // Workspace must exist
    try {
      const stats = await stat(context.workspacePath);
      if (!stats.isDirectory()) {
        errors.push(`Workspace path is not a directory: ${context.workspacePath}`);
      }
    } catch {
      errors.push(`Workspace path does not exist: ${context.workspacePath}`);
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(context: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();

    try {
      context.onProgress?.({
        type: "status",
        message: "Analyzing codebase structure...",
      });

      // Analyze codebase structure
      const codebaseInfo = await this.analyzeCodebase(context.workspacePath);

      context.onProgress?.({
        type: "status",
        message: "Generating implementation plan...",
      });

      // Generate plan using agent (stub for now)
      const output = await this.generatePlan(context, codebaseInfo);

      // Save artifacts
      await saveArtifact(
        context.run.id,
        context.phase.id,
        context.iteration,
        PLAN_FILE,
        output.plan,
      );

      context.onProgress?.({
        type: "artifact",
        message: `Saved ${PLAN_FILE}`,
        data: { artifact: PLAN_FILE },
      });

      await saveArtifact(
        context.run.id,
        context.phase.id,
        context.iteration,
        TASKS_FILE,
        JSON.stringify(output.tasks, null, 2),
      );

      context.onProgress?.({
        type: "artifact",
        message: `Saved ${TASKS_FILE} (${output.tasks.tasks.length} tasks)`,
        data: { artifact: TASKS_FILE, taskCount: output.tasks.tasks.length },
      });

      return {
        success: true,
        artifacts: [PLAN_FILE, TASKS_FILE],
        output,
        metrics: {
          durationMs: Date.now() - startTime,
          // TODO: Add token metrics when integrated with real agent
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
  // Codebase Analysis
  // ==========================================================================

  private async analyzeCodebase(workspacePath: string): Promise<CodebaseInfo> {
    const info: CodebaseInfo = {
      structure: [],
      packageJson: null,
      hasTypeScript: false,
      hasTests: false,
      frameworks: [],
    };

    try {
      // Check for package.json
      const pkgPath = join(workspacePath, "package.json");
      try {
        const pkgContent = await readFile(pkgPath, "utf-8");
        const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
        info.packageJson = pkg;

        // Detect frameworks from dependencies
        const pkgDeps = (pkg.dependencies || {}) as Record<string, string>;
        const pkgDevDeps = (pkg.devDependencies || {}) as Record<string, string>;
        const deps = { ...pkgDeps, ...pkgDevDeps };

        if (deps.react) info.frameworks.push("react");
        if (deps.vue) info.frameworks.push("vue");
        if (deps.express) info.frameworks.push("express");
        if (deps.fastify) info.frameworks.push("fastify");
        if (deps.next) info.frameworks.push("next");
        if (deps.typescript) info.hasTypeScript = true;
        if (deps.vitest || deps.jest || deps.mocha) info.hasTests = true;
      } catch {
        // No package.json
      }

      // Get directory structure (limited depth)
      info.structure = await this.getDirectoryStructure(workspacePath, 3);
    } catch {
      // Ignore analysis errors
    }

    return info;
  }

  private async getDirectoryStructure(
    dir: string,
    maxDepth: number,
    currentDepth = 0,
  ): Promise<string[]> {
    if (currentDepth >= maxDepth) return [];

    const entries = await readdir(dir, { withFileTypes: true });
    const structure: string[] = [];

    for (const entry of entries) {
      // Skip common non-essential directories
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === "coverage"
      ) {
        continue;
      }

      const relativePath = entry.name;
      structure.push(entry.isDirectory() ? `${relativePath}/` : relativePath);

      if (entry.isDirectory()) {
        const subStructure = await this.getDirectoryStructure(
          join(dir, entry.name),
          maxDepth,
          currentDepth + 1,
        );
        structure.push(...subStructure.map((s) => `${relativePath}/${s}`));
      }
    }

    return structure;
  }

  // ==========================================================================
  // Plan Generation
  // ==========================================================================

  private async generatePlan(
    context: EngineContext,
    codebaseInfo: CodebaseInfo,
  ): Promise<PlannerOutput> {
    const taskDescription = context.run.input.task;
    const projectName = (codebaseInfo.packageJson?.name as string) || "project";

    // Use live mode if enabled
    if (this.isLiveMode(context)) {
      return this.generatePlanLive(context, codebaseInfo);
    }

    // Stub mode: generate a structured stub based on the task description
    const plan = this.generatePlanMarkdown(taskDescription, codebaseInfo);
    const tasks = this.generateTaskList(taskDescription, projectName, codebaseInfo);

    return { plan, tasks };
  }

  /**
   * Generate plan using real agent in live mode.
   */
  private async generatePlanLive(
    context: EngineContext,
    codebaseInfo: CodebaseInfo,
  ): Promise<PlannerOutput> {
    const taskDescription = context.run.input.task;
    const projectName = (codebaseInfo.packageJson?.name as string) || "project";

    // Create handoff package with context, instructions, and expectations
    context.onProgress?.({
      type: "status",
      message: "Creating handoff package...",
    });

    const handoffPackage = await createHandoffPackage(
      context.run,
      context.phase,
      context.iteration,
      null, // planner is first phase, no previous phase
    );

    // Read handoff content for prompt inclusion
    const [handoffContext, handoffInstructions, handoffExpectations] = await Promise.all([
      readFile(handoffPackage.contextPath, "utf-8"),
      readFile(handoffPackage.instructionsPath, "utf-8"),
      readFile(handoffPackage.expectationsPath, "utf-8"),
    ]);

    context.onProgress?.({
      type: "artifact",
      message: "Handoff package created",
      data: {
        contextPath: handoffPackage.contextPath,
        instructionsPath: handoffPackage.instructionsPath,
        expectationsPath: handoffPackage.expectationsPath,
      },
    });

    // Use injected runner if available, otherwise create one for live mode
    const runner =
      this.runner instanceof StubRunner
        ? createRunner({
            live: true,
            phaseDir: context.phaseDir,
            artifactsDir: context.artifactsDir,
            policy: context.policy,
            runId: context.run.id,
            phaseId: context.phase.id,
            policyEngine: context.policyEngine,
            approvalTimeoutMs: context.approvalTimeoutMs,
            onApprovalEvent: context.onApprovalEvent,
          })
        : this.runner;

    // Build prompt for planning with handoff data
    const prompt = this.buildPlanningPrompt(taskDescription, codebaseInfo, {
      context: handoffContext,
      instructions: handoffInstructions,
      expectations: handoffExpectations,
    });

    // Get agent config from phase
    const agentParams = mapAgentConfigToRunnerParams(context.phase.agent);

    // Generate session ID
    const sessionId = generateSessionId(context.run.id, context.phase.id, context.iteration);

    context.onProgress?.({
      type: "status",
      message: "Running live agent for planning...",
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
      throw new Error(`Live planning failed: ${result.error}`);
    }

    // Parse the agent output to extract plan and tasks (with 1 retry on parse failure)
    try {
      const { plan, tasks } = this.parseAgentOutput(result.output, projectName);
      return { plan, tasks };
    } catch (parseError) {
      // Retry once with a clarification prompt
      context.onProgress?.({
        type: "status",
        message: "Parse failed, retrying with clarification prompt...",
      });

      const retryPrompt =
        `The previous output could not be parsed. Please output the tasks.json again in the correct format.\n\n` +
        `Error: ${parseError instanceof Error ? parseError.message : String(parseError)}\n\n` +
        `Required format:\n` +
        `--- BEGIN tasks.json ---\n` +
        `{\n  "version": "1.0",\n  "tasks": [...]\n}\n` +
        `--- END tasks.json ---`;

      const retryResult = await runner.run({
        sessionId: `${sessionId}-retry`,
        prompt: retryPrompt,
        workspacePath: context.workspacePath,
        timeoutMs: context.phase.settings.timeoutMs,
        ...agentParams,
        abortSignal: context.abortSignal,
      });

      if (!retryResult.success) {
        throw new Error(`Live planning retry failed: ${retryResult.error}`);
      }

      // Try parsing the retry output
      const { plan, tasks } = this.parseAgentOutput(retryResult.output, projectName);
      return { plan, tasks };
    }
  }

  /**
   * Build the prompt for planning agent.
   */
  private buildPlanningPrompt(
    task: string,
    info: CodebaseInfo,
    handoff?: { context: string; instructions: string; expectations: string },
  ): string {
    const frameworks = info.frameworks.length > 0 ? info.frameworks.join(", ") : "none detected";
    const lang = info.hasTypeScript ? "TypeScript" : "JavaScript";
    const structure = info.structure.slice(0, 30).join("\n  ");

    // Build handoff sections if provided
    const handoffSections = handoff
      ? `
## Handoff Context
\`\`\`json
${handoff.context}
\`\`\`

## Handoff Instructions
${handoff.instructions}

## Handoff Expectations
\`\`\`json
${handoff.expectations}
\`\`\`

`
      : "";

    return `# Planning Task

## Task Description
${task}

## Project Context
- **Language**: ${lang}
- **Frameworks**: ${frameworks}
- **Has Tests**: ${info.hasTests ? "Yes" : "No"}
- **Project Structure**:
  ${structure}
${handoffSections}
## Output Requirements

You must create two artifacts:

### 1. Implementation Plan (plan.md)
Create a markdown document with:
- Task summary
- Approach and implementation strategy
- Key considerations and risks
- Success criteria

### 2. Task List (tasks.json)
Create a JSON file following this exact schema:
\`\`\`json
{
  "version": "1.0",
  "projectName": "<project-name>",
  "createdAt": <timestamp>,
  "updatedAt": <timestamp>,
  "tasks": [
    {
      "id": "task-1",
      "title": "<clear task title>",
      "description": "<detailed description>",
      "type": "feature|bugfix|refactor|test|docs",
      "priority": 1,
      "complexity": 1-5,
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": ["<criterion 1>", "<criterion 2>"]
    }
  ],
  "stats": {
    "total": <count>,
    "pending": <count>,
    "completed": 0,
    "failed": 0
  }
}
\`\`\`

## Instructions

1. Analyze the task requirements thoroughly
2. Break down into atomic, implementable subtasks
3. Identify dependencies between tasks
4. Order by priority (1 = highest)
5. Estimate complexity (1 = trivial, 5 = very complex)

Write the plan.md content first, then the tasks.json content.
Clearly mark each section with:
--- BEGIN plan.md ---
<content>
--- END plan.md ---

--- BEGIN tasks.json ---
<json content>
--- END tasks.json ---
`;
  }

  /**
   * Parse agent output to extract plan and tasks.
   * In live mode, fails with clear error if parsing fails (no silent fallback).
   */
  private parseAgentOutput(
    output: string,
    _projectName: string,
  ): { plan: string; tasks: TaskList } {
    // Try to extract marked sections
    const planMatch = output.match(
      /---\s*BEGIN plan\.md\s*---\n?([\s\S]*?)---\s*END plan\.md\s*---/i,
    );
    const tasksMatch = output.match(
      /---\s*BEGIN tasks\.json\s*---\n?([\s\S]*?)---\s*END tasks\.json\s*---/i,
    );

    // Extract plan (use full output as fallback if no markers)
    const plan = planMatch ? planMatch[1].trim() : output;

    // Extract tasks - fail if not found or invalid
    let tasks: TaskList;

    if (tasksMatch) {
      try {
        tasks = JSON.parse(tasksMatch[1].trim()) as TaskList;
        // Validate basic structure
        if (!tasks.version || !Array.isArray(tasks.tasks)) {
          throw new Error(
            "Invalid TaskList structure: missing 'version' or 'tasks' array. " +
              "Agent output did not match expected schema.",
          );
        }
      } catch (err) {
        const parseError = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to parse tasks.json from agent output: ${parseError}. ` +
            `Output snippet: ${tasksMatch[1].slice(0, 200)}...`,
        );
      }
    } else {
      // Try to find JSON block in output
      const jsonMatch = output.match(/```json\n?([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          tasks = JSON.parse(jsonMatch[1].trim()) as TaskList;
          if (!tasks.version || !Array.isArray(tasks.tasks)) {
            throw new Error("Invalid TaskList structure");
          }
        } catch (err) {
          const parseError = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to parse JSON block as TaskList: ${parseError}. ` +
              `JSON snippet: ${jsonMatch[1].slice(0, 200)}...`,
          );
        }
      } else {
        // No tasks found - fail with clear error
        throw new Error(
          "Failed to extract tasks.json from agent output. " +
            "Expected format: '--- BEGIN tasks.json ---' ... '--- END tasks.json ---' " +
            "or a ```json code block. " +
            `Output length: ${output.length} chars, preview: ${output.slice(0, 300)}...`,
        );
      }
    }

    return { plan, tasks };
  }

  private generatePlanMarkdown(task: string, info: CodebaseInfo): string {
    const frameworks = info.frameworks.length > 0 ? info.frameworks.join(", ") : "none detected";
    const lang = info.hasTypeScript ? "TypeScript" : "JavaScript";

    return `# Implementation Plan

## Task
${task}

## Codebase Analysis
- **Language**: ${lang}
- **Frameworks**: ${frameworks}
- **Has Tests**: ${info.hasTests ? "Yes" : "No"}

## Approach
This plan outlines the implementation steps for the requested task.
Each step is broken down into actionable tasks with clear acceptance criteria.

## Implementation Steps

### Phase 1: Setup & Analysis
1. Review existing codebase structure
2. Identify affected components
3. Plan integration points

### Phase 2: Core Implementation
1. Implement core functionality
2. Add necessary types/interfaces
3. Update existing code as needed

### Phase 3: Testing & Polish
1. Add unit tests
2. Add integration tests
3. Update documentation

## Risk Assessment
- **Low Risk**: Standard implementation patterns
- **Dependencies**: None identified that would block progress

## Success Criteria
- All acceptance criteria met for each task
- Tests pass
- No regressions in existing functionality
`;
  }

  private generateTaskList(
    taskDescription: string,
    projectName: string,
    _info: CodebaseInfo,
  ): TaskList {
    // Parse task description to generate reasonable tasks
    // This is a simplified version - real implementation would use Claude

    const tasks: Task[] = [
      {
        id: "task-1",
        title: "Analyze requirements and existing code",
        description: `Review the task requirements: "${taskDescription}". Identify affected files and components.`,
        type: "feature",
        priority: 1,
        complexity: 2,
        status: "pending",
        dependsOn: [],
        acceptanceCriteria: [
          "Requirements are clearly understood",
          "Affected files are identified",
          "Integration points are documented",
        ],
      },
      {
        id: "task-2",
        title: "Implement core functionality",
        description: "Implement the main feature/change based on the requirements analysis.",
        type: "feature",
        priority: 2,
        complexity: 3,
        status: "pending",
        dependsOn: ["task-1"],
        acceptanceCriteria: [
          "Core functionality is implemented",
          "Code follows existing patterns",
          "No TypeScript errors",
        ],
      },
      {
        id: "task-3",
        title: "Add tests",
        description: "Write unit tests and integration tests for the new functionality.",
        type: "test",
        priority: 3,
        complexity: 2,
        status: "pending",
        dependsOn: ["task-2"],
        acceptanceCriteria: [
          "Unit tests cover main functionality",
          "Tests pass",
          "Coverage meets project standards",
        ],
      },
      {
        id: "task-4",
        title: "Update documentation",
        description: "Update relevant documentation to reflect the changes.",
        type: "docs",
        priority: 4,
        complexity: 1,
        status: "pending",
        dependsOn: ["task-2"],
        acceptanceCriteria: [
          "README updated if needed",
          "Code comments added where necessary",
          "API documentation updated if applicable",
        ],
      },
    ];

    const now = Date.now();
    return {
      version: "1.0",
      projectName,
      createdAt: now,
      updatedAt: now,
      tasks,
      stats: {
        total: tasks.length,
        pending: tasks.length,
        completed: 0,
        failed: 0,
      },
    };
  }
}

// ============================================================================
// Types
// ============================================================================

interface CodebaseInfo {
  structure: string[];
  packageJson: Record<string, unknown> | null;
  hasTypeScript: boolean;
  hasTests: boolean;
  frameworks: string[];
}

// ============================================================================
// Factory
// ============================================================================

export function createPlannerEngine(options?: PlannerOptions): PlannerEngine {
  return new PlannerEngine(options);
}
