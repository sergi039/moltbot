import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PlannerEngine, ExecutorEngine, ReviewerEngine, getEngine } from "./index.js";
import type { EngineContext, EngineProgressUpdate } from "./types.js";
import type { WorkflowRun, PhaseDefinition, TaskList } from "../types.js";
import { setWorkflowStoragePath } from "../state/persistence.js";
import { TASKS_FILE } from "../constants.js";

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = join(tmpdir(), "workflow-engines-test");

function createTestWorkspace(): string {
  const workspacePath = join(TEST_DIR, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  // Create a minimal package.json
  writeFileSync(
    join(workspacePath, "package.json"),
    JSON.stringify(
      {
        name: "test-project",
        version: "1.0.0",
        dependencies: {
          typescript: "^5.0.0",
        },
        devDependencies: {
          vitest: "^1.0.0",
        },
      },
      null,
      2,
    ),
  );

  // Create src directory
  mkdirSync(join(workspacePath, "src"), { recursive: true });
  writeFileSync(join(workspacePath, "src", "index.ts"), 'export const hello = "world";');

  return workspacePath;
}

function createTestContext(overrides: Partial<EngineContext> = {}): EngineContext {
  const runId = `wf-test-${Date.now()}`;
  const workspacePath = createTestWorkspace();

  const run: WorkflowRun = {
    id: runId,
    definitionType: "dev-cycle",
    status: "running",
    input: {
      task: "Add a new feature to handle user authentication",
      repoPath: workspacePath,
    },
    workspace: {
      mode: "in-place",
      targetRepo: workspacePath,
    },
    currentPhase: "planning",
    phaseHistory: [],
    iterationCount: 0,
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
  };

  const phase: PhaseDefinition = {
    id: "planning",
    name: "Project Planning",
    engine: "planner",
    agent: { type: "claude", model: "claude-sonnet-4" },
    inputArtifacts: [],
    outputArtifacts: ["plan.md", "tasks.json"],
    settings: { timeoutMs: 300000 },
  };

  return {
    run,
    phase,
    iteration: 1,
    workflowDir: join(TEST_DIR, "workflows", runId),
    artifactsDir: join(TEST_DIR, "workflows", runId, "phases", "01-planning", "artifacts"),
    workspacePath,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Workflow Engines", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    setWorkflowStoragePath(join(TEST_DIR, "workflows"));
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("getEngine", () => {
    it("should return PlannerEngine for planner type", () => {
      const engine = getEngine("planner");
      expect(engine).toBeInstanceOf(PlannerEngine);
      expect(engine.id).toBe("planner");
    });

    it("should return ExecutorEngine for executor type", () => {
      const engine = getEngine("executor");
      expect(engine).toBeInstanceOf(ExecutorEngine);
      expect(engine.id).toBe("executor");
    });

    it("should return ReviewerEngine for reviewer type", () => {
      const engine = getEngine("reviewer");
      expect(engine).toBeInstanceOf(ReviewerEngine);
      expect(engine.id).toBe("reviewer");
    });
  });

  describe("PlannerEngine", () => {
    it("should validate inputs correctly", async () => {
      const engine = new PlannerEngine();
      const context = createTestContext();

      const result = await engine.validateInputs(context);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail validation without task description", async () => {
      const engine = new PlannerEngine();
      const context = createTestContext();
      context.run.input.task = "";

      const result = await engine.validateInputs(context);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing task description in workflow input");
    });

    it("should execute and produce artifacts", async () => {
      const engine = new PlannerEngine();
      const context = createTestContext();

      const progressUpdates: EngineProgressUpdate[] = [];
      context.onProgress = (update) => progressUpdates.push(update);

      const result = await engine.execute(context);

      expect(result.success).toBe(true);
      expect(result.artifacts).toContain("plan.md");
      expect(result.artifacts).toContain("tasks.json");
      expect(result.metrics.durationMs).toBeGreaterThan(0);

      // Check progress updates were emitted
      expect(progressUpdates.some((u) => u.type === "status")).toBe(true);
      expect(progressUpdates.some((u) => u.type === "artifact")).toBe(true);
    });

    it("should generate valid task list structure", async () => {
      const engine = new PlannerEngine();
      const context = createTestContext();

      const result = await engine.execute(context);

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();

      const output = result.output as { tasks: TaskList };
      expect(output.tasks.version).toBe("1.0");
      expect(output.tasks.projectName).toBe("test-project");
      expect(Array.isArray(output.tasks.tasks)).toBe(true);
      expect(output.tasks.tasks.length).toBeGreaterThan(0);

      // Verify task structure
      const task = output.tasks.tasks[0];
      expect(task.id).toBeDefined();
      expect(task.title).toBeDefined();
      expect(task.status).toBe("pending");
      expect(Array.isArray(task.dependsOn)).toBe(true);
    });
  });

  describe("ExecutorEngine", () => {
    it("should validate inputs correctly when tasks exist", async () => {
      const engine = new ExecutorEngine();
      const context = createTestContext();

      // First run planner to create tasks
      const planner = new PlannerEngine();
      await planner.execute(context);

      // Update context for executor
      context.phase = {
        id: "execution",
        name: "Task Execution",
        engine: "executor",
        agent: { type: "claude" },
        inputArtifacts: [TASKS_FILE],
        outputArtifacts: [TASKS_FILE, "execution-report.json"],
        settings: { timeoutMs: 1800000 },
      };
      context.run.phaseHistory = [
        {
          phaseId: "planning",
          iteration: 1,
          status: "completed",
          artifacts: ["plan.md", TASKS_FILE],
          metrics: { durationMs: 1000 },
          logPath: "phases/01-planning/logs",
        },
      ];

      const result = await engine.validateInputs(context);
      expect(result.valid).toBe(true);
    });

    it("should fail validation without tasks.json", async () => {
      const engine = new ExecutorEngine();
      const context = createTestContext();

      context.phase = {
        id: "execution",
        name: "Task Execution",
        engine: "executor",
        agent: { type: "claude" },
        inputArtifacts: [TASKS_FILE],
        outputArtifacts: [TASKS_FILE, "execution-report.json"],
        settings: { timeoutMs: 1800000 },
      };

      const result = await engine.validateInputs(context);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes(TASKS_FILE))).toBe(true);
    });

    it("should execute tasks and produce report", async () => {
      const engine = new ExecutorEngine();
      const context = createTestContext();

      // First run planner to create tasks
      const planner = new PlannerEngine();
      await planner.execute(context);

      // Update context for executor
      context.phase = {
        id: "execution",
        name: "Task Execution",
        engine: "executor",
        agent: { type: "claude" },
        inputArtifacts: [TASKS_FILE],
        outputArtifacts: [TASKS_FILE, "execution-report.json"],
        settings: { timeoutMs: 1800000 },
      };
      context.run.phaseHistory = [
        {
          phaseId: "planning",
          iteration: 1,
          status: "completed",
          artifacts: ["plan.md", TASKS_FILE],
          metrics: { durationMs: 1000 },
          logPath: "phases/01-planning/logs",
        },
      ];

      const progressUpdates: EngineProgressUpdate[] = [];
      context.onProgress = (update) => progressUpdates.push(update);

      const result = await engine.execute(context);

      expect(result.success).toBe(true);
      expect(result.artifacts).toContain(TASKS_FILE);
      expect(result.artifacts).toContain("execution-report.json");

      // Check task updates were emitted
      expect(progressUpdates.some((u) => u.type === "task")).toBe(true);
    });

    it("should pick planning tasks over execution tasks in plan-review loop", async () => {
      const engine = new ExecutorEngine();
      const context = createTestContext();

      // First run planner at iteration 2 (simulating a plan-review loop)
      const planner = new PlannerEngine();
      context.iteration = 2;
      await planner.execute(context);

      // Simulate phase history with:
      // - planning iteration 1 (rejected by review)
      // - planning iteration 2 (approved)
      // - execution iteration 1 (previous, also produced tasks.json)
      context.run.phaseHistory = [
        {
          phaseId: "planning",
          iteration: 1,
          status: "completed",
          artifacts: ["plan.md", TASKS_FILE],
          metrics: { durationMs: 1000 },
          logPath: "phases/01-planning/logs",
        },
        {
          phaseId: "execution",
          iteration: 1,
          status: "completed",
          artifacts: [TASKS_FILE, "execution-report.json"], // Execution also produces tasks.json
          metrics: { durationMs: 5000 },
          logPath: "phases/01-execution/logs",
        },
        {
          phaseId: "planning",
          iteration: 2, // Re-planning after review rejection
          status: "completed",
          artifacts: ["plan.md", TASKS_FILE],
          metrics: { durationMs: 1500 },
          logPath: "phases/02-planning/logs",
        },
      ];

      // Now run executor at iteration 2
      context.phase = {
        id: "execution",
        name: "Task Execution",
        engine: "executor",
        agent: { type: "claude" },
        inputArtifacts: [TASKS_FILE],
        outputArtifacts: [TASKS_FILE, "execution-report.json"],
        settings: { timeoutMs: 1800000 },
      };
      context.iteration = 2;

      // Validate should pass and pick planning iteration 2, not execution iteration 1
      const validation = await engine.validateInputs(context);
      expect(validation.valid).toBe(true);

      // Execute should work
      const result = await engine.execute(context);
      expect(result.success).toBe(true);
    });
  });

  describe("ReviewerEngine", () => {
    it("should validate inputs for git repo", async () => {
      const engine = new ReviewerEngine();
      const context = createTestContext();

      // Note: validation will fail because workspace isn't a git repo
      const result = await engine.validateInputs(context);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("git"))).toBe(true);
    });

    it("should execute and produce review artifacts", async () => {
      const engine = new ReviewerEngine();
      const context = createTestContext();

      const progressUpdates: EngineProgressUpdate[] = [];
      context.onProgress = (update) => progressUpdates.push(update);

      // Execute will succeed even without git (generates stub review)
      const result = await engine.execute(context);

      expect(result.success).toBe(true);
      expect(result.artifacts).toContain("review.json");
      expect(result.artifacts).toContain("recommendations.json");

      // Check output structure
      const output = result.output as {
        review: { approved: boolean; overallScore: number };
        recommendations: unknown[];
      };
      expect(typeof output.review.approved).toBe("boolean");
      expect(typeof output.review.overallScore).toBe("number");
      expect(Array.isArray(output.recommendations)).toBe(true);
    });
  });
});
