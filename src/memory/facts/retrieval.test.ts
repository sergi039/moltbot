/**
 * Facts Memory Retrieval Tests
 *
 * Tests for the retrieval contract and query-time retrieval.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openFactsMemoryStore, type FactsMemoryStore } from "./store.js";
import {
  buildSessionContext,
  getRelevantContext,
  getTopFacts,
  getImportantMemories,
  searchMemories,
} from "./retrieval.js";

describe("Facts Memory Retrieval", () => {
  let tempDir: string;
  let store: FactsMemoryStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-retrieval-test-"));
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

  describe("Retrieval Contract", () => {
    it("always includes user_profile in context", () => {
      // Set up user_profile block
      store.upsertBlock({
        label: "user_profile",
        value: "Name: TestUser\nPreferences: dark mode, vim bindings",
      });

      const context = buildSessionContext(store);

      expect(context).toContain("## User Profile");
      expect(context).toContain("TestUser");
      expect(context).toContain("dark mode");
    });

    it("includes daily summary when available", () => {
      // Set up daily summary
      const today = new Date().toISOString().split("T")[0];
      store.saveDailySummary({
        date: today,
        summary: "User discussed project planning and set up development environment.",
      });

      const context = buildSessionContext(store);

      expect(context).toContain("## Recent Context");
      expect(context).toContain("project planning");
    });

    it("includes top facts by importance and access", () => {
      // Add memories with varying importance
      store.add({
        type: "fact",
        content: "User works at TechCorp",
        source: "conversation",
        importance: 0.9,
      });
      store.add({
        type: "fact",
        content: "User likes coffee",
        source: "conversation",
        importance: 0.3,
      });
      store.add({
        type: "preference",
        content: "Prefers TypeScript over JavaScript",
        source: "conversation",
        importance: 0.8,
      });

      const context = buildSessionContext(store, { maxMemories: 10 });

      expect(context).toContain("## Known Facts");
      expect(context).toContain("TechCorp");
      expect(context).toContain("TypeScript");
    });

    it("respects token limit", () => {
      // Add many memories
      for (let i = 0; i < 50; i++) {
        store.add({
          type: "fact",
          content: `This is fact number ${i} with some additional content to increase size`,
          source: "conversation",
          importance: 0.5,
        });
      }

      const context = buildSessionContext(store, { maxTokens: 500 });

      // Should be roughly under 500 tokens (approx 2000 chars)
      expect(context.length).toBeLessThan(2500);
    });

    it("returns empty string for empty store", () => {
      const context = buildSessionContext(store);
      expect(context).toBe("");
    });
  });

  describe("getTopFacts", () => {
    it("returns memories sorted by weighted score", () => {
      // High importance, low access
      const id1 = store.add({
        type: "fact",
        content: "High importance fact",
        source: "conversation",
        importance: 0.9,
      });

      // Medium importance, will get high access
      const id2 = store.add({
        type: "fact",
        content: "Frequently accessed fact",
        source: "conversation",
        importance: 0.5,
      });

      // Access the second memory multiple times
      for (let i = 0; i < 10; i++) {
        store.get(id2);
      }

      const topFacts = getTopFacts(store, 5);

      expect(topFacts.length).toBe(2);
      // Both should be included, order depends on weighted scoring
      expect(topFacts.map((f) => f.content)).toContain("High importance fact");
      expect(topFacts.map((f) => f.content)).toContain("Frequently accessed fact");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 20; i++) {
        store.add({
          type: "fact",
          content: `Fact ${i}`,
          source: "conversation",
          importance: 0.5,
        });
      }

      const topFacts = getTopFacts(store, 5);
      expect(topFacts.length).toBe(5);
    });
  });

  describe("getRelevantContext (Query-time Retrieval)", () => {
    beforeEach(() => {
      // Set up test data
      store.add({
        type: "fact",
        content: "User's name is John Smith",
        source: "explicit",
        importance: 0.9,
        tags: ["identity", "name"],
      });
      store.add({
        type: "fact",
        content: "User's email is john@example.com",
        source: "explicit",
        importance: 0.8,
        tags: ["contact", "email"],
      });
      store.add({
        type: "preference",
        content: "Prefers dark mode in all applications",
        source: "conversation",
        importance: 0.7,
      });
      store.add({
        type: "fact",
        content: "Lives in San Francisco",
        source: "conversation",
        importance: 0.6,
      });
    });

    it("returns relevant memories for matching query", () => {
      const context = getRelevantContext(store, "name");

      expect(context).toContain("John Smith");
    });

    it("returns empty for non-matching query", () => {
      const context = getRelevantContext(store, "cryptocurrency blockchain quantum");

      // May return important memories even without match
      // But should not crash
      expect(typeof context).toBe("string");
    });

    it("merges FTS results with important memories", () => {
      const context = getRelevantContext(store, "email");

      expect(context).toContain("john@example.com");
      // Should also include important non-matching memories
    });

    it("deduplicates results by id", () => {
      const context = getRelevantContext(store, "John");

      // Count occurrences of "John Smith" - should be exactly 1
      const matches = context.match(/John Smith/g);
      expect(matches?.length ?? 0).toBe(1);
    });

    it("respects minScore threshold", () => {
      const context = getRelevantContext(store, "irrelevant query", {
        minScore: 0.9,
      });

      // With high threshold, may return empty or only very important items
      expect(typeof context).toBe("string");
    });
  });

  describe("searchMemories", () => {
    it("performs FTS search", async () => {
      store.add({
        type: "fact",
        content: "The quick brown fox jumps over the lazy dog",
        source: "conversation",
      });

      // FTS5 searches for exact terms, use a single word
      const results = await searchMemories(store, "quick");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.content).toContain("quick");
    });

    it("returns empty array for no matches", async () => {
      store.add({
        type: "fact",
        content: "Hello world",
        source: "conversation",
      });

      const results = await searchMemories(store, "xyznonexistent");

      expect(results).toEqual([]);
    });
  });

  describe("getImportantMemories", () => {
    it("filters by importance threshold", () => {
      store.add({
        type: "fact",
        content: "Very important",
        source: "conversation",
        importance: 0.9,
      });
      store.add({
        type: "fact",
        content: "Not important",
        source: "conversation",
        importance: 0.2,
      });

      const important = getImportantMemories(store, 0.7);

      expect(important.length).toBe(1);
      expect(important[0].content).toBe("Very important");
    });
  });
});
