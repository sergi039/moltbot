/**
 * Facts Memory Retrieval Trace Tests (Explainability)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FactsMemoryConfig, RetrievalTrace } from "./types.js";
import { createFactsMemoryManager, type FactsMemoryManager } from "./manager.js";
import { getRelevantContextWithTrace } from "./retrieval.js";

describe("Retrieval Trace (Explainability)", () => {
  let tempDir: string;
  let manager: FactsMemoryManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-trace-test-"));
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

  describe("getRelevantContextWithTrace", () => {
    it("returns trace with reasons for each memory", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add test data
      await manager.add({
        type: "fact",
        content: "User works at TechCorp as a software engineer",
        source: "conversation",
        importance: 0.9,
      });
      await manager.add({
        type: "preference",
        content: "Prefers TypeScript over JavaScript",
        source: "explicit",
        importance: 0.8,
      });
      await manager.add({
        type: "fact",
        content: "User lives in San Francisco",
        source: "conversation",
        importance: 0.7,
      });

      const trace = getRelevantContextWithTrace(store, "What does the user do at work?");

      expect(trace).toBeDefined();
      expect(trace.context).toContain("Relevant Memories");
      expect(trace.reasons.length).toBeGreaterThan(0);
      expect(trace.query).toBe("What does the user do at work?");
      expect(trace.timestamp).toBeGreaterThan(0);
      expect(trace.memoriesIncluded).toBeGreaterThan(0);
    });

    it("includes source information in reasons", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        type: "fact",
        content: "User is a Python developer",
        source: "conversation",
        importance: 0.85,
      });

      const trace = getRelevantContextWithTrace(store, "Python");

      expect(trace.reasons.length).toBeGreaterThan(0);

      const reason = trace.reasons[0];
      expect(reason.id).toBeDefined();
      expect(reason.source).toBeDefined();
      expect(["fts", "importance", "recency", "semantic"]).toContain(reason.source);
      expect(reason.score).toBeGreaterThanOrEqual(0);
      expect(reason.score).toBeLessThanOrEqual(1);
      expect(reason.snippet).toBeDefined();
      expect(reason.type).toBe("fact");
    });

    it("sorts reasons by score", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        type: "fact",
        content: "Low importance fact",
        source: "conversation",
        importance: 0.3,
      });
      await manager.add({
        type: "fact",
        content: "High importance fact about coding",
        source: "conversation",
        importance: 0.95,
      });
      await manager.add({
        type: "fact",
        content: "Medium importance fact",
        source: "conversation",
        importance: 0.6,
      });

      const trace = getRelevantContextWithTrace(store, "coding");

      expect(trace.reasons.length).toBeGreaterThan(1);

      // Verify sorted by score (descending)
      for (let i = 1; i < trace.reasons.length; i++) {
        expect(trace.reasons[i - 1].score).toBeGreaterThanOrEqual(trace.reasons[i].score);
      }
    });

    it("returns empty trace for empty database", async () => {
      manager = createManager();
      const store = manager.getStore();

      const trace = getRelevantContextWithTrace(store, "test query");

      expect(trace.context).toBe("");
      expect(trace.reasons).toHaveLength(0);
      expect(trace.memoriesIncluded).toBe(0);
      expect(trace.query).toBe("test query");
    });

    it("includes metadata in reasons", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        type: "preference",
        content: "Prefers dark mode in all applications",
        source: "explicit",
        importance: 0.85,
      });

      const trace = getRelevantContextWithTrace(store, "dark mode preference");

      expect(trace.reasons.length).toBeGreaterThan(0);

      // At least one reason should have metadata
      const hasMetadata = trace.reasons.some((r) => r.metadata !== undefined);
      expect(hasMetadata).toBe(true);
    });

    it("respects maxResults option", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add multiple memories
      for (let i = 0; i < 20; i++) {
        await manager.add({
          type: "fact",
          content: `Test fact number ${i}`,
          source: "conversation",
          importance: 0.5 + i * 0.02,
        });
      }

      const trace = getRelevantContextWithTrace(store, "test", { maxResults: 5 });

      expect(trace.memoriesIncluded).toBeLessThanOrEqual(5);
    });

    it("tracks totalConsidered accurately", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        type: "fact",
        content: "Test memory one",
        source: "conversation",
        importance: 0.8,
      });
      await manager.add({
        type: "fact",
        content: "Test memory two",
        source: "conversation",
        importance: 0.7,
      });

      const trace = getRelevantContextWithTrace(store, "test");

      // totalConsidered includes FTS + importance + recency lookups
      expect(trace.totalConsidered).toBeGreaterThanOrEqual(trace.memoriesIncluded);
    });

    it("includes snippet in reasons", async () => {
      manager = createManager();
      const store = manager.getStore();

      const longContent =
        "This is a very long content that should be truncated in the snippet because it exceeds the maximum length allowed for snippets in the trace output";
      await manager.add({
        type: "fact",
        content: longContent,
        source: "conversation",
        importance: 0.8,
      });

      const trace = getRelevantContextWithTrace(store, "content");

      expect(trace.reasons.length).toBeGreaterThan(0);
      const reason = trace.reasons[0];
      expect(reason.snippet).toBeDefined();
      expect(reason.snippet.length).toBeLessThanOrEqual(103); // 100 + "..."
    });

    it("identifies FTS matches correctly", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        type: "fact",
        content: "User prefers Python programming language",
        source: "conversation",
        importance: 0.8,
      });

      const trace = getRelevantContextWithTrace(store, "Python programming");

      // Should have at least one FTS match if FTS is available
      const ftsMatches = trace.reasons.filter((r) => r.source === "fts");
      const importanceMatches = trace.reasons.filter((r) => r.source === "importance");

      // Either FTS works or we fall back to importance-based retrieval
      expect(ftsMatches.length + importanceMatches.length).toBeGreaterThan(0);
    });
  });

  describe("access control in retrieval", () => {
    it("filters memories by role when access enabled", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add memories of different types
      await manager.add({
        content: "This is a fact about coding",
        type: "fact",
        source: "conversation",
        importance: 0.8,
      });
      await manager.add({
        content: "User prefers dark mode",
        type: "preference",
        source: "conversation",
        importance: 0.8,
      });
      await manager.add({
        content: "User bought a laptop",
        type: "event",
        source: "conversation",
        importance: 0.8,
      });

      // Retrieve with analyst role (only fact + event)
      const trace = getRelevantContextWithTrace(store, "coding", {
        access: {
          enabled: true,
          role: "analyst",
        },
      });

      // Check access info
      expect(trace.access).toBeDefined();
      expect(trace.access?.role).toBe("analyst");

      // Should not include preference type
      const types = trace.reasons.map((r) => r.type);
      expect(types).not.toContain("preference");
    });

    it("includes all types for admin role", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        content: "This is a fact",
        type: "fact",
        source: "conversation",
        importance: 0.9,
      });
      await manager.add({
        content: "User preference for testing",
        type: "preference",
        source: "conversation",
        importance: 0.9,
      });

      const trace = getRelevantContextWithTrace(store, "testing", {
        access: {
          enabled: true,
          role: "admin",
        },
      });

      expect(trace.access?.role).toBe("admin");
      // Admin should see all types
      expect(trace.access?.excluded).toBe(0);
    });

    it("only includes facts for guest role", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        content: "Guest visible fact",
        type: "fact",
        source: "conversation",
        importance: 0.9,
      });
      await manager.add({
        content: "Hidden preference",
        type: "preference",
        source: "conversation",
        importance: 0.9,
      });
      await manager.add({
        content: "Hidden decision",
        type: "decision",
        source: "conversation",
        importance: 0.9,
      });

      const trace = getRelevantContextWithTrace(store, "hidden", {
        access: {
          enabled: true,
          role: "guest",
        },
      });

      expect(trace.access?.role).toBe("guest");
      // Guest only sees facts
      const types = trace.reasons.map((r) => r.type);
      expect(types.every((t) => t === "fact")).toBe(true);
      expect(trace.access?.excluded).toBeGreaterThan(0);
    });

    it("does not filter when access disabled", async () => {
      manager = createManager();
      const store = manager.getStore();

      await manager.add({
        content: "A fact",
        type: "fact",
        source: "conversation",
        importance: 0.9,
      });
      await manager.add({
        content: "A preference",
        type: "preference",
        source: "conversation",
        importance: 0.9,
      });

      const trace = getRelevantContextWithTrace(store, "preference", {
        access: {
          enabled: false,
          role: "guest",
        },
      });

      // Access info should not be present when disabled
      expect(trace.access).toBeUndefined();
    });
  });
});
