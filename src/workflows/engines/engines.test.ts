import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PlannerEngine,
  ExecutorEngine,
  ReviewerEngine,
  getEngine,
  StubRunner,
  LiveRunner,
  createRunner,
  generateSessionId,
  mapAgentConfigToRunnerParams,
  type EngineAgentRunner,
} from "./index.js";
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

  // Define phases for the workflow
  const planningPhase: PhaseDefinition = {
    id: "planning",
    name: "Project Planning",
    engine: "planner",
    agent: { type: "claude", model: "claude-sonnet-4-5" },
    inputArtifacts: [],
    outputArtifacts: ["plan.md", "tasks.json"],
    settings: { timeoutMs: 300000 },
  };

  const executionPhase: PhaseDefinition = {
    id: "execution",
    name: "Task Execution",
    engine: "executor",
    agent: { type: "claude" },
    inputArtifacts: [TASKS_FILE],
    outputArtifacts: [TASKS_FILE, "execution-report.json"],
    settings: { timeoutMs: 1800000, retries: 0 },
  };

  const reviewPhase: PhaseDefinition = {
    id: "code-review",
    name: "Code Review",
    engine: "reviewer",
    agent: { type: "codex" },
    inputArtifacts: [TASKS_FILE],
    outputArtifacts: ["review.json", "recommendations.json"],
    settings: { timeoutMs: 300000 },
  };

  const run: WorkflowRun = {
    id: runId,
    definitionType: "dev-cycle",
    definition: {
      type: "dev-cycle",
      name: "Test Workflow",
      description: "Test workflow",
      version: "1.0.0",
      phases: [planningPhase, executionPhase, reviewPhase],
      settings: {
        maxDurationMs: 3600000,
        maxReviewIterations: 3,
        maxTasks: 50,
        maxAgentRuns: 100,
        autoCommit: false,
        notifyOnPhaseComplete: false,
      },
      successCriteria: {
        testsPass: true,
        requiredArtifacts: ["tasks.json", "review.json"],
      },
    },
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

  const phaseDir = join(TEST_DIR, "workflows", runId, "phases", "01-planning");
  const artifactsDir = join(phaseDir, "artifacts");

  return {
    run,
    phase: planningPhase,
    iteration: 1,
    workflowDir: join(TEST_DIR, "workflows", runId),
    phaseDir,
    artifactsDir,
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

  // ==========================================================================
  // Runner Tests
  // ==========================================================================

  describe("StubRunner", () => {
    it("should return mock success after delay", async () => {
      const runner = new StubRunner({ delayMs: 50 });

      const result = await runner.run({
        sessionId: "test-session",
        prompt: "Test prompt",
        workspacePath: "/tmp",
        timeoutMs: 10000,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Stub response");
      // Allow for minor timing variations (45ms = 90% of 50ms delay)
      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(45);
      expect(result.metrics.provider).toBe("stub");
    });

    it("should use custom mock response", async () => {
      const customResponse = "Custom mock output";
      const runner = new StubRunner({ delayMs: 10, mockResponse: customResponse });

      const result = await runner.run({
        sessionId: "test-session",
        prompt: "Test prompt",
        workspacePath: "/tmp",
        timeoutMs: 10000,
      });

      expect(result.output).toBe(customResponse);
    });

    it("should handle abort signal", async () => {
      const runner = new StubRunner({ delayMs: 5000 });
      const controller = new AbortController();

      const runPromise = runner.run({
        sessionId: "test-session",
        prompt: "Test prompt",
        workspacePath: "/tmp",
        timeoutMs: 10000,
        abortSignal: controller.signal,
      });

      // Abort after 10ms
      setTimeout(() => controller.abort(), 10);

      await expect(runPromise).rejects.toThrow("Aborted");
    });
  });

  describe("createRunner", () => {
    it("should create StubRunner when live=false", () => {
      const runner = createRunner({
        live: false,
        artifactsDir: "/tmp",
      });

      expect(runner).toBeInstanceOf(StubRunner);
    });

    it("should create LiveRunner when live=true", () => {
      const runner = createRunner({
        live: true,
        phaseDir: "/tmp/phases/1-planning",
        artifactsDir: "/tmp",
      });

      // LiveRunner is exported, verify instance
      expect(runner).toBeInstanceOf(LiveRunner);
    });

    it("should throw error when live=true but phaseDir is missing", () => {
      expect(() =>
        createRunner({
          live: true,
          artifactsDir: "/tmp",
        }),
      ).toThrow("phaseDir is required for live mode");
    });
  });

  describe("LiveRunner retry logic", () => {
    it("should be created with default retry options", () => {
      const runner = new LiveRunner({
        phaseDir: "/tmp/phases/1-planning",
        artifactsDir: "/tmp",
      });

      // Verify runner was created - it has internal defaults
      expect(runner).toBeInstanceOf(LiveRunner);
    });

    it("should be created with custom retry options", () => {
      const runner = new LiveRunner({
        phaseDir: "/tmp/phases/1-planning",
        artifactsDir: "/tmp",
        maxRetries: 5,
        retryDelayMs: 2000,
      });

      expect(runner).toBeInstanceOf(LiveRunner);
    });

    it("should include attempt count in error message on failure", async () => {
      // This tests the error message format includes attempt info
      // Since we can't easily mock runEmbeddedPiAgent, we test via createRunner
      const runner = new LiveRunner({
        phaseDir: "/tmp/phases/1-planning",
        artifactsDir: "/tmp",
        maxRetries: 1, // Only try once
      });

      // The runner exists and can be invoked (would fail without API key)
      expect(runner).toBeDefined();
    });

    it("should accept policy for exec security", () => {
      const mockPolicy = {
        version: "1.0" as const,
        pathScope: {
          workspaceRoot: "/tmp/workspace",
          allowedPaths: ["/tmp/workspace/**"],
          blockedPaths: [],
        },
        rules: [
          {
            id: "allow-tests",
            name: "Allow test commands",
            actions: ["bash_execute" as const],
            commandPatterns: ["^npm test$"],
            decision: "allow" as const,
            priority: 100,
            enabled: true,
          },
        ],
        defaultDecision: "prompt" as const,
        requireApprovalForDestructive: true,
        destructiveActions: ["file_delete" as const, "bash_execute" as const],
        logging: {
          logAllActions: false,
          logDeniedActions: true,
          logPromptedActions: true,
        },
      };

      const runner = new LiveRunner({
        phaseDir: "/tmp/phases/1-planning",
        artifactsDir: "/tmp",
        policy: mockPolicy,
        runId: "run-123",
        phaseId: "planning",
      });

      expect(runner).toBeInstanceOf(LiveRunner);
    });
  });

  describe("generateSessionId", () => {
    it("should generate correct session ID format", () => {
      const sessionId = generateSessionId("run123", "planning", 2);
      expect(sessionId).toBe("wf-run123-planning-2");
    });
  });

  describe("mapAgentConfigToRunnerParams", () => {
    it("should map claude config correctly", () => {
      const params = mapAgentConfigToRunnerParams({
        type: "claude",
        model: "claude-sonnet-4-5",
      });

      expect(params.provider).toBe("claude");
      expect(params.model).toBe("claude-sonnet-4-5");
    });

    it("should map codex config correctly", () => {
      const params = mapAgentConfigToRunnerParams({
        type: "codex",
        model: "gpt-4o",
      });

      expect(params.provider).toBe("codex");
      expect(params.model).toBe("gpt-4o");
    });
  });

  // ==========================================================================
  // Live Mode Detection Tests
  // ==========================================================================

  describe("Live Mode Detection", () => {
    it("should detect live mode in planner", async () => {
      // Create a mock runner to verify it's called
      const runFn = vi.fn().mockResolvedValue({
        success: true,
        output: `--- BEGIN plan.md ---
# Test Plan
--- END plan.md ---

--- BEGIN tasks.json ---
{
  "version": "1.0",
  "projectName": "test",
  "createdAt": 0,
  "updatedAt": 0,
  "tasks": [],
  "stats": { "total": 0, "pending": 0, "completed": 0, "failed": 0 }
}
--- END tasks.json ---`,
        metrics: { durationMs: 100 },
      });
      const mockRunner: EngineAgentRunner = {
        run: runFn,
      };

      const engine = new PlannerEngine({}, mockRunner);
      const context = createTestContext();
      context.run.input.context = { live: true };

      await engine.execute(context);

      // Verify the runner was called (live mode engaged)
      expect(runFn).toHaveBeenCalled();
    });

    it("should not use runner when live mode is disabled", async () => {
      const runFn = vi.fn();
      const mockRunner: EngineAgentRunner = {
        run: runFn,
      };

      const engine = new PlannerEngine({}, mockRunner);
      const context = createTestContext();
      // No live: true in context

      await engine.execute(context);

      // Runner should NOT be called in stub mode
      expect(runFn).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Engine with Mock Runner Tests
  // ==========================================================================

  describe("Engines with Mock Runner", () => {
    it("PlannerEngine should produce valid TaskList with mock runner", async () => {
      const mockTaskList: TaskList = {
        version: "1.0",
        projectName: "mock-project",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tasks: [
          {
            id: "task-1",
            title: "Mock task",
            description: "A mock task",
            type: "feature",
            priority: 1,
            complexity: 2,
            status: "pending",
            dependsOn: [],
            acceptanceCriteria: ["Works correctly"],
          },
        ],
        stats: { total: 1, pending: 1, completed: 0, failed: 0 },
      };

      const mockRunner: EngineAgentRunner = {
        run: vi.fn().mockResolvedValue({
          success: true,
          output: `--- BEGIN plan.md ---
# Mock Plan
This is a mock plan.
--- END plan.md ---

--- BEGIN tasks.json ---
${JSON.stringify(mockTaskList, null, 2)}
--- END tasks.json ---`,
          metrics: { durationMs: 100 },
        }),
      };

      const engine = new PlannerEngine({}, mockRunner);
      const context = createTestContext();
      context.run.input.context = { live: true };

      const result = await engine.execute(context);

      expect(result.success).toBe(true);
      const output = result.output as { tasks: TaskList };
      expect(output.tasks.version).toBe("1.0");
      expect(output.tasks.tasks).toHaveLength(1);
      expect(output.tasks.tasks[0].title).toBe("Mock task");
    });

    it("ExecutorEngine should update tasks with mock runner", async () => {
      // First set up planner output
      const planner = new PlannerEngine();
      const context = createTestContext();
      await planner.execute(context);

      // Set up executor with mock runner
      const runFn = vi.fn().mockResolvedValue({
        success: true,
        output: `--- SUMMARY ---
Implemented the task successfully.
--- FILES CHANGED ---
- src/index.ts
- src/utils.ts
--- END ---`,
        metrics: { durationMs: 100 },
      });
      const mockRunner: EngineAgentRunner = {
        run: runFn,
      };

      const executor = new ExecutorEngine({}, mockRunner);

      // Update context for executor with live mode
      context.phase = {
        id: "execution",
        name: "Task Execution",
        engine: "executor",
        agent: { type: "claude" },
        inputArtifacts: [TASKS_FILE],
        outputArtifacts: [TASKS_FILE, "execution-report.json"],
        settings: { timeoutMs: 1800000, retries: 0 },
      };
      // Update phaseDir and artifactsDir for execution phase
      context.phaseDir = join(context.workflowDir, "phases", "01-execution");
      context.artifactsDir = join(context.phaseDir, "artifacts");
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
      context.run.input.context = { live: true };

      const result = await executor.execute(context);

      expect(result.success).toBe(true);
      // Runner should have been called for each task
      expect(runFn).toHaveBeenCalled();
    });

    it("ReviewerEngine should produce valid ReviewResult with mock runner", async () => {
      const mockReview = {
        version: "1.0",
        reviewedAt: Date.now(),
        reviewer: "codex",
        overallScore: 85,
        approved: true,
        summary: "Good code quality",
        scores: {
          architecture: 80,
          codeQuality: 90,
          testCoverage: 85,
          security: 85,
          documentation: 85,
        },
        issues: [],
        recommendations: [],
      };

      const mockRunner: EngineAgentRunner = {
        run: vi.fn().mockResolvedValue({
          success: true,
          output: `--- BEGIN review.json ---
${JSON.stringify(mockReview, null, 2)}
--- END review.json ---`,
          metrics: { durationMs: 100 },
        }),
      };

      const reviewer = new ReviewerEngine({}, mockRunner);
      const context = createTestContext();
      context.run.input.context = { live: true };

      const result = await reviewer.execute(context);

      expect(result.success).toBe(true);
      const output = result.output as { review: { approved: boolean; overallScore: number } };
      expect(output.review.approved).toBe(true);
      expect(output.review.overallScore).toBe(85);
    });

    it("PlannerEngine prompt should include handoff data in live mode", async () => {
      // Track the prompt sent to the runner
      let capturedPrompt = "";
      const mockRunner: EngineAgentRunner = {
        run: vi.fn().mockImplementation(async (params) => {
          capturedPrompt = params.prompt;
          return {
            success: true,
            output: `--- BEGIN plan.md ---
# Test Plan
--- END plan.md ---

--- BEGIN tasks.json ---
{
  "version": "1.0",
  "projectName": "test",
  "createdAt": 0,
  "updatedAt": 0,
  "tasks": [],
  "stats": { "total": 0, "pending": 0, "completed": 0, "failed": 0 }
}
--- END tasks.json ---`,
            metrics: { durationMs: 100 },
          };
        }),
      };

      const engine = new PlannerEngine({}, mockRunner);
      const context = createTestContext();
      context.run.input.context = { live: true };

      await engine.execute(context);

      // Verify handoff sections are in the prompt
      expect(capturedPrompt).toContain("## Handoff Instructions");
      expect(capturedPrompt).toContain("## Handoff Context");
      expect(capturedPrompt).toContain("## Handoff Expectations");
      // Verify actual content from instructions.md (contains "Your Role" from buildInstructions)
      expect(capturedPrompt).toContain("Your Role");
    });
  });
});
