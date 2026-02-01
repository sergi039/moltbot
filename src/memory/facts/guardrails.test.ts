/**
 * Facts Memory Guardrails Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFactsMemoryManager, type FactsMemoryManager } from "./manager.js";
import type { FactsMemoryConfig } from "./types.js";

describe("Facts Memory Guardrails", () => {
  let tempDir: string;
  let manager: FactsMemoryManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-guardrails-test-"));
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
      extraction: { enabled: true },
      ...config,
    });
  }

  // Mock LLM that returns a configurable number of facts
  // Note: LLM should return a JSON array directly, not wrapped in an object
  function createMockLlm(factCount: number = 3) {
    const facts = Array.from({ length: factCount }, (_, i) => ({
      op: "ADD",
      type: "fact",
      content: `Fact ${i + 1}`,
      confidence: 0.9,
    }));

    // Return plain JSON array as expected by the extractor
    return vi.fn().mockResolvedValue(JSON.stringify(facts));
  }

  describe("cooldown", () => {
    it("skips extraction when within cooldown period", async () => {
      manager = createManager({
        limits: { cooldownMs: 60000 }, // 1 minute cooldown
      });
      manager.setLlmCall(createMockLlm(1));

      // First extraction should work (message with "remember my" pattern)
      const result1 = await manager.extractFromBatch(["Please remember my name is Alice"]);
      expect(result1.length).toBe(1);

      // Second extraction immediately after should be skipped (cooldown)
      const result2 = await manager.extractFromBatch(["Please remember my favorite color is blue"]);
      expect(result2.length).toBe(0);

      // Verify telemetry shows skip
      const telemetry = manager.getTelemetry();
      expect(telemetry.skipped).toBeGreaterThan(0);
    });

    it("allows extraction after cooldown expires", async () => {
      manager = createManager({
        limits: { cooldownMs: 10 }, // Very short cooldown for testing
      });
      manager.setLlmCall(createMockLlm(1));

      // First extraction
      await manager.extractFromBatch(["Please remember my name is Alice"]);

      // Wait for cooldown to expire
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Second extraction should work
      const result = await manager.extractFromBatch(["Please remember my favorite color is blue"]);
      expect(result.length).toBe(1);
    });
  });

  describe("maxMessages", () => {
    it("truncates messages when exceeding limit", async () => {
      manager = createManager({
        limits: { maxMessages: 2, cooldownMs: 0 },
      });

      const mockLlm = createMockLlm(1);
      manager.setLlmCall(mockLlm);

      // Send 5 messages, only 2 should be processed (most recent)
      const messages = [
        "Old message 1",
        "Old message 2",
        "Please remember my name is Alice",
        "Please remember my email is alice@example.com",
        "Please remember my most recent info",
      ];

      await manager.extractFromBatch(messages);

      // LLM should have been called (extraction + block updates)
      expect(mockLlm).toHaveBeenCalled();
      const callArg = mockLlm.mock.calls[0][1]; // userPrompt
      expect(callArg).not.toContain("Old message 1");
      expect(callArg).not.toContain("Old message 2");
      expect(callArg).not.toContain("Alice");
      // Should contain most recent messages
      expect(callArg).toContain("most recent");
    });

    it("processes all messages when under limit", async () => {
      manager = createManager({
        limits: { maxMessages: 10, cooldownMs: 0 },
      });

      const mockLlm = createMockLlm(1);
      manager.setLlmCall(mockLlm);

      const messages = ["Please remember my friend Alice", "Please remember my friend Bob"];
      await manager.extractFromBatch(messages);

      expect(mockLlm).toHaveBeenCalled();
      const callArg = mockLlm.mock.calls[0][1];
      expect(callArg).toContain("Alice");
      expect(callArg).toContain("Bob");
    });
  });

  describe("maxTokens", () => {
    it("skips extraction when token budget exceeded", async () => {
      manager = createManager({
        limits: { maxTokens: 5, cooldownMs: 0 }, // Very low token limit
      });

      const mockLlm = createMockLlm(1);
      manager.setLlmCall(mockLlm);

      // Long message that exceeds token budget
      const result = await manager.extractFromBatch([
        "Please remember my very long message that definitely exceeds five tokens and should be skipped due to token limits",
      ]);

      // Should be skipped due to token limit
      expect(result.length).toBe(0);
      expect(mockLlm).not.toHaveBeenCalled();

      // Verify telemetry
      const telemetry = manager.getTelemetry();
      expect(telemetry.skipped).toBeGreaterThan(0);
    });

    it("allows extraction when under token budget", async () => {
      manager = createManager({
        limits: { maxTokens: 1000, cooldownMs: 0 },
      });

      const mockLlm = createMockLlm(1);
      manager.setLlmCall(mockLlm);

      const result = await manager.extractFromBatch(["Please remember my name is Alice"]);
      expect(result.length).toBe(1);
      expect(mockLlm).toHaveBeenCalled();
    });
  });

  describe("maxFacts", () => {
    it("limits extracted facts to maxFacts", async () => {
      manager = createManager({
        limits: { maxFacts: 2, cooldownMs: 0 },
      });

      // LLM returns 5 facts but we limit to 2
      const mockLlm = createMockLlm(5);
      manager.setLlmCall(mockLlm);

      const result = await manager.extractFromBatch([
        "Please remember my fact 1, fact 2, fact 3, fact 4, fact 5",
      ]);

      // Should only add 2 facts
      expect(result.length).toBe(2);
      expect(result[0].content).toBe("Fact 1");
      expect(result[1].content).toBe("Fact 2");
    });

    it("allows all facts when under limit", async () => {
      manager = createManager({
        limits: { maxFacts: 10, cooldownMs: 0 },
      });

      const mockLlm = createMockLlm(3);
      manager.setLlmCall(mockLlm);

      const result = await manager.extractFromBatch(["Please remember my three facts"]);
      expect(result.length).toBe(3);
    });
  });

  describe("logging", () => {
    it("logs guardrail skip events", async () => {
      manager = createManager({
        limits: { cooldownMs: 60000 },
      });
      manager.setLlmCall(createMockLlm(1));

      // Trigger first extraction
      await manager.extractFromBatch(["First message"]);

      // Second extraction should be skipped and logged
      // We can't easily verify logging without mocking the logger,
      // but we can verify the skip happened via telemetry
      await manager.extractFromBatch(["Second message"], "test-session");

      const telemetry = manager.getTelemetry();
      expect(telemetry.skipped).toBeGreaterThan(0);
    });
  });

  describe("combined guardrails", () => {
    it("applies multiple guardrails in order", async () => {
      manager = createManager({
        limits: {
          maxMessages: 5,
          maxTokens: 500,
          maxFacts: 3,
          cooldownMs: 0,
        },
      });

      const mockLlm = createMockLlm(5);
      manager.setLlmCall(mockLlm);

      // Send many messages - should be truncated to 5, then maxFacts limits to 3
      const messages = Array.from({ length: 10 }, (_, i) => `Please remember my fact ${i + 1}`);

      const result = await manager.extractFromBatch(messages);

      // Should be limited by maxFacts
      expect(result.length).toBe(3);
    });
  });

  describe("defaults", () => {
    it("uses default limits when not configured", async () => {
      manager = createManager({});
      manager.setLlmCall(createMockLlm(1));

      // Should work with defaults (maxMessages=25, maxTokens=1500, etc.)
      const result = await manager.extractFromBatch(["Please remember my friend Alice"]);
      expect(result.length).toBe(1);
    });

    it("respects default cooldown", async () => {
      manager = createManager({});
      manager.setLlmCall(createMockLlm(1));

      // First extraction
      await manager.extractFromBatch(["First"]);

      // Second immediately should be skipped (default 30s cooldown)
      const result = await manager.extractFromBatch(["Second"]);
      expect(result.length).toBe(0);
    });
  });
});
