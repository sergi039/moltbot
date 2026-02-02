/**
 * Workflow Logs CLI Command Tests
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getGlobalEvents } from "../../workflows/index.js";
import { loadRunEvents } from "../../workflows/observability/logger.js";
import { setWorkflowStoragePath } from "../../workflows/state/persistence.js";
import { getWorkflowEvents } from "../../workflows/state/persistence.js";

describe("workflow logs command", () => {
  let testDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    testDir = join(tmpdir(), `logs-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    originalPath = process.env.CLAWDBOT_WORKFLOW_PATH;
    setWorkflowStoragePath(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    if (originalPath) {
      setWorkflowStoragePath(originalPath);
    }
  });

  describe("getGlobalEvents (--global)", () => {
    it("returns empty array when no events exist", async () => {
      const events = await getGlobalEvents();
      expect(events).toEqual([]);
    });

    it("reads cleanup events from orchestrator-events.jsonl", async () => {
      // Write some cleanup events to global orchestrator-events.jsonl
      const eventsPath = join(testDir, "orchestrator-events.jsonl");
      const events = [
        {
          type: "cleanup:start",
          timestamp: 1706000000000,
          data: { scheduled: false, manual: true },
        },
        {
          type: "cleanup:complete",
          timestamp: 1706000001000,
          data: { deletedCount: 3, freedBytes: 1024 },
        },
      ];

      await writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const result = await getGlobalEvents();

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("cleanup:start");
      expect(result[0].data.manual).toBe(true);
      expect(result[1].type).toBe("cleanup:complete");
      expect(result[1].data.deletedCount).toBe(3);
    });
  });

  describe("getWorkflowEvents (--orchestrator)", () => {
    it("returns empty array when workflow has no orchestrator events", async () => {
      const runId = "wf-test-123";
      const workflowDir = join(testDir, runId);
      await mkdir(workflowDir, { recursive: true });

      const events = await getWorkflowEvents(runId);
      expect(events).toEqual([]);
    });

    it("reads orchestrator events from per-workflow orchestrator-events.jsonl", async () => {
      const runId = "wf-test-456";
      const workflowDir = join(testDir, runId);
      await mkdir(workflowDir, { recursive: true });

      const events = [
        {
          type: "workflow:started",
          workflowId: runId,
          timestamp: 1706000000000,
          data: { task: "test" },
        },
        {
          type: "phase:started",
          workflowId: runId,
          timestamp: 1706000001000,
          data: { phaseId: "planning" },
        },
        {
          type: "phase:completed",
          workflowId: runId,
          timestamp: 1706000002000,
          data: { phaseId: "planning" },
        },
      ];

      const eventsPath = join(workflowDir, "orchestrator-events.jsonl");
      await writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const result = await getWorkflowEvents(runId);

      expect(result).toHaveLength(3);
      expect(result[0].type).toBe("workflow:started");
      expect(result[1].type).toBe("phase:started");
      expect(result[2].type).toBe("phase:completed");
    });
  });

  describe("loadRunEvents (default observability)", () => {
    it("returns empty array when workflow has no observability events", async () => {
      const runId = "wf-test-obs-empty";
      const workflowDir = join(testDir, runId);
      await mkdir(workflowDir, { recursive: true });

      const events = await loadRunEvents(workflowDir);
      expect(events).toEqual([]);
    });

    it("reads observability events from events.jsonl", async () => {
      const runId = "wf-test-obs";
      const workflowDir = join(testDir, runId);
      await mkdir(workflowDir, { recursive: true });

      // Observability events have different structure (WorkflowEventBase)
      const events = [
        {
          type: "workflow.start",
          runId,
          timestamp: "2024-01-23T10:00:00.000Z",
          payload: { task: "test task" },
        },
        {
          type: "phase.start",
          runId,
          phaseId: "planning",
          timestamp: "2024-01-23T10:00:01.000Z",
          payload: { phaseName: "Planning" },
        },
        {
          type: "agent.start",
          runId,
          phaseId: "planning",
          timestamp: "2024-01-23T10:00:02.000Z",
          payload: { sessionId: "sess-123" },
        },
        {
          type: "agent.complete",
          runId,
          phaseId: "planning",
          timestamp: "2024-01-23T10:00:10.000Z",
          payload: { sessionId: "sess-123", durationMs: 8000 },
        },
        {
          type: "phase.complete",
          runId,
          phaseId: "planning",
          timestamp: "2024-01-23T10:00:11.000Z",
          payload: { success: true },
        },
      ];

      const eventsPath = join(workflowDir, "events.jsonl");
      await writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const result = await loadRunEvents(workflowDir);

      expect(result).toHaveLength(5);
      expect(result[0].type).toBe("workflow.start");
      expect(result[1].type).toBe("phase.start");
      expect(result[2].type).toBe("agent.start");
      expect(result[3].type).toBe("agent.complete");
      expect(result[4].type).toBe("phase.complete");
    });

    it("supports --tail option to limit events", async () => {
      const runId = "wf-test-tail";
      const workflowDir = join(testDir, runId);
      await mkdir(workflowDir, { recursive: true });

      const events = [
        { type: "workflow.start", runId, timestamp: "2024-01-23T10:00:00.000Z", payload: {} },
        { type: "phase.start", runId, timestamp: "2024-01-23T10:00:01.000Z", payload: {} },
        { type: "phase.complete", runId, timestamp: "2024-01-23T10:00:02.000Z", payload: {} },
        { type: "workflow.complete", runId, timestamp: "2024-01-23T10:00:03.000Z", payload: {} },
      ];

      const eventsPath = join(workflowDir, "events.jsonl");
      await writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

      // Request only last 2 events
      const result = await loadRunEvents(workflowDir, { tail: 2 });

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("phase.complete");
      expect(result[1].type).toBe("workflow.complete");
    });
  });

  describe("event type distinction", () => {
    it("observability events use dot notation (workflow.start)", async () => {
      const runId = "wf-dot-notation";
      const workflowDir = join(testDir, runId);
      await mkdir(workflowDir, { recursive: true });

      const events = [
        { type: "workflow.start", runId, timestamp: "2024-01-23T10:00:00.000Z", payload: {} },
        { type: "phase.start", runId, timestamp: "2024-01-23T10:00:01.000Z", payload: {} },
        { type: "agent.start", runId, timestamp: "2024-01-23T10:00:02.000Z", payload: {} },
        { type: "policy.allow", runId, timestamp: "2024-01-23T10:00:03.000Z", payload: {} },
      ];

      const eventsPath = join(workflowDir, "events.jsonl");
      await writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const result = await loadRunEvents(workflowDir);

      // All should use dot notation
      expect(result.every((e) => e.type.includes("."))).toBe(true);
    });

    it("orchestrator events use colon notation (workflow:started)", async () => {
      const runId = "wf-colon-notation";
      const workflowDir = join(testDir, runId);
      await mkdir(workflowDir, { recursive: true });

      const events = [
        { type: "workflow:started", workflowId: runId, timestamp: 1706000000000, data: {} },
        { type: "phase:started", workflowId: runId, timestamp: 1706000001000, data: {} },
        { type: "phase:completed", workflowId: runId, timestamp: 1706000002000, data: {} },
      ];

      const eventsPath = join(workflowDir, "orchestrator-events.jsonl");
      await writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const result = await getWorkflowEvents(runId);

      // All should use colon notation
      expect(result.every((e) => e.type.includes(":"))).toBe(true);
    });

    it("global cleanup events use colon notation (cleanup:start)", async () => {
      const events = [
        { type: "cleanup:start", timestamp: 1706000000000, data: {} },
        { type: "cleanup:complete", timestamp: 1706000001000, data: {} },
      ];

      const eventsPath = join(testDir, "orchestrator-events.jsonl");
      await writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const result = await getGlobalEvents();

      // All should use colon notation
      expect(result.every((e) => e.type.includes(":"))).toBe(true);
    });
  });
});
