/**
 * Facts Memory System Types
 *
 * Types for the conversation memory system that stores facts, preferences,
 * decisions, events, and todos extracted from conversations.
 */

// ============================================================================
// Memory Entry Types
// ============================================================================

/** Type of memory entry */
export type MemoryType = "fact" | "preference" | "decision" | "event" | "todo";

/** Source of memory entry */
export type MemorySource = "explicit" | "inferred" | "conversation";

/** Memory entry stored in the database */
export interface MemoryEntry {
  /** Unique identifier */
  id: string;
  /** Type of memory */
  type: MemoryType;
  /** Content text */
  content: string;
  /** How the memory was derived */
  source: MemorySource;
  /** Importance score (0-1) */
  importance: number;
  /** Confidence score (0-1) */
  confidence: number;
  /** Unix timestamp when created */
  createdAt: number;
  /** Unix timestamp when last accessed */
  lastAccessedAt: number;
  /** Unix timestamp when last updated */
  updatedAt: number;
  /** Number of times accessed */
  accessCount: number;
  /** Optional expiry timestamp */
  expiresAt?: number;
  /** Tags for categorization (JSON array) */
  tags?: string[];
  /** Related memory IDs (JSON array) */
  relatedIds?: string[];
  /** ID of memory that this one supersedes */
  supersedes?: string;
  /** ID of memory that supersedes this one */
  supersededBy?: string;
  /** Embedding vector (stored as blob) */
  embedding?: Float32Array;
}

/** Input for creating a new memory entry */
export type MemoryEntryInput = Partial<
  Omit<MemoryEntry, "id" | "createdAt" | "lastAccessedAt" | "accessCount">
> & {
  content: string;
  type: MemoryType;
  /** ID of the memory this supersedes (set during supersession) */
  supersedes?: string;
};

// ============================================================================
// Memory Block Types
// ============================================================================

/** Labels for self-editing memory blocks */
export type MemoryBlockLabel = "persona" | "user_profile" | "active_context";

/** A self-editing memory block */
export interface MemoryBlock {
  /** Block identifier (auto-generated) */
  id?: number;
  /** Block label (unique) */
  label: MemoryBlockLabel;
  /** Block content (markdown) */
  value: string;
  /** Last update timestamp */
  updatedAt?: number;
}

// ============================================================================
// Daily Summary Types
// ============================================================================

/** Daily summary of conversations */
export interface DailySummary {
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Summary text */
  summary: string;
  /** Key decisions made */
  keyDecisions?: string[];
  /** Mentioned entities */
  mentionedEntities?: string[];
  /** Approximate token count */
  tokenCount?: number;
}

// ============================================================================
// Extraction Types
// ============================================================================

/** Operation type for extraction */
export type ExtractionOp = "ADD" | "UPDATE" | "DELETE" | "NONE";

/** Extraction result from LLM */
export interface ExtractionResult {
  /** Operation to perform */
  op: ExtractionOp;
  /** Memory type (for ADD) */
  type?: MemoryType;
  /** Content (for ADD/UPDATE) */
  content?: string;
  /** Confidence score (0-1) */
  confidence?: number;
  /** Target memory ID (for UPDATE/DELETE) */
  target?: string;
  /** Tags for the memory */
  tags?: string[];
}

/** Batch extraction input */
export interface BatchExtractionInput {
  /** Messages to extract from */
  messages: string[];
  /** Existing memories for context */
  existingMemories?: MemoryEntry[];
  /** Current memory blocks for context */
  currentBlocks?: MemoryBlock[];
}

/** Batch extraction output */
export interface BatchExtractionOutput {
  /** Extraction results */
  results: ExtractionResult[];
  /** Raw LLM response */
  rawResponse?: string;
  /** Whether extraction succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Search Types
// ============================================================================

/** Search result from memory retrieval */
export interface MemorySearchResult {
  /** Memory entry */
  entry: MemoryEntry;
  /** Relevance score */
  score: number;
  /** Match type (fts or semantic) */
  matchType: "fts" | "semantic" | "hybrid";
}

// ============================================================================
// Retrieval Trace Types (Explainability)
// ============================================================================

/** Source that contributed to a memory being retrieved */
export type RetrievalSource = "fts" | "importance" | "recency" | "semantic";

/** Reason for including a specific memory in the context */
export interface RetrievalReason {
  /** Memory ID */
  id: string;
  /** Source that triggered retrieval */
  source: RetrievalSource;
  /** Score from this source (0-1 scale) */
  score: number;
  /** Content snippet for reference */
  snippet: string;
  /** Memory type */
  type: MemoryType;
  /** Additional context (e.g., importance value, access count) */
  metadata?: Record<string, unknown>;
}

/** Full retrieval trace with context and reasons */
export interface RetrievalTrace {
  /** The formatted context string */
  context: string;
  /** Reasons for each memory included */
  reasons: RetrievalReason[];
  /** Query that triggered retrieval */
  query: string;
  /** Total memories considered */
  totalConsidered: number;
  /** Memories included in context */
  memoriesIncluded: number;
  /** Timestamp of retrieval */
  timestamp: number;
  /** Access control info (if enabled) */
  access?: {
    /** Role used for filtering */
    role: string;
    /** Number of memories excluded by access control */
    excluded: number;
    /** Types that were filtered out */
    excludedTypes: MemoryType[];
  };
}

/** Search options */
export interface MemorySearchOptions {
  /** Maximum results to return */
  limit?: number;
  /** Filter by memory type */
  types?: MemoryType[];
  /** Filter by minimum importance */
  minImportance?: number;
  /** Filter by minimum confidence */
  minConfidence?: number;
  /** Include superseded memories */
  includeSuperseded?: boolean;
}

// ============================================================================
// Classifier Types
// ============================================================================

/** Classification result for a message */
export interface ClassificationResult {
  /** Whether the message should be processed for extraction */
  shouldExtract: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Priority level (higher = more important) */
  priority: "high" | "medium" | "low" | "skip";
  /** Detected patterns */
  patterns: string[];
  /** Reason for classification */
  reason?: string;
  /** Hint about memory type based on patterns */
  typeHint?: MemoryType;
}

// ============================================================================
// Config Types
// ============================================================================

/** Configuration for facts memory system */
export interface FactsMemoryConfig {
  /** Whether the system is enabled */
  enabled?: boolean;
  /** Path to SQLite database */
  dbPath?: string;
  /** Path to markdown files directory */
  markdownPath?: string;
  /** Batch size for extraction */
  batchSize?: number;
  /** Extraction settings */
  extraction?: {
    /** Whether extraction is enabled */
    enabled?: boolean;
    /** Provider for LLM extraction */
    provider?: string;
    /** Model for LLM extraction */
    model?: string;
  };
  /** Scheduler settings */
  scheduler?: {
    /** Enable daily consolidation */
    dailyEnabled?: boolean;
    /** Daily cron expression */
    dailyCron?: string;
    /** Enable weekly consolidation */
    weeklyEnabled?: boolean;
    /** Weekly cron expression */
    weeklyCron?: string;
    /** Timezone for cron expressions */
    timezone?: string;
  };
  /** Embeddings settings */
  embeddings?: {
    /** Whether embeddings are enabled */
    enabled?: boolean;
    /** Provider for embeddings */
    provider?: string;
    /** Model for embeddings */
    model?: string;
    /** Enable fallback to local/stub embeddings */
    fallbackEnabled?: boolean;
  };
  /** Retention settings for cleanup */
  retention?: {
    /** Maximum age in days for memories */
    maxAgeDays?: number;
    /** Maximum database size in MB */
    maxSizeMb?: number;
    /** Prune memories with low importance */
    pruneLowImportance?: boolean;
    /** Minimum importance threshold */
    minImportance?: number;
    /** Days after which summaries are truncated */
    truncateSummariesDays?: number;
  };
  /** Rate limits and guardrails */
  limits?: {
    /** Maximum messages per extraction batch */
    maxMessages?: number;
    /** Maximum facts per extraction */
    maxFacts?: number;
    /** Maximum token budget per extraction */
    maxTokens?: number;
    /** Cooldown between extractions in ms */
    cooldownMs?: number;
  };
}

// ============================================================================
// Manager Types
// ============================================================================

/** Memory manager interface */
export interface IMemoryManager {
  /** Add a new memory entry */
  add(entry: MemoryEntryInput): Promise<string>;
  /** Update an existing memory entry */
  update(id: string, updates: Partial<MemoryEntry>): Promise<void>;
  /** Delete a memory entry */
  delete(id: string): Promise<void>;
  /** Search memories */
  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;
  /** Get session context for prompt injection */
  getSessionContext(): Promise<string>;
  /** Extract memories from a batch of messages */
  extractFromBatch(messages: string[], sessionId?: string): Promise<MemoryEntry[]>;
  /** Upsert memory blocks */
  upsertMemoryBlocks(blocks: MemoryBlock[]): Promise<void>;
  /** Get a memory block by label */
  getMemoryBlock(label: MemoryBlockLabel): Promise<MemoryBlock | null>;
  /** Close the manager and release resources */
  close(): Promise<void>;
}
