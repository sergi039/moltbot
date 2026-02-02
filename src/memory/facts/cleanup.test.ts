/**
 * Facts Memory Cleanup Tests
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FactsMemoryConfig } from "./types.js";
import { runCleanup, getCleanupStats, vacuumDatabase } from "./cleanup.js";
import { openFactsMemoryStore, type FactsMemoryStore } from "./store.js";

describe("Facts Memory Cleanup", () => {
  let tempDir: string;
  let store: FactsMemoryStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-cleanup-test-"));
    store = openFactsMemoryStore(join(tempDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getCleanupStats", () => {
    it("returns correct stats for empty store", () => {
      const stats = getCleanupStats(store, tempDir);

      expect(stats.totalMemories).toBe(0);
      expect(stats.oldMemories).toBe(0);
      expect(stats.lowImportanceMemories).toBe(0);
      expect(stats.dailySummaries).toBe(0);
      expect(stats.weeklySummaries).toBe(0);
    });

    it("counts memories by age", () => {
      // Add a recent memory
      store.add({
        type: "fact",
        content: "Recent memory",
        source: "explicit",
        importance: 0.8,
      });

      // Add an old memory (manually set old timestamp)
      const oldId = store.add({
        type: "fact",
        content: "Old memory",
        source: "conversation",
        importance: 0.5,
      });

      // Update the old memory to have old timestamp
      const oldTimestamp = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
      store.update(oldId, { createdAt: Math.floor(oldTimestamp / 1000) });

      const stats = getCleanupStats(store, tempDir, { maxAgeDays: 90 });

      expect(stats.totalMemories).toBe(2);
      expect(stats.oldMemories).toBe(1);
    });

    it("counts low importance memories", () => {
      store.add({
        type: "fact",
        content: "High importance",
        source: "explicit",
        importance: 0.9,
      });

      store.add({
        type: "fact",
        content: "Low importance",
        source: "conversation",
        importance: 0.1,
      });

      const stats = getCleanupStats(store, tempDir, { minImportance: 0.2 });

      expect(stats.totalMemories).toBe(2);
      expect(stats.lowImportanceMemories).toBe(1);
    });

    it("counts summary files", () => {
      // Create daily and weekly directories with files
      const dailyDir = join(tempDir, "daily");
      const weeklyDir = join(tempDir, "weekly");
      mkdirSync(dailyDir, { recursive: true });
      mkdirSync(weeklyDir, { recursive: true });

      writeFileSync(join(dailyDir, "2024-01-01.md"), "Summary 1");
      writeFileSync(join(dailyDir, "2024-01-02.md"), "Summary 2");
      writeFileSync(join(weeklyDir, "2024-W01.md"), "Weekly 1");

      const stats = getCleanupStats(store, tempDir);

      expect(stats.dailySummaries).toBe(2);
      expect(stats.weeklySummaries).toBe(1);
    });
  });

  describe("runCleanup", () => {
    describe("dry-run mode", () => {
      it("returns candidates without deleting", () => {
        // Add an old memory
        const oldId = store.add({
          type: "fact",
          content: "Old memory to delete",
          source: "conversation",
          importance: 0.5,
        });

        // Make it old
        const oldTimestamp = Date.now() - 100 * 24 * 60 * 60 * 1000;
        store.update(oldId, { createdAt: Math.floor(oldTimestamp / 1000) });

        const result = runCleanup(store, tempDir, {}, { dryRun: true, maxAgeDays: 90 });

        expect(result.success).toBe(true);
        expect(result.memoriesDeleted).toBe(0);
        expect(result.candidates?.length).toBe(1);
        expect(result.candidates?.[0].id).toBe(oldId);

        // Memory should still exist
        expect(store.get(oldId)).not.toBeNull();
      });

      it("includes summary candidates in dry-run", () => {
        const dailyDir = join(tempDir, "daily");
        mkdirSync(dailyDir, { recursive: true });

        // Create an old summary file
        const oldFile = join(dailyDir, "2020-01-01.md");
        writeFileSync(oldFile, "Old summary");
        // Set old mtime
        const oldTime = new Date("2020-01-01");
        require("fs").utimesSync(oldFile, oldTime, oldTime);

        const result = runCleanup(
          store,
          tempDir,
          {},
          { dryRun: true, truncateSummaries: true, truncateSummariesDays: 30 },
        );

        expect(result.success).toBe(true);
        expect(result.summaryCandidates?.length).toBeGreaterThan(0);
      });
    });

    describe("actual cleanup", () => {
      it("deletes old memories", () => {
        // Add memories
        store.add({
          type: "fact",
          content: "Recent memory",
          source: "explicit",
          importance: 0.8,
        });

        const oldId = store.add({
          type: "fact",
          content: "Old memory",
          source: "conversation",
          importance: 0.5,
        });

        // Make it old
        const oldTimestamp = Date.now() - 100 * 24 * 60 * 60 * 1000;
        store.update(oldId, { createdAt: Math.floor(oldTimestamp / 1000) });

        const result = runCleanup(store, tempDir, {}, { maxAgeDays: 90 });

        expect(result.success).toBe(true);
        expect(result.memoriesDeleted).toBe(1);

        // Old memory should be gone
        expect(store.get(oldId)).toBeNull();

        // Recent memory should still exist
        const remaining = store.list();
        expect(remaining.length).toBe(1);
        expect(remaining[0].content).toBe("Recent memory");
      });

      it("prunes low importance memories when enabled", () => {
        store.add({
          type: "fact",
          content: "High importance",
          source: "explicit",
          importance: 0.9,
        });

        const lowId = store.add({
          type: "fact",
          content: "Low importance",
          source: "conversation",
          importance: 0.1,
        });

        const config: FactsMemoryConfig = {
          retention: {
            pruneLowImportance: true,
            minImportance: 0.2,
          },
        };

        const result = runCleanup(store, tempDir, config, {});

        expect(result.success).toBe(true);
        expect(result.memoriesDeleted).toBe(1);
        expect(store.get(lowId)).toBeNull();
      });

      it("respects config defaults", () => {
        const config: FactsMemoryConfig = {
          retention: {
            maxAgeDays: 30,
            pruneLowImportance: true,
            minImportance: 0.3,
          },
        };

        // Add a 35-day old memory
        const oldId = store.add({
          type: "fact",
          content: "35 days old",
          source: "conversation",
        });
        const oldTimestamp = Date.now() - 35 * 24 * 60 * 60 * 1000;
        store.update(oldId, { createdAt: Math.floor(oldTimestamp / 1000) });

        const result = runCleanup(store, tempDir, config, {});

        expect(result.success).toBe(true);
        expect(result.memoriesDeleted).toBe(1);
      });

      it("cli options override config", () => {
        const config: FactsMemoryConfig = {
          retention: {
            maxAgeDays: 30, // Would delete 35-day old memory
          },
        };

        // Add a 35-day old memory
        const oldId = store.add({
          type: "fact",
          content: "35 days old",
          source: "conversation",
        });
        const oldTimestamp = Date.now() - 35 * 24 * 60 * 60 * 1000;
        store.update(oldId, { createdAt: Math.floor(oldTimestamp / 1000) });

        // Override with 60 days - should NOT delete
        const result = runCleanup(store, tempDir, config, { maxAgeDays: 60 });

        expect(result.success).toBe(true);
        expect(result.memoriesDeleted).toBe(0);
        expect(store.get(oldId)).not.toBeNull();
      });
    });

    describe("size limit", () => {
      it("removes low importance memories when over size limit", () => {
        // Add several memories with different importance
        for (let i = 0; i < 10; i++) {
          store.add({
            type: "fact",
            content: `Memory ${i} with some content to take up space`,
            source: "conversation",
            importance: i * 0.1, // 0.0, 0.1, 0.2, ...
          });
        }

        // Set a very small size limit to trigger cleanup
        const result = runCleanup(store, tempDir, {}, { maxSizeMb: 0.0001 });

        expect(result.success).toBe(true);
        // Should have deleted some memories
        expect(result.memoriesDeleted).toBeGreaterThan(0);
      });
    });
  });

  describe("vacuumDatabase", () => {
    it("vacuums successfully", () => {
      // Add and delete some memories to create fragmentation
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(
          store.add({
            type: "fact",
            content: `Memory ${i} with content`,
            source: "conversation",
          }),
        );
      }

      for (const id of ids) {
        store.delete(id);
      }

      const result = vacuumDatabase(store);
      expect(result).toBe(true);
    });
  });
});
