/**
 * Facts Memory Embeddings
 *
 * Embedding generation for semantic search with fallback support.
 * Tries OpenAI embeddings first, falls back to local/stub if unavailable.
 */

import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveApiKeyForProvider } from "../../agents/model-auth.js";

// ============================================================================
// Types
// ============================================================================

const logger = createSubsystemLogger("facts-embeddings");

export interface EmbeddingResult {
  vector: Float32Array;
  source: "openai" | "local" | "stub";
  dimensions: number;
}

export interface EmbeddingConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
  fallbackEnabled?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** Default embedding dimensions for OpenAI text-embedding-3-small */
const OPENAI_DIMENSIONS = 1536;
/** Stub embedding dimensions (smaller for testing) */
const STUB_DIMENSIONS = 384;

// ============================================================================
// Main Embedding Function
// ============================================================================

/**
 * Generate embedding for text.
 * Tries configured provider first, falls back to stub if unavailable.
 */
export async function embed(text: string, cfg?: OpenClawConfig): Promise<EmbeddingResult | null> {
  const embeddingsConfig = cfg?.factsMemory?.embeddings;

  // Check if embeddings are enabled
  if (embeddingsConfig?.enabled === false) {
    return null;
  }

  const provider = embeddingsConfig?.provider ?? "openai";
  const model = embeddingsConfig?.model ?? "text-embedding-3-small";
  const fallbackEnabled = embeddingsConfig?.fallbackEnabled !== false;

  // Try primary provider
  try {
    if (provider === "openai") {
      return await embedWithOpenAI(text, model, cfg);
    }
    // Add more providers here as needed
    logger.warn(`memory.embedding.unknown_provider: ${provider}`);
  } catch (err) {
    // Log structured event for monitoring
    logger.warn(`memory.embedding.failed: provider=${provider} error=${err}`);
    if (!fallbackEnabled) {
      return null;
    }
  }

  // Fallback to stub embeddings
  if (fallbackEnabled) {
    logger.info("memory.embedding.fallback: using stub embeddings");
    return embedWithStub(text);
  }

  return null;
}

// ============================================================================
// OpenAI Embeddings
// ============================================================================

/**
 * Generate embedding using OpenAI API.
 * Uses auth profiles for API key resolution (falls back to env var).
 */
async function embedWithOpenAI(
  text: string,
  model: string,
  cfg?: OpenClawConfig,
): Promise<EmbeddingResult> {
  // Resolve API key via auth profiles (priority: profile → env → error)
  const auth = await resolveApiKeyForProvider({
    provider: "openai",
    cfg,
  });

  if (!auth?.apiKey) {
    throw new Error("OpenAI API key not available (check auth profiles or OPENAI_API_KEY)");
  }

  logger.debug(`Using OpenAI embeddings (source: ${auth.source})`);

  // Get base URL from provider config (allows custom endpoints)
  const providerConfig = cfg?.models?.providers?.openai;
  const baseUrl = providerConfig?.baseUrl ?? "https://api.openai.com";

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${error}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  const embedding = data.data[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("Invalid embedding response from OpenAI");
  }

  return {
    vector: new Float32Array(embedding),
    source: "openai",
    dimensions: embedding.length,
  };
}

// ============================================================================
// Stub/Local Embeddings
// ============================================================================

/**
 * Generate stub embedding (deterministic hash-based).
 * This is a fallback when no API is available.
 * NOT suitable for production semantic search but provides consistent behavior.
 */
function embedWithStub(text: string): EmbeddingResult {
  const vector = new Float32Array(STUB_DIMENSIONS);

  // Simple hash-based embedding (deterministic)
  const normalized = text.toLowerCase().trim();
  let hash = 0;

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }

  // Generate pseudo-random but deterministic values
  const seed = Math.abs(hash);
  for (let i = 0; i < STUB_DIMENSIONS; i++) {
    // Simple LCG for deterministic pseudo-random
    const x = Math.sin(seed + i) * 10000;
    vector[i] = x - Math.floor(x);
  }

  // Normalize to unit vector
  let norm = 0;
  for (let i = 0; i < STUB_DIMENSIONS; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < STUB_DIMENSIONS; i++) {
      vector[i] /= norm;
    }
  }

  return {
    vector,
    source: "stub",
    dimensions: STUB_DIMENSIONS,
  };
}

// ============================================================================
// Similarity Functions
// ============================================================================

/**
 * Calculate cosine similarity between two vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Find top-k most similar vectors.
 */
export function findTopK(
  query: Float32Array,
  candidates: Array<{ id: string; vector: Float32Array }>,
  k: number,
): Array<{ id: string; score: number }> {
  const scored = candidates.map((c) => ({
    id: c.id,
    score: cosineSimilarity(query, c.vector),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ============================================================================
// Batch Embedding
// ============================================================================

/**
 * Generate embeddings for multiple texts.
 */
export async function embedBatch(
  texts: string[],
  cfg?: OpenClawConfig,
): Promise<Array<EmbeddingResult | null>> {
  // For now, embed sequentially. Could be optimized with batch API.
  const results: Array<EmbeddingResult | null> = [];

  for (const text of texts) {
    try {
      const result = await embed(text, cfg);
      results.push(result);
    } catch (err) {
      logger.warn(`Failed to embed text: ${err}`);
      results.push(null);
    }
  }

  return results;
}
