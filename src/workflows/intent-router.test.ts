import { describe, it, expect } from "vitest";
import {
  detectWorkflowIntent,
  isWorkflowIntent,
  suggestWorkflowCommand,
  type WorkflowIntentResult,
} from "./intent-router.js";

describe("detectWorkflowIntent", () => {
  describe("dev-cycle detection", () => {
    it("detects explicit workflow invocation", () => {
      const result = detectWorkflowIntent("/workflow start a REST API");
      expect(result.type).toBe("dev-cycle");
      expect(result.confidence).toBe(1.0);
    });

    it("detects skill invocation format", () => {
      const result = detectWorkflowIntent("use skill multi-agent-workflow: build a todo app");
      expect(result.type).toBe("dev-cycle");
      expect(result.confidence).toBe(1.0);
    });

    it("detects plan and implement pattern", () => {
      const result = detectWorkflowIntent("plan and implement user authentication");
      expect(result.type).toBe("dev-cycle");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("detects implement and review pattern", () => {
      const result = detectWorkflowIntent("implement file upload and review");
      expect(result.type).toBe("dev-cycle");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("detects start dev-cycle command", () => {
      const result = detectWorkflowIntent("start a dev-cycle for refactoring the API");
      expect(result.type).toBe("dev-cycle");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("detects build with review pattern", () => {
      const result = detectWorkflowIntent("build a login form with review");
      expect(result.type).toBe("dev-cycle");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });
  });

  describe("review-only detection", () => {
    it("detects code review request", () => {
      const result = detectWorkflowIntent("review the code changes");
      expect(result.type).toBe("review-only");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects PR review request", () => {
      const result = detectWorkflowIntent("review this PR");
      expect(result.type).toBe("review-only");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects review-only keyword", () => {
      const result = detectWorkflowIntent("do a review-only on the diff");
      expect(result.type).toBe("review-only");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("plan-only detection", () => {
    it("detects just plan request", () => {
      const result = detectWorkflowIntent("just plan the refactoring");
      expect(result.type).toBe("plan-only");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects create a plan request", () => {
      const result = detectWorkflowIntent("create a plan for the new feature");
      expect(result.type).toBe("plan-only");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects plan-only keyword", () => {
      const result = detectWorkflowIntent("run plan-only for the migration");
      expect(result.type).toBe("plan-only");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("negative patterns", () => {
    it("returns null for don't use workflow", () => {
      const result = detectWorkflowIntent("don't use a workflow for this");
      expect(result.type).toBeNull();
      expect(result.confidence).toBe(0);
    });

    it("returns null for manual request", () => {
      const result = detectWorkflowIntent("manually implement the feature");
      expect(result.type).toBeNull();
      expect(result.confidence).toBe(0);
    });

    it("returns null for simple question", () => {
      const result = detectWorkflowIntent("simple question about APIs");
      expect(result.type).toBeNull();
      expect(result.confidence).toBe(0);
    });
  });

  describe("no intent detected", () => {
    it("returns null for generic message", () => {
      const result = detectWorkflowIntent("hello, how are you?");
      expect(result.type).toBeNull();
    });

    it("returns null for coding question", () => {
      const result = detectWorkflowIntent("how do I use async/await?");
      expect(result.type).toBeNull();
    });
  });

  describe("task extraction", () => {
    it("extracts task from explicit invocation", () => {
      const result = detectWorkflowIntent("workflow: build a REST API for todos");
      expect(result.task).toBe("build a REST API for todos");
    });

    it("extracts task from plan+implement", () => {
      const result = detectWorkflowIntent("plan and implement user authentication with JWT");
      expect(result.task).toContain("user authentication");
    });
  });
});

describe("isWorkflowIntent", () => {
  it("returns true for high confidence intent", () => {
    expect(isWorkflowIntent("/workflow build an API")).toBe(true);
  });

  it("returns false for low confidence", () => {
    expect(isWorkflowIntent("hello world")).toBe(false);
  });

  it("respects custom threshold", () => {
    const message = "build something with review";
    expect(isWorkflowIntent(message, 0.5)).toBe(true);
    expect(isWorkflowIntent(message, 0.95)).toBe(false);
  });
});

describe("suggestWorkflowCommand", () => {
  it("suggests dev-cycle command", () => {
    const intent: WorkflowIntentResult = {
      type: "dev-cycle",
      confidence: 0.9,
      task: "build a REST API",
    };
    const command = suggestWorkflowCommand(intent);
    expect(command).toContain("--type dev-cycle");
    expect(command).toContain('--task "build a REST API"');
    expect(command).toContain("--repo .");
  });

  it("suggests review-only command", () => {
    const intent: WorkflowIntentResult = {
      type: "review-only",
      confidence: 0.8,
    };
    const command = suggestWorkflowCommand(intent);
    expect(command).toContain("--type review-only");
    expect(command).not.toContain("--task");
  });

  it("returns null for low confidence", () => {
    const intent: WorkflowIntentResult = {
      type: "dev-cycle",
      confidence: 0.3,
    };
    expect(suggestWorkflowCommand(intent)).toBeNull();
  });

  it("returns null for no type", () => {
    const intent: WorkflowIntentResult = {
      type: null,
      confidence: 0,
    };
    expect(suggestWorkflowCommand(intent)).toBeNull();
  });

  it("escapes quotes in task", () => {
    const intent: WorkflowIntentResult = {
      type: "dev-cycle",
      confidence: 0.9,
      task: 'task with "quotes"',
    };
    const command = suggestWorkflowCommand(intent);
    expect(command).toContain('\\"quotes\\"');
  });
});
