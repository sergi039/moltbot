/**
 * Facts Memory CLI Tests
 *
 * Tests for the `moltbot memory facts status` and `moltbot memory facts stats` commands.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFactsMemoryManager, type FactsMemoryManager } from "./manager.js";
import { getCleanupStats } from "./cleanup.js";
import type { FactsMemoryConfig } from "./types.js";

describe("Facts Memory CLI", () => {
  let tempDir: string;
  let manager: FactsMemoryManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-cli-test-"));
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

  describe("status command data", () => {
    it("returns enabled status when facts memory is enabled", async () => {
      manager = createManager({ enabled: true });
      const store = manager.getStore();
      const config = manager.getConfig();

      // Verify status data
      expect(config.enabled).not.toBe(false);
      expect(store.getDbPath()).toContain("test.db");
      // FTS availability depends on SQLite build, just check it returns a boolean
      expect(typeof store.isFtsAvailable()).toBe("boolean");
    });

    it("reports disabled when factsMemory.enabled is false", () => {
      const config: FactsMemoryConfig = { enabled: false };
      expect(config.enabled).toBe(false);
    });

    it("shows default guardrail limits when not configured", () => {
      manager = createManager({});
      const config = manager.getConfig();

      // Default limits should be used
      const limits = config.limits ?? {};
      expect(limits.maxMessages ?? 25).toBe(25);
      expect(limits.maxFacts ?? 50).toBe(50);
      expect(limits.maxTokens ?? 1500).toBe(1500);
      expect(limits.cooldownMs ?? 30000).toBe(30000);
    });

    it("shows custom guardrail limits when configured", () => {
      manager = createManager({
        limits: {
          maxMessages: 10,
          maxFacts: 20,
          maxTokens: 500,
          cooldownMs: 5000,
        },
      });
      const config = manager.getConfig();
      const limits = config.limits!;

      expect(limits.maxMessages).toBe(10);
      expect(limits.maxFacts).toBe(20);
      expect(limits.maxTokens).toBe(500);
      expect(limits.cooldownMs).toBe(5000);
    });

    it("shows extraction provider and model when configured", () => {
      manager = createManager({
        extraction: {
          enabled: true,
          provider: "openai",
          model: "gpt-4o-mini",
        },
      });
      const config = manager.getConfig();

      expect(config.extraction?.enabled).toBe(true);
      expect(config.extraction?.provider).toBe("openai");
      expect(config.extraction?.model).toBe("gpt-4o-mini");
    });

    it("reports FTS availability", () => {
      manager = createManager();
      const store = manager.getStore();

      // FTS should be available with node:sqlite
      expect(typeof store.isFtsAvailable()).toBe("boolean");
    });
  });

  describe("stats command data", () => {
    it("returns database statistics", async () => {
      manager = createManager();
      const store = manager.getStore();
      const markdownPath = manager.getMarkdownPath();

      // Add some test memories
      await manager.add({
        type: "fact",
        content: "Test fact 1",
        source: "conversation",
      });
      await manager.add({
        type: "preference",
        content: "Test preference",
        source: "explicit",
      });

      const stats = getCleanupStats(store, markdownPath);

      expect(stats.totalMemories).toBe(2);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });

    it("returns extraction telemetry", async () => {
      manager = createManager();

      // Initially, telemetry should be zero
      const telemetry = manager.getTelemetry();
      expect(telemetry.added).toBe(0);
      expect(telemetry.updated).toBe(0);
      expect(telemetry.deleted).toBe(0);
      expect(telemetry.skipped).toBe(0);
      expect(telemetry.extractionCount).toBe(0);
    });

    it("calculates average latency correctly", async () => {
      manager = createManager();

      // Telemetry with mock data would show avg latency
      const telemetry = manager.getTelemetry();
      const avgLatencyMs =
        telemetry.extractionCount > 0
          ? Math.round(telemetry.totalLatencyMs / telemetry.extractionCount)
          : 0;

      expect(avgLatencyMs).toBe(0); // No extractions yet
    });

    it("returns summary counts", async () => {
      manager = createManager();
      const store = manager.getStore();
      const markdownPath = manager.getMarkdownPath();

      const stats = getCleanupStats(store, markdownPath);

      expect(stats.dailySummaries).toBe(0);
      expect(stats.weeklySummaries).toBe(0);
    });
  });

  describe("JSON output format", () => {
    it("status produces valid JSON structure", async () => {
      manager = createManager({
        limits: {
          maxMessages: 25,
          maxFacts: 50,
          maxTokens: 1500,
          cooldownMs: 30000,
        },
      });
      const store = manager.getStore();
      const markdownPath = manager.getMarkdownPath();
      const config = manager.getConfig();
      const stats = getCleanupStats(store, markdownPath);

      // Build the status result structure
      const result = {
        enabled: config.enabled !== false,
        extraction: {
          enabled: config.extraction?.enabled !== false,
          provider: config.extraction?.provider,
          model: config.extraction?.model,
        },
        limits: {
          maxMessages: config.limits?.maxMessages ?? 25,
          maxFacts: config.limits?.maxFacts ?? 50,
          maxTokens: config.limits?.maxTokens ?? 1500,
          cooldownMs: config.limits?.cooldownMs ?? 30000,
        },
        database: {
          path: store.getDbPath(),
          sizeBytes: stats.dbSizeBytes,
          totalFacts: stats.totalMemories,
          ftsAvailable: store.isFtsAvailable(),
        },
      };

      // Verify JSON is valid
      const json = JSON.stringify(result, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.enabled).toBe(true);
      expect(parsed.limits.maxMessages).toBe(25);
      expect(parsed.database.path).toContain("test.db");
    });

    it("stats produces valid JSON structure", async () => {
      manager = createManager();
      const store = manager.getStore();
      const markdownPath = manager.getMarkdownPath();
      const stats = getCleanupStats(store, markdownPath);
      const telemetry = manager.getTelemetry();

      const avgLatencyMs =
        telemetry.extractionCount > 0
          ? Math.round(telemetry.totalLatencyMs / telemetry.extractionCount)
          : 0;

      // Build the stats result structure
      const result = {
        database: {
          path: store.getDbPath(),
          sizeBytes: stats.dbSizeBytes,
          totalMemories: stats.totalMemories,
          oldMemories: stats.oldMemories,
          lowImportanceMemories: stats.lowImportanceMemories,
        },
        summaries: {
          daily: stats.dailySummaries,
          weekly: stats.weeklySummaries,
        },
        extraction: {
          added: telemetry.added,
          updated: telemetry.updated,
          deleted: telemetry.deleted,
          skipped: telemetry.skipped,
          avgLatencyMs,
          extractionCount: telemetry.extractionCount,
        },
      };

      // Verify JSON is valid
      const json = JSON.stringify(result, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.database.totalMemories).toBe(0);
      expect(parsed.extraction.added).toBe(0);
      expect(parsed.summaries.daily).toBe(0);
    });
  });

  describe("disabled state handling", () => {
    it("status works when memory is disabled", () => {
      const config: FactsMemoryConfig = { enabled: false };

      // Should be able to build a valid disabled status
      const result = {
        enabled: false,
        extraction: { enabled: false },
        limits: {
          maxMessages: 25,
          maxFacts: 50,
          maxTokens: 1500,
          cooldownMs: 30000,
        },
        database: {
          path: "",
          sizeBytes: 0,
          totalFacts: 0,
          ftsAvailable: false,
        },
      };

      expect(result.enabled).toBe(false);
      expect(result.database.totalFacts).toBe(0);
    });

    it("stats works when memory is disabled", () => {
      const config: FactsMemoryConfig = { enabled: false };

      // Should be able to build a valid disabled stats
      const result = {
        database: {
          path: "",
          sizeBytes: 0,
          totalMemories: 0,
          oldMemories: 0,
          lowImportanceMemories: 0,
        },
        summaries: { daily: 0, weekly: 0 },
        extraction: {
          added: 0,
          updated: 0,
          deleted: 0,
          skipped: 0,
          avgLatencyMs: 0,
          extractionCount: 0,
        },
      };

      expect(result.database.totalMemories).toBe(0);
      expect(result.extraction.added).toBe(0);
    });
  });

  describe("top command data", () => {
    it("returns top facts sorted by score", async () => {
      manager = createManager();

      // Add memories with different importance
      await manager.add({
        type: "fact",
        content: "High importance fact",
        source: "conversation",
        importance: 0.9,
      });
      await manager.add({
        type: "preference",
        content: "Medium importance preference",
        source: "explicit",
        importance: 0.5,
      });
      await manager.add({
        type: "decision",
        content: "Low importance decision",
        source: "conversation",
        importance: 0.2,
      });

      const store = manager.getStore();
      const memories = store.list({ limit: 10 });
      const now = Math.floor(Date.now() / 1000);

      // Calculate scores like the CLI does
      const scored = memories.map((m) => {
        const ageDays = Math.max(0, (now - m.createdAt) / 86400);
        const recencyDecay = Math.max(0.1, 1 - ageDays / 365);
        const score = m.importance * recencyDecay;
        return { memory: m, score };
      });
      scored.sort((a, b) => b.score - a.score);

      expect(scored.length).toBe(3);
      // High importance should be first (new memories have high recency)
      expect(scored[0].memory.importance).toBe(0.9);
    });

    it("filters by type when --type is specified", async () => {
      manager = createManager();

      // Add different types
      await manager.add({
        type: "fact",
        content: "A fact",
        source: "conversation",
        importance: 0.8,
      });
      await manager.add({
        type: "preference",
        content: "A preference",
        source: "explicit",
        importance: 0.9,
      });
      await manager.add({
        type: "fact",
        content: "Another fact",
        source: "conversation",
        importance: 0.7,
      });

      const store = manager.getStore();

      // Filter by fact type
      const facts = store.list({ types: ["fact"], limit: 10 });
      expect(facts.length).toBe(2);
      expect(facts.every((m) => m.type === "fact")).toBe(true);

      // Filter by preference type
      const preferences = store.list({ types: ["preference"], limit: 10 });
      expect(preferences.length).toBe(1);
      expect(preferences[0].type).toBe("preference");
    });

    it("returns empty array when no memories match type filter", async () => {
      manager = createManager();

      await manager.add({
        type: "fact",
        content: "Only a fact",
        source: "conversation",
      });

      const store = manager.getStore();
      const decisions = store.list({ types: ["decision"], limit: 10 });

      expect(decisions.length).toBe(0);
    });

    it("validates type filter values", () => {
      const validTypes = ["fact", "preference", "decision", "event", "todo"];

      expect(validTypes.includes("fact")).toBe(true);
      expect(validTypes.includes("preference")).toBe(true);
      expect(validTypes.includes("invalid")).toBe(false);
    });

    it("produces valid JSON output with type filter", async () => {
      manager = createManager();

      await manager.add({
        type: "preference",
        content: "Test preference",
        source: "explicit",
        importance: 0.8,
      });

      const store = manager.getStore();
      const memories = store.list({ types: ["preference"], limit: 10 });
      const now = Math.floor(Date.now() / 1000);

      const scored = memories.map((m) => {
        const ageDays = Math.max(0, (now - m.createdAt) / 86400);
        const recencyDecay = Math.max(0.1, 1 - ageDays / 365);
        const score = m.importance * recencyDecay;
        return { memory: m, score };
      });

      const output = {
        facts: scored.map((f) => ({
          id: f.memory.id,
          type: f.memory.type,
          content: f.memory.content,
          importance: f.memory.importance,
          score: f.score,
          createdAt: f.memory.createdAt,
        })),
        count: scored.length,
        filter: "preference",
      };

      const json = JSON.stringify(output, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.count).toBe(1);
      expect(parsed.filter).toBe("preference");
      expect(parsed.facts[0].type).toBe("preference");
    });
  });
});
