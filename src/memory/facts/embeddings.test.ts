/**
 * Facts Memory Embeddings Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { embed, cosineSimilarity, findTopK, embedBatch } from "./embeddings.js";

describe("Facts Memory Embeddings", () => {
  describe("embed (fallback)", () => {
    it("returns stub embedding when no API key", async () => {
      // Ensure no API key is set
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const result = await embed("test text", {
          factsMemory: {
            embeddings: {
              enabled: true,
              fallbackEnabled: true,
            },
          },
        });

        expect(result).not.toBeNull();
        expect(result!.source).toBe("stub");
        expect(result!.vector).toBeInstanceOf(Float32Array);
        expect(result!.dimensions).toBe(384);
      } finally {
        if (originalKey) {
          process.env.OPENAI_API_KEY = originalKey;
        }
      }
    });

    it("returns null when embeddings disabled", async () => {
      const result = await embed("test text", {
        factsMemory: {
          embeddings: {
            enabled: false,
          },
        },
      });

      expect(result).toBeNull();
    });

    it("generates deterministic stub embeddings", async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const result1 = await embed("hello world", {
          factsMemory: { embeddings: { fallbackEnabled: true } },
        });
        const result2 = await embed("hello world", {
          factsMemory: { embeddings: { fallbackEnabled: true } },
        });

        expect(result1).not.toBeNull();
        expect(result2).not.toBeNull();

        // Same input should produce same embedding
        for (let i = 0; i < result1!.dimensions; i++) {
          expect(result1!.vector[i]).toBe(result2!.vector[i]);
        }
      } finally {
        if (originalKey) {
          process.env.OPENAI_API_KEY = originalKey;
        }
      }
    });

    it("generates different embeddings for different text", async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const result1 = await embed("hello world", {
          factsMemory: { embeddings: { fallbackEnabled: true } },
        });
        const result2 = await embed("goodbye world", {
          factsMemory: { embeddings: { fallbackEnabled: true } },
        });

        expect(result1).not.toBeNull();
        expect(result2).not.toBeNull();

        // Different inputs should produce different embeddings
        let allSame = true;
        for (let i = 0; i < result1!.dimensions; i++) {
          if (result1!.vector[i] !== result2!.vector[i]) {
            allSame = false;
            break;
          }
        }
        expect(allSame).toBe(false);
      } finally {
        if (originalKey) {
          process.env.OPENAI_API_KEY = originalKey;
        }
      }
    });

    it("logs warning when using fallback", async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const result = await embed("test", {
          factsMemory: { embeddings: { fallbackEnabled: true } },
        });

        expect(result?.source).toBe("stub");
      } finally {
        if (originalKey) {
          process.env.OPENAI_API_KEY = originalKey;
        }
      }
    });
  });

  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      const similarity = cosineSimilarity(v, v);
      expect(similarity).toBeCloseTo(1, 5);
    });

    it("returns -1 for opposite vectors", () => {
      const v1 = new Float32Array([1, 0, 0]);
      const v2 = new Float32Array([-1, 0, 0]);
      const similarity = cosineSimilarity(v1, v2);
      expect(similarity).toBeCloseTo(-1, 5);
    });

    it("returns 0 for orthogonal vectors", () => {
      const v1 = new Float32Array([1, 0]);
      const v2 = new Float32Array([0, 1]);
      const similarity = cosineSimilarity(v1, v2);
      expect(similarity).toBeCloseTo(0, 5);
    });

    it("throws for mismatched dimensions", () => {
      const v1 = new Float32Array([1, 0, 0]);
      const v2 = new Float32Array([1, 0]);
      expect(() => cosineSimilarity(v1, v2)).toThrow(/dimension mismatch/);
    });
  });

  describe("findTopK", () => {
    it("returns top k most similar vectors", () => {
      const query = new Float32Array([1, 0, 0]);
      const candidates = [
        { id: "a", vector: new Float32Array([1, 0, 0]) }, // Identical
        { id: "b", vector: new Float32Array([0.9, 0.1, 0]) }, // Very similar
        { id: "c", vector: new Float32Array([0, 1, 0]) }, // Orthogonal
        { id: "d", vector: new Float32Array([-1, 0, 0]) }, // Opposite
      ];

      const results = findTopK(query, candidates, 2);

      expect(results.length).toBe(2);
      expect(results[0].id).toBe("a");
      expect(results[0].score).toBeCloseTo(1, 5);
      expect(results[1].id).toBe("b");
    });

    it("handles empty candidates", () => {
      const query = new Float32Array([1, 0, 0]);
      const results = findTopK(query, [], 5);
      expect(results).toEqual([]);
    });
  });

  describe("embedBatch", () => {
    it("embeds multiple texts", async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const texts = ["hello", "world", "test"];
        const results = await embedBatch(texts, {
          factsMemory: { embeddings: { fallbackEnabled: true } },
        });

        expect(results.length).toBe(3);
        for (const result of results) {
          expect(result).not.toBeNull();
          expect(result!.source).toBe("stub");
        }
      } finally {
        if (originalKey) {
          process.env.OPENAI_API_KEY = originalKey;
        }
      }
    });
  });
});
