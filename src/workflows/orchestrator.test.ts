/**
 * Orchestrator Tests - Anti-Loop Limits
 *
 * Tests for maxDurationMs and maxAgentRuns enforcement.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WorkflowDefinition, WorkflowInput, WorkspaceConfig } from "./types.js";
import { DEFAULT_MAX_TASKS, DEFAULT_MAX_AGENT_RUNS } from "./constants.js";
import { WorkflowOrchestrator, resetOrchestrator } from "./orchestrator.js";

// Mock the persistence functions
vi.mock("./state/persistence.js", () => ({
  saveWorkflowState: vi.fn().mockResolvedValue(undefined),
  loadWorkflowState: vi.fn().mockResolvedValue(null),
  saveWorkflowInput: vi.fn().mockResolvedValue(undefined),
  logWorkflowEvent: vi.fn().mockResolvedValue(undefined),
  getWorkflowDir: vi.fn().mockReturnValue("/tmp/test-workflow"),
  listRunningWorkflows: vi.fn().mockResolvedValue([]),
  getWorkflowStoragePath: vi.fn().mockReturnValue("/tmp/workflows"),
}));

// Mock mkdirSync
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
  };
});

// Mock config
vi.mock("../config/io.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

// Mock engines
vi.mock("./engines/index.js", () => ({
  getEngine: vi.fn().mockReturnValue({
    validateInputs: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    execute: vi.fn().mockResolvedValue({ success: true }),
  }),
}));

// Mock validator
vi.mock("./artifacts/validator.js", () => ({
  validatePhaseOutput: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  evaluateCondition: vi.fn().mockReturnValue(false),
}));

// Mock artifacts/store
vi.mock("./artifacts/store.js", () => ({
  loadArtifactJson: vi.fn().mockResolvedValue(null),
  generateManifest: vi.fn().mockResolvedValue(undefined),
  getArtifactsDir: vi.fn().mockReturnValue("/tmp/test-artifacts"),
}));

// Mock observability
vi.mock("./observability/adapter.js", () => ({
  attachObservability: vi.fn().mockReturnValue({
    getLogger: vi.fn().mockReturnValue(null),
  }),
}));

// Mock retention scheduler
vi.mock("./retention/scheduler.js", () => ({
  startCleanupScheduler: vi.fn().mockResolvedValue(undefined),
  stopCleanupScheduler: vi.fn(),
}));

describe("WorkflowOrchestrator - Anti-Loop Limits", () => {
  let orchestrator: WorkflowOrchestrator;

  const testDefinition: WorkflowDefinition = {
    type: "dev-cycle",
    name: "Test Workflow",
    version: "1.0.0",
    phases: [
      {
        id: "planning",
        name: "Planning",
        engine: "planner",
        agent: { type: "claude" },
        inputArtifacts: [],
        outputArtifacts: ["plan.md"],
        settings: { timeoutMs: 30000, retries: 0 },
      },
    ],
    settings: {
      maxDurationMs: 100, // Very short for testing
      maxReviewIterations: 3,
      maxTasks: DEFAULT_MAX_TASKS,
      maxAgentRuns: DEFAULT_MAX_AGENT_RUNS,
      autoCommit: false,
      notifyOnPhaseComplete: false,
    },
    successCriteria: {
      testsPass: true,
      requiredArtifacts: ["plan.md"],
    },
  };

  const testInput: WorkflowInput = {
    task: "Test task",
    repoPath: "/tmp/test-repo",
    context: {},
  };

  const testWorkspace: WorkspaceConfig = {
    mode: "in-place",
    targetRepo: "/tmp/test-repo",
  };

  beforeEach(() => {
    resetOrchestrator();
    orchestrator = new WorkflowOrchestrator();
    orchestrator.registerDefinition(testDefinition);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("maxDurationMs enforcement", () => {
    it("should fail workflow when maxDurationMs exceeded", async () => {
      // Override Date.now to simulate time passing
      const originalDateNow = Date.now;
      let currentTime = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => {
        currentTime += 150; // Each call advances 150ms
        return currentTime;
      });

      try {
        // Start workflow
        const run = await orchestrator.start("dev-cycle", testInput, testWorkspace);
        expect(run.status).toBe("pending");

        // Execute should fail with timeout (150ms > 100ms limit)
        await expect(orchestrator.execute(run.id)).rejects.toThrow(
          /Workflow timeout.*maxDurationMs/,
        );
      } finally {
        Date.now = originalDateNow;
      }
    });

    it("should not fail before maxDurationMs", async () => {
      // Use longer timeout
      const longDefinition: WorkflowDefinition = {
        ...testDefinition,
        settings: { ...testDefinition.settings, maxDurationMs: 100000 },
      };
      orchestrator.registerDefinition(longDefinition);

      const run = await orchestrator.start("dev-cycle", testInput, testWorkspace);

      // Execute should succeed
      const result = await orchestrator.execute(run.id);
      expect(result.status).toBe("completed");
    });
  });

  describe("maxAgentRuns enforcement", () => {
    it("should fail when agentRuns exceeds maxAgentRuns in live mode", async () => {
      // Use definition with very low maxAgentRuns and multiple phases
      const lowAgentRunsDefinition: WorkflowDefinition = {
        ...testDefinition,
        settings: { ...testDefinition.settings, maxAgentRuns: 1, maxDurationMs: 100000 },
        phases: [
          testDefinition.phases[0],
          {
            id: "execution",
            name: "Execution",
            engine: "executor",
            agent: { type: "claude" },
            inputArtifacts: ["plan.md"],
            outputArtifacts: ["tasks.json"],
            settings: { timeoutMs: 30000, retries: 0 },
          },
        ],
      };
      orchestrator.registerDefinition(lowAgentRunsDefinition);

      // Start with live=true to enable agent run counting
      const run = await orchestrator.start(
        "dev-cycle",
        { ...testInput, context: { live: true } },
        testWorkspace,
      );

      // Phase 1: agentRunCount=0, check passes (0 < 1), increments to 1
      // Phase 2: agentRunCount=1, check fails (1 >= 1)
      await expect(orchestrator.execute(run.id)).rejects.toThrow(/Agent run limit exceeded/);
    });

    it("should not count agent runs in stub mode", async () => {
      // Use definition with low maxAgentRuns but stub mode (live=false)
      const lowAgentRunsDefinition: WorkflowDefinition = {
        ...testDefinition,
        settings: { ...testDefinition.settings, maxAgentRuns: 1, maxDurationMs: 100000 },
        phases: [
          testDefinition.phases[0],
          {
            id: "execution",
            name: "Execution",
            engine: "executor",
            agent: { type: "claude" },
            inputArtifacts: ["plan.md"],
            outputArtifacts: ["tasks.json"],
            settings: { timeoutMs: 30000, retries: 0 },
          },
        ],
      };
      orchestrator.registerDefinition(lowAgentRunsDefinition);

      // Start without live=true (stub mode)
      const run = await orchestrator.start("dev-cycle", testInput, testWorkspace);

      // Should succeed because agent runs aren't counted in stub mode
      const result = await orchestrator.execute(run.id);
      expect(result.status).toBe("completed");
    });
  });
});
