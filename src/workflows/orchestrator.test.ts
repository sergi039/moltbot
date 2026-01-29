import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  WorkflowOrchestrator,
  getOrchestrator,
  resetOrchestrator,
  setWorkflowStoragePath,
  DEV_CYCLE_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
  registerBuiltinWorkflows,
  generateWorkflowId,
  WORKFLOW_ID_PREFIX,
} from "./index.js";

describe("WorkflowOrchestrator", () => {
  let orchestrator: WorkflowOrchestrator;
  let testStoragePath: string;

  beforeEach(() => {
    resetOrchestrator();
    orchestrator = getOrchestrator();

    // Use a temporary storage path for tests
    testStoragePath = join(os.tmpdir(), `workflow-test-${Date.now()}`);
    setWorkflowStoragePath(testStoragePath);
    mkdirSync(testStoragePath, { recursive: true });
  });

  afterEach(() => {
    // Clean up test storage
    try {
      rmSync(testStoragePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Definition Management", () => {
    it("should register and retrieve workflow definitions", () => {
      orchestrator.registerDefinition(DEV_CYCLE_WORKFLOW);

      const definition = orchestrator.getDefinition("dev-cycle");
      expect(definition).toBeDefined();
      expect(definition?.name).toBe("Standard Development Cycle");
    });

    it("should list all registered definitions", () => {
      registerBuiltinWorkflows(orchestrator);

      const definitions = orchestrator.listDefinitions();
      expect(definitions).toHaveLength(2);
      expect(definitions.map((d) => d.type)).toContain("dev-cycle");
      expect(definitions.map((d) => d.type)).toContain("review-only");
    });

    it("should return undefined for unknown definition", () => {
      const definition = orchestrator.getDefinition("unknown");
      expect(definition).toBeUndefined();
    });
  });

  describe("Workflow Lifecycle", () => {
    beforeEach(() => {
      registerBuiltinWorkflows(orchestrator);
    });

    it("should start a new workflow", async () => {
      const run = await orchestrator.start(
        "dev-cycle",
        {
          task: "Test task",
          repoPath: "/tmp/test-repo",
        },
        {
          mode: "in-place",
          targetRepo: "/tmp/test-repo",
        },
      );

      expect(run.id).toMatch(new RegExp(`^${WORKFLOW_ID_PREFIX}`));
      expect(run.status).toBe("pending");
      expect(run.definitionType).toBe("dev-cycle");
      expect(run.input.task).toBe("Test task");
    });

    it("should throw for unknown workflow type", async () => {
      await expect(
        orchestrator.start(
          "unknown-type",
          { task: "Test", repoPath: "/tmp" },
          { mode: "in-place", targetRepo: "/tmp" },
        ),
      ).rejects.toThrow("Unknown workflow type: unknown-type");
    });

    it("should get workflow status", async () => {
      const run = await orchestrator.start(
        "review-only",
        { task: "Review code", repoPath: "/tmp/test" },
        { mode: "in-place", targetRepo: "/tmp/test" },
      );

      const status = await orchestrator.getStatus(run.id);
      expect(status).toBeDefined();
      expect(status?.id).toBe(run.id);
      expect(status?.status).toBe("pending");
    });

    it("should return null for unknown workflow", async () => {
      const status = await orchestrator.getStatus("wf_nonexistent");
      expect(status).toBeNull();
    });
  });

  describe("Event Handling", () => {
    beforeEach(() => {
      registerBuiltinWorkflows(orchestrator);
    });

    it("should emit workflow:started event", async () => {
      const events: Array<{ type: string; workflowId: string }> = [];

      orchestrator.onWorkflowEvent((event) => {
        events.push({ type: event.type, workflowId: event.workflowId });
      });

      const run = await orchestrator.start(
        "dev-cycle",
        { task: "Test", repoPath: "/tmp" },
        { mode: "in-place", targetRepo: "/tmp" },
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("workflow:started");
      expect(events[0].workflowId).toBe(run.id);
    });
  });
});

describe("generateWorkflowId", () => {
  it("should generate IDs with correct prefix", () => {
    const id = generateWorkflowId();
    expect(id).toMatch(new RegExp(`^${WORKFLOW_ID_PREFIX}`));
  });

  it("should generate unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateWorkflowId());
    }
    expect(ids.size).toBe(100);
  });
});

describe("Built-in Workflow Definitions", () => {
  describe("DEV_CYCLE_WORKFLOW", () => {
    it("should have correct type and name", () => {
      expect(DEV_CYCLE_WORKFLOW.type).toBe("dev-cycle");
      expect(DEV_CYCLE_WORKFLOW.name).toBe("Standard Development Cycle");
    });

    it("should have 5 phases", () => {
      expect(DEV_CYCLE_WORKFLOW.phases).toHaveLength(5);
    });

    it("should have planning phase first", () => {
      expect(DEV_CYCLE_WORKFLOW.phases[0].id).toBe("planning");
      expect(DEV_CYCLE_WORKFLOW.phases[0].engine).toBe("planner");
    });

    it("should have finalize phase last", () => {
      const lastPhase = DEV_CYCLE_WORKFLOW.phases[DEV_CYCLE_WORKFLOW.phases.length - 1];
      expect(lastPhase.id).toBe("finalize");
    });

    it("should have transitions for review phases", () => {
      const planReview = DEV_CYCLE_WORKFLOW.phases.find((p) => p.id === "plan-review");
      expect(planReview?.transitions).toBeDefined();
      expect(planReview?.transitions).toHaveLength(1);
      expect(planReview?.transitions?.[0].targetPhase).toBe("planning");
    });
  });

  describe("REVIEW_ONLY_WORKFLOW", () => {
    it("should have correct type and name", () => {
      expect(REVIEW_ONLY_WORKFLOW.type).toBe("review-only");
      expect(REVIEW_ONLY_WORKFLOW.name).toBe("Code Review Only");
    });

    it("should have single phase", () => {
      expect(REVIEW_ONLY_WORKFLOW.phases).toHaveLength(1);
      expect(REVIEW_ONLY_WORKFLOW.phases[0].id).toBe("code-review");
    });
  });
});
