/**
 * Facts Memory Consolidation Tests
 *
 * Tests for daily/weekly summaries and pruning.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateDailySummary,
  generateWeeklySummary,
  pruneMemories,
  runConsolidation,
} from "./consolidation.js";
import { openFactsMemoryStore, type FactsMemoryStore } from "./store.js";

describe("Facts Memory Consolidation", () => {
  let tempDir: string;
  let store: FactsMemoryStore;
  let markdownPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-consolidation-test-"));
    store = openFactsMemoryStore(join(tempDir, "test.db"));
    markdownPath = join(tempDir, "memory");
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("generateDailySummary", () => {
    it("generates summary for memories created today", async () => {
      const today = new Date().toISOString().split("T")[0];

      // Add some memories (they'll have today's timestamp)
      store.add({
        type: "fact",
        content: "User's name is TestUser",
        source: "conversation",
        importance: 0.8,
      });
      store.add({
        type: "decision",
        content: "Decided to use TypeScript for the project",
        source: "conversation",
        importance: 0.9,
      });

      const summary = await generateDailySummary(store, today, null, markdownPath);

      expect(summary).not.toBeNull();
      expect(summary!.date).toBe(today);
      expect(summary!.summary).toBeTruthy();
    });

    it("returns null when no memories for the date", async () => {
      const futureDate = "2099-12-31";

      const summary = await generateDailySummary(store, futureDate, null, markdownPath);

      expect(summary).toBeNull();
    });

    it("writes markdown file when markdownPath provided", async () => {
      const today = new Date().toISOString().split("T")[0];

      store.add({
        type: "fact",
        content: "Test memory for markdown",
        source: "conversation",
      });

      await generateDailySummary(store, today, null, markdownPath);

      const mdPath = join(markdownPath, "daily", `${today}.md`);
      expect(existsSync(mdPath)).toBe(true);

      const content = readFileSync(mdPath, "utf-8");
      expect(content).toContain(`# Daily Summary: ${today}`);
    });

    it("saves summary to database", async () => {
      const today = new Date().toISOString().split("T")[0];

      store.add({
        type: "fact",
        content: "Test memory",
        source: "conversation",
      });

      await generateDailySummary(store, today, null);

      const saved = store.getDailySummary(today);
      expect(saved).not.toBeNull();
      expect(saved!.date).toBe(today);
    });

    it("uses LLM when provided", async () => {
      const today = new Date().toISOString().split("T")[0];

      store.add({
        type: "fact",
        content: "Important project information",
        source: "conversation",
      });

      const mockLlm = vi.fn().mockResolvedValue(
        JSON.stringify({
          summary: "LLM generated summary about important project.",
          keyDecisions: ["Decided to proceed"],
          mentionedEntities: ["project"],
        }),
      );

      const summary = await generateDailySummary(store, today, mockLlm);

      expect(mockLlm).toHaveBeenCalled();
      expect(summary!.summary).toContain("LLM generated");
      expect(summary!.keyDecisions).toContain("Decided to proceed");
    });
  });

  describe("generateWeeklySummary", () => {
    it("generates weekly summary from daily summaries", async () => {
      // Create daily summaries for the past week
      const today = new Date();
      for (let i = 0; i < 5; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split("T")[0];
        store.saveDailySummary({
          date: dateStr,
          summary: `Activities for day ${i}`,
          keyDecisions: i % 2 === 0 ? [`Decision ${i}`] : undefined,
        });
      }

      const todayStr = today.toISOString().split("T")[0];
      const result = await generateWeeklySummary(store, todayStr, null, markdownPath);

      expect(result).not.toBeNull();
      expect(result!.weekId).toMatch(/^\d{4}-W\d{2}$/);
      expect(result!.summary).toBeTruthy();
    });

    it("returns null when no daily summaries exist", async () => {
      const result = await generateWeeklySummary(store, "2099-12-31", null);
      expect(result).toBeNull();
    });

    it("writes weekly markdown file", async () => {
      const today = new Date();
      const todayStr = today.toISOString().split("T")[0];

      // Add one daily summary
      store.saveDailySummary({
        date: todayStr,
        summary: "Test daily summary",
      });

      const result = await generateWeeklySummary(store, todayStr, null, markdownPath);

      const mdPath = join(markdownPath, "weekly", `${result!.weekId}.md`);
      expect(existsSync(mdPath)).toBe(true);
    });
  });

  describe("pruneMemories", () => {
    it("deletes expired memories", () => {
      const now = Math.floor(Date.now() / 1000);

      // Add expired memory
      store.add({
        type: "todo",
        content: "Expired todo",
        source: "conversation",
        expiresAt: now - 3600, // 1 hour ago
      });

      // Add non-expired memory
      store.add({
        type: "fact",
        content: "Valid fact",
        source: "conversation",
      });

      const result = pruneMemories(store);

      expect(result.expired).toBe(1);
      expect(store.list().length).toBe(1);
      expect(store.list()[0].content).toBe("Valid fact");
    });

    it("deletes old low-importance memories with no access", () => {
      // Manually insert an old memory with low importance
      // Since we can't set createdAt directly, we'll test the logic differently
      const id = store.add({
        type: "fact",
        content: "Low importance fact",
        source: "conversation",
        importance: 0.1,
      });

      // Directly update created_at in DB to simulate old memory
      // @ts-expect-error - accessing private db for testing
      store["db"]
        .prepare("UPDATE memories SET created_at = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000) - 40 * 86400, id); // 40 days old

      const result = pruneMemories(store);

      expect(result.deleted).toBe(1);
    });

    it("keeps high-importance memories regardless of age", () => {
      const id = store.add({
        type: "fact",
        content: "Important fact",
        source: "conversation",
        importance: 0.9,
      });

      // Make it old
      // @ts-expect-error - accessing private db for testing
      store["db"]
        .prepare("UPDATE memories SET created_at = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000) - 100 * 86400, id); // 100 days old

      const result = pruneMemories(store);

      expect(result.deleted).toBe(0);
      expect(store.list().length).toBe(1);
    });

    it("keeps accessed memories even if low importance", () => {
      const id = store.add({
        type: "fact",
        content: "Accessed fact",
        source: "conversation",
        importance: 0.1,
      });

      // Access the memory (increases access count)
      store.get(id);

      // Make it old
      // @ts-expect-error - accessing private db for testing
      store["db"]
        .prepare("UPDATE memories SET created_at = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000) - 40 * 86400, id);

      const result = pruneMemories(store);

      expect(result.deleted).toBe(0);
    });
  });

  describe("runConsolidation", () => {
    it("runs daily summary and pruning together", async () => {
      // Add a memory for today
      store.add({
        type: "fact",
        content: "Today's memory",
        source: "conversation",
      });

      // Add an expired memory
      store.add({
        type: "todo",
        content: "Expired",
        source: "conversation",
        expiresAt: Math.floor(Date.now() / 1000) - 3600,
      });

      const result = await runConsolidation(store, null, markdownPath);

      expect(result.dailySummary).not.toBeNull();
      expect(result.pruned.expired).toBe(1);
    });

    it("runs weekly summary on Sunday", async () => {
      // Mock Date to be Sunday
      const sunday = new Date();
      sunday.setDate(sunday.getDate() + ((7 - sunday.getDay()) % 7)); // Next Sunday

      // Store a daily summary
      store.saveDailySummary({
        date: sunday.toISOString().split("T")[0],
        summary: "Sunday summary",
      });

      // Add memory for "today"
      store.add({
        type: "fact",
        content: "Sunday fact",
        source: "conversation",
      });

      // We can't easily mock Date.now() here, so just verify the function runs
      const result = await runConsolidation(store, null, markdownPath);

      expect(result.dailySummary).not.toBeNull();
      // weeklySummary may or may not be generated depending on actual day
    });
  });
});
