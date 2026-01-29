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
import type { TaskList, Task } from "../types.js";
import { saveArtifact } from "../artifacts/store.js";
import { PLAN_FILE, TASKS_FILE } from "../constants.js";

// ============================================================================
// Planner Engine
// ============================================================================

export class PlannerEngine implements WorkflowEngine {
  readonly id = "planner" as const;
  readonly name = "Project Planner";

  private options: PlannerOptions;

  constructor(options: PlannerOptions = {}) {
    this.options = options;
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
    // TODO: Integrate with runEmbeddedPiAgent() for real planning
    // For now, generate a structured stub based on the task description

    const taskDescription = context.run.input.task;
    const projectName = (codebaseInfo.packageJson?.name as string) || "project";

    // Generate plan markdown
    const plan = this.generatePlanMarkdown(taskDescription, codebaseInfo);

    // Generate task list
    const tasks = this.generateTaskList(taskDescription, projectName, codebaseInfo);

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
    info: CodebaseInfo,
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
