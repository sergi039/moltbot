/**
 * Facts Memory System
 *
 * A conversation memory system for storing facts, preferences,
 * decisions, events, and todos extracted from conversations.
 *
 * @example
 * ```typescript
 * import { getFactsMemoryManager } from "./memory/facts";
 *
 * const manager = getFactsMemoryManager({ enabled: true });
 *
 * // Add a memory explicitly
 * const id = await manager.add({
 *   type: "fact",
 *   content: "User's name is Sergio",
 *   source: "explicit",
 *   confidence: 0.95,
 * });
 *
 * // Search memories
 * const results = await manager.search("Sergio");
 *
 * // Get session context for prompts
 * const context = await manager.getSessionContext();
 *
 * // Extract from conversation batch
 * const extracted = await manager.extractFromBatch([
 *   "Remember my email is test@example.com",
 *   "I prefer dark mode",
 * ]);
 * ```
 */

// Types
export type {
  MemoryType,
  MemorySource,
  MemoryEntry,
  MemoryEntryInput,
  MemoryBlockLabel,
  MemoryBlock,
  DailySummary,
  ExtractionOp,
  ExtractionResult,
  BatchExtractionInput,
  BatchExtractionOutput,
  MemorySearchResult,
  MemorySearchOptions,
  ClassificationResult,
  FactsMemoryConfig,
  IMemoryManager,
  RetrievalSource,
  RetrievalReason,
  RetrievalTrace,
} from "./types.js";

// Manager
export {
  FactsMemoryManager,
  createFactsMemoryManager,
  getFactsMemoryManager,
  resetFactsMemoryManager,
  type ExtractionTelemetry,
  type GuardrailSkipEvent,
} from "./manager.js";

// Store
export { FactsMemoryStore, openFactsMemoryStore } from "./store.js";

// Schema
export { initializeSchema, initializePragmas, hasRequiredSchema, getTableStats } from "./schema.js";

// Classifier
export {
  classifyMessage,
  filterMessagesForExtraction,
  shouldExtractFromBatch,
  getBatchPriority,
} from "./classifier.js";

// Extractor
export {
  extractFromBatch,
  extractBlockUpdates,
  createStubLlmCall,
  type LlmCallFn,
} from "./extractor.js";

// Retrieval
export {
  searchMemories,
  searchByType,
  getRecentMemories,
  getImportantMemories,
  getRelatedMemories,
  buildSessionContext,
  getRelevantContext,
  getRelevantContextWithTrace,
  getTopFacts,
  searchSemantic,
  mergeResults,
  calculateDecay,
  applyDecayToAll,
  type RetrievalAccessOptions,
} from "./retrieval.js";

// Markdown
export {
  generateMemoryMarkdown,
  writeMemoryFile,
  importMemoryFile,
  writeDailySummary,
  readDailySummary,
  syncBlocksToMarkdown,
  initializeMemoryFile,
} from "./markdown.js";

// Integration
export {
  getFactsMemoryManagerInstance,
  resetFactsMemoryManagerInstance,
  getFactsSessionContext,
  getFactsRelevantContext,
  getFactsRelevantContextWithTrace,
  addMessageForExtraction,
  flushSessionMessages,
  triggerExtraction,
  flushAllExtractions,
  runMemoryConsolidation,
  createLlmCallBridge,
  setupLlmCallForManager,
} from "./integration.js";

// Consolidation
export {
  generateDailySummary,
  generateWeeklySummary,
  pruneMemories,
  runConsolidation,
  type ConsolidationResult,
} from "./consolidation.js";

// Scheduler
export {
  startMemoryScheduler,
  stopMemoryScheduler,
  getMemorySchedulerState,
  isMemorySchedulerRunning,
  getMemorySchedulerStatus,
  triggerConsolidationNow,
  triggerHealthCheckNow,
  type MemorySchedulerConfig,
  type MemorySchedulerState,
} from "./scheduler.js";

// Health
export {
  getHealthSnapshot,
  getHealthState,
  resetHealthState,
  checkHealth,
  runHealthCheck,
  getRecentAlerts,
  clearAlerts,
  getHealthSummary,
  getAlertThresholds,
  recordExtraction,
  recordExtractionError,
  recordCleanup,
  type HealthSnapshot,
  type HealthAlert,
  type HealthState,
  type AlertThresholds,
} from "./health.js";

// Embeddings
export {
  embed,
  embedBatch,
  cosineSimilarity,
  findTopK,
  type EmbeddingResult,
  type EmbeddingConfig,
} from "./embeddings.js";

// Connection Pool
export {
  SQLitePool,
  createSQLitePool,
  getPool,
  closePool,
  closeAllPools,
  type PoolConfig,
} from "./pool.js";

// Migration
export {
  migrateMemoryFile,
  migrateMemoryDirectory,
  parseMemoryFile,
  exportToMemoryFile,
  type MigrationResult,
  type ParsedMemoryFile,
} from "./migrate.js";

// Cleanup
export {
  runCleanup,
  getCleanupStats,
  vacuumDatabase,
  type CleanupOptions,
  type CleanupResult,
  type CleanupStats,
} from "./cleanup.js";

// Repair
export {
  runRepair,
  checkIntegrity,
  rebuildFtsIndex,
  type RepairOptions,
  type RepairResult,
  type IntegrityCheckResult,
  type FtsReindexResult,
} from "./repair.js";

// Export
export {
  exportToJsonl,
  type ExportResult,
  type ExportRecord,
  type MemoryExportRecord,
  type BlockExportRecord,
  type SummaryExportRecord,
  type MetadataExportRecord,
} from "./export.js";

// Import
export {
  importFromJsonl,
  type ImportOptions,
  type ImportResult,
  type ImportMode,
} from "./import.js";

// Utils
export {
  generateMemoryId,
  nowSeconds,
  getTodayDate,
  formatTimestamp,
  parseDate,
  truncate,
  normalizeWhitespace,
  firstSentence,
  estimateTokens,
  safeJsonParse,
  safeJsonStringify,
  isNonEmptyString,
  isNumberInRange,
  clamp,
  unique,
  chunk,
  groupBy,
  maskSensitiveData,
  containsSensitiveData,
  safeCall,
  safeCallAsync,
} from "./utils.js";
