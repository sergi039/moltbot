/**
 * Approval Store Tests
 *
 * Tests for approval persistence with JSONL format.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalRecord, ApprovalRequest } from "./types.js";
import {
  InMemoryApprovalStore,
  FileApprovalStore,
  CompositeApprovalStore,
  createApprovalStore,
} from "./store.js";

function createTestRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: randomUUID(),
    runId: overrides.runId ?? "test-run-123",
    phaseId: overrides.phaseId ?? "plan",
    action: {
      actionType: "bash_execute",
      workspacePath: "/workspace",
      command: "npm test",
      ...overrides.action,
    },
    reason: "Test action",
    createdAt: Date.now(),
    timeoutMs: 60000,
    ...overrides,
  };
}

function createTestRecord(
  request: ApprovalRequest,
  decision: "approved" | "denied" = "approved",
): ApprovalRecord {
  return {
    request,
    decision,
    decidedAt: Date.now(),
    remember: false,
  };
}

describe("InMemoryApprovalStore", () => {
  let store: InMemoryApprovalStore;

  beforeEach(() => {
    store = new InMemoryApprovalStore();
  });

  it("saves and retrieves by ID", async () => {
    const request = createTestRequest();
    const record = createTestRecord(request);

    await store.save(record);

    const retrieved = await store.getById(request.id);
    expect(retrieved).toEqual(record);
  });

  it("retrieves all records for a run", async () => {
    const runId = "test-run-456";
    const request1 = createTestRequest({ runId });
    const request2 = createTestRequest({ runId });
    const request3 = createTestRequest({ runId: "other-run" });

    await store.save(createTestRecord(request1));
    await store.save(createTestRecord(request2));
    await store.save(createTestRecord(request3));

    const records = await store.getByRun(runId);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.request.id)).toContain(request1.id);
    expect(records.map((r) => r.request.id)).toContain(request2.id);
  });

  it("clears records for a run", async () => {
    const runId = "test-run-789";
    const request1 = createTestRequest({ runId });
    const request2 = createTestRequest({ runId: "other-run" });

    await store.save(createTestRecord(request1));
    await store.save(createTestRecord(request2));

    await store.clearRun(runId);

    const records = await store.getByRun(runId);
    expect(records).toHaveLength(0);

    const otherRecords = await store.getByRun("other-run");
    expect(otherRecords).toHaveLength(1);
  });

  describe("findMatching", () => {
    it("finds matching approval by action type and path", async () => {
      const runId = "test-run";
      const request1 = createTestRequest({
        runId,
        action: {
          actionType: "file_read",
          targetPath: "/workspace/src/index.ts",
          workspacePath: "/workspace",
        },
      });
      const record = {
        ...createTestRecord(request1),
        remember: true,
        rememberScope: "run" as const,
      };
      await store.save(record);

      const request2 = createTestRequest({
        runId,
        action: {
          actionType: "file_read",
          targetPath: "/workspace/src/index.ts",
          workspacePath: "/workspace",
        },
      });

      const match = await store.findMatching(request2);
      expect(match).toEqual(record);
    });

    it("finds matching approval by command prefix", async () => {
      const runId = "test-run";
      const request1 = createTestRequest({
        runId,
        action: {
          actionType: "bash_execute",
          command: "npm test src/",
          workspacePath: "/workspace",
        },
      });
      const record = {
        ...createTestRecord(request1),
        remember: true,
        rememberScope: "run" as const,
      };
      await store.save(record);

      const request2 = createTestRequest({
        runId,
        action: { actionType: "bash_execute", command: "npm install", workspacePath: "/workspace" },
      });

      const match = await store.findMatching(request2);
      expect(match).toEqual(record);
    });

    it("finds matching approval by URL origin", async () => {
      const runId = "test-run";
      const request1 = createTestRequest({
        runId,
        action: {
          actionType: "network_request",
          url: "https://api.example.com/v1/users",
          workspacePath: "/workspace",
        },
      });
      const record = {
        ...createTestRecord(request1),
        remember: true,
        rememberScope: "run" as const,
      };
      await store.save(record);

      const request2 = createTestRequest({
        runId,
        action: {
          actionType: "network_request",
          url: "https://api.example.com/v1/posts",
          workspacePath: "/workspace",
        },
      });

      const match = await store.findMatching(request2);
      expect(match).toEqual(record);
    });

    it("does not match without remember flag", async () => {
      const runId = "test-run";
      const request1 = createTestRequest({
        runId,
        action: {
          actionType: "file_read",
          targetPath: "/workspace/config.json",
          workspacePath: "/workspace",
        },
      });
      const record = createTestRecord(request1); // remember: false
      await store.save(record);

      const request2 = createTestRequest({
        runId,
        action: {
          actionType: "file_read",
          targetPath: "/workspace/config.json",
          workspacePath: "/workspace",
        },
      });

      const match = await store.findMatching(request2);
      expect(match).toBeNull();
    });

    it("does not match different action types", async () => {
      const runId = "test-run";
      const request1 = createTestRequest({
        runId,
        action: {
          actionType: "file_read",
          targetPath: "/workspace/config.json",
          workspacePath: "/workspace",
        },
      });
      const record = {
        ...createTestRecord(request1),
        remember: true,
        rememberScope: "run" as const,
      };
      await store.save(record);

      const request2 = createTestRequest({
        runId,
        action: {
          actionType: "file_write",
          targetPath: "/workspace/config.json",
          workspacePath: "/workspace",
        },
      });

      const match = await store.findMatching(request2);
      expect(match).toBeNull();
    });
  });
});

describe("FileApprovalStore", () => {
  const testDir = join(process.cwd(), "test-approvals-temp");
  let store: FileApprovalStore;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    store = new FileApprovalStore(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("appends records to JSONL file", async () => {
    const runId = "test-run";
    const request1 = createTestRequest({ runId });
    const request2 = createTestRequest({ runId });

    await store.save(createTestRecord(request1));
    await store.save(createTestRecord(request2));

    const filePath = join(testDir, runId, "approvals.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const record1 = JSON.parse(lines[0]);
    const record2 = JSON.parse(lines[1]);
    expect(record1.request.id).toBe(request1.id);
    expect(record2.request.id).toBe(request2.id);
  });

  it("retrieves records from file", async () => {
    const runId = "test-run";
    const request1 = createTestRequest({ runId });
    const request2 = createTestRequest({ runId });

    await store.save(createTestRecord(request1));
    await store.save(createTestRecord(request2));

    // Create a fresh store to test file loading
    const freshStore = new FileApprovalStore(testDir);
    const records = await freshStore.getByRun(runId);
    expect(records).toHaveLength(2);
  });

  it("clears run by deleting file", async () => {
    const runId = "test-run";
    const request = createTestRequest({ runId });
    await store.save(createTestRecord(request));

    const filePath = join(testDir, runId, "approvals.jsonl");
    expect(existsSync(filePath)).toBe(true);

    await store.clearRun(runId);
    expect(existsSync(filePath)).toBe(false);
  });

  it("handles missing files gracefully", async () => {
    const records = await store.getByRun("nonexistent-run");
    expect(records).toEqual([]);
  });
});

describe("CompositeApprovalStore", () => {
  const testDir = join(process.cwd(), "test-approvals-composite-temp");
  let store: CompositeApprovalStore;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    store = new CompositeApprovalStore(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("saves to both memory and file", async () => {
    const runId = "test-run";
    const request = createTestRequest({ runId });
    const record = createTestRecord(request);

    await store.save(record);

    // Memory should have it immediately
    const retrieved = await store.getById(request.id);
    expect(retrieved).toEqual(record);

    // File should also have it
    const filePath = join(testDir, runId, "approvals.jsonl");
    expect(existsSync(filePath)).toBe(true);
  });

  it("finds matching from memory first", async () => {
    const runId = "test-run";
    const request1 = createTestRequest({
      runId,
      action: { actionType: "bash_execute", command: "npm test", workspacePath: "/workspace" },
    });
    const record = { ...createTestRecord(request1), remember: true, rememberScope: "run" as const };
    await store.save(record);

    const request2 = createTestRequest({
      runId,
      action: { actionType: "bash_execute", command: "npm install", workspacePath: "/workspace" },
    });

    const match = await store.findMatching(request2);
    expect(match).toEqual(record);
  });
});

describe("createApprovalStore", () => {
  const testDir = join(process.cwd(), "test-approvals-factory-temp");

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("creates memory store", () => {
    const store = createApprovalStore({ type: "memory" });
    expect(store).toBeInstanceOf(InMemoryApprovalStore);
  });

  it("creates file store with baseDir", () => {
    mkdirSync(testDir, { recursive: true });
    const store = createApprovalStore({ type: "file", baseDir: testDir });
    expect(store).toBeInstanceOf(FileApprovalStore);
  });

  it("creates composite store with baseDir", () => {
    mkdirSync(testDir, { recursive: true });
    const store = createApprovalStore({ type: "composite", baseDir: testDir });
    expect(store).toBeInstanceOf(CompositeApprovalStore);
  });

  it("throws without baseDir for file store", () => {
    expect(() => createApprovalStore({ type: "file" })).toThrow("baseDir required");
  });

  it("throws without baseDir for composite store", () => {
    expect(() => createApprovalStore({ type: "composite" })).toThrow("baseDir required");
  });
});
