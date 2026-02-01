/**
 * Facts Memory Migration Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openFactsMemoryStore, type FactsMemoryStore } from "./store.js";
import {
  parseMemoryFile,
  migrateMemoryFile,
  migrateMemoryDirectory,
  exportToMemoryFile,
} from "./migrate.js";

describe("Facts Memory Migration", () => {
  let tempDir: string;
  let store: FactsMemoryStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-migrate-test-"));
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

  describe("parseMemoryFile", () => {
    it("parses user profile block", () => {
      const content = `## User Profile

Name: John Doe
Location: San Francisco
Occupation: Software Engineer`;

      const result = parseMemoryFile(content);

      expect(result.blocks.has("user_profile")).toBe(true);
      expect(result.blocks.get("user_profile")).toContain("John Doe");
    });

    it("parses persona block", () => {
      const content = `## Persona

A helpful AI assistant that specializes in coding.`;

      const result = parseMemoryFile(content);

      expect(result.blocks.has("persona")).toBe(true);
      expect(result.blocks.get("persona")).toContain("helpful AI");
    });

    it("parses facts as memories", () => {
      const content = `## Facts

- User works at TechCorp
- User has a dog named Max
- User prefers morning meetings`;

      const result = parseMemoryFile(content);

      expect(result.memories.length).toBe(3);
      expect(result.memories[0].type).toBe("fact");
      expect(result.memories[0].content).toBe("User works at TechCorp");
    });

    it("parses preferences as memories", () => {
      const content = `## Preferences

- Dark mode enabled
- Vim keybindings
- Compact notifications`;

      const result = parseMemoryFile(content);

      expect(result.memories.length).toBe(3);
      expect(result.memories.every((m) => m.type === "preference")).toBe(true);
    });

    it("parses decisions as memories", () => {
      const content = `## Decisions

- Use TypeScript for all new projects
- Deploy to AWS
- Weekly code reviews`;

      const result = parseMemoryFile(content);

      expect(result.memories.length).toBe(3);
      expect(result.memories.every((m) => m.type === "decision")).toBe(true);
    });

    it("extracts tags from items", () => {
      const content = `## Facts

- [identity, name] User's name is John
- [work] Works at TechCorp`;

      const result = parseMemoryFile(content);

      expect(result.memories[0].tags).toEqual(["identity", "name"]);
      expect(result.memories[0].content).toBe("User's name is John");
      expect(result.memories[1].tags).toEqual(["work"]);
    });

    it("handles mixed content", () => {
      const content = `## User Profile

Name: John

## Facts

- Fact 1
- Fact 2

## Preferences

- Preference 1`;

      const result = parseMemoryFile(content);

      expect(result.blocks.size).toBe(1);
      expect(result.memories.length).toBe(3);
    });

    it("skips empty lines and short items", () => {
      const content = `## Facts

- Valid fact here

- A

-

- Another valid fact`;

      const result = parseMemoryFile(content);

      expect(result.memories.length).toBe(2);
    });

    it("handles numbered lists", () => {
      const content = `## Facts

1. First fact
2. Second fact
3. Third fact`;

      const result = parseMemoryFile(content);

      expect(result.memories.length).toBe(3);
      expect(result.memories[0].content).toBe("First fact");
    });
  });

  describe("migrateMemoryFile", () => {
    it("imports blocks to database", () => {
      const content = `## User Profile

Name: TestUser
Location: TestCity`;

      const filePath = join(tempDir, "MEMORY.md");
      writeFileSync(filePath, content);

      const result = migrateMemoryFile(filePath, store);

      expect(result.success).toBe(true);
      expect(result.blocksImported).toBe(1);

      const block = store.getBlock("user_profile");
      expect(block).not.toBeNull();
      expect(block!.value).toContain("TestUser");
    });

    it("imports memories to database", () => {
      const content = `## Facts

- User's name is TestUser
- User works at TestCorp`;

      const filePath = join(tempDir, "MEMORY.md");
      writeFileSync(filePath, content);

      const result = migrateMemoryFile(filePath, store);

      expect(result.success).toBe(true);
      expect(result.memoriesImported).toBe(2);

      const memories = store.list();
      expect(memories.length).toBe(2);
    });

    it("skips duplicate memories", () => {
      const content = `## Facts

- Existing fact`;

      const filePath = join(tempDir, "MEMORY.md");
      writeFileSync(filePath, content);

      // First migration
      migrateMemoryFile(filePath, store);

      // Second migration
      const result = migrateMemoryFile(filePath, store);

      expect(result.skipped).toBe(1);
      expect(result.memoriesImported).toBe(0);
    });

    it("returns error for missing file", () => {
      const result = migrateMemoryFile("/nonexistent/file.md", store);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("migrateMemoryDirectory", () => {
    it("migrates MEMORY.md from directory", () => {
      const content = `## Facts

- Directory fact`;

      writeFileSync(join(tempDir, "MEMORY.md"), content);

      const result = migrateMemoryDirectory(tempDir, store);

      expect(result.success).toBe(true);
      expect(result.memoriesImported).toBe(1);
    });

    it("tries multiple file names", () => {
      const content = `## Facts

- Lowercase fact`;

      writeFileSync(join(tempDir, "memory.md"), content);

      const result = migrateMemoryDirectory(tempDir, store);

      expect(result.success).toBe(true);
      expect(result.memoriesImported).toBe(1);
    });
  });

  describe("exportToMemoryFile", () => {
    it("exports blocks to markdown", () => {
      store.upsertBlock({
        label: "user_profile",
        value: "Name: ExportUser",
      });

      const markdown = exportToMemoryFile(store);

      expect(markdown).toContain("## User Profile");
      expect(markdown).toContain("ExportUser");
    });

    it("exports memories by type", () => {
      store.add({
        type: "fact",
        content: "A fact to export",
        source: "explicit",
      });
      store.add({
        type: "preference",
        content: "A preference to export",
        source: "explicit",
      });

      const markdown = exportToMemoryFile(store);

      expect(markdown).toContain("## Facts");
      expect(markdown).toContain("A fact to export");
      expect(markdown).toContain("## Preferences");
      expect(markdown).toContain("A preference to export");
    });

    it("includes tags in export", () => {
      store.add({
        type: "fact",
        content: "Tagged fact",
        source: "explicit",
        tags: ["tag1", "tag2"],
      });

      const markdown = exportToMemoryFile(store);

      expect(markdown).toContain("[tag1, tag2]");
      expect(markdown).toContain("Tagged fact");
    });
  });

  describe("Round-trip", () => {
    it("imports and exports preserve data", () => {
      const original = `## User Profile

Name: RoundtripUser

## Facts

- [identity] User name is RoundtripUser
- User works remotely`;

      const filePath = join(tempDir, "MEMORY.md");
      writeFileSync(filePath, original);

      // Import
      migrateMemoryFile(filePath, store);

      // Export
      const exported = exportToMemoryFile(store);

      // Verify key content is preserved
      expect(exported).toContain("RoundtripUser");
      expect(exported).toContain("works remotely");
      expect(exported).toContain("[identity]");
    });
  });
});
