/**
 * Policy Engine Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, rm, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { PathGuard, createPolicyEngine } from "./engine.js";
import {
  DEFAULT_WORKFLOW_POLICY,
  STRICT_POLICY,
  PERMISSIVE_POLICY,
  getPolicyPreset,
  mergePolicy,
} from "./defaults.js";
import { InMemoryApprovalStore, FileApprovalStore, createApprovalStore } from "./store.js";
import {
  AutoApprovePrompt,
  CliApprovalPrompt,
  createApprovalPrompt,
  createApprovalRequest,
} from "./prompt.js";
import type { PolicyContext } from "./types.js";

// ============================================================================
// PathGuard Tests
// ============================================================================

describe("PathGuard", () => {
  const workspacePath = "/home/user/project";
  const tempPath = "/tmp";

  describe("workspaceOnly scope", () => {
    const guard = new PathGuard(workspacePath, { type: "workspaceOnly" });

    it("allows paths within workspace", () => {
      const result = guard.isAllowed("/home/user/project/src/file.ts");
      expect(result.allowed).toBe(true);
    });

    it("denies paths outside workspace", () => {
      const result = guard.isAllowed("/home/user/other/file.ts");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("outside workspace");
    });

    it("denies temp paths", () => {
      const result = guard.isAllowed("/tmp/file.ts");
      expect(result.allowed).toBe(false);
    });
  });

  describe("workspaceAndTemp scope", () => {
    const guard = new PathGuard(workspacePath, { type: "workspaceAndTemp" }, tempPath);

    it("allows workspace paths", () => {
      const result = guard.isAllowed("/home/user/project/src/file.ts");
      expect(result.allowed).toBe(true);
    });

    it("allows temp paths", () => {
      const result = guard.isAllowed("/tmp/scratch.txt");
      expect(result.allowed).toBe(true);
    });

    it("denies other paths", () => {
      const result = guard.isAllowed("/etc/passwd");
      expect(result.allowed).toBe(false);
    });
  });

  describe("denied paths", () => {
    const guard = new PathGuard(workspacePath, {
      type: "workspaceAndTemp",
      deniedPaths: ["~/.ssh", "/etc"],
    });

    it("blocks explicitly denied paths", () => {
      const result = guard.isAllowed("/etc/passwd");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("denied list");
    });
  });

  describe("getRelativePath", () => {
    const guard = new PathGuard(workspacePath, { type: "workspaceOnly" });

    it("returns relative path for workspace files", () => {
      const rel = guard.getRelativePath("/home/user/project/src/index.ts");
      expect(rel).toBe("src/index.ts");
    });

    it("returns absolute path for non-workspace files", () => {
      const rel = guard.getRelativePath("/etc/passwd");
      expect(rel).toBe("/etc/passwd");
    });
  });

  describe("symlink escape detection", () => {
    const guard = new PathGuard("/home/user/project", {
      type: "workspaceOnly",
      blockSymlinkEscape: true,
    });

    it("allows paths that don't exist yet (new files)", () => {
      // Non-existent paths should be allowed (creating new file)
      const result = guard.isAllowed("/home/user/project/new-file.ts");
      expect(result.allowed).toBe(true);
    });

    it("respects blockSymlinkEscape=false option", () => {
      const noSymlinkGuard = new PathGuard("/home/user/project", {
        type: "workspaceOnly",
        blockSymlinkEscape: false,
      });
      // With symlink check disabled, should just pass scope check
      const result = noSymlinkGuard.isAllowed("/home/user/project/file.ts");
      expect(result.allowed).toBe(true);
    });
  });
});

// ============================================================================
// NetworkGuard Tests
// ============================================================================

import { NetworkGuard } from "./engine.js";
import { DEFAULT_NETWORK_SCOPE } from "./defaults.js";

describe("NetworkGuard", () => {
  describe("default deny behavior", () => {
    const guard = new NetworkGuard({
      defaultBehavior: "deny",
      allowedDomains: [],
    });

    it("denies all requests by default", () => {
      const result = guard.isAllowed("https://example.com/api");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in allowlist");
    });

    it("denies invalid URLs", () => {
      const result = guard.isAllowed("not-a-url");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid URL");
    });
  });

  describe("domain allowlist", () => {
    const guard = new NetworkGuard({
      defaultBehavior: "deny",
      allowedDomains: ["api.github.com", "*.example.com"],
    });

    it("allows exact domain match", () => {
      const result = guard.isAllowed("https://api.github.com/repos/test");
      expect(result.allowed).toBe(true);
    });

    it("allows wildcard subdomain match", () => {
      const result = guard.isAllowed("https://sub.example.com/path");
      expect(result.allowed).toBe(true);
    });

    it("allows base domain with wildcard", () => {
      const result = guard.isAllowed("https://example.com/path");
      expect(result.allowed).toBe(true);
    });

    it("denies non-matching domain", () => {
      const result = guard.isAllowed("https://other.com/api");
      expect(result.allowed).toBe(false);
    });

    it("is case-insensitive for domain matching", () => {
      const result = guard.isAllowed("https://API.GITHUB.COM/test");
      expect(result.allowed).toBe(true);
    });
  });

  describe("URL pattern allowlist", () => {
    const guard = new NetworkGuard({
      defaultBehavior: "deny",
      allowedDomains: [],
      allowedUrls: ["https://api.example.com/v1/**"],
    });

    it("allows matching URL pattern", () => {
      const result = guard.isAllowed("https://api.example.com/v1/users");
      expect(result.allowed).toBe(true);
    });

    it("denies non-matching URL pattern", () => {
      const result = guard.isAllowed("https://api.example.com/v2/users");
      expect(result.allowed).toBe(false);
    });
  });

  describe("denied domains", () => {
    const guard = new NetworkGuard({
      defaultBehavior: "allow",
      allowedDomains: ["*.example.com"],
      deniedDomains: ["blocked.example.com"],
    });

    it("blocks denied domain even with allow behavior", () => {
      const result = guard.isAllowed("https://blocked.example.com/api");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("denied list");
    });

    it("allows non-denied subdomain", () => {
      const result = guard.isAllowed("https://allowed.example.com/api");
      expect(result.allowed).toBe(true);
    });
  });

  describe("default allow behavior", () => {
    const guard = new NetworkGuard({
      defaultBehavior: "allow",
      deniedDomains: ["blocked.com"],
    });

    it("allows unlisted domains", () => {
      const result = guard.isAllowed("https://any-domain.com/api");
      expect(result.allowed).toBe(true);
    });

    it("still blocks denied domains", () => {
      const result = guard.isAllowed("https://blocked.com/api");
      expect(result.allowed).toBe(false);
    });
  });

  describe("DEFAULT_NETWORK_SCOPE", () => {
    const guard = new NetworkGuard(DEFAULT_NETWORK_SCOPE);

    it("allows github.com", () => {
      const result = guard.isAllowed("https://github.com/user/repo");
      expect(result.allowed).toBe(true);
    });

    it("allows api.github.com", () => {
      const result = guard.isAllowed("https://api.github.com/repos");
      expect(result.allowed).toBe(true);
    });

    it("allows npmjs.org", () => {
      const result = guard.isAllowed("https://registry.npmjs.org/package");
      expect(result.allowed).toBe(true);
    });

    it("allows api.anthropic.com", () => {
      const result = guard.isAllowed("https://api.anthropic.com/v1/messages");
      expect(result.allowed).toBe(true);
    });

    it("denies unknown domains", () => {
      const result = guard.isAllowed("https://malicious-site.com/payload");
      expect(result.allowed).toBe(false);
    });
  });
});

// ============================================================================
// PolicyEngine Tests
// ============================================================================

describe("PolicyEngine", () => {
  const workspacePath = "/home/user/project";

  describe("evaluate", () => {
    it("allows file reads in workspace by default", async () => {
      const engine = createPolicyEngine({ workspacePath });

      const context: PolicyContext = {
        actionType: "file_read",
        targetPath: "/home/user/project/src/index.ts",
        workspacePath,
        runId: "test-run",
        phaseId: "test-phase",
      };

      const result = await engine.evaluate(context);
      expect(result.decision).toBe("allow");
    });

    it("denies sensitive files", async () => {
      const engine = createPolicyEngine({ workspacePath });

      const context: PolicyContext = {
        actionType: "file_read",
        targetPath: "/home/user/project/.env",
        workspacePath,
        runId: "test-run",
        phaseId: "test-phase",
      };

      const result = await engine.evaluate(context);
      expect(result.decision).toBe("deny");
      expect(result.matchedRule?.id).toBe("block-sensitive-files");
    });

    it("denies dangerous bash commands", async () => {
      const engine = createPolicyEngine({ workspacePath });

      const context: PolicyContext = {
        actionType: "bash_execute",
        command: "rm -rf /",
        workspacePath,
        runId: "test-run",
        phaseId: "test-phase",
      };

      const result = await engine.evaluate(context);
      expect(result.decision).toBe("deny");
    });

    it("allows safe bash commands", async () => {
      const engine = createPolicyEngine({ workspacePath });

      const context: PolicyContext = {
        actionType: "bash_execute",
        command: "git status",
        workspacePath,
        runId: "test-run",
        phaseId: "test-phase",
      };

      const result = await engine.evaluate(context);
      expect(result.decision).toBe("allow");
    });

    it("denies network requests to unknown domains (network guard)", async () => {
      const engine = createPolicyEngine({ workspacePath });

      const context: PolicyContext = {
        actionType: "network_request",
        url: "https://example.com/api",
        workspacePath,
        runId: "test-run",
        phaseId: "test-phase",
      };

      // With network guard, unknown domains are denied before rules
      const result = await engine.evaluate(context);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("not in allowlist");
    });

    it("allows trusted domains", async () => {
      const engine = createPolicyEngine({ workspacePath });

      const context: PolicyContext = {
        actionType: "network_request",
        url: "https://api.github.com/repos/test",
        workspacePath,
        runId: "test-run",
        phaseId: "test-phase",
      };

      const result = await engine.evaluate(context);
      expect(result.decision).toBe("allow");
    });

    it("denies paths outside scope", async () => {
      const engine = createPolicyEngine({ workspacePath });

      // Use a path that's outside scope but not in denied list
      const context: PolicyContext = {
        actionType: "file_write",
        targetPath: "/var/data/file.txt",
        workspacePath,
        runId: "test-run",
        phaseId: "test-phase",
      };

      const result = await engine.evaluate(context);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("outside");
    });
  });

  describe("requestApproval", () => {
    it("auto-denies when no prompt handler", async () => {
      const engine = createPolicyEngine({ workspacePath });

      const request = createApprovalRequest(
        {
          actionType: "agent_spawn",
          workspacePath,
          runId: "test-run",
          phaseId: "test-phase",
        },
        "Test reason",
        { runId: "test-run", phaseId: "test-phase" },
      );

      const record = await engine.requestApproval(request);
      expect(record.decision).toBe("denied");
      expect(record.comment).toContain("No approval prompt handler");
    });

    it("uses prompt handler when provided", async () => {
      const prompt = new AutoApprovePrompt({ decision: "approved" });
      const engine = createPolicyEngine({
        workspacePath,
        approvalPrompt: prompt,
      });

      const request = createApprovalRequest(
        {
          actionType: "agent_spawn",
          workspacePath,
          runId: "test-run",
          phaseId: "test-phase",
        },
        "Test reason",
        { runId: "test-run", phaseId: "test-phase" },
      );

      const record = await engine.requestApproval(request);
      expect(record.decision).toBe("approved");
    });

    it("caches remembered approvals", async () => {
      const prompt = new AutoApprovePrompt({ decision: "approved" });
      const engine = createPolicyEngine({
        workspacePath,
        approvalPrompt: prompt,
      });

      const context: PolicyContext = {
        actionType: "file_write",
        targetPath: "/home/user/project/test.ts",
        workspacePath,
        runId: "test-run",
        phaseId: "test-phase",
      };

      const request1 = createApprovalRequest(context, "Test", {
        runId: "test-run",
        phaseId: "test-phase",
      });

      // First request
      const record1 = await engine.requestApproval(request1);
      expect(record1.decision).toBe("approved");

      // Check cache
      const cached = await engine.checkPreviousApproval(context);
      // AutoApprovePrompt doesn't set remember=true by default
      expect(cached).toBeNull();
    });
  });
});

// ============================================================================
// Policy Defaults Tests
// ============================================================================

describe("Policy Defaults", () => {
  it("has valid default policy", () => {
    expect(DEFAULT_WORKFLOW_POLICY.version).toBe("1.0");
    expect(DEFAULT_WORKFLOW_POLICY.rules.length).toBeGreaterThan(0);
    expect(DEFAULT_WORKFLOW_POLICY.defaultDecision).toBe("prompt");
  });

  it("has valid strict policy", () => {
    expect(STRICT_POLICY.defaultDecision).toBe("deny");
    expect(STRICT_POLICY.logging.logAll).toBe(true);
  });

  it("has valid permissive policy", () => {
    expect(PERMISSIVE_POLICY.defaultDecision).toBe("allow");
    expect(PERMISSIVE_POLICY.requireApprovalForDestructive).toBe(false);
  });

  it("getPolicyPreset returns correct presets", () => {
    expect(getPolicyPreset("default")).toBe(DEFAULT_WORKFLOW_POLICY);
    expect(getPolicyPreset("strict")).toBe(STRICT_POLICY);
    expect(getPolicyPreset("permissive")).toBe(PERMISSIVE_POLICY);
  });

  it("mergePolicy combines configs correctly", () => {
    const merged = mergePolicy(DEFAULT_WORKFLOW_POLICY, {
      defaultDecision: "deny",
      logging: { logAll: true },
    });

    expect(merged.defaultDecision).toBe("deny");
    expect(merged.logging.logAll).toBe(true);
    expect(merged.rules).toBe(DEFAULT_WORKFLOW_POLICY.rules);
  });
});

// ============================================================================
// Approval Store Tests
// ============================================================================

describe("InMemoryApprovalStore", () => {
  let store: InMemoryApprovalStore;

  beforeEach(() => {
    store = new InMemoryApprovalStore();
  });

  it("saves and retrieves records", async () => {
    const request = createApprovalRequest(
      {
        actionType: "file_write",
        workspacePath: "/test",
        runId: "run-1",
        phaseId: "phase-1",
      },
      "Test",
      { runId: "run-1", phaseId: "phase-1" },
    );

    const record = {
      request,
      decision: "approved" as const,
      decidedAt: Date.now(),
      remember: true,
    };

    await store.save(record);

    const records = await store.getByRun("run-1");
    expect(records.length).toBe(1);
    expect(records[0].decision).toBe("approved");
  });

  it("retrieves by id", async () => {
    const request = createApprovalRequest(
      {
        actionType: "file_write",
        workspacePath: "/test",
        runId: "run-1",
        phaseId: "phase-1",
      },
      "Test",
      { runId: "run-1", phaseId: "phase-1" },
    );

    const record = {
      request,
      decision: "approved" as const,
      decidedAt: Date.now(),
      remember: true,
    };

    await store.save(record);

    const retrieved = await store.getById(request.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.decision).toBe("approved");
  });

  it("clears records by run", async () => {
    const request = createApprovalRequest(
      {
        actionType: "file_write",
        workspacePath: "/test",
        runId: "run-1",
        phaseId: "phase-1",
      },
      "Test",
      { runId: "run-1", phaseId: "phase-1" },
    );

    await store.save({
      request,
      decision: "approved",
      decidedAt: Date.now(),
      remember: false,
    });

    await store.clearRun("run-1");

    const records = await store.getByRun("run-1");
    expect(records.length).toBe(0);
  });
});

// ============================================================================
// Approval Prompt Tests
// ============================================================================

describe("AutoApprovePrompt", () => {
  it("auto-approves by default", async () => {
    const prompt = new AutoApprovePrompt();
    const request = createApprovalRequest(
      {
        actionType: "agent_spawn",
        workspacePath: "/test",
        runId: "run-1",
        phaseId: "phase-1",
      },
      "Test",
      { runId: "run-1", phaseId: "phase-1" },
    );

    const record = await prompt.prompt(request);
    expect(record.decision).toBe("approved");
  });

  it("can be configured to deny", async () => {
    const prompt = new AutoApprovePrompt({ decision: "denied" });
    const request = createApprovalRequest(
      {
        actionType: "agent_spawn",
        workspacePath: "/test",
        runId: "run-1",
        phaseId: "phase-1",
      },
      "Test",
      { runId: "run-1", phaseId: "phase-1" },
    );

    const record = await prompt.prompt(request);
    expect(record.decision).toBe("denied");
  });

  it("can add delay", async () => {
    const prompt = new AutoApprovePrompt({ delayMs: 50 });
    const request = createApprovalRequest(
      {
        actionType: "agent_spawn",
        workspacePath: "/test",
        runId: "run-1",
        phaseId: "phase-1",
      },
      "Test",
      { runId: "run-1", phaseId: "phase-1" },
    );

    const start = Date.now();
    await prompt.prompt(request);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});

describe("createApprovalPrompt", () => {
  it("creates cli prompt", () => {
    const prompt = createApprovalPrompt({ type: "cli" });
    expect(prompt).toBeInstanceOf(CliApprovalPrompt);
  });

  it("creates auto prompt", () => {
    const prompt = createApprovalPrompt({ type: "auto" });
    expect(prompt).toBeInstanceOf(AutoApprovePrompt);
  });
});

// ============================================================================
// createApprovalRequest Tests
// ============================================================================

describe("createApprovalRequest", () => {
  it("creates valid request", () => {
    const request = createApprovalRequest(
      {
        actionType: "file_write",
        targetPath: "/test/file.ts",
        workspacePath: "/test",
        runId: "run-1",
        phaseId: "phase-1",
      },
      "Need to write file",
      { runId: "run-1", phaseId: "phase-1" },
    );

    expect(request.id).toBeDefined();
    expect(request.runId).toBe("run-1");
    expect(request.phaseId).toBe("phase-1");
    expect(request.reason).toBe("Need to write file");
    expect(request.action.actionType).toBe("file_write");
    expect(request.createdAt).toBeLessThanOrEqual(Date.now());
  });
});

// ============================================================================
// Store Factory Tests
// ============================================================================

describe("createApprovalStore", () => {
  it("creates memory store", () => {
    const store = createApprovalStore({ type: "memory" });
    expect(store).toBeInstanceOf(InMemoryApprovalStore);
  });

  it("creates file store with baseDir", () => {
    const store = createApprovalStore({
      type: "file",
      baseDir: join(tmpdir(), "test-approvals"),
    });
    expect(store).toBeInstanceOf(FileApprovalStore);
  });

  it("throws for file store without baseDir", () => {
    expect(() => createApprovalStore({ type: "file" })).toThrow("baseDir required");
  });
});

// ============================================================================
// FileApprovalStore JSONL Format Tests
// ============================================================================

describe("FileApprovalStore JSONL format", () => {
  let baseDir: string;
  let store: FileApprovalStore;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `test-approvals-${randomUUID()}`);
    await mkdir(baseDir, { recursive: true });
    store = new FileApprovalStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
  });

  it("writes approvals.jsonl in run directory", async () => {
    const runId = "test-run-jsonl";
    const request = createApprovalRequest(
      {
        actionType: "file_write",
        workspacePath: "/test",
        runId,
        phaseId: "phase-1",
      },
      "Test reason",
      { runId, phaseId: "phase-1" },
    );

    await store.save({
      request,
      decision: "approved",
      decidedAt: Date.now(),
      remember: true,
    });

    // Verify file exists at {baseDir}/{runId}/approvals.jsonl
    const filePath = join(baseDir, runId, "approvals.jsonl");
    const content = await readFile(filePath, "utf-8");

    // Should be valid JSONL (one JSON object per line)
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.decision).toBe("approved");
    expect(parsed.request.runId).toBe(runId);
  });

  it("appends multiple records as JSONL", async () => {
    const runId = "test-run-multi";

    for (let i = 0; i < 3; i++) {
      const request = createApprovalRequest(
        {
          actionType: "file_write",
          targetPath: `/test/file${i}.ts`,
          workspacePath: "/test",
          runId,
          phaseId: "phase-1",
        },
        `Test reason ${i}`,
        { runId, phaseId: "phase-1" },
      );

      await store.save({
        request,
        decision: i % 2 === 0 ? "approved" : "denied",
        decidedAt: Date.now(),
        remember: false,
      });
    }

    const filePath = join(baseDir, runId, "approvals.jsonl");
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    expect(lines.length).toBe(3);

    // Each line should be valid JSON
    const records = lines.map((line) => JSON.parse(line));
    expect(records[0].decision).toBe("approved");
    expect(records[1].decision).toBe("denied");
    expect(records[2].decision).toBe("approved");
  });

  it("loads records from JSONL file", async () => {
    const runId = "test-run-load";
    const request = createApprovalRequest(
      {
        actionType: "bash_execute",
        command: "npm test",
        workspacePath: "/test",
        runId,
        phaseId: "phase-1",
      },
      "Run tests",
      { runId, phaseId: "phase-1" },
    );

    await store.save({
      request,
      decision: "approved",
      decidedAt: Date.now(),
      remember: true,
      rememberScope: "run",
    });

    // Create new store instance to test loading from file
    const store2 = new FileApprovalStore(baseDir);
    const records = await store2.getByRun(runId);

    expect(records.length).toBe(1);
    expect(records[0].decision).toBe("approved");
    expect(records[0].request.action.command).toBe("npm test");
  });
});

// ============================================================================
// PolicyEngine + IApprovalStore Integration Tests
// ============================================================================

describe("PolicyEngine with IApprovalStore", () => {
  const workspacePath = "/home/user/project";
  let baseDir: string;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `test-policy-store-${randomUUID()}`);
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
  });

  it("persists approval to store when approved", async () => {
    const store = new FileApprovalStore(baseDir);
    const prompt = new AutoApprovePrompt({ decision: "approved" });
    const engine = createPolicyEngine({
      workspacePath,
      approvalPrompt: prompt,
      approvalStore: store,
    });

    const runId = "test-persist-run";
    const request = createApprovalRequest(
      {
        actionType: "agent_spawn",
        workspacePath,
        runId,
        phaseId: "phase-1",
      },
      "Spawn agent",
      { runId, phaseId: "phase-1" },
    );

    await engine.requestApproval(request);

    // Verify stored in file
    const filePath = join(baseDir, runId, "approvals.jsonl");
    const content = await readFile(filePath, "utf-8");
    const record = JSON.parse(content.trim());

    expect(record.decision).toBe("approved");
  });

  it("persists denial to store", async () => {
    const store = new FileApprovalStore(baseDir);
    const prompt = new AutoApprovePrompt({ decision: "denied" });
    const engine = createPolicyEngine({
      workspacePath,
      approvalPrompt: prompt,
      approvalStore: store,
    });

    const runId = "test-deny-run";
    const request = createApprovalRequest(
      {
        actionType: "network_request",
        url: "https://unknown.com",
        workspacePath,
        runId,
        phaseId: "phase-1",
      },
      "Network request",
      { runId, phaseId: "phase-1" },
    );

    await engine.requestApproval(request);

    const records = await store.getByRun(runId);
    expect(records.length).toBe(1);
    expect(records[0].decision).toBe("denied");
  });

  it("finds matching approval from store", async () => {
    const store = new InMemoryApprovalStore();

    const runId = "test-match-run";

    // First request - will prompt
    const request1 = createApprovalRequest(
      {
        actionType: "file_write",
        targetPath: "/home/user/project/src/index.ts",
        workspacePath,
        runId,
        phaseId: "phase-1",
      },
      "Write file",
      { runId, phaseId: "phase-1" },
    );

    // Save with remember=true manually
    await store.save({
      request: request1,
      decision: "approved",
      decidedAt: Date.now(),
      remember: true,
      rememberScope: "run",
    });

    // Second request for same file - should find matching
    const request2 = createApprovalRequest(
      {
        actionType: "file_write",
        targetPath: "/home/user/project/src/index.ts",
        workspacePath,
        runId,
        phaseId: "phase-2",
      },
      "Write file again",
      { runId, phaseId: "phase-2" },
    );

    const match = await store.findMatching(request2);
    expect(match).not.toBeNull();
    expect(match!.decision).toBe("approved");
  });
});
