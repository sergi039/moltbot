/**
 * Facts Memory Retrieval
 *
 * Search and retrieval functions for the facts memory system.
 * Supports FTS5 search and semantic search (stub for now).
 */

import type { FactsMemoryStore } from "./store.js";
import type {
  MemoryEntry,
  MemoryType,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryBlockLabel,
  DailySummary,
  RetrievalTrace,
  RetrievalReason,
} from "./types.js";
import { estimateTokens, truncate } from "./utils.js";

// ============================================================================
// Access Control Helpers
// ============================================================================

const ALL_MEMORY_TYPES: MemoryType[] = ["fact", "preference", "decision", "event", "todo"];

/** Get default allowed types for a role */
function getRoleDefaultTypes(role: "admin" | "operator" | "analyst" | "guest"): MemoryType[] {
  switch (role) {
    case "admin":
    case "operator":
      return ALL_MEMORY_TYPES;
    case "analyst":
      return ["fact", "event"];
    case "guest":
      return ["fact"];
    default:
      return ["fact"];
  }
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum tokens for session context */
const MAX_CONTEXT_TOKENS = 1800;
/** Default number of top facts to include */
const DEFAULT_TOP_FACTS = 15;
/** Minimum relevance score for query retrieval */
const MIN_RELEVANCE_SCORE = 0.1;

// ============================================================================
// Search Functions
// ============================================================================

/**
 * Search memories using combined FTS and semantic search.
 * Currently uses FTS only - semantic search is a stub for future implementation.
 */
export async function searchMemories(
  store: FactsMemoryStore,
  query: string,
  options?: MemorySearchOptions,
): Promise<MemorySearchResult[]> {
  const limit = options?.limit ?? 10;

  // Get FTS results
  const ftsResults = store.searchFts(query, { ...options, limit });

  // TODO: Add semantic search when embeddings are implemented
  // const semanticResults = await searchSemantic(store, query, options);
  // return mergeResults(ftsResults, semanticResults, limit);

  return ftsResults;
}

/**
 * Search memories by type.
 */
export function searchByType(
  store: FactsMemoryStore,
  type: MemoryEntry["type"],
  options?: Omit<MemorySearchOptions, "types">,
): MemoryEntry[] {
  return store.list({ ...options, types: [type] });
}

/**
 * Get recent memories.
 */
export function getRecentMemories(store: FactsMemoryStore, limit: number = 20): MemoryEntry[] {
  return store.list({ limit });
}

/**
 * Get memories by importance threshold.
 */
export function getImportantMemories(
  store: FactsMemoryStore,
  minImportance: number = 0.7,
  limit: number = 20,
): MemoryEntry[] {
  return store.list({ minImportance, limit });
}

/**
 * Get memories related to a specific memory.
 */
export function getRelatedMemories(store: FactsMemoryStore, memoryId: string): MemoryEntry[] {
  const memory = store.get(memoryId);
  if (!memory || !memory.relatedIds || memory.relatedIds.length === 0) {
    return [];
  }

  const related: MemoryEntry[] = [];
  for (const relatedId of memory.relatedIds) {
    const relatedMemory = store.get(relatedId);
    if (relatedMemory) {
      related.push(relatedMemory);
    }
  }

  return related;
}

// ============================================================================
// Context Building
// ============================================================================

/**
 * Build session context string for prompt injection.
 * Implements the retrieval contract:
 * 1. Always includes user_profile block
 * 2. Includes last daily summary (if exists)
 * 3. Includes top N facts by importance + accessCount
 * 4. Respects token limit (1500-2000 tokens)
 */
export function buildSessionContext(
  store: FactsMemoryStore,
  options?: {
    maxMemories?: number;
    includeBlocks?: MemoryBlockLabel[];
    query?: string;
    maxTokens?: number;
  },
): string {
  const parts: string[] = [];
  const maxTokens = options?.maxTokens ?? MAX_CONTEXT_TOKENS;
  const maxMemories = options?.maxMemories ?? DEFAULT_TOP_FACTS;
  let currentTokens = 0;

  // 1. Always include user_profile block (highest priority)
  const userProfile = store.getBlock("user_profile");
  if (userProfile && userProfile.value.trim()) {
    const section = `## User Profile\n${userProfile.value}`;
    const sectionTokens = estimateTokens(section);
    if (currentTokens + sectionTokens <= maxTokens) {
      parts.push(section);
      currentTokens += sectionTokens;
    }
  }

  // 2. Include last daily summary if exists
  const lastSummary = getLastDailySummary(store);
  if (lastSummary) {
    const section = `## Recent Context (${lastSummary.date})\n${lastSummary.summary}`;
    const sectionTokens = estimateTokens(section);
    if (currentTokens + sectionTokens <= maxTokens) {
      parts.push(section);
      currentTokens += sectionTokens;
    }
  }

  // 3. Include active_context block if exists
  const activeContext = store.getBlock("active_context");
  if (activeContext && activeContext.value.trim()) {
    const section = `## Active Context\n${activeContext.value}`;
    const sectionTokens = estimateTokens(section);
    if (currentTokens + sectionTokens <= maxTokens) {
      parts.push(section);
      currentTokens += sectionTokens;
    }
  }

  // 4. Get top facts by importance + accessCount
  const topFacts = getTopFacts(store, maxMemories);
  if (topFacts.length > 0) {
    const factsHeader = "## Known Facts";
    const headerTokens = estimateTokens(factsHeader);
    if (currentTokens + headerTokens <= maxTokens) {
      const factLines: string[] = [factsHeader];
      currentTokens += headerTokens;

      for (const mem of topFacts) {
        const line = `- [${mem.type}] ${mem.content}`;
        const lineTokens = estimateTokens(line);
        if (currentTokens + lineTokens > maxTokens) break;
        factLines.push(line);
        currentTokens += lineTokens;
      }

      if (factLines.length > 1) {
        parts.push(factLines.join("\n"));
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * Get the last daily summary from the store.
 */
function getLastDailySummary(store: FactsMemoryStore): DailySummary | null {
  // Get today and yesterday dates
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const todayStr = formatDateString(today);
  const yesterdayStr = formatDateString(yesterday);

  // Try today first, then yesterday
  return store.getDailySummary(todayStr) ?? store.getDailySummary(yesterdayStr);
}

/**
 * Format date as YYYY-MM-DD.
 */
function formatDateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Get top facts sorted by importance + accessCount (weighted score).
 */
export function getTopFacts(
  store: FactsMemoryStore,
  limit: number = DEFAULT_TOP_FACTS,
): MemoryEntry[] {
  // Get all non-superseded memories
  const memories = store.list({ includeSuperseded: false, limit: 100 });

  // Calculate weighted score: importance * 0.7 + normalized_access * 0.3
  const maxAccess = Math.max(...memories.map((m) => m.accessCount), 1);
  const scored = memories.map((m) => ({
    entry: m,
    score: m.importance * 0.7 + (m.accessCount / maxAccess) * 0.3,
  }));

  // Sort by score descending and take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * Get relevant context for a specific message query.
 * Performs FTS search, merges with important memories, and dedupes.
 */
export function getRelevantContext(
  store: FactsMemoryStore,
  message: string,
  options?: {
    maxResults?: number;
    minScore?: number;
    maxTokens?: number;
    access?: RetrievalAccessOptions;
  },
): string {
  const maxResults = options?.maxResults ?? 10;
  const minScore = options?.minScore ?? MIN_RELEVANCE_SCORE;
  const maxTokens = options?.maxTokens ?? MAX_CONTEXT_TOKENS;

  // Access control configuration
  const accessEnabled = options?.access?.enabled ?? false;
  const accessRole = options?.access?.role ?? "operator";
  let allowedTypes: MemoryType[] | undefined = options?.access?.allowedTypes;

  // If access enabled but no explicit allowed types, use role defaults
  if (accessEnabled && !allowedTypes) {
    allowedTypes = getRoleDefaultTypes(accessRole);
  }

  // 1. FTS search for the message
  const ftsResults = store.searchFts(message, { limit: maxResults });

  // 2. Get important/recent memories
  const importantMemories = getImportantMemories(store, 0.6, maxResults);
  const recentMemories = getRecentMemories(store, 5);

  // 3. Merge and dedupe by id
  const seen = new Set<string>();
  const merged: MemorySearchResult[] = [];

  // Add FTS results first (most relevant)
  for (const result of ftsResults) {
    if (result.score >= minScore && !seen.has(result.entry.id)) {
      seen.add(result.entry.id);
      merged.push(result);
    }
  }

  // Add important memories
  for (const entry of importantMemories) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      merged.push({
        entry,
        score: entry.importance,
        matchType: "fts",
      });
    }
  }

  // Add recent memories (lower priority)
  for (const entry of recentMemories) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      merged.push({
        entry,
        score: entry.importance * 0.8,
        matchType: "fts",
      });
    }
  }

  // 4. Sort by score and limit
  merged.sort((a, b) => b.score - a.score);
  let topResults = merged.slice(0, maxResults);

  // 4b. Apply access control filtering if enabled
  if (accessEnabled && allowedTypes) {
    const allowedSet = new Set(allowedTypes);
    topResults = topResults.filter((r) => allowedSet.has(r.entry.type as MemoryType));
  }

  // 5. If no results, return empty
  if (topResults.length === 0) {
    return "";
  }

  // 6. Build context string with token limit
  const parts: string[] = ["## Relevant Memories"];
  let currentTokens = estimateTokens(parts[0]);

  for (const result of topResults) {
    const line = `- [${result.entry.type}] ${result.entry.content}`;
    const lineTokens = estimateTokens(line);
    if (currentTokens + lineTokens > maxTokens) break;
    parts.push(line);
    currentTokens += lineTokens;
  }

  // Return empty if only header
  if (parts.length === 1) {
    return "";
  }

  return parts.join("\n");
}

/** Options for access-controlled retrieval */
export interface RetrievalAccessOptions {
  /** Whether access control is enabled */
  enabled?: boolean;
  /** Role to use for filtering (defaults to 'operator') */
  role?: "admin" | "operator" | "analyst" | "guest";
  /** Allowed types for the role (overrides default role config) */
  allowedTypes?: MemoryType[];
}

/**
 * Get relevant context with full trace information (explainability).
 * Returns both the context string and detailed reasons for each memory included.
 */
export function getRelevantContextWithTrace(
  store: FactsMemoryStore,
  message: string,
  options?: {
    maxResults?: number;
    minScore?: number;
    maxTokens?: number;
    access?: RetrievalAccessOptions;
  },
): RetrievalTrace {
  const maxResults = options?.maxResults ?? 10;
  const minScore = options?.minScore ?? MIN_RELEVANCE_SCORE;
  const maxTokens = options?.maxTokens ?? MAX_CONTEXT_TOKENS;
  const timestamp = Date.now();

  // Access control configuration
  const accessEnabled = options?.access?.enabled ?? false;
  const accessRole = options?.access?.role ?? "operator";
  let allowedTypes: MemoryType[] | undefined = options?.access?.allowedTypes;

  // If access enabled but no explicit allowed types, use role defaults
  if (accessEnabled && !allowedTypes) {
    allowedTypes = getRoleDefaultTypes(accessRole);
  }

  // Track all reasons with their source
  const reasons: RetrievalReason[] = [];
  const seen = new Set<string>();

  // 1. FTS search for the message
  const ftsResults = store.searchFts(message, { limit: maxResults });
  let totalConsidered = ftsResults.length;

  // Add FTS results with trace
  for (const result of ftsResults) {
    if (result.score >= minScore && !seen.has(result.entry.id)) {
      seen.add(result.entry.id);
      reasons.push({
        id: result.entry.id,
        source: "fts",
        score: result.score,
        snippet: truncate(result.entry.content, 100),
        type: result.entry.type,
        metadata: {
          matchType: result.matchType,
          ftsScore: result.score,
        },
      });
    }
  }

  // 2. Get important memories
  const importantMemories = getImportantMemories(store, 0.6, maxResults);
  totalConsidered += importantMemories.length;

  for (const entry of importantMemories) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      reasons.push({
        id: entry.id,
        source: "importance",
        score: entry.importance,
        snippet: truncate(entry.content, 100),
        type: entry.type,
        metadata: {
          importance: entry.importance,
          accessCount: entry.accessCount,
        },
      });
    }
  }

  // 3. Get recent memories
  const recentMemories = getRecentMemories(store, 5);
  totalConsidered += recentMemories.length;

  for (const entry of recentMemories) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      reasons.push({
        id: entry.id,
        source: "recency",
        score: entry.importance * 0.8,
        snippet: truncate(entry.content, 100),
        type: entry.type,
        metadata: {
          createdAt: entry.createdAt,
          lastAccessedAt: entry.lastAccessedAt,
        },
      });
    }
  }

  // 4. Sort by score and limit
  reasons.sort((a, b) => b.score - a.score);
  let topReasons = reasons.slice(0, maxResults);

  // 4b. Apply access control filtering if enabled
  let accessExcluded = 0;
  const excludedTypes = new Set<MemoryType>();

  if (accessEnabled && allowedTypes) {
    const allowedSet = new Set(allowedTypes);
    const beforeCount = topReasons.length;

    topReasons = topReasons.filter((r) => {
      const isAllowed = allowedSet.has(r.type as MemoryType);
      if (!isAllowed) {
        excludedTypes.add(r.type as MemoryType);
      }
      return isAllowed;
    });

    accessExcluded = beforeCount - topReasons.length;
  }

  // 5. Build context string with token limit
  const parts: string[] = ["## Relevant Memories"];
  let currentTokens = estimateTokens(parts[0]);
  const includedReasons: RetrievalReason[] = [];

  for (const reason of topReasons) {
    const entry = store.get(reason.id);
    if (!entry) continue;

    const line = `- [${entry.type}] ${entry.content}`;
    const lineTokens = estimateTokens(line);
    if (currentTokens + lineTokens > maxTokens) break;
    parts.push(line);
    currentTokens += lineTokens;
    includedReasons.push(reason);
  }

  // Build context (empty if only header)
  const context = parts.length > 1 ? parts.join("\n") : "";

  // Build access info if enabled
  const accessInfo = accessEnabled
    ? {
        role: accessRole,
        excluded: accessExcluded,
        excludedTypes: [...excludedTypes],
      }
    : undefined;

  return {
    context,
    reasons: includedReasons,
    query: message,
    totalConsidered,
    memoriesIncluded: includedReasons.length,
    access: accessInfo,
    timestamp,
  };
}

/**
 * Format block label for display.
 */
function formatBlockLabel(label: MemoryBlockLabel): string {
  switch (label) {
    case "persona":
      return "Persona";
    case "user_profile":
      return "User Profile";
    case "active_context":
      return "Active Context";
    default:
      return label;
  }
}

// ============================================================================
// Semantic Search (Stub)
// ============================================================================

/**
 * Semantic search using embeddings.
 * Currently a stub - will be implemented in Phase 2.
 */
export async function searchSemantic(
  _store: FactsMemoryStore,
  _query: string,
  _options?: MemorySearchOptions,
): Promise<MemorySearchResult[]> {
  // TODO: Implement semantic search with embeddings
  // 1. Generate embedding for query
  // 2. Find similar embeddings in store
  // 3. Return ranked results
  return [];
}

// ============================================================================
// Hybrid Search
// ============================================================================

/**
 * Merge FTS and semantic results with deduplication.
 * Currently not used as semantic search is not implemented.
 */
export function mergeResults(
  ftsResults: MemorySearchResult[],
  semanticResults: MemorySearchResult[],
  limit: number,
): MemorySearchResult[] {
  const seen = new Set<string>();
  const merged: MemorySearchResult[] = [];

  // Interleave results, preferring FTS for exact matches
  const maxLen = Math.max(ftsResults.length, semanticResults.length);

  for (let i = 0; i < maxLen && merged.length < limit; i++) {
    // Add FTS result
    if (i < ftsResults.length) {
      const fts = ftsResults[i];
      if (!seen.has(fts.entry.id)) {
        seen.add(fts.entry.id);
        merged.push(fts);
      }
    }

    // Add semantic result
    if (i < semanticResults.length && merged.length < limit) {
      const sem = semanticResults[i];
      if (!seen.has(sem.entry.id)) {
        seen.add(sem.entry.id);
        merged.push(sem);
      }
    }
  }

  return merged;
}

// ============================================================================
// Decay Functions
// ============================================================================

/**
 * Calculate importance decay based on access patterns.
 * Memories that haven't been accessed lose importance over time.
 */
export function calculateDecay(memory: MemoryEntry, now: number = Date.now()): number {
  const nowSeconds = Math.floor(now / 1000);
  const daysSinceAccess = (nowSeconds - memory.lastAccessedAt) / 86400;

  // Decay formula: importance * (0.95 ^ days)
  // With a floor based on access count
  const decayFactor = Math.pow(0.95, daysSinceAccess);
  const accessBonus = Math.min(memory.accessCount * 0.02, 0.2); // Max 20% bonus
  const floor = 0.1 + accessBonus;

  return Math.max(memory.importance * decayFactor, floor);
}

/**
 * Apply decay to all memories in store.
 * Call this periodically (e.g., daily).
 */
export function applyDecayToAll(store: FactsMemoryStore): number {
  const memories = store.list({ includeSuperseded: false });
  let updated = 0;

  for (const memory of memories) {
    const decayedImportance = calculateDecay(memory);
    if (Math.abs(decayedImportance - memory.importance) > 0.01) {
      store.update(memory.id, { importance: decayedImportance });
      updated++;
    }
  }

  return updated;
}
