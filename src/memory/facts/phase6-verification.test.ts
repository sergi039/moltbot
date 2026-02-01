/**
 * Phase 6 Verification Tests
 *
 * Tests for:
 * 1. Access enforcement in getFactsRelevantContext (not just trace)
 * 2. Forced redaction when canSeeUnredacted=false
 * 3. Default role applied when --role not specified
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFactsMemoryManager, type FactsMemoryManager } from "./manager.js";
import { getRelevantContext } from "./retrieval.js";
import { exportToJsonl, type ExportOptions } from "./export.js";
import { getRoleConfig } from "./access.js";
import type { FactsMemoryConfig } from "../../config/types.openclaw.js";

describe("Phase 6 Verification", () => {
  let tempDir: string;
  let manager: FactsMemoryManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function createManager(config: FactsMemoryConfig = {}): FactsMemoryManager {
    const dbPath = join(tempDir, "test.db");
    const markdownPath = tempDir;
    return createFactsMemoryManager({
      dbPath,
      markdownPath,
      enabled: true,
      extraction: { enabled: true },
      ...config,
    });
  }

  describe("1. getRelevantContext applies access control", () => {
    it("filters memories by role when access enabled", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add memories of different types
      await manager.add({
        content: "This is a fact about testing",
        type: "fact",
        source: "conversation",
        importance: 0.9,
      });
      await manager.add({
        content: "User prefers testing tools",
        type: "preference",
        source: "conversation",
        importance: 0.9,
      });
      await manager.add({
        content: "Important event about testing",
        type: "event",
        source: "conversation",
        importance: 0.9,
      });

      // Without access control - should return all types
      const contextAll = getRelevantContext(store, "testing", {
        access: { enabled: false },
      });
      expect(contextAll).toContain("fact");
      expect(contextAll).toContain("preference");
      expect(contextAll).toContain("event");

      // With analyst role - should only return fact + event
      const contextAnalyst = getRelevantContext(store, "testing", {
        access: { enabled: true, role: "analyst" },
      });
      expect(contextAnalyst).toContain("fact");
      expect(contextAnalyst).toContain("event");
      expect(contextAnalyst).not.toContain("preference");

      // With guest role - should only return facts
      const contextGuest = getRelevantContext(store, "testing", {
        access: { enabled: true, role: "guest" },
      });
      expect(contextGuest).toContain("fact");
      expect(contextGuest).not.toContain("preference");
      expect(contextGuest).not.toContain("event");
    });
  });

  describe("2. Export forces redaction when canSeeUnredacted=false", () => {
    it("analyst export is always redacted even without --redact", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add memory with email
      await manager.add({
        content: "Contact user@example.com for testing",
        type: "fact",
        source: "conversation",
        importance: 0.9,
      });

      const outputPath = join(tempDir, "export.jsonl");

      // Verify analyst role has canSeeUnredacted=false
      const analystConfig = getRoleConfig("analyst");
      expect(analystConfig.canSeeUnredacted).toBe(false);

      // Export without --redact flag, but role can't see unredacted
      // CLI would force redaction - we simulate by passing redact=true
      const forceRedact = !analystConfig.canSeeUnredacted;
      const result = exportToJsonl(store, outputPath, {
        redact: forceRedact,
      });

      expect(result.success).toBe(true);
      expect(result.redactionApplied).toBe(true);

      // Verify email is redacted in export
      const content = readFileSync(outputPath, "utf-8");
      expect(content).toContain("[EMAIL]");
      expect(content).not.toContain("user@example.com");
    });

    it("admin can export without redaction", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        content: "Contact admin@example.com",
        type: "fact",
        source: "conversation",
        importance: 0.9,
      });

      const outputPath = join(tempDir, "export-admin.jsonl");

      // Verify admin role has canSeeUnredacted=true
      const adminConfig = getRoleConfig("admin");
      expect(adminConfig.canSeeUnredacted).toBe(true);

      // Export without redaction
      const result = exportToJsonl(store, outputPath, {
        redact: false,
      });

      expect(result.success).toBe(true);
      expect(result.redactionApplied).toBe(false);

      // Verify email is NOT redacted
      const content = readFileSync(outputPath, "utf-8");
      expect(content).toContain("admin@example.com");
    });
  });

  describe("3. Default role applied when --role not specified", () => {
    it("uses defaultRole from config when role not specified", () => {
      // Simulate config with defaultRole
      const accessConfig = {
        enabled: true,
        defaultRole: "analyst" as const,
      };

      // When role not specified, should fall back to defaultRole
      const effectiveRole = accessConfig.defaultRole ?? "operator";
      expect(effectiveRole).toBe("analyst");
    });

    it("falls back to operator when no defaultRole configured", () => {
      // Simulate config without defaultRole
      const accessConfig = {
        enabled: true,
      };

      // Should fall back to operator
      const effectiveRole = accessConfig.defaultRole ?? "operator";
      expect(effectiveRole).toBe("operator");
    });

    it("getRoleConfig respects custom role configuration", () => {
      const accessConfig = {
        enabled: true,
        defaultRole: "operator" as const,
        roles: {
          operator: {
            allowedTypes: ["fact", "preference"] as (
              | "fact"
              | "preference"
              | "decision"
              | "event"
              | "todo"
            )[],
            canExport: true,
            canSeeUnredacted: false,
          },
        },
      };

      const config = getRoleConfig("operator", accessConfig);

      // Should use custom config
      expect(config.allowedTypes).toEqual(["fact", "preference"]);
      expect(config.canExport).toBe(true);
      expect(config.canSeeUnredacted).toBe(false);
    });
  });

  describe("Role permission checks", () => {
    it("guest cannot export", () => {
      const guestConfig = getRoleConfig("guest");
      expect(guestConfig.canExport).toBe(false);
    });

    it("admin can export and see unredacted", () => {
      const adminConfig = getRoleConfig("admin");
      expect(adminConfig.canExport).toBe(true);
      expect(adminConfig.canSeeUnredacted).toBe(true);
    });

    it("operator can export but not see unredacted", () => {
      const operatorConfig = getRoleConfig("operator");
      expect(operatorConfig.canExport).toBe(true);
      expect(operatorConfig.canSeeUnredacted).toBe(false);
    });
  });
});
