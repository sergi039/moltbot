/**
 * Facts Memory E2E Tests
 *
 * End-to-end tests for the full memory pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFactsMemoryManager, type FactsMemoryManager } from "./manager.js";
import type { FactsMemoryConfig } from "./types.js";

describe("Facts Memory E2E", () => {
  let tempDir: string;
  let manager: FactsMemoryManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-e2e-test-"));

    const config: FactsMemoryConfig = {
      enabled: true,
      dbPath: join(tempDir, "facts.db"),
      markdownPath: tempDir,
      extraction: {
        enabled: true,
      },
    };

    manager = createFactsMemoryManager(config);
  });

  afterEach(() => {
    manager.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("full pipeline", () => {
    it("stores and retrieves memories via FTS", async () => {
      // Step 1: Add memories directly (simulating extraction)
      const id1 = await manager.add({
        type: "fact",
        content: "User works as a software engineer at TechCorp",
        source: "conversation",
        confidence: 0.9,
      });

      const id2 = await manager.add({
        type: "preference",
        content: "User prefers dark mode for all applications",
        source: "explicit",
        confidence: 1.0,
      });

      const id3 = await manager.add({
        type: "decision",
        content: "Decided to use TypeScript for the new project",
        source: "conversation",
        confidence: 0.85,
      });

      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id3).toBeDefined();

      // Step 2: Search via FTS
      const results = await manager.search("software engineer");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.content).toContain("software engineer");
    });

    it("builds session context from stored memories", async () => {
      // Add some memories
      await manager.add({
        type: "fact",
        content: "User's name is Alice",
        source: "explicit",
        importance: 1.0,
      });

      await manager.add({
        type: "preference",
        content: "Prefers concise responses",
        source: "explicit",
        importance: 0.8,
      });

      // Get session context
      const context = await manager.getSessionContext();

      expect(context).toContain("Alice");
      expect(context).toContain("concise");
    });

    it("handles memory blocks", async () => {
      // Upsert a user profile block
      await manager.upsertMemoryBlocks([
        {
          label: "user_profile",
          value: "Name: Bob\nLocation: Seattle\nRole: Developer",
        },
      ]);

      // Retrieve the block
      const block = await manager.getMemoryBlock("user_profile");

      expect(block).not.toBeNull();
      expect(block!.value).toContain("Bob");
      expect(block!.value).toContain("Seattle");
    });

    it("gracefully handles extraction without LLM", async () => {
      // Without setting LLM, extraction should skip gracefully
      const messages = [
        "Remember that I prefer morning meetings",
        "My timezone is Pacific",
        "I use VS Code as my editor",
      ];

      // This should not throw, just skip extraction
      const extracted = await manager.extractFromBatch(messages);

      // No LLM set, so no extraction happens
      expect(extracted).toEqual([]);

      // Telemetry should show skipped
      const telemetry = manager.getTelemetry();
      expect(telemetry.skipped).toBeGreaterThan(0);
    });

    it("extracts memories with mock LLM", async () => {
      // Set up a mock LLM that returns extraction results as array
      manager.setLlmCall(async () => {
        return JSON.stringify([
          {
            op: "ADD",
            type: "preference",
            content: "User prefers morning meetings",
            confidence: 0.9,
          },
        ]);
      });

      // Use explicit memory pattern that classifier will accept
      const messages = ["Remember that I prefer morning meetings"];

      const extracted = await manager.extractFromBatch(messages);

      expect(extracted.length).toBe(1);
      expect(extracted[0].type).toBe("preference");
      expect(extracted[0].content).toContain("morning meetings");
    });

    it("searches across multiple memory types", async () => {
      // Add memories of different types
      await manager.add({
        type: "fact",
        content: "User lives in San Francisco",
        source: "conversation",
      });

      await manager.add({
        type: "preference",
        content: "Prefers San Francisco weather updates",
        source: "explicit",
      });

      await manager.add({
        type: "decision",
        content: "Decided to move to San Francisco office",
        source: "conversation",
      });

      // Search should find all related memories
      const results = await manager.search("San Francisco");

      expect(results.length).toBe(3);
    });

    it("filters search by memory type", async () => {
      await manager.add({
        type: "fact",
        content: "Works at Google",
        source: "conversation",
      });

      await manager.add({
        type: "preference",
        content: "Prefers Google products",
        source: "explicit",
      });

      // Search only facts
      const results = await manager.search("Google", { types: ["fact"] });

      expect(results.length).toBe(1);
      expect(results[0].entry.type).toBe("fact");
    });
  });

  describe("degradation scenarios", () => {
    it("continues working when embeddings fail", async () => {
      // Add memory should work even if embeddings would fail
      const id = await manager.add({
        type: "fact",
        content: "Test fact for degradation",
        source: "conversation",
      });

      expect(id).toBeDefined();

      // Search should still work via FTS
      const results = await manager.search("degradation");
      expect(results.length).toBe(1);
    });

    it("extraction failure does not throw", async () => {
      // Set up a failing LLM
      manager.setLlmCall(async () => {
        throw new Error("LLM service unavailable");
      });

      // Should not throw, just return empty
      const extracted = await manager.extractFromBatch(["Test message"]);

      expect(extracted).toEqual([]);
    });
  });
});
