/**
 * Cleanup Tests
 *
 * Tests for retention policies, cleanup candidate selection, and disk management.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { WorkflowSummary } from "../state/persistence.js";
import type { RetentionConfigForCleanup, CleanupCandidate } from "./types.js";
import { WORKFLOW_STATE_FILE, WORKFLOW_ID_PREFIX } from "../constants.js";
import { setWorkflowStoragePath } from "../state/persistence.js";
import {
  findCleanupCandidates,
  runCleanup,
  getCleanupCandidates,
  getTotalDiskUsage,
  cleanupArtifacts,
  cleanupLogs,
  runPartialCleanup,
  determineCleanupModeForCandidate,
} from "./cleanup.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createWorkflowSummary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  const now = Date.now();
  return {
    id: `wf-${randomUUID().slice(0, 8)}`,
    type: "dev-cycle",
    task: "Test task",
    status: "completed",
    createdAt: now - 24 * 60 * 60 * 1000, // 1 day ago
    updatedAt: now,
    ...overrides,
  };
}

function createWorkflowWithDisk(
  workflow: WorkflowSummary,
  diskUsageBytes: number,
): { workflow: WorkflowSummary; diskUsageBytes: number } {
  return { workflow, diskUsageBytes };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

// ============================================================================
// Unit Tests: Candidate Selection
// ============================================================================

describe("findCleanupCandidates", () => {
  describe("age-based cleanup", () => {
    it("identifies workflows exceeding logRetentionDays", () => {
      const now = Date.now();
      const config: RetentionConfigForCleanup = {
        logRetentionDays: 7,
      };

      const workflows = [
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "old-wf",
            createdAt: now - 10 * DAY_MS, // 10 days old
            status: "completed",
          }),
          1 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "new-wf",
            createdAt: now - 3 * DAY_MS, // 3 days old
            status: "completed",
          }),
          1 * MB,
        ),
      ];

      const candidates = findCleanupCandidates(workflows, config);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].workflow.id).toBe("old-wf");
      expect(candidates[0].reasons).toContainEqual(
        expect.objectContaining({ reason: "age_exceeded" }),
      );
    });

    it("uses failedLogRetentionDays for failed workflows", () => {
      const now = Date.now();
      const config: RetentionConfigForCleanup = {
        logRetentionDays: 30, // Completed kept for 30 days
        failedLogRetentionDays: 7, // Failed kept for only 7 days
      };

      const workflows = [
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "failed-old",
            createdAt: now - 10 * DAY_MS,
            status: "failed",
          }),
          1 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "completed-old",
            createdAt: now - 10 * DAY_MS,
            status: "completed",
          }),
          1 * MB,
        ),
      ];

      const candidates = findCleanupCandidates(workflows, config);

      // Only failed workflow should be a candidate (10 days > 7 days for failed)
      // Completed workflow is not (10 days < 30 days)
      expect(candidates).toHaveLength(1);
      expect(candidates[0].workflow.id).toBe("failed-old");
    });

    it("does not flag running workflows for age cleanup", () => {
      const now = Date.now();
      const config: RetentionConfigForCleanup = {
        logRetentionDays: 7,
      };

      const workflows = [
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "running-old",
            createdAt: now - 30 * DAY_MS,
            status: "running",
          }),
          1 * MB,
        ),
      ];

      const candidates = findCleanupCandidates(workflows, config);
      expect(candidates).toHaveLength(0);
    });
  });

  describe("maxCompleted count limit", () => {
    it("identifies workflows exceeding maxCompleted", () => {
      const now = Date.now();
      const config: RetentionConfigForCleanup = {
        maxCompleted: 3,
      };

      const workflows = [
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "wf-1",
            createdAt: now - 5 * DAY_MS,
            status: "completed",
          }),
          1 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "wf-2",
            createdAt: now - 4 * DAY_MS,
            status: "completed",
          }),
          1 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "wf-3",
            createdAt: now - 3 * DAY_MS,
            status: "completed",
          }),
          1 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "wf-4",
            createdAt: now - 2 * DAY_MS,
            status: "completed",
          }),
          1 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "wf-5",
            createdAt: now - 1 * DAY_MS,
            status: "completed",
          }),
          1 * MB,
        ),
      ];

      const candidates = findCleanupCandidates(workflows, config);

      // Should flag 2 oldest (5 - 3 = 2)
      expect(candidates).toHaveLength(2);
      const ids = candidates.map((c) => c.workflow.id);
      expect(ids).toContain("wf-1");
      expect(ids).toContain("wf-2");
      expect(candidates[0].reasons).toContainEqual(
        expect.objectContaining({ reason: "count_limit" }),
      );
    });

    it("does not count failed/running workflows against maxCompleted", () => {
      const now = Date.now();
      const config: RetentionConfigForCleanup = {
        maxCompleted: 2,
      };

      const workflows = [
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "completed-1",
            createdAt: now - 3 * DAY_MS,
            status: "completed",
          }),
          1 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "failed-1",
            createdAt: now - 2 * DAY_MS,
            status: "failed",
          }),
          1 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "completed-2",
            createdAt: now - 1 * DAY_MS,
            status: "completed",
          }),
          1 * MB,
        ),
      ];

      const candidates = findCleanupCandidates(workflows, config);

      // Only 2 completed, maxCompleted=2, so no cleanup needed
      expect(candidates).toHaveLength(0);
    });
  });

  describe("disk limits", () => {
    it("identifies workflows exceeding maxDiskPerWorkflowMb", () => {
      const config: RetentionConfigForCleanup = {
        maxDiskPerWorkflowMb: 100,
      };

      const workflows = [
        createWorkflowWithDisk(
          createWorkflowSummary({ id: "small-wf", status: "completed" }),
          50 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({ id: "large-wf", status: "completed" }),
          150 * MB,
        ),
      ];

      const candidates = findCleanupCandidates(workflows, config);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].workflow.id).toBe("large-wf");
      expect(candidates[0].reasons).toContainEqual(
        expect.objectContaining({ reason: "disk_limit_per_workflow" }),
      );
    });

    it("identifies workflows when maxTotalDiskGb exceeded", () => {
      const config: RetentionConfigForCleanup = {
        maxTotalDiskGb: 1, // 1 GB limit
      };

      const now = Date.now();
      const workflows = [
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "wf-old",
            createdAt: now - 5 * DAY_MS,
            status: "completed",
          }),
          400 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "wf-mid",
            createdAt: now - 3 * DAY_MS,
            status: "completed",
          }),
          400 * MB,
        ),
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "wf-new",
            createdAt: now - 1 * DAY_MS,
            status: "completed",
          }),
          400 * MB,
        ),
      ];

      // Total: 1.2 GB, limit: 1 GB
      const candidates = findCleanupCandidates(workflows, config);

      // Should flag oldest to get under limit
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].workflow.id).toBe("wf-old");
      expect(candidates[0].reasons).toContainEqual(
        expect.objectContaining({ reason: "disk_limit_total" }),
      );
    });

    it("does not flag running workflows for disk cleanup", () => {
      const config: RetentionConfigForCleanup = {
        maxDiskPerWorkflowMb: 100,
      };

      const workflows = [
        createWorkflowWithDisk(
          createWorkflowSummary({ id: "running-large", status: "running" }),
          500 * MB,
        ),
      ];

      const candidates = findCleanupCandidates(workflows, config);
      expect(candidates).toHaveLength(0);
    });
  });

  describe("multiple reasons", () => {
    it("accumulates multiple cleanup reasons", () => {
      const now = Date.now();
      const config: RetentionConfigForCleanup = {
        logRetentionDays: 7,
        maxDiskPerWorkflowMb: 50,
      };

      const workflows = [
        createWorkflowWithDisk(
          createWorkflowSummary({
            id: "old-and-large",
            createdAt: now - 14 * DAY_MS,
            status: "completed",
          }),
          100 * MB,
        ),
      ];

      const candidates = findCleanupCandidates(workflows, config);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].reasons).toHaveLength(2);
      const reasonTypes = candidates[0].reasons.map((r) => r.reason);
      expect(reasonTypes).toContain("age_exceeded");
      expect(reasonTypes).toContain("disk_limit_per_workflow");
    });
  });

  describe("no config", () => {
    it("returns empty with no config set", () => {
      const workflows = [
        createWorkflowWithDisk(
          createWorkflowSummary({ id: "any-wf", status: "completed" }),
          1 * GB,
        ),
      ];

      const candidates = findCleanupCandidates(workflows, {});
      expect(candidates).toHaveLength(0);
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("cleanup integration", () => {
  let testDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    testDir = join(tmpdir(), `cleanup-test-${randomUUID()}`);
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

  async function createTestWorkflow(
    id: string,
    status: string,
    createdAt: number,
    sizeBytes: number = 1000,
  ): Promise<void> {
    // Ensure ID uses correct prefix (wf_ not wf-)
    const workflowId = id.startsWith(WORKFLOW_ID_PREFIX) ? id : `${WORKFLOW_ID_PREFIX}${id}`;
    const dir = join(testDir, workflowId);
    await mkdir(dir, { recursive: true });

    // Create state file matching WorkflowRun structure
    const state = {
      id: workflowId,
      definitionType: "dev-cycle",
      status,
      createdAt,
      updatedAt: Date.now(),
      currentPhase: "planning",
      input: {
        task: `Task for ${workflowId}`,
        repoPath: "/test/repo",
      },
      phases: [],
    };

    // Use WORKFLOW_STATE_FILE (workflow.json)
    await writeFile(join(dir, WORKFLOW_STATE_FILE), JSON.stringify(state, null, 2));

    // Create dummy files to reach target size
    const dummyContent = "x".repeat(Math.max(100, sizeBytes - 200));
    await writeFile(join(dir, "events.jsonl"), dummyContent);
  }

  describe("dry-run mode", () => {
    it("does not delete anything in dry-run mode", async () => {
      const now = Date.now();
      await createTestWorkflow("old", "completed", now - 30 * DAY_MS);
      await createTestWorkflow("new", "completed", now - 1 * DAY_MS);

      const result = await runCleanup({
        dryRun: true,
        retentionConfig: { logRetentionDays: 7 },
      });

      // Should identify candidate (30 days > 7 days)
      expect(result.summary.candidatesFound).toBeGreaterThan(0);
      // In dry-run, deletedCount shows what WOULD be deleted
      expect(result.deleted.length).toBeGreaterThan(0);

      // Verify workflow still exists (dry-run doesn't actually delete)
      const dirs = await readdir(testDir);
      expect(dirs).toContain(`${WORKFLOW_ID_PREFIX}old`);
    });

    it("reports what would be freed in dry-run", async () => {
      const now = Date.now();
      await createTestWorkflow("old", "completed", now - 30 * DAY_MS, 5000);

      const result = await runCleanup({
        dryRun: true,
        retentionConfig: { logRetentionDays: 7 },
      });

      // freedBytes is calculated even in dry-run
      expect(result.summary.freedBytes).toBeGreaterThan(0);
    });
  });

  describe("actual cleanup", () => {
    it("cleans logs from old workflows (age_exceeded triggers logs-only cleanup)", async () => {
      const now = Date.now();
      await createTestWorkflow("old1", "completed", now - 30 * DAY_MS, 3000);
      await createTestWorkflow("old2", "completed", now - 20 * DAY_MS, 2000);
      await createTestWorkflow("new", "completed", now - 1 * DAY_MS, 1000);

      const result = await runCleanup({
        dryRun: false,
        retentionConfig: { logRetentionDays: 7 },
      });

      // Should have processed old workflows (20 and 30 days > 7 days)
      expect(result.summary.deletedCount).toBe(2);
      expect(result.summary.freedBytes).toBeGreaterThan(0);

      // With per-candidate strategy, age_exceeded triggers logs-only cleanup
      // Workflow directories should still exist (state preserved)
      const dirs = await readdir(testDir);
      expect(dirs).toContain(`${WORKFLOW_ID_PREFIX}old1`);
      expect(dirs).toContain(`${WORKFLOW_ID_PREFIX}old2`);
      expect(dirs).toContain(`${WORKFLOW_ID_PREFIX}new`);

      // Verify logs were removed from old workflows
      const old1Entries = await readdir(join(testDir, `${WORKFLOW_ID_PREFIX}old1`));
      expect(old1Entries).not.toContain("events.jsonl");
      expect(old1Entries).toContain(WORKFLOW_STATE_FILE);

      // Verify cleanup mode was "logs"
      expect(result.deleted[0]?.cleanupMode).toBe("logs");
      expect(result.deleted[1]?.cleanupMode).toBe("logs");
    });

    it("skips running workflows", async () => {
      const now = Date.now();
      await createTestWorkflow("running", "running", now - 30 * DAY_MS);
      await createTestWorkflow("paused", "paused", now - 30 * DAY_MS);

      const result = await runCleanup({
        dryRun: false,
        retentionConfig: { logRetentionDays: 7 },
      });

      // Running/paused workflows are filtered out from candidates
      // They are not counted as skipped - they're simply not candidates
      expect(result.summary.deletedCount).toBe(0);
      expect(result.summary.candidatesFound).toBe(0);

      // Workflows still exist
      const dirs = await readdir(testDir);
      expect(dirs).toContain(`${WORKFLOW_ID_PREFIX}running`);
      expect(dirs).toContain(`${WORKFLOW_ID_PREFIX}paused`);
    });

    it("records deletion by reason", async () => {
      const now = Date.now();
      await createTestWorkflow("old", "completed", now - 30 * DAY_MS);

      const result = await runCleanup({
        dryRun: false,
        retentionConfig: { logRetentionDays: 7 },
      });

      expect(result.summary.byReason.age_exceeded).toBe(1);
    });
  });

  describe("disk usage calculation", () => {
    it("calculates total disk usage", async () => {
      await createTestWorkflow("1", "completed", Date.now(), 5000);
      await createTestWorkflow("2", "completed", Date.now(), 3000);

      const result = await getTotalDiskUsage();

      // Should be at least 8000 bytes (returns object with totalBytes)
      expect(result.totalBytes).toBeGreaterThanOrEqual(8000);
      expect(result.byWorkflow).toHaveLength(2);
    });

    it("returns candidates with disk usage", async () => {
      const now = Date.now();
      await createTestWorkflow("old", "completed", now - 30 * DAY_MS, 5000);

      const candidates = await getCleanupCandidates({
        retentionConfig: { logRetentionDays: 7 },
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].diskUsageBytes).toBeGreaterThan(0);
    });
  });

  describe("maxCompleted enforcement", () => {
    it("deletes oldest when maxCompleted exceeded", async () => {
      const now = Date.now();
      // Create 5 completed workflows
      for (let i = 1; i <= 5; i++) {
        await createTestWorkflow(`${i}`, "completed", now - i * DAY_MS);
      }

      const result = await runCleanup({
        dryRun: false,
        retentionConfig: { maxCompleted: 3 },
      });

      // Should delete 2 oldest (5 - 3)
      expect(result.summary.deletedCount).toBe(2);
      expect(result.summary.byReason.count_limit).toBe(2);

      const dirs = await readdir(testDir);
      // wf_4 and wf_5 are oldest (4 and 5 days ago)
      expect(dirs).not.toContain(`${WORKFLOW_ID_PREFIX}4`);
      expect(dirs).not.toContain(`${WORKFLOW_ID_PREFIX}5`);
      // Newer ones remain
      expect(dirs).toContain(`${WORKFLOW_ID_PREFIX}1`);
      expect(dirs).toContain(`${WORKFLOW_ID_PREFIX}2`);
      expect(dirs).toContain(`${WORKFLOW_ID_PREFIX}3`);
    });
  });

  describe("preview respects maxToDelete", () => {
    it("getCleanupCandidates respects maxToDelete limit", async () => {
      const now = Date.now();
      // Create 5 old workflows
      for (let i = 1; i <= 5; i++) {
        await createTestWorkflow(`old${i}`, "completed", now - 30 * DAY_MS);
      }

      // Get candidates with maxToDelete=3
      const candidates = await getCleanupCandidates({
        retentionConfig: { logRetentionDays: 7 },
        maxToDelete: 3,
      });

      // Should only return 3 even though 5 are eligible
      expect(candidates).toHaveLength(3);
    });

    it("dry-run and actual cleanup show same count with maxToDelete", async () => {
      const now = Date.now();
      // Create 5 old workflows
      for (let i = 1; i <= 5; i++) {
        await createTestWorkflow(`dryrun${i}`, "completed", now - 30 * DAY_MS);
      }

      // Dry-run with maxToDelete=2
      const dryRunResult = await runCleanup({
        dryRun: true,
        retentionConfig: { logRetentionDays: 7 },
        maxToDelete: 2,
      });

      // Reset - recreate workflows for actual run
      await rm(testDir, { recursive: true, force: true });
      await mkdir(testDir, { recursive: true });
      setWorkflowStoragePath(testDir);

      for (let i = 1; i <= 5; i++) {
        await createTestWorkflow(`actual${i}`, "completed", now - 30 * DAY_MS);
      }

      // Actual cleanup with same maxToDelete
      const actualResult = await runCleanup({
        dryRun: false,
        retentionConfig: { logRetentionDays: 7 },
        maxToDelete: 2,
      });

      // Both should report same deletion count
      expect(dryRunResult.summary.deletedCount).toBe(2);
      expect(actualResult.summary.deletedCount).toBe(2);
    });
  });

  describe("retention config integration", () => {
    it("uses custom retention config for candidate selection", async () => {
      const now = Date.now();
      // Create workflows at different ages
      await createTestWorkflow("recent", "completed", now - 5 * DAY_MS); // 5 days
      await createTestWorkflow("old", "completed", now - 15 * DAY_MS); // 15 days

      // With 7-day retention, only "old" should be a candidate
      const candidates7Days = await getCleanupCandidates({
        retentionConfig: { logRetentionDays: 7 },
      });
      expect(candidates7Days).toHaveLength(1);
      expect(candidates7Days[0].workflow.id).toContain("old");

      // With 30-day retention, neither should be a candidate
      const candidates30Days = await getCleanupCandidates({
        retentionConfig: { logRetentionDays: 30 },
      });
      expect(candidates30Days).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Phase 5: Partial Cleanup Tests
  // ==========================================================================

  describe("partial cleanup - artifacts only", () => {
    async function createWorkflowWithArtifacts(
      id: string,
      status: string,
      createdAt: number,
    ): Promise<string> {
      const workflowId = id.startsWith(WORKFLOW_ID_PREFIX) ? id : `${WORKFLOW_ID_PREFIX}${id}`;
      const dir = join(testDir, workflowId);
      const artifactsDir = join(dir, "artifacts");
      const phasesDir = join(dir, "phases");

      await mkdir(dir, { recursive: true });
      await mkdir(artifactsDir, { recursive: true });
      await mkdir(phasesDir, { recursive: true });

      // Create state file
      const state = {
        id: workflowId,
        definitionType: "dev-cycle",
        status,
        createdAt,
        updatedAt: Date.now(),
        currentPhase: "planning",
        input: { task: `Task for ${workflowId}`, repoPath: "/test/repo" },
        phases: [],
      };
      await writeFile(join(dir, WORKFLOW_STATE_FILE), JSON.stringify(state, null, 2));

      // Create artifacts
      await writeFile(join(artifactsDir, "plan.md"), "# Plan\nSome content");
      await writeFile(join(artifactsDir, "tasks.json"), JSON.stringify({ tasks: [] }));

      // Create phase data
      const phase1Dir = join(phasesDir, "1-planning");
      await mkdir(phase1Dir, { recursive: true });
      await writeFile(join(phase1Dir, "session.jsonl"), '{"type":"start"}\n');

      // Create events log
      await writeFile(join(dir, "events.jsonl"), '{"type":"workflow.start"}\n');

      return workflowId;
    }

    it("deletes only artifacts directory, keeps state and logs", async () => {
      const workflowId = await createWorkflowWithArtifacts(
        "partial-test",
        "completed",
        Date.now() - 7 * DAY_MS,
      );

      const result = await cleanupArtifacts(workflowId);

      expect(result.success).toBe(true);
      expect(result.mode).toBe("artifacts");
      expect(result.freedBytes).toBeGreaterThan(0);
      expect(result.deletedPaths.length).toBeGreaterThan(0);

      // Verify artifacts directory is gone
      const dir = join(testDir, workflowId);
      const entries = await readdir(dir);
      expect(entries).not.toContain("artifacts");
      expect(entries).not.toContain("phases");

      // State and logs should remain
      expect(entries).toContain(WORKFLOW_STATE_FILE);
      expect(entries).toContain("events.jsonl");
    });

    it("returns success with 0 bytes if no artifacts exist", async () => {
      const now = Date.now();
      await createTestWorkflow("no-artifacts", "completed", now - 1 * DAY_MS);

      const result = await cleanupArtifacts(`${WORKFLOW_ID_PREFIX}no-artifacts`);

      expect(result.success).toBe(true);
      expect(result.freedBytes).toBe(0);
      expect(result.deletedPaths).toHaveLength(0);
    });
  });

  describe("partial cleanup - logs only", () => {
    async function createWorkflowWithLogs(
      id: string,
      status: string,
      createdAt: number,
    ): Promise<string> {
      const workflowId = id.startsWith(WORKFLOW_ID_PREFIX) ? id : `${WORKFLOW_ID_PREFIX}${id}`;
      const dir = join(testDir, workflowId);
      const artifactsDir = join(dir, "artifacts");

      await mkdir(dir, { recursive: true });
      await mkdir(artifactsDir, { recursive: true });

      // Create state file
      const state = {
        id: workflowId,
        definitionType: "dev-cycle",
        status,
        createdAt,
        updatedAt: Date.now(),
        currentPhase: "planning",
        input: { task: `Task for ${workflowId}`, repoPath: "/test/repo" },
        phases: [],
      };
      await writeFile(join(dir, WORKFLOW_STATE_FILE), JSON.stringify(state, null, 2));

      // Create artifacts
      await writeFile(join(artifactsDir, "plan.md"), "# Plan\nSome content");

      // Create logs
      await writeFile(
        join(dir, "events.jsonl"),
        '{"type":"workflow.start"}\n{"type":"phase.start"}\n',
      );
      await writeFile(join(dir, "events.jsonl.1"), '{"type":"old.event"}\n');
      await writeFile(join(dir, "run.json"), JSON.stringify({ runId: workflowId }));

      return workflowId;
    }

    it("deletes only log files, keeps state and artifacts", async () => {
      const workflowId = await createWorkflowWithLogs(
        "logs-test",
        "completed",
        Date.now() - 7 * DAY_MS,
      );

      const result = await cleanupLogs(workflowId);

      expect(result.success).toBe(true);
      expect(result.mode).toBe("logs");
      expect(result.freedBytes).toBeGreaterThan(0);

      // Verify log files are gone (events.jsonl and rotations)
      const dir = join(testDir, workflowId);
      const entries = await readdir(dir);
      expect(entries).not.toContain("events.jsonl");
      expect(entries).not.toContain("events.jsonl.1");

      // State, summary (run.json) and artifacts should remain
      // Note: run.json is a summary file, not a log file
      expect(entries).toContain(WORKFLOW_STATE_FILE);
      expect(entries).toContain("artifacts");
      expect(entries).toContain("run.json"); // Summary is preserved
    });
  });

  describe("runPartialCleanup batch operation", () => {
    it("processes multiple workflows", async () => {
      const now = Date.now();

      // Create multiple workflows with artifacts
      const ids: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const workflowId = `${WORKFLOW_ID_PREFIX}batch${i}`;
        const dir = join(testDir, workflowId);
        const artifactsDir = join(dir, "artifacts");
        await mkdir(artifactsDir, { recursive: true });

        const state = {
          id: workflowId,
          definitionType: "dev-cycle",
          status: "completed",
          createdAt: now - i * DAY_MS,
          updatedAt: now,
          currentPhase: "done",
          input: { task: `Task ${i}`, repoPath: "/test/repo" },
          phases: [],
        };
        await writeFile(join(dir, WORKFLOW_STATE_FILE), JSON.stringify(state, null, 2));
        await writeFile(join(artifactsDir, "data.txt"), `Data for workflow ${i}`);
        ids.push(workflowId);
      }

      const results = await runPartialCleanup(ids, "artifacts");

      expect(results).toHaveLength(3);
      expect(results.filter((r) => r.success)).toHaveLength(3);

      // Verify all artifacts are removed but state remains
      for (const id of ids) {
        const dir = join(testDir, id);
        const entries = await readdir(dir);
        expect(entries).not.toContain("artifacts");
        expect(entries).toContain(WORKFLOW_STATE_FILE);
      }
    });

    it("continues on individual failures", async () => {
      const now = Date.now();

      // Create one valid workflow
      const validId = `${WORKFLOW_ID_PREFIX}valid`;
      const validDir = join(testDir, validId);
      const validArtifactsDir = join(validDir, "artifacts");
      await mkdir(validArtifactsDir, { recursive: true });
      await writeFile(
        join(validDir, WORKFLOW_STATE_FILE),
        JSON.stringify({
          id: validId,
          definitionType: "dev-cycle",
          status: "completed",
          createdAt: now,
          updatedAt: now,
          currentPhase: "done",
          input: { task: "Valid", repoPath: "/test" },
          phases: [],
        }),
      );
      await writeFile(join(validArtifactsDir, "file.txt"), "content");

      // Run with one valid and one non-existent workflow
      const results = await runPartialCleanup([validId, "nonexistent-wf"], "artifacts");

      expect(results).toHaveLength(2);
      expect(results.find((r) => r.workflowId === validId)?.success).toBe(true);
      expect(results.find((r) => r.workflowId === "nonexistent-wf")?.success).toBe(false);
    });
  });
});

// ============================================================================
// Phase 7: Per-Candidate Cleanup Mode Strategy Tests
// ============================================================================

describe("determineCleanupModeForCandidate", () => {
  const mockWorkflow: WorkflowSummary = {
    id: "wf_test",
    type: "dev-cycle",
    task: "Test task",
    status: "completed",
    createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now(),
  };

  it("returns 'artifacts' for artifact_age_exceeded only", () => {
    const candidate: CleanupCandidate = {
      workflow: mockWorkflow,
      reasons: [
        {
          reason: "artifact_age_exceeded",
          description: "Artifacts are 10 days old",
          context: { ageInDays: 10, limit: 7 },
        },
      ],
      diskUsageBytes: 1000,
    };

    expect(determineCleanupModeForCandidate(candidate)).toBe("artifacts");
  });

  it("returns 'logs' for age_exceeded only", () => {
    const candidate: CleanupCandidate = {
      workflow: mockWorkflow,
      reasons: [
        {
          reason: "age_exceeded",
          description: "Workflow is 30 days old",
          context: { ageInDays: 30, limit: 14 },
        },
      ],
      diskUsageBytes: 1000,
    };

    expect(determineCleanupModeForCandidate(candidate)).toBe("logs");
  });

  it("returns 'full' for count_limit", () => {
    const candidate: CleanupCandidate = {
      workflow: mockWorkflow,
      reasons: [
        {
          reason: "count_limit",
          description: "Exceeds max completed limit",
          context: { limit: 10 },
        },
      ],
      diskUsageBytes: 1000,
    };

    expect(determineCleanupModeForCandidate(candidate)).toBe("full");
  });

  it("returns 'full' for disk_limit_per_workflow", () => {
    const candidate: CleanupCandidate = {
      workflow: mockWorkflow,
      reasons: [
        {
          reason: "disk_limit_per_workflow",
          description: "Disk usage exceeds limit",
          context: { diskUsageMb: 500, limit: 100 },
        },
      ],
      diskUsageBytes: 500 * 1024 * 1024,
    };

    expect(determineCleanupModeForCandidate(candidate)).toBe("full");
  });

  it("returns 'full' for disk_limit_total", () => {
    const candidate: CleanupCandidate = {
      workflow: mockWorkflow,
      reasons: [
        {
          reason: "disk_limit_total",
          description: "Total disk exceeds limit",
          context: { diskUsageMb: 200, limit: "5GB" },
        },
      ],
      diskUsageBytes: 200 * 1024 * 1024,
    };

    expect(determineCleanupModeForCandidate(candidate)).toBe("full");
  });

  it("returns 'full' when multiple reasons present", () => {
    const candidate: CleanupCandidate = {
      workflow: mockWorkflow,
      reasons: [
        {
          reason: "age_exceeded",
          description: "Workflow is 30 days old",
          context: { ageInDays: 30, limit: 14 },
        },
        {
          reason: "artifact_age_exceeded",
          description: "Artifacts are 30 days old",
          context: { ageInDays: 30, limit: 7 },
        },
      ],
      diskUsageBytes: 1000,
    };

    expect(determineCleanupModeForCandidate(candidate)).toBe("full");
  });

  it("returns 'full' when hard reason combined with soft reason", () => {
    const candidate: CleanupCandidate = {
      workflow: mockWorkflow,
      reasons: [
        {
          reason: "age_exceeded",
          description: "Workflow is old",
          context: { ageInDays: 30, limit: 14 },
        },
        {
          reason: "count_limit",
          description: "Exceeds max completed",
          context: { limit: 10 },
        },
      ],
      diskUsageBytes: 1000,
    };

    expect(determineCleanupModeForCandidate(candidate)).toBe("full");
  });
});

describe("runCleanup per-candidate strategy integration", () => {
  let testDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    testDir = join(tmpdir(), `cleanup-strategy-test-${randomUUID()}`);
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

  async function createWorkflowWithArtifactsAndLogs(
    id: string,
    status: string,
    createdAt: number,
  ): Promise<string> {
    const workflowId = id.startsWith(WORKFLOW_ID_PREFIX) ? id : `${WORKFLOW_ID_PREFIX}${id}`;
    const dir = join(testDir, workflowId);
    const artifactsDir = join(dir, "artifacts");

    await mkdir(artifactsDir, { recursive: true });

    const state = {
      id: workflowId,
      definitionType: "dev-cycle",
      status,
      createdAt,
      updatedAt: Date.now(),
      currentPhase: "planning",
      input: { task: `Task for ${workflowId}`, repoPath: "/test/repo" },
      phases: [],
    };

    await writeFile(join(dir, WORKFLOW_STATE_FILE), JSON.stringify(state, null, 2));
    await writeFile(join(artifactsDir, "plan.md"), "# Plan\nContent here");
    await writeFile(join(dir, "events.jsonl"), '{"type":"workflow.start"}\n');
    await writeFile(join(dir, "run.json"), JSON.stringify({ runId: workflowId }));

    return workflowId;
  }

  it("uses artifacts-only cleanup for artifact_age_exceeded reason", async () => {
    const now = Date.now();
    // Create workflow that exceeds artifact retention (7 days default) but not log retention (14 days)
    const workflowId = await createWorkflowWithArtifactsAndLogs(
      "artifact-only",
      "completed",
      now - 10 * DAY_MS, // 10 days old
    );

    // Run cleanup with artifact retention of 7 days and log retention of 30 days
    const result = await runCleanup({
      retentionConfig: {
        artifactRetentionDays: 7,
        logRetentionDays: 30,
        failedLogRetentionDays: 30,
      },
      dryRun: false,
    });

    // Should clean artifacts only
    expect(result.summary.deletedCount).toBe(1);
    expect(result.deleted[0]?.cleanupMode).toBe("artifacts");

    // Workflow should still exist with state and logs, but no artifacts
    const dir = join(testDir, workflowId);
    const entries = await readdir(dir);
    expect(entries).toContain(WORKFLOW_STATE_FILE);
    expect(entries).toContain("events.jsonl");
    expect(entries).toContain("run.json");
    expect(entries).not.toContain("artifacts");
  });

  it("uses logs-only cleanup for age_exceeded reason", async () => {
    const now = Date.now();
    // Create workflow that exceeds log retention (14 days)
    const workflowId = await createWorkflowWithArtifactsAndLogs(
      "logs-only",
      "completed",
      now - 20 * DAY_MS, // 20 days old
    );

    // Run cleanup with log retention of 14 days
    // artifactRetentionDays set high so only age_exceeded triggers
    const result = await runCleanup({
      retentionConfig: {
        artifactRetentionDays: 90,
        logRetentionDays: 14,
        failedLogRetentionDays: 14,
      },
      dryRun: false,
    });

    // Should clean logs only
    expect(result.summary.deletedCount).toBe(1);
    expect(result.deleted[0]?.cleanupMode).toBe("logs");

    // Workflow should still exist with state and artifacts, but no logs
    const dir = join(testDir, workflowId);
    const entries = await readdir(dir);
    expect(entries).toContain(WORKFLOW_STATE_FILE);
    expect(entries).toContain("artifacts");
    expect(entries).toContain("run.json");
    expect(entries).not.toContain("events.jsonl");
  });

  it("uses full cleanup for count_limit reason", async () => {
    const now = Date.now();
    // Create 5 workflows, with maxCompleted of 3
    for (let i = 1; i <= 5; i++) {
      await createWorkflowWithArtifactsAndLogs(`count${i}`, "completed", now - i * DAY_MS);
    }

    // Run cleanup with maxCompleted of 3 (should delete 2 oldest)
    const result = await runCleanup({
      retentionConfig: {
        maxCompleted: 3,
        // Set age limits high so only count triggers
        logRetentionDays: 90,
        artifactRetentionDays: 90,
        failedLogRetentionDays: 90,
      },
      dryRun: false,
    });

    // Should fully delete 2 workflows
    expect(result.summary.deletedCount).toBe(2);
    expect(result.deleted.every((d) => d.cleanupMode === "full")).toBe(true);

    // Deleted workflows should be completely gone
    const dirs = await readdir(testDir);
    expect(dirs).not.toContain(`${WORKFLOW_ID_PREFIX}count4`);
    expect(dirs).not.toContain(`${WORKFLOW_ID_PREFIX}count5`);
    // Newer ones should remain
    expect(dirs).toContain(`${WORKFLOW_ID_PREFIX}count1`);
  });
});
