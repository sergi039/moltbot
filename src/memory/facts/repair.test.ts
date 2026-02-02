/**
 * Facts Memory Repair Tests
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FactsMemoryConfig } from "./types.js";
import { createFactsMemoryManager, type FactsMemoryManager } from "./manager.js";
import { checkIntegrity, rebuildFtsIndex, runRepair } from "./repair.js";

describe("Facts Memory Repair", () => {
  let tempDir: string;
  let manager: FactsMemoryManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-repair-test-"));
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

  describe("checkIntegrity", () => {
    it("returns ok for healthy database", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add some data
      await manager.add({
        type: "fact",
        content: "Test fact",
        source: "conversation",
      });

      const result = checkIntegrity(store);

      expect(result.ok).toBe(true);
      expect(result.messages).toEqual([]);
    });

    it("returns ok for empty database", async () => {
      manager = createManager();
      const store = manager.getStore();

      const result = checkIntegrity(store);

      expect(result.ok).toBe(true);
      expect(result.messages).toEqual([]);
    });
  });

  describe("rebuildFtsIndex", () => {
    it("attempts to rebuild FTS index", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add test data
      await manager.add({
        type: "fact",
        content: "Alice is a software engineer",
        source: "conversation",
      });
      await manager.add({
        type: "preference",
        content: "Prefers dark mode",
        source: "explicit",
      });

      // Rebuild FTS - may fail if FTS5 not available
      const result = rebuildFtsIndex(store);

      // If FTS5 is available, it should succeed
      if (result.success) {
        expect(result.rowsReindexed).toBe(2);
        expect(result.error).toBeUndefined();
      } else {
        // FTS5 not available - should have error
        expect(result.error).toBeDefined();
        expect(result.error).toContain("fts5");
      }
    });

    it("reports error when FTS5 not available", async () => {
      manager = createManager();
      const store = manager.getStore();

      const result = rebuildFtsIndex(store);

      // Either succeeds or fails with clear error
      expect(typeof result.success).toBe("boolean");
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe("runRepair", () => {
    it("runs check only by default", async () => {
      manager = createManager();
      const store = manager.getStore();

      const result = runRepair(store, { check: true });

      expect(result.success).toBe(true);
      expect(result.integrityCheck).toBeDefined();
      expect(result.integrityCheck?.ok).toBe(true);
      expect(result.ftsReindex).toBeUndefined();
      expect(result.vacuumed).toBeUndefined();
    });

    it("runs reindex when requested", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        type: "fact",
        content: "Test data for reindex",
        source: "conversation",
      });

      const result = runRepair(store, { reindex: true });

      // Reindex result depends on FTS5 availability
      expect(result.ftsReindex).toBeDefined();
      if (result.ftsReindex?.success) {
        expect(result.success).toBe(true);
        expect(result.ftsReindex.rowsReindexed).toBe(1);
      } else {
        // FTS5 not available - failure is expected
        expect(result.ftsReindex.error).toBeDefined();
      }
    });

    it("runs vacuum when requested", async () => {
      manager = createManager();
      const store = manager.getStore();

      const result = runRepair(store, { vacuum: true });

      expect(result.success).toBe(true);
      expect(result.vacuumed).toBe(true);
    });

    it("vacuum is safe on empty database", async () => {
      manager = createManager();
      const store = manager.getStore();

      const result = runRepair(store, { vacuum: true });

      expect(result.success).toBe(true);
      expect(result.vacuumed).toBe(true);
    });

    it("runs all operations together", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        type: "fact",
        content: "Test for combined repair",
        source: "conversation",
      });

      const result = runRepair(store, { check: true, reindex: true, vacuum: true });

      // Check and vacuum should always work
      expect(result.integrityCheck?.ok).toBe(true);
      expect(result.vacuumed).toBe(true);

      // Reindex depends on FTS5 availability
      expect(result.ftsReindex).toBeDefined();
      // Overall success depends on FTS5 availability
      if (result.ftsReindex?.success) {
        expect(result.success).toBe(true);
      }
    });
  });
});
