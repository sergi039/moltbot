import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  saveArtifact,
  loadArtifact,
  loadArtifactJson,
  listArtifacts,
  artifactExists,
  redactSecrets,
  generateManifest,
} from "./store.js";
import { setWorkflowStoragePath } from "../state/persistence.js";

describe("Artifact Store", () => {
  let testStoragePath: string;
  const testRunId = "wf_testabc123";
  const testPhaseId = "planning";
  const testIteration = 1;

  beforeEach(() => {
    testStoragePath = join(os.tmpdir(), `artifact-test-${Date.now()}`);
    setWorkflowStoragePath(testStoragePath);
    mkdirSync(testStoragePath, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testStoragePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("saveArtifact", () => {
    it("should save a text artifact", async () => {
      const metadata = await saveArtifact(
        testRunId,
        testPhaseId,
        testIteration,
        "test.txt",
        "Hello, World!",
      );

      expect(metadata.name).toBe("test.txt");
      expect(metadata.size).toBeGreaterThan(0);
      expect(metadata.contentType).toBe("text/plain");
      expect(existsSync(metadata.path)).toBe(true);
    });

    it("should save a JSON artifact", async () => {
      const data = { foo: "bar", num: 42 };
      const metadata = await saveArtifact(
        testRunId,
        testPhaseId,
        testIteration,
        "data.json",
        JSON.stringify(data),
      );

      expect(metadata.name).toBe("data.json");
      expect(metadata.contentType).toBe("application/json");
    });

    it("should save artifacts in nested directories", async () => {
      const metadata = await saveArtifact(
        testRunId,
        testPhaseId,
        testIteration,
        "nested/deep/file.txt",
        "content",
      );

      expect(metadata.name).toBe("nested/deep/file.txt");
      expect(existsSync(metadata.path)).toBe(true);
    });

    it("should reject blocked file patterns", async () => {
      await expect(
        saveArtifact(testRunId, testPhaseId, testIteration, ".env", "SECRET=foo"),
      ).rejects.toThrow("matches blocked file pattern");
    });

    it("should redact secrets from content", async () => {
      const content = "API key: sk-abc123xyz789012345678901234567890";
      await saveArtifact(testRunId, testPhaseId, testIteration, "log.txt", content);

      const loaded = await loadArtifact(testRunId, testPhaseId, testIteration, "log.txt");
      expect(loaded).toContain("[REDACTED]");
      expect(loaded).not.toContain("sk-abc123xyz");
    });
  });

  describe("loadArtifact", () => {
    it("should load a saved artifact", async () => {
      await saveArtifact(testRunId, testPhaseId, testIteration, "test.txt", "content");

      const loaded = await loadArtifact(testRunId, testPhaseId, testIteration, "test.txt");
      expect(loaded).toBe("content");
    });

    it("should return null for non-existent artifact", async () => {
      const loaded = await loadArtifact(testRunId, testPhaseId, testIteration, "nonexistent.txt");
      expect(loaded).toBeNull();
    });
  });

  describe("loadArtifactJson", () => {
    it("should load and parse JSON artifact", async () => {
      const data = { tasks: [{ id: "1", title: "Test" }] };
      await saveArtifact(testRunId, testPhaseId, testIteration, "tasks.json", JSON.stringify(data));

      const loaded = await loadArtifactJson<typeof data>(
        testRunId,
        testPhaseId,
        testIteration,
        "tasks.json",
      );
      expect(loaded).toEqual(data);
    });

    it("should return null for invalid JSON", async () => {
      await saveArtifact(testRunId, testPhaseId, testIteration, "bad.json", "not valid json");

      const loaded = await loadArtifactJson(testRunId, testPhaseId, testIteration, "bad.json");
      expect(loaded).toBeNull();
    });
  });

  describe("listArtifacts", () => {
    it("should list all artifacts in a phase", async () => {
      await saveArtifact(testRunId, testPhaseId, testIteration, "a.txt", "a");
      await saveArtifact(testRunId, testPhaseId, testIteration, "b.json", '{"b":1}');
      await saveArtifact(testRunId, testPhaseId, testIteration, "nested/c.md", "# C");

      const artifacts = await listArtifacts(testRunId, testPhaseId, testIteration);
      expect(artifacts).toHaveLength(3);
      expect(artifacts.map((a) => a.name)).toContain("a.txt");
      expect(artifacts.map((a) => a.name)).toContain("b.json");
      expect(artifacts.map((a) => a.name)).toContain("nested/c.md");
    });

    it("should return empty array for non-existent phase", async () => {
      const artifacts = await listArtifacts("wf_nonexistent", "phase", 1);
      expect(artifacts).toEqual([]);
    });
  });

  describe("artifactExists", () => {
    it("should return true for existing artifact", async () => {
      await saveArtifact(testRunId, testPhaseId, testIteration, "exists.txt", "yes");

      const exists = await artifactExists(testRunId, testPhaseId, testIteration, "exists.txt");
      expect(exists).toBe(true);
    });

    it("should return false for non-existent artifact", async () => {
      const exists = await artifactExists(testRunId, testPhaseId, testIteration, "nope.txt");
      expect(exists).toBe(false);
    });
  });

  describe("generateManifest", () => {
    it("should generate manifest with all artifacts", async () => {
      await saveArtifact(testRunId, testPhaseId, testIteration, "file1.txt", "content1");
      await saveArtifact(testRunId, testPhaseId, testIteration, "file2.json", '{"x":1}');

      const manifest = await generateManifest(testRunId);

      expect(manifest.workflowId).toBe(testRunId);
      expect(manifest.artifacts).toHaveLength(2);
      expect(manifest.totalSize).toBeGreaterThan(0);
    });
  });
});

describe("redactSecrets", () => {
  it("should redact OpenAI API keys", () => {
    const text = "key: sk-proj-abc123xyz789012345678901234567890123456789";
    const redacted = redactSecrets(text);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk-proj");
  });

  it("should redact Anthropic API keys", () => {
    const text = "ANTHROPIC_API_KEY=sk-ant-api03-abc123-xyz789-etc-more-characters-here";
    const redacted = redactSecrets(text);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk-ant");
  });

  it("should redact GitHub PATs", () => {
    const text = "token: ghp_abcdefghijklmnopqrstuvwxyz123456789012";
    const redacted = redactSecrets(text);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("ghp_");
  });

  it("should redact AWS access keys", () => {
    const text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const redacted = redactSecrets(text);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("AKIA");
  });

  it("should redact Bearer tokens", () => {
    const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx";
    const redacted = redactSecrets(text);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("eyJhbGc");
  });

  it("should preserve non-secret content", () => {
    const text = "This is a normal log message with no secrets.";
    const redacted = redactSecrets(text);
    expect(redacted).toBe(text);
  });
});
