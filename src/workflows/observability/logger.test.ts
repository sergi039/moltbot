/**
 * Workflow Logger Tests
 *
 * Unit tests for WorkflowLogger and event logging.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { WorkflowEventBase } from "./types.js";
import { DEFAULT_LOG_ROTATION_OPTIONS } from "../retention/types.js";
import { createWorkflowLogger, loadRunSummary, loadRunEvents } from "./logger.js";

describe("WorkflowLogger", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `wf-logger-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("creates run.json on init", async () => {
      await createWorkflowLogger({
        runId: "test-run-1",
        workflowType: "dev-cycle",
        task: "Test task",
        workspacePath: "/test/workspace",
        live: false,
        artifactsDir: testDir,
      });

      const summaryPath = join(testDir, "run.json");
      const content = await readFile(summaryPath, "utf-8");
      const summary = JSON.parse(content);

      expect(summary.runId).toBe("test-run-1");
      expect(summary.workflowType).toBe("dev-cycle");
      expect(summary.status).toBe("running");
    });

    it("sets initial summary values", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-run-2",
        workflowType: "review",
        task: "Review code",
        workspacePath: "/work",
        live: true,
        artifactsDir: testDir,
      });

      const summary = logger.getSummary();

      expect(summary.version).toBe("1.0");
      expect(summary.live).toBe(true);
      expect(summary.task).toBe("Review code");
      expect(summary.phases.total).toBe(0);
      expect(summary.phases.completed).toBe(0);
      expect(summary.artifacts).toEqual([]);
    });
  });

  describe("event logging", () => {
    it("writes events to JSONL format", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-events",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      logger.logEvent({
        runId: "test-events",
        type: "workflow.start",
        payload: { message: "Starting" },
      });

      logger.logEvent({
        runId: "test-events",
        type: "phase.start",
        phaseId: "plan",
        payload: { phaseName: "Planning" },
      });

      await logger.finalize();

      const eventsPath = join(testDir, "events.jsonl");
      const content = await readFile(eventsPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(2);

      const event1 = JSON.parse(lines[0]) as WorkflowEventBase;
      expect(event1.type).toBe("workflow.start");
      expect(event1.timestamp).toBeTruthy();

      const event2 = JSON.parse(lines[1]) as WorkflowEventBase;
      expect(event2.type).toBe("phase.start");
      expect(event2.phaseId).toBe("plan");
    });

    it("includes timestamp in events", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-ts",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      const before = new Date().toISOString();

      logger.logEvent({
        runId: "test-ts",
        type: "workflow.start",
        payload: {},
      });

      await logger.finalize();

      const after = new Date().toISOString();

      const events = await loadRunEvents(testDir);
      expect(events.length).toBe(1);

      const eventTime = events[0].timestamp;
      expect(eventTime >= before).toBe(true);
      expect(eventTime <= after).toBe(true);
    });
  });

  describe("redaction", () => {
    it("redacts sensitive data in events", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-redact",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: true,
      });

      logger.logEvent({
        runId: "test-redact",
        type: "workflow.start",
        payload: {
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234",
        },
      });

      await logger.finalize();

      const events = await loadRunEvents(testDir);
      expect(events.length).toBe(1);
      expect(events[0].payload.apiKey).toContain("[REDACTED:");
      expect(events[0].payload.apiKey).not.toContain("sk-proj");
    });

    it("redacts sensitive data in summary", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-redact-summary",
        workflowType: "test",
        task: "Use key sk-abcdefghijklmnopqrstuvwxyz1234",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: true,
      });

      await logger.finalize();

      const summary = await loadRunSummary(testDir);
      expect(summary?.task).toContain("[REDACTED:");
      expect(summary?.task).not.toContain("sk-proj");
    });

    it("can disable redaction", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-no-redact",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      logger.logEvent({
        runId: "test-no-redact",
        type: "workflow.start",
        payload: {
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234",
        },
      });

      await logger.finalize();

      const events = await loadRunEvents(testDir);
      expect(events[0].payload.apiKey).toBe("sk-abcdefghijklmnopqrstuvwxyz1234");
    });
  });

  describe("convenience methods", () => {
    it("logWorkflowStart logs workflow.start event", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-wf-start",
        workflowType: "dev-cycle",
        task: "Build feature",
        workspacePath: "/workspace",
        live: true,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      logger.logWorkflowStart();
      await logger.finalize();

      const events = await loadRunEvents(testDir);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("workflow.start");
      expect(events[0].payload.workflowType).toBe("dev-cycle");
      expect(events[0].payload.live).toBe(true);
    });

    it("logWorkflowComplete updates status and logs event", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-wf-complete",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      logger.logWorkflowComplete(true);
      await logger.finalize();

      const summary = await loadRunSummary(testDir);
      expect(summary?.status).toBe("completed");

      const events = await loadRunEvents(testDir);
      const completeEvent = events.find((e) => e.type === "workflow.complete");
      expect(completeEvent).toBeTruthy();
    });

    it("logWorkflowComplete handles failure", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-wf-fail",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      logger.logWorkflowComplete(false, "Something went wrong");
      await logger.finalize();

      const summary = await loadRunSummary(testDir);
      expect(summary?.status).toBe("failed");
      expect(summary?.error).toBe("Something went wrong");

      const events = await loadRunEvents(testDir);
      const failEvent = events.find((e) => e.type === "workflow.fail");
      expect(failEvent).toBeTruthy();
      expect(failEvent?.payload.error).toBe("Something went wrong");
    });

    it("logPhaseStart and logPhaseComplete track phases", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-phases",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      logger.logPhaseStart("plan", "Planning", "planner-engine");
      logger.logPhaseComplete("plan", "Planning", "planner-engine", 1000, ["plan.md"], true);

      logger.logPhaseStart("exec", "Execution", "executor-engine");
      logger.logPhaseComplete(
        "exec",
        "Execution",
        "executor-engine",
        5000,
        [],
        false,
        "Task failed",
      );

      await logger.finalize();

      const summary = await loadRunSummary(testDir);
      expect(summary?.phases.completed).toBe(1);
      expect(summary?.phases.failed).toBe(1);
      expect(summary?.artifacts).toContain("plan.md");
    });

    it("logAgentComplete tracks tokens", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-tokens",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      logger.logAgentStart("plan", "session-1", "claude-3-5-sonnet", "anthropic");
      logger.logAgentComplete("plan", "session-1", 2000, { input: 1000, output: 500 });

      logger.logAgentStart("exec", "session-2", "claude-3-5-sonnet", "anthropic");
      logger.logAgentComplete("exec", "session-2", 3000, { input: 2000, output: 1000 });

      await logger.finalize();

      const summary = await loadRunSummary(testDir);
      expect(summary?.tokens?.input).toBe(3000);
      expect(summary?.tokens?.output).toBe(1500);
    });

    it("logApproval tracks approval statistics", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-approvals",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      logger.logApproval("plan", "req-1", "file:write", "approved", true);
      logger.logApproval("plan", "req-2", "bash:execute", "denied");
      logger.logApproval("exec", "req-3", "file:write", "approved");

      await logger.finalize();

      const summary = await loadRunSummary(testDir);
      expect(summary?.approvals?.total).toBe(3);
      expect(summary?.approvals?.approved).toBe(2);
      expect(summary?.approvals?.denied).toBe(1);
    });

    it("logError logs workflow.fail event", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-error",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      const error = new Error("Test error");
      logger.logError(error, { context: "testing" });

      await logger.finalize();

      const events = await loadRunEvents(testDir);
      const errorEvent = events.find((e) => e.type === "workflow.fail");
      expect(errorEvent).toBeTruthy();
      expect(errorEvent?.payload.error).toBe("Test error");
      expect(errorEvent?.payload.context).toBe("testing");
    });
  });

  describe("finalize", () => {
    it("sets completedAt and durationMs", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-finalize",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      // Small delay to ensure duration > 0
      await new Promise((resolve) => setTimeout(resolve, 50));

      await logger.finalize();

      const summary = await loadRunSummary(testDir);
      expect(summary?.completedAt).toBeTruthy();
      expect(summary?.durationMs).toBeGreaterThan(0);
    });

    it("flushes buffered events", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-flush",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      // Log multiple events without waiting
      for (let i = 0; i < 10; i++) {
        logger.logEvent({
          runId: "test-flush",
          type: "workflow.start",
          payload: { index: i },
        });
      }

      await logger.finalize();

      const events = await loadRunEvents(testDir);
      expect(events.length).toBe(10);
    });
  });

  describe("loading functions", () => {
    it("loadRunSummary loads existing summary", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-load-summary",
        workflowType: "dev-cycle",
        task: "Test task",
        workspacePath: "/test",
        live: true,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      logger.updateSummary({ status: "completed" });
      await logger.finalize();

      const summary = await loadRunSummary(testDir);
      expect(summary?.runId).toBe("test-load-summary");
      expect(summary?.status).toBe("completed");
      expect(summary?.live).toBe(true);
    });

    it("loadRunSummary returns null for missing file", async () => {
      const summary = await loadRunSummary("/nonexistent/path");
      expect(summary).toBeNull();
    });

    it("loadRunEvents loads events with tail option", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-tail",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      for (let i = 0; i < 20; i++) {
        logger.logEvent({
          runId: "test-tail",
          type: "workflow.start",
          payload: { index: i },
        });
      }

      await logger.finalize();

      const lastFive = await loadRunEvents(testDir, { tail: 5 });
      expect(lastFive.length).toBe(5);
      expect(lastFive[0].payload.index).toBe(15);
      expect(lastFive[4].payload.index).toBe(19);
    });

    it("loadRunEvents returns empty array for missing file", async () => {
      const events = await loadRunEvents("/nonexistent/path");
      expect(events).toEqual([]);
    });
  });

  describe("readEvents", () => {
    it("reads events from logger instance", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-read",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      logger.logEvent({ runId: "test-read", type: "workflow.start", payload: {} });
      logger.logEvent({ runId: "test-read", type: "phase.start", payload: {} });

      await logger.finalize();

      const events = await logger.readEvents();
      expect(events.length).toBe(2);
    });

    it("supports tail option", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-read-tail",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        enableRedaction: false,
      });

      for (let i = 0; i < 10; i++) {
        logger.logEvent({ runId: "test-read-tail", type: "workflow.start", payload: { i } });
      }

      await logger.finalize();

      const events = await logger.readEvents({ tail: 3 });
      expect(events.length).toBe(3);
    });
  });

  describe("log rotation defaults", () => {
    it("enables log rotation by default", async () => {
      // When logRotation is not specified, it should default to DEFAULT_LOG_ROTATION_OPTIONS
      const logger = await createWorkflowLogger({
        runId: "test-rotation-default",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
      });

      // Access the private logRotation field via any cast (for testing)
      const loggerAny = logger as unknown as {
        logRotation?: { maxSizeBytes: number; maxRotatedFiles: number };
      };

      expect(loggerAny.logRotation).toBeDefined();
      expect(loggerAny.logRotation?.maxSizeBytes).toBe(DEFAULT_LOG_ROTATION_OPTIONS.maxSizeBytes);
      expect(loggerAny.logRotation?.maxRotatedFiles).toBe(
        DEFAULT_LOG_ROTATION_OPTIONS.maxRotatedFiles,
      );
    });

    it("can disable log rotation with null", async () => {
      const logger = await createWorkflowLogger({
        runId: "test-rotation-disabled",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        logRotation: null,
      });

      // Access the private logRotation field via any cast (for testing)
      const loggerAny = logger as unknown as { logRotation?: unknown };

      expect(loggerAny.logRotation).toBeUndefined();
    });

    it("can use custom log rotation options", async () => {
      const customOptions = {
        maxSizeBytes: 5 * 1024 * 1024, // 5 MB
        maxRotatedFiles: 5,
      };

      const logger = await createWorkflowLogger({
        runId: "test-rotation-custom",
        workflowType: "test",
        task: "Test",
        workspacePath: "/test",
        live: false,
        artifactsDir: testDir,
        logRotation: customOptions,
      });

      // Access the private logRotation field via any cast (for testing)
      const loggerAny = logger as unknown as {
        logRotation?: { maxSizeBytes: number; maxRotatedFiles: number };
      };

      expect(loggerAny.logRotation?.maxSizeBytes).toBe(customOptions.maxSizeBytes);
      expect(loggerAny.logRotation?.maxRotatedFiles).toBe(customOptions.maxRotatedFiles);
    });
  });
});
