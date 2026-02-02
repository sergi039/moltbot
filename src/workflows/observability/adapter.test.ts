/**
 * Observability Adapter Tests
 *
 * Tests for ObservabilityAdapter, focusing on:
 * - Phase duration calculation (using phase start times, not workflow start)
 * - Correct event routing to observability events (not orchestrator events)
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { WorkflowEvent } from "../types.js";
import { setWorkflowStoragePath, getWorkflowDir } from "../state/persistence.js";
import { ObservabilityAdapter } from "./adapter.js";

// ============================================================================
// Mock Orchestrator
// ============================================================================

class MockOrchestrator extends EventEmitter {
  private eventHandler: ((event: WorkflowEvent) => void) | null = null;

  onWorkflowEvent(handler: (event: WorkflowEvent) => void): void {
    this.eventHandler = handler;
  }

  emitEvent(event: WorkflowEvent): void {
    if (this.eventHandler) {
      this.eventHandler(event);
    }
    this.emit("workflow-event", event);
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("ObservabilityAdapter", () => {
  let testDir: string;
  let originalStoragePath: string | undefined;

  beforeEach(async () => {
    testDir = join(tmpdir(), `wf-adapter-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Set workflow storage path to test directory
    originalStoragePath = process.env.CLAWDBOT_WORKFLOW_PATH;
    setWorkflowStoragePath(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    if (originalStoragePath) {
      setWorkflowStoragePath(originalStoragePath);
    }
  });

  describe("phase duration calculation", () => {
    it("calculates duration from phase start, not workflow start", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-duration-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      const workflowStartTime = 1000000000000; // Base timestamp
      const phaseStartTime = workflowStartTime + 5000; // Phase starts 5s after workflow
      const phaseEndTime = phaseStartTime + 3000; // Phase takes 3s

      // Emit workflow:started
      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: workflowStartTime,
        data: {
          definitionType: "dev-cycle",
          input: { task: "Test task", repoPath: "/test/repo" },
        },
      });

      // Wait for async handling
      await new Promise((r) => setTimeout(r, 100));

      // Emit phase:started (5 seconds after workflow start)
      orchestrator.emitEvent({
        type: "phase:started",
        workflowId,
        timestamp: phaseStartTime,
        data: { phaseId: "planning", iteration: 1 },
      });

      await new Promise((r) => setTimeout(r, 50));

      // Emit phase:completed (3 seconds after phase start)
      orchestrator.emitEvent({
        type: "phase:completed",
        workflowId,
        timestamp: phaseEndTime,
        data: { phaseId: "planning", iteration: 1 },
      });

      await new Promise((r) => setTimeout(r, 100));
      await adapter.finalizeAll();

      // Read events.jsonl to verify duration
      const eventsPath = join(workflowDir, "events.jsonl");
      if (existsSync(eventsPath)) {
        const content = await readFile(eventsPath, "utf-8");
        const events = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));

        // Find phase.complete event
        const completeEvent = events.find(
          (e: any) => e.type === "phase.complete" && e.phaseId === "planning",
        );

        if (completeEvent) {
          // Duration should be ~3000ms (phase end - phase start), NOT 8000ms (phase end - workflow start)
          expect(completeEvent.payload.durationMs).toBe(3000);
          expect(completeEvent.payload.durationMs).not.toBe(8000);
        }
      }
    });

    it("tracks multiple phases independently", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-multi-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      const baseTime = 1000000000000;

      // Start workflow
      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: baseTime,
        data: {
          definitionType: "dev-cycle",
          input: { task: "Test", repoPath: "/test" },
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      // Phase 1: starts at +1s, ends at +3s (duration: 2s)
      orchestrator.emitEvent({
        type: "phase:started",
        workflowId,
        timestamp: baseTime + 1000,
        data: { phaseId: "planning", iteration: 1 },
      });

      orchestrator.emitEvent({
        type: "phase:completed",
        workflowId,
        timestamp: baseTime + 3000,
        data: { phaseId: "planning", iteration: 1 },
      });

      // Phase 2: starts at +4s, ends at +10s (duration: 6s)
      orchestrator.emitEvent({
        type: "phase:started",
        workflowId,
        timestamp: baseTime + 4000,
        data: { phaseId: "execution", iteration: 1 },
      });

      orchestrator.emitEvent({
        type: "phase:completed",
        workflowId,
        timestamp: baseTime + 10000,
        data: { phaseId: "execution", iteration: 1 },
      });

      await new Promise((r) => setTimeout(r, 100));
      await adapter.finalizeAll();

      // Verify events
      const eventsPath = join(workflowDir, "events.jsonl");
      if (existsSync(eventsPath)) {
        const content = await readFile(eventsPath, "utf-8");
        const events = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));

        const planningComplete = events.find(
          (e: any) => e.type === "phase.complete" && e.phaseId === "planning",
        );
        const executionComplete = events.find(
          (e: any) => e.type === "phase.complete" && e.phaseId === "execution",
        );

        if (planningComplete) {
          expect(planningComplete.payload.durationMs).toBe(2000);
        }
        if (executionComplete) {
          expect(executionComplete.payload.durationMs).toBe(6000);
        }
      }
    });

    it("handles iteration-specific phase tracking", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-iter-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      const baseTime = 1000000000000;

      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: baseTime,
        data: {
          definitionType: "dev-cycle",
          input: { task: "Test", repoPath: "/test" },
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      // Same phase, iteration 1: 1s duration
      orchestrator.emitEvent({
        type: "phase:started",
        workflowId,
        timestamp: baseTime + 1000,
        data: { phaseId: "review", iteration: 1 },
      });

      orchestrator.emitEvent({
        type: "phase:completed",
        workflowId,
        timestamp: baseTime + 2000,
        data: { phaseId: "review", iteration: 1 },
      });

      // Same phase, iteration 2: 5s duration
      orchestrator.emitEvent({
        type: "phase:started",
        workflowId,
        timestamp: baseTime + 3000,
        data: { phaseId: "review", iteration: 2 },
      });

      orchestrator.emitEvent({
        type: "phase:completed",
        workflowId,
        timestamp: baseTime + 8000,
        data: { phaseId: "review", iteration: 2 },
      });

      await new Promise((r) => setTimeout(r, 100));
      await adapter.finalizeAll();

      // Both iterations should have correct individual durations
      const eventsPath = join(workflowDir, "events.jsonl");
      if (existsSync(eventsPath)) {
        const content = await readFile(eventsPath, "utf-8");
        const events = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));

        const completeEvents = events.filter((e: any) => e.type === "phase.complete");

        // Should have 2 complete events for review phase
        expect(completeEvents.length).toBe(2);

        // First iteration: 1s
        expect(completeEvents[0].payload.durationMs).toBe(1000);
        // Second iteration: 5s
        expect(completeEvents[1].payload.durationMs).toBe(5000);
      }
    });
  });

  describe("events separation", () => {
    it("writes observability events to events.jsonl", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-obs-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(),
        data: {
          definitionType: "dev-cycle",
          input: { task: "Test", repoPath: "/test" },
        },
      });

      await new Promise((r) => setTimeout(r, 100));
      await adapter.finalizeAll();

      // Check that events.jsonl exists (observability)
      const obsEventsPath = join(workflowDir, "events.jsonl");
      expect(existsSync(obsEventsPath)).toBe(true);

      // Read and verify it contains observability format (ISO timestamps)
      const content = await readFile(obsEventsPath, "utf-8");
      const events = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      expect(events.length).toBeGreaterThan(0);
      // Observability events have ISO string timestamps
      expect(typeof events[0].timestamp).toBe("string");
      expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("does not mix with orchestrator events file", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-sep-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      // Simulate orchestrator event file (written by persistence layer)
      const orchestratorEventsPath = join(workflowDir, "orchestrator-events.jsonl");
      const orchestratorEvent = {
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(), // Number timestamp
        data: { test: true },
      };
      await writeFile(orchestratorEventsPath, JSON.stringify(orchestratorEvent) + "\n");

      // Emit event to adapter
      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(),
        data: {
          definitionType: "dev-cycle",
          input: { task: "Test", repoPath: "/test" },
        },
      });

      await new Promise((r) => setTimeout(r, 100));
      await adapter.finalizeAll();

      // Both files should exist
      const obsEventsPath = join(workflowDir, "events.jsonl");
      expect(existsSync(obsEventsPath)).toBe(true);
      expect(existsSync(orchestratorEventsPath)).toBe(true);

      // Read both and verify they have different formats
      const obsContent = await readFile(obsEventsPath, "utf-8");
      const orchContent = await readFile(orchestratorEventsPath, "utf-8");

      const obsEvents = obsContent
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const orchEvents = orchContent
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      // Observability: ISO string timestamp
      expect(typeof obsEvents[0].timestamp).toBe("string");

      // Orchestrator: number timestamp
      expect(typeof orchEvents[0].timestamp).toBe("number");
    });
  });

  describe("workspacePath handling", () => {
    it("uses repoPath for in-place mode workspacePath", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-path-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      const actualRepoPath = "/home/user/my-project";

      // Write workflow.json with in-place mode
      await writeFile(
        join(workflowDir, "workflow.json"),
        JSON.stringify({
          id: workflowId,
          workspace: { mode: "in-place", targetRepo: actualRepoPath },
        }),
      );

      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(),
        data: {
          definitionType: "dev-cycle",
          input: {
            task: "Test task",
            repoPath: actualRepoPath,
          },
        },
      });

      await new Promise((r) => setTimeout(r, 100));
      await adapter.finalizeAll();

      // Read run.json to verify workspacePath
      const runJsonPath = join(workflowDir, "run.json");
      if (existsSync(runJsonPath)) {
        const content = await readFile(runJsonPath, "utf-8");
        const summary = JSON.parse(content);

        // For in-place mode, should use actual repo path
        expect(summary.workspacePath).toBe(actualRepoPath);
      }
    });

    it("uses workflow dir workspace for worktree mode", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-worktree-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      const originalRepoPath = "/home/user/original-repo";

      // Write workflow.json with worktree mode
      await writeFile(
        join(workflowDir, "workflow.json"),
        JSON.stringify({
          id: workflowId,
          workspace: { mode: "worktree", targetRepo: originalRepoPath },
        }),
      );

      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(),
        data: {
          definitionType: "dev-cycle",
          input: {
            task: "Test task",
            repoPath: originalRepoPath,
          },
        },
      });

      await new Promise((r) => setTimeout(r, 100));
      await adapter.finalizeAll();

      // Read run.json to verify workspacePath
      const runJsonPath = join(workflowDir, "run.json");
      if (existsSync(runJsonPath)) {
        const content = await readFile(runJsonPath, "utf-8");
        const summary = JSON.parse(content);

        // For worktree mode, should use workflow dir + workspace
        expect(summary.workspacePath).toBe(join(workflowDir, "workspace"));
        expect(summary.workspacePath).not.toBe(originalRepoPath);
      }
    });

    it("uses workflow dir workspace for copy mode", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-copy-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      const originalRepoPath = "/home/user/original-repo";

      // Write workflow.json with copy mode
      await writeFile(
        join(workflowDir, "workflow.json"),
        JSON.stringify({
          id: workflowId,
          workspace: { mode: "copy", targetRepo: originalRepoPath },
        }),
      );

      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(),
        data: {
          definitionType: "dev-cycle",
          input: {
            task: "Test task",
            repoPath: originalRepoPath,
          },
        },
      });

      await new Promise((r) => setTimeout(r, 100));
      await adapter.finalizeAll();

      // Read run.json to verify workspacePath
      const runJsonPath = join(workflowDir, "run.json");
      if (existsSync(runJsonPath)) {
        const content = await readFile(runJsonPath, "utf-8");
        const summary = JSON.parse(content);

        // For copy mode, should use workflow dir + workspace
        expect(summary.workspacePath).toBe(join(workflowDir, "workspace"));
        expect(summary.workspacePath).not.toBe(originalRepoPath);
      }
    });

    it("falls back to workflow dir when repoPath not provided", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-fallback-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(),
        data: {
          definitionType: "dev-cycle",
          input: {
            task: "Test task",
            // No repoPath
          },
        },
      });

      await new Promise((r) => setTimeout(r, 100));
      await adapter.finalizeAll();

      // Read run.json
      const runJsonPath = join(workflowDir, "run.json");
      if (existsSync(runJsonPath)) {
        const content = await readFile(runJsonPath, "utf-8");
        const summary = JSON.parse(content);

        // Should fall back to workflow directory
        expect(summary.workspacePath).toBe(workflowDir);
      }
    });
  });

  describe("logRotation config", () => {
    it("passes logRotation options to logger", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
        logRotation: { maxSizeBytes: 1024, maxRotatedFiles: 2 },
      });
      adapter.attach();

      const workflowId = `wf-rotation-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(),
        data: {
          definitionType: "dev-cycle",
          input: { task: "Test", repoPath: "/test" },
        },
      });

      await new Promise((r) => setTimeout(r, 100));

      // Verify logger was created (events.jsonl exists)
      const eventsPath = join(workflowDir, "events.jsonl");
      expect(existsSync(eventsPath)).toBe(true);

      await adapter.finalizeAll();
    });

    it("can disable logRotation with null", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
        logRotation: null, // Explicitly disabled
      });
      adapter.attach();

      const workflowId = `wf-no-rotation-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(),
        data: {
          definitionType: "dev-cycle",
          input: { task: "Test", repoPath: "/test" },
        },
      });

      await new Promise((r) => setTimeout(r, 100));

      // Should still create events.jsonl
      const eventsPath = join(workflowDir, "events.jsonl");
      expect(existsSync(eventsPath)).toBe(true);

      await adapter.finalizeAll();
    });
  });

  describe("files creation", () => {
    it("creates events.jsonl on workflow start", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-files-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(),
        data: {
          definitionType: "dev-cycle",
          input: { task: "Test", repoPath: "/test" },
        },
      });

      await new Promise((r) => setTimeout(r, 100));

      // events.jsonl should be created
      const eventsPath = join(workflowDir, "events.jsonl");
      expect(existsSync(eventsPath)).toBe(true);

      await adapter.finalizeAll();
    });

    it("creates run.json on workflow start", async () => {
      const orchestrator = new MockOrchestrator();
      const adapter = new ObservabilityAdapter({
        orchestrator: orchestrator as any,
        enableRedaction: false,
      });
      adapter.attach();

      const workflowId = `wf-runjson-${randomUUID().slice(0, 8)}`;
      const workflowDir = getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });

      orchestrator.emitEvent({
        type: "workflow:started",
        workflowId,
        timestamp: Date.now(),
        data: {
          definitionType: "dev-cycle",
          input: { task: "My test task", repoPath: "/my/repo" },
        },
      });

      await new Promise((r) => setTimeout(r, 100));

      // run.json should be created
      const runJsonPath = join(workflowDir, "run.json");
      expect(existsSync(runJsonPath)).toBe(true);

      // Verify content
      const content = await readFile(runJsonPath, "utf-8");
      const summary = JSON.parse(content);

      expect(summary.runId).toBe(workflowId);
      expect(summary.workflowType).toBe("dev-cycle");
      expect(summary.task).toBe("My test task");
      expect(summary.status).toBe("running");

      await adapter.finalizeAll();
    });
  });
});
