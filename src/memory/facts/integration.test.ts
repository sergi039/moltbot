/**
 * Facts Memory Integration Tests
 *
 * Tests for the integration layer between facts memory and the reply pipeline.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getFactsMemoryManagerInstance,
  resetFactsMemoryManagerInstance,
  getFactsSessionContext,
  addMessageForExtraction,
  flushSessionMessages,
  triggerExtraction,
  createLlmCallBridge,
} from "./integration.js";

describe("Facts Memory Integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-integration-test-"));
    resetFactsMemoryManagerInstance();
  });

  afterEach(() => {
    resetFactsMemoryManagerInstance();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getFactsMemoryManagerInstance", () => {
    it("returns null when disabled", () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: false,
        },
      };
      const manager = getFactsMemoryManagerInstance(cfg);
      expect(manager).toBeNull();
    });

    it("creates manager when enabled", () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: true,
          dbPath: join(tempDir, "facts.db"),
          markdownPath: tempDir,
        },
      };
      const manager = getFactsMemoryManagerInstance(cfg);
      expect(manager).not.toBeNull();
    });

    it("returns same instance on repeated calls", () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: true,
          dbPath: join(tempDir, "facts.db"),
        },
      };
      const manager1 = getFactsMemoryManagerInstance(cfg);
      const manager2 = getFactsMemoryManagerInstance(cfg);
      expect(manager1).toBe(manager2);
    });
  });

  describe("getFactsSessionContext", () => {
    it("returns empty string when disabled", async () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: false,
        },
      };
      const context = await getFactsSessionContext(cfg);
      expect(context).toBe("");
    });

    it("returns context when enabled", async () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: true,
          dbPath: join(tempDir, "facts.db"),
        },
      };
      const context = await getFactsSessionContext(cfg);
      // Empty database returns empty context
      expect(typeof context).toBe("string");
    });
  });

  describe("addMessageForExtraction", () => {
    it("skips when disabled", () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: false,
        },
      };
      // Should not throw
      addMessageForExtraction("session1", "remember my name is Test", cfg);
    });

    it("skips when extraction disabled", () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: true,
          extraction: {
            enabled: false,
          },
        },
      };
      // Should not throw
      addMessageForExtraction("session1", "remember my name is Test", cfg);
    });
  });

  describe("createLlmCallBridge", () => {
    it("returns null when no provider configured", () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: true,
        },
      };
      const bridge = createLlmCallBridge(cfg);
      expect(bridge).toBeNull();
    });

    it("returns null when only provider configured (no model)", () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: true,
          extraction: {
            provider: "anthropic",
          },
        },
      };
      const bridge = createLlmCallBridge(cfg);
      expect(bridge).toBeNull();
    });

    it("returns function when provider and model configured", () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: true,
          extraction: {
            provider: "anthropic",
            model: "claude-3-haiku-20240307",
          },
        },
      };
      const bridge = createLlmCallBridge(cfg);
      expect(bridge).not.toBeNull();
      expect(typeof bridge).toBe("function");
    });
  });

  describe("end-to-end flow", () => {
    it("adds memory and retrieves it", async () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: true,
          dbPath: join(tempDir, "facts.db"),
          markdownPath: tempDir,
        },
      };

      const manager = getFactsMemoryManagerInstance(cfg);
      expect(manager).not.toBeNull();

      // Add a memory directly
      const id = await manager!.add({
        type: "fact",
        content: "User's name is TestUser",
        source: "explicit",
        confidence: 0.95,
        tags: ["identity"],
      });
      expect(id).toBeTruthy();

      // Retrieve via session context
      const context = await getFactsSessionContext(cfg);
      expect(context).toContain("TestUser");
    });

    it("handles explicit remember requests with mock LLM", async () => {
      const cfg: OpenClawConfig = {
        factsMemory: {
          enabled: true,
          dbPath: join(tempDir, "facts.db"),
          markdownPath: tempDir,
          batchSize: 10, // Don't auto-trigger
          extraction: {
            enabled: true,
          },
        },
      };

      const manager = getFactsMemoryManagerInstance(cfg);
      expect(manager).not.toBeNull();

      // Mock LLM call to return a valid extraction
      manager!.setLlmCall(async (_system: string, _user: string) => {
        return JSON.stringify([
          {
            op: "ADD",
            type: "fact",
            content: "User's email is test@example.com",
            confidence: 0.95,
            importance: 0.9,
          },
        ]);
      });

      // Add message to buffer
      addMessageForExtraction("test-session", "remember my email is test@example.com", cfg);

      // Manually trigger and await extraction
      await triggerExtraction("test-session", cfg);

      // Check if memory was extracted by searching
      const results = await manager!.search("email");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.content).toContain("test@example.com");
    });
  });
});
