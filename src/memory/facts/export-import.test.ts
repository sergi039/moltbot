/**
 * Facts Memory Export/Import Tests
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FactsMemoryConfig } from "./types.js";
import { exportToJsonl } from "./export.js";
import { importFromJsonl } from "./import.js";
import { createFactsMemoryManager, type FactsMemoryManager } from "./manager.js";

describe("Facts Memory Export/Import", () => {
  let tempDir: string;
  let manager: FactsMemoryManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-export-test-"));
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

  function createManager(config: FactsMemoryConfig = {}, suffix: string = ""): FactsMemoryManager {
    const dbPath = join(tempDir, `test${suffix}.db`);
    const markdownPath = tempDir;
    return createFactsMemoryManager({
      dbPath,
      markdownPath,
      enabled: true,
      extraction: { enabled: true },
      ...config,
    });
  }

  describe("exportToJsonl", () => {
    it("exports memories to JSONL file", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add test data
      await manager.add({
        type: "fact",
        content: "User is a developer",
        source: "conversation",
        importance: 0.8,
      });
      await manager.add({
        type: "preference",
        content: "Prefers TypeScript",
        source: "explicit",
        importance: 0.9,
      });

      const outputPath = join(tempDir, "export.jsonl");
      const result = exportToJsonl(store, outputPath);

      expect(result.success).toBe(true);
      expect(result.memoriesExported).toBe(2);
      expect(existsSync(outputPath)).toBe(true);

      // Verify file content
      const content = readFileSync(outputPath, "utf-8");
      const lines = content.trim().split("\n");
      // 2 memories + blocks (may be 0 or more) + 1 metadata
      expect(lines.length).toBeGreaterThanOrEqual(3);

      // Verify records can be parsed
      for (const line of lines) {
        const record = JSON.parse(line);
        expect(record.type).toBeDefined();
        expect(record.version).toBe(1);
      }
    });

    it("exports blocks and summaries", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add memory, block, and summary
      await manager.add({
        type: "fact",
        content: "Test memory",
        source: "conversation",
      });

      store.upsertBlock({
        label: "persona",
        value: "A helpful assistant",
      });

      store.saveDailySummary({
        date: "2024-01-15",
        summary: "Test summary",
      });

      const outputPath = join(tempDir, "export.jsonl");
      const result = exportToJsonl(store, outputPath);

      expect(result.success).toBe(true);
      expect(result.memoriesExported).toBe(1);
      // At least 1 block (the one we added), may have more from initialization
      expect(result.blocksExported).toBeGreaterThanOrEqual(1);
      expect(result.summariesExported).toBe(1);
    });

    it("exports empty database", async () => {
      manager = createManager();
      const store = manager.getStore();

      const outputPath = join(tempDir, "empty.jsonl");
      const result = exportToJsonl(store, outputPath);

      expect(result.success).toBe(true);
      expect(result.memoriesExported).toBe(0);
      // Blocks may exist from initialization
      expect(result.blocksExported).toBeGreaterThanOrEqual(0);
      expect(result.summariesExported).toBe(0);
    });
  });

  describe("importFromJsonl", () => {
    it("imports memories to empty database", async () => {
      // Create source and add data
      const sourceManager = createManager({}, "-source");
      const sourceStore = sourceManager.getStore();

      await sourceManager.add({
        type: "fact",
        content: "Imported fact",
        source: "conversation",
      });

      // Export
      const exportPath = join(tempDir, "transfer.jsonl");
      exportToJsonl(sourceStore, exportPath);
      await sourceManager.close();

      // Import to new database
      manager = createManager({}, "-target");
      const targetStore = manager.getStore();

      const result = importFromJsonl(targetStore, exportPath, { mode: "merge" });

      expect(result.success).toBe(true);
      expect(result.memoriesImported).toBe(1);
      expect(result.memoriesSkipped).toBe(0);

      // Verify data
      const memories = targetStore.list({});
      expect(memories.length).toBe(1);
      expect(memories[0].content).toBe("Imported fact");
    });

    it("merge mode skips duplicates", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add existing data
      const id1 = await manager.add({
        type: "fact",
        content: "Existing fact",
        source: "conversation",
      });

      // Export existing data
      const exportPath = join(tempDir, "merge.jsonl");
      exportToJsonl(store, exportPath);

      // Import again (merge mode)
      const result = importFromJsonl(store, exportPath, { mode: "merge" });

      expect(result.success).toBe(true);
      expect(result.memoriesImported).toBe(0); // Duplicate skipped
      expect(result.memoriesSkipped).toBe(1);

      // Verify no duplicates
      const memories = store.list({});
      expect(memories.length).toBe(1);
    });

    it("replace mode clears existing data", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add existing data
      await manager.add({
        type: "fact",
        content: "Old fact to be replaced",
        source: "conversation",
      });

      // Create export with different data
      const sourceManager = createManager({}, "-source");
      await sourceManager.add({
        type: "preference",
        content: "New preference",
        source: "explicit",
      });

      const exportPath = join(tempDir, "replace.jsonl");
      exportToJsonl(sourceManager.getStore(), exportPath);
      await sourceManager.close();

      // Import with replace
      const result = importFromJsonl(store, exportPath, { mode: "replace" });

      expect(result.success).toBe(true);
      expect(result.memoriesImported).toBe(1);

      // Verify old data is gone
      const memories = store.list({});
      expect(memories.length).toBe(1);
      expect(memories[0].content).toBe("New preference");
    });
  });

  describe("roundtrip", () => {
    it("preserves all data through export/import cycle", async () => {
      // Create source with various data
      const sourceManager = createManager({}, "-source");
      const sourceStore = sourceManager.getStore();

      await sourceManager.add({
        type: "fact",
        content: "User works at TechCorp",
        source: "conversation",
        importance: 0.85,
        confidence: 0.9,
        tags: ["work", "company"],
      });

      await sourceManager.add({
        type: "preference",
        content: "Prefers dark mode",
        source: "explicit",
        importance: 0.7,
      });

      await sourceManager.add({
        type: "decision",
        content: "Use TypeScript for the project",
        source: "conversation",
      });

      sourceStore.upsertBlock({
        label: "user_profile",
        value: "Developer at TechCorp",
      });

      sourceStore.saveDailySummary({
        date: "2024-01-15",
        summary: "Discussed project setup",
        keyDecisions: ["Use TypeScript"],
      });

      // Export
      const exportPath = join(tempDir, "roundtrip.jsonl");
      const exportResult = exportToJsonl(sourceStore, exportPath);
      expect(exportResult.success).toBe(true);
      await sourceManager.close();

      // Import to new database
      manager = createManager({}, "-target");
      const targetStore = manager.getStore();

      const importResult = importFromJsonl(targetStore, exportPath, { mode: "replace" });
      expect(importResult.success).toBe(true);

      // Verify memories
      const memories = targetStore.list({});
      expect(memories.length).toBe(3);

      const fact = memories.find((m) => m.type === "fact");
      expect(fact?.content).toBe("User works at TechCorp");
      expect(fact?.importance).toBe(0.85);
      expect(fact?.tags).toEqual(["work", "company"]);

      // Verify block
      const block = targetStore.getBlock("user_profile");
      expect(block?.value).toBe("Developer at TechCorp");

      // Verify summary
      const summary = targetStore.getDailySummary("2024-01-15");
      expect(summary?.summary).toBe("Discussed project setup");
      expect(summary?.keyDecisions).toEqual(["Use TypeScript"]);
    });

    it("handles special characters in content", async () => {
      const sourceManager = createManager({}, "-source");
      const sourceStore = sourceManager.getStore();

      await sourceManager.add({
        type: "fact",
        content: 'User said: "Hello, World!" with newlines\nand\ttabs',
        source: "conversation",
      });

      const exportPath = join(tempDir, "special.jsonl");
      exportToJsonl(sourceStore, exportPath);
      await sourceManager.close();

      manager = createManager({}, "-target");
      const targetStore = manager.getStore();

      importFromJsonl(targetStore, exportPath, { mode: "replace" });

      const memories = targetStore.list({});
      expect(memories.length).toBe(1);
      expect(memories[0].content).toBe('User said: "Hello, World!" with newlines\nand\ttabs');
    });
  });
});
