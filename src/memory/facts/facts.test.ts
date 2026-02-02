/**
 * Facts Memory System Tests
 *
 * Tests for:
 * 1. Classifier - positive/negative cases
 * 2. Extractor - parses valid batch output
 * 3. Memory block update
 * 4. FTS triggers
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryBlock, ExtractionResult } from "./types.js";
import {
  classifyMessage,
  filterMessagesForExtraction,
  shouldExtractFromBatch,
  getBatchPriority,
} from "./classifier.js";
import { extractFromBatch, extractBlockUpdates, createStubLlmCall } from "./extractor.js";
import { FactsMemoryStore, openFactsMemoryStore } from "./store.js";

// ============================================================================
// Test Setup
// ============================================================================

let tempDir: string;
let store: FactsMemoryStore;

function createTempStore(): FactsMemoryStore {
  tempDir = mkdtempSync(join(tmpdir(), "facts-test-"));
  const dbPath = join(tempDir, "test.db");
  return openFactsMemoryStore(dbPath);
}

// ============================================================================
// 1. Classifier Tests
// ============================================================================

describe("classifier", () => {
  describe("classifyMessage", () => {
    it("returns false for trivial messages", () => {
      const result = classifyMessage("hi how are you");
      expect(result.shouldExtract).toBe(false);
    });

    it("returns false for greetings", () => {
      expect(classifyMessage("hello").shouldExtract).toBe(false);
      expect(classifyMessage("hey there").shouldExtract).toBe(false);
      expect(classifyMessage("good morning").shouldExtract).toBe(false);
    });

    it("returns false for acknowledgments", () => {
      expect(classifyMessage("ok").shouldExtract).toBe(false);
      expect(classifyMessage("thanks").shouldExtract).toBe(false);
      expect(classifyMessage("got it").shouldExtract).toBe(false);
      expect(classifyMessage("sounds good").shouldExtract).toBe(false);
    });

    it("returns true for explicit remember commands", () => {
      const result = classifyMessage("remember my name is Sergio");
      expect(result.shouldExtract).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("returns true for preference statements", () => {
      const result = classifyMessage("I prefer dark mode for all my apps");
      expect(result.shouldExtract).toBe(true);
    });

    it("returns true for decision statements", () => {
      const result = classifyMessage("I decided to use TypeScript for this project");
      expect(result.shouldExtract).toBe(true);
    });

    it("returns true for todo items", () => {
      const result = classifyMessage("remind me to call the dentist tomorrow");
      expect(result.shouldExtract).toBe(true);
    });

    it("returns true for factual statements about user", () => {
      const result = classifyMessage("my email is test@example.com");
      expect(result.shouldExtract).toBe(true);
    });

    it("detects memory type hints correctly", () => {
      const prefResult = classifyMessage("I always prefer vim over emacs");
      expect(prefResult.typeHint).toBe("preference");

      const decisionResult = classifyMessage("we decided to go with PostgreSQL");
      expect(decisionResult.typeHint).toBe("decision");

      const todoResult = classifyMessage("don't forget to update the docs");
      expect(todoResult.typeHint).toBe("todo");
    });
  });

  describe("filterMessagesForExtraction", () => {
    it("filters out trivial messages", () => {
      const messages = [
        "hi",
        "remember my name is Alice",
        "ok",
        "I prefer Python over JavaScript",
        "thanks",
      ];
      const { filtered } = filterMessagesForExtraction(messages);
      expect(filtered).toHaveLength(2);
      expect(filtered).toContain("remember my name is Alice");
      expect(filtered).toContain("I prefer Python over JavaScript");
    });

    it("returns empty array for all trivial messages", () => {
      const messages = ["hi", "hello", "ok", "thanks"];
      const { filtered } = filterMessagesForExtraction(messages);
      expect(filtered).toHaveLength(0);
    });
  });

  describe("shouldExtractFromBatch", () => {
    it("returns false for empty batch", () => {
      expect(shouldExtractFromBatch([])).toBe(false);
    });

    it("returns false for batch of only trivial messages", () => {
      expect(shouldExtractFromBatch(["hi", "ok", "thanks"])).toBe(false);
    });

    it("returns true for batch with extractable content", () => {
      expect(shouldExtractFromBatch(["hi", "remember my birthday is Jan 1"])).toBe(true);
    });
  });

  describe("getBatchPriority", () => {
    it("returns skip priority for trivial batch", () => {
      expect(getBatchPriority(["hi", "ok"])).toBe("skip");
    });

    it("returns high priority for explicit commands", () => {
      expect(getBatchPriority(["remember my name is Bob"])).toBe("high");
    });

    it("returns high priority for implicit facts", () => {
      // Facts pattern matches "my email" and returns high priority
      expect(getBatchPriority(["my email is test@example.com"])).toBe("high");
    });
  });
});

// ============================================================================
// 2. Extractor Tests
// ============================================================================

describe("extractor", () => {
  describe("extractFromBatch", () => {
    it("parses valid batch output", async () => {
      // LlmCallFn expects (systemPrompt, userPrompt) => Promise<string>
      const mockLlmCall = async (_system: string, _user: string) =>
        JSON.stringify([
          {
            op: "ADD",
            type: "fact",
            content: "User's name is Alice",
            confidence: 0.95,
            tags: ["identity"],
          },
          {
            op: "ADD",
            type: "preference",
            content: "User prefers dark mode",
            confidence: 0.85,
            tags: ["ui"],
          },
        ]);

      const result = await extractFromBatch(
        {
          messages: ["my name is Alice", "I like dark mode"],
          existingMemories: [],
          currentBlocks: [],
        },
        mockLlmCall,
      );

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].op).toBe("ADD");
      expect(result.results[0].type).toBe("fact");
      expect(result.results[0].content).toBe("User's name is Alice");
      expect(result.results[1].type).toBe("preference");
    });

    it("handles UPDATE operations", async () => {
      const mockLlmCall = async (_system: string, _user: string) =>
        JSON.stringify([
          {
            op: "UPDATE",
            target: "mem-12345678",
            content: "User's name is Bob (changed from Alice)",
            confidence: 0.9,
          },
        ]);

      const result = await extractFromBatch(
        {
          messages: ["actually my name is Bob"],
          existingMemories: [
            {
              id: "mem-12345678",
              type: "fact" as const,
              content: "User's name is Alice",
              source: "conversation" as const,
              confidence: 0.95,
              importance: 0.8,
              createdAt: 1000,
              updatedAt: 1000,
              accessCount: 1,
              lastAccessedAt: 1000,
            },
          ],
          currentBlocks: [],
        },
        mockLlmCall,
      );

      expect(result.success).toBe(true);
      expect(result.results[0].op).toBe("UPDATE");
      expect(result.results[0].target).toBe("mem-12345678");
    });

    it("handles DELETE operations", async () => {
      const mockLlmCall = async (_system: string, _user: string) =>
        JSON.stringify([
          {
            op: "DELETE",
            target: "mem-12345678",
          },
        ]);

      const result = await extractFromBatch(
        {
          messages: ["forget what I said about my name"],
          existingMemories: [
            {
              id: "mem-12345678",
              type: "fact" as const,
              content: "User's name is Alice",
              source: "conversation" as const,
              confidence: 0.95,
              importance: 0.8,
              createdAt: 1000,
              updatedAt: 1000,
              accessCount: 1,
              lastAccessedAt: 1000,
            },
          ],
          currentBlocks: [],
        },
        mockLlmCall,
      );

      expect(result.success).toBe(true);
      expect(result.results[0].op).toBe("DELETE");
      expect(result.results[0].target).toBe("mem-12345678");
    });

    it("handles malformed JSON with retry", async () => {
      let callCount = 0;
      const mockLlmCall = async (_system: string, _user: string) => {
        callCount++;
        if (callCount === 1) {
          return "{ invalid json";
        }
        return JSON.stringify([{ op: "ADD", type: "fact", content: "Test", confidence: 0.8 }]);
      };

      const result = await extractFromBatch(
        {
          messages: ["remember this is a test message"],
          existingMemories: [],
          currentBlocks: [],
        },
        mockLlmCall,
      );

      expect(result.success).toBe(true);
      expect(callCount).toBe(2);
    });

    it("returns failure after max retries", async () => {
      const mockLlmCall = async (_system: string, _user: string) => "not json at all";

      const result = await extractFromBatch(
        {
          messages: ["remember this is a test message"],
          existingMemories: [],
          currentBlocks: [],
        },
        mockLlmCall,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns empty results for NONE operation", async () => {
      const mockLlmCall = async (_system: string, _user: string) => "[]";

      const result = await extractFromBatch(
        {
          messages: ["just chatting"],
          existingMemories: [],
          currentBlocks: [],
        },
        mockLlmCall,
      );

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(0);
    });
  });

  describe("extractBlockUpdates", () => {
    it("extracts block updates from results", async () => {
      const results: ExtractionResult[] = [
        { op: "ADD", type: "fact", content: "User is a software engineer", confidence: 0.9 },
        { op: "ADD", type: "preference", content: "User prefers TypeScript", confidence: 0.85 },
      ];

      const currentBlocks: MemoryBlock[] = [
        { label: "user_profile", value: "No information yet." },
      ];

      const mockLlmCall = async (_system: string, _user: string) =>
        JSON.stringify({
          user_profile: "Software engineer who prefers TypeScript.",
        });

      const updates = await extractBlockUpdates(results, currentBlocks, mockLlmCall);

      expect(updates.user_profile).toBe("Software engineer who prefers TypeScript.");
    });

    it("returns empty object when no updates needed", async () => {
      const results: ExtractionResult[] = [];
      const currentBlocks: MemoryBlock[] = [];

      const mockLlmCall = async (_system: string, _user: string) => "{}";

      const updates = await extractBlockUpdates(results, currentBlocks, mockLlmCall);

      expect(Object.keys(updates)).toHaveLength(0);
    });
  });

  describe("createStubLlmCall", () => {
    it("returns stub response", async () => {
      const stub = createStubLlmCall();
      const result = await stub("system", "user");
      expect(result).toBe("[]");
    });
  });
});

// ============================================================================
// 3. Memory Block Update Tests
// ============================================================================

describe("memory block operations", () => {
  beforeEach(() => {
    store = createTempStore();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("upsertBlock", () => {
    it("creates a new block", () => {
      store.upsertBlock({ label: "user_profile", value: "Test user profile" });

      const block = store.getBlock("user_profile");
      expect(block).not.toBeNull();
      expect(block?.value).toBe("Test user profile");
    });

    it("updates an existing block", () => {
      store.upsertBlock({ label: "user_profile", value: "Initial value" });
      store.upsertBlock({ label: "user_profile", value: "Updated value" });

      const block = store.getBlock("user_profile");
      expect(block?.value).toBe("Updated value");
    });

    it("stores all block types", () => {
      store.upsertBlock({ label: "persona", value: "Helpful assistant" });
      store.upsertBlock({ label: "user_profile", value: "Software developer" });
      store.upsertBlock({ label: "active_context", value: "Working on memory system" });

      const blocks = store.getAllBlocks();
      expect(blocks).toHaveLength(3);

      const labels = blocks.map((b) => b.label);
      expect(labels).toContain("persona");
      expect(labels).toContain("user_profile");
      expect(labels).toContain("active_context");
    });
  });

  describe("getBlock", () => {
    it("returns null for non-existent block", () => {
      const block = store.getBlock("user_profile");
      expect(block).toBeNull();
    });

    it("returns correct block value", () => {
      store.upsertBlock({ label: "persona", value: "Test persona" });

      const block = store.getBlock("persona");
      expect(block?.label).toBe("persona");
      expect(block?.value).toBe("Test persona");
    });
  });

  describe("getAllBlocks", () => {
    it("returns empty array when no blocks", () => {
      const blocks = store.getAllBlocks();
      expect(blocks).toHaveLength(0);
    });

    it("returns all blocks", () => {
      store.upsertBlock({ label: "persona", value: "A" });
      store.upsertBlock({ label: "user_profile", value: "B" });

      const blocks = store.getAllBlocks();
      expect(blocks).toHaveLength(2);
    });
  });
});

// ============================================================================
// 4. FTS Trigger Tests
// ============================================================================

describe("FTS triggers", () => {
  beforeEach(() => {
    store = createTempStore();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("INSERT trigger", () => {
    it("indexes new memories in FTS", () => {
      const id = store.add({
        type: "fact",
        content: "User works at OpenAI",
        source: "explicit",
        confidence: 0.95,
      });

      // Search should find it
      const results = store.searchFts("OpenAI");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.entry.id === id)).toBe(true);
    });

    it("stores tags on memory entry", () => {
      const id = store.add({
        type: "fact",
        content: "User's email is test@example.com",
        source: "explicit",
        confidence: 0.9,
        tags: ["contact", "email"],
      });

      // Verify tags are stored correctly
      const memory = store.get(id);
      expect(memory?.tags).toContain("contact");
      expect(memory?.tags).toContain("email");
    });
  });

  describe("UPDATE trigger", () => {
    it("updates FTS index on content change", () => {
      const id = store.add({
        type: "fact",
        content: "User works at Google",
        source: "conversation",
        confidence: 0.8,
      });

      // Update content
      store.update(id, { content: "User works at Microsoft" });

      // Old content should not be found
      const oldResults = store.searchFts("Google");
      expect(oldResults.some((r) => r.entry.id === id)).toBe(false);

      // New content should be found
      const newResults = store.searchFts("Microsoft");
      expect(newResults.some((r) => r.entry.id === id)).toBe(true);
    });

    it("updates tags on memory entry", () => {
      const id = store.add({
        type: "preference",
        content: "User prefers dark mode",
        source: "conversation",
        confidence: 0.85,
        tags: ["ui"],
      });

      // Update tags
      store.update(id, { tags: ["ui", "theme", "visual"] });

      // Verify tags are updated correctly
      const memory = store.get(id);
      expect(memory?.tags).toContain("visual");
      expect(memory?.tags).toHaveLength(3);
    });
  });

  describe("DELETE trigger", () => {
    it("removes deleted memories from FTS", () => {
      const id = store.add({
        type: "fact",
        content: "User has a cat named Whiskers",
        source: "conversation",
        confidence: 0.9,
      });

      // Verify it's searchable
      let results = store.searchFts("Whiskers");
      expect(results.some((r) => r.entry.id === id)).toBe(true);

      // Delete it
      store.delete(id);

      // Should no longer be found
      results = store.searchFts("Whiskers");
      expect(results.some((r) => r.entry.id === id)).toBe(false);
    });
  });

  describe("FTS search functionality", () => {
    it("searches across content", () => {
      store.add({
        type: "fact",
        content: "User's birthday is January 15",
        source: "explicit",
        confidence: 0.95,
        tags: ["personal", "birthday"],
      });

      store.add({
        type: "preference",
        content: "User prefers morning meetings",
        source: "conversation",
        confidence: 0.8,
        tags: ["work", "schedule"],
      });

      // Search by content
      const birthdayResults = store.searchFts("birthday");
      expect(birthdayResults.length).toBeGreaterThanOrEqual(1);

      // Search by content keyword
      const morningResults = store.searchFts("morning");
      expect(morningResults.length).toBeGreaterThanOrEqual(1);
    });

    it("handles special characters in search", () => {
      store.add({
        type: "fact",
        content: "User's email is test@example.com",
        source: "explicit",
        confidence: 0.9,
      });

      // Search with special characters
      const results = store.searchFts("test@example.com");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("respects type filter in search options", () => {
      store.add({
        type: "fact",
        content: "Critical fact about user",
        source: "explicit",
        confidence: 0.95,
        importance: 0.9,
      });

      store.add({
        type: "preference",
        content: "Critical preference setting",
        source: "conversation",
        confidence: 0.8,
        importance: 0.3,
      });

      // Without filter, both results found
      const allResults = store.searchFts("Critical");
      expect(allResults.length).toBe(2);

      // Filter by type works
      const factResults = store.searchFts("Critical", { types: ["fact"] });
      expect(factResults.length).toBe(1);
      expect(factResults[0].entry.type).toBe("fact");

      // Filter by preference type
      const prefResults = store.searchFts("Critical", { types: ["preference"] });
      expect(prefResults.length).toBe(1);
      expect(prefResults[0].entry.type).toBe("preference");
    });

    it("limits results", () => {
      // Add multiple memories
      for (let i = 0; i < 10; i++) {
        store.add({
          type: "fact",
          content: `Test memory number ${i}`,
          source: "conversation",
          confidence: 0.8,
        });
      }

      const results = store.searchFts("memory", { limit: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });
});

// ============================================================================
// Additional Store Tests
// ============================================================================

describe("store operations", () => {
  beforeEach(() => {
    store = createTempStore();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("CRUD operations", () => {
    it("adds and retrieves a memory", () => {
      const id = store.add({
        type: "fact",
        content: "Test content",
        source: "explicit",
        confidence: 0.9,
      });

      const memory = store.get(id);
      expect(memory).not.toBeNull();
      expect(memory?.content).toBe("Test content");
      expect(memory?.type).toBe("fact");
      expect(memory?.source).toBe("explicit");
    });

    it("updates a memory", () => {
      const id = store.add({
        type: "fact",
        content: "Original content",
        source: "conversation",
        confidence: 0.8,
      });

      store.update(id, { content: "Updated content", confidence: 0.9 });

      const memory = store.get(id);
      expect(memory?.content).toBe("Updated content");
      expect(memory?.confidence).toBe(0.9);
    });

    it("deletes a memory", () => {
      const id = store.add({
        type: "fact",
        content: "To be deleted",
        source: "conversation",
        confidence: 0.8,
      });

      const deleted = store.delete(id);
      expect(deleted).toBe(true);

      const memory = store.get(id);
      expect(memory).toBeNull();
    });

    it("returns false when deleting non-existent memory", () => {
      const deleted = store.delete("non-existent-id");
      expect(deleted).toBe(false);
    });
  });

  describe("supersession", () => {
    it("supersedes a memory", () => {
      const oldId = store.add({
        type: "fact",
        content: "Old fact",
        source: "conversation",
        confidence: 0.8,
      });

      const newId = store.supersede(oldId, {
        type: "fact",
        content: "New fact replacing old",
        source: "conversation",
        confidence: 0.9,
      });

      expect(newId).not.toBeNull();

      // Old memory should be deleted
      const oldMemory = store.get(oldId);
      expect(oldMemory).toBeNull();

      // New memory should exist with supersedes reference
      const newMemory = store.get(newId!);
      expect(newMemory?.content).toBe("New fact replacing old");
      expect(newMemory?.supersedes).toBe(oldId);
    });

    it("limits supersession chain depth", () => {
      // Create initial memory
      const id1 = store.add({
        type: "fact",
        content: "Version 1",
        source: "conversation",
        confidence: 0.8,
      });

      // Supersede 3 times (each supersession increments chain depth)
      // After supersede, the old entry is deleted but new entry tracks supersedes
      const id2 = store.supersede(id1, {
        type: "fact",
        content: "Version 2",
        source: "conversation",
        confidence: 0.8,
      });
      expect(id2).not.toBeNull();

      const id3 = store.supersede(id2!, {
        type: "fact",
        content: "Version 3",
        source: "conversation",
        confidence: 0.8,
      });
      expect(id3).not.toBeNull();

      const id4 = store.supersede(id3!, {
        type: "fact",
        content: "Version 4",
        source: "conversation",
        confidence: 0.8,
      });
      expect(id4).not.toBeNull();

      // Fifth supersession should fail (depth = 3 at this point)
      const id5 = store.supersede(id4!, {
        type: "fact",
        content: "Version 5",
        source: "conversation",
        confidence: 0.8,
      });

      expect(id5).toBeNull();
    });
  });

  describe("list operations", () => {
    it("lists all memories", () => {
      store.add({ type: "fact", content: "A", source: "explicit", confidence: 0.9 });
      store.add({ type: "preference", content: "B", source: "conversation", confidence: 0.8 });
      store.add({ type: "decision", content: "C", source: "conversation", confidence: 0.85 });

      const memories = store.list();
      expect(memories).toHaveLength(3);
    });

    it("filters by type", () => {
      store.add({ type: "fact", content: "A", source: "explicit", confidence: 0.9 });
      store.add({ type: "preference", content: "B", source: "conversation", confidence: 0.8 });
      store.add({ type: "fact", content: "C", source: "conversation", confidence: 0.85 });

      const facts = store.list({ types: ["fact"] });
      expect(facts).toHaveLength(2);
      expect(facts.every((m) => m.type === "fact")).toBe(true);
    });

    it("filters by minimum importance", () => {
      store.add({
        type: "fact",
        content: "High importance",
        source: "explicit",
        confidence: 0.9,
        importance: 0.9,
      });
      store.add({
        type: "fact",
        content: "Low importance",
        source: "conversation",
        confidence: 0.8,
        importance: 0.3,
      });

      const important = store.list({ minImportance: 0.5 });
      expect(important).toHaveLength(1);
      expect(important[0].content).toBe("High importance");
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        store.add({
          type: "fact",
          content: `Memory ${i}`,
          source: "conversation",
          confidence: 0.8,
        });
      }

      const limited = store.list({ limit: 5 });
      expect(limited).toHaveLength(5);
    });
  });

  describe("access tracking", () => {
    it("increments access count on get", () => {
      const id = store.add({
        type: "fact",
        content: "Test",
        source: "conversation",
        confidence: 0.8,
      });

      // First get returns initial count (0), then increments in DB
      let memory = store.get(id);
      expect(memory?.accessCount).toBe(0);

      // Second get returns the incremented count (1)
      memory = store.get(id);
      expect(memory?.accessCount).toBe(1);

      // Third get returns (2)
      memory = store.get(id);
      expect(memory?.accessCount).toBe(2);
    });
  });
});
