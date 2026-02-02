/**
 * Facts Memory Manager
 *
 * Main API for the facts memory system.
 * Provides a unified interface for memory operations.
 */

import { join } from "node:path";
import type {
  FactsMemoryConfig,
  IMemoryManager,
  MemoryBlock,
  MemoryBlockLabel,
  MemoryEntry,
  MemoryEntryInput,
  MemorySearchOptions,
  MemorySearchResult,
} from "./types.js";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { filterMessagesForExtraction, shouldExtractFromBatch } from "./classifier.js";
import { extractFromBatch, extractBlockUpdates, type LlmCallFn } from "./extractor.js";
import { writeMemoryFile, initializeMemoryFile, syncBlocksToMarkdown } from "./markdown.js";
import { searchMemories, buildSessionContext } from "./retrieval.js";
import { FactsMemoryStore, openFactsMemoryStore } from "./store.js";
import { estimateTokens } from "./utils.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_BATCH_SIZE = 10;

// Guardrail defaults
const DEFAULT_MAX_MESSAGES = 25;
const DEFAULT_MAX_FACTS = 50;
const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_COOLDOWN_MS = 30000;

function getDefaultDbPath(): string {
  return join(resolveStateDir(), "memory", "facts.db");
}

function getDefaultMarkdownPath(): string {
  return join(resolveStateDir(), "memory");
}

// ============================================================================
// Manager Class
// ============================================================================

/** Telemetry counters for extraction operations */
export interface ExtractionTelemetry {
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
  totalLatencyMs: number;
  extractionCount: number;
}

/** Guardrail skip event */
export interface GuardrailSkipEvent {
  reason: "cooldown" | "max_messages" | "max_tokens" | "max_facts";
  limit: number;
  value: number;
  sessionId?: string;
}

export class FactsMemoryManager implements IMemoryManager {
  private store: FactsMemoryStore;
  private config: FactsMemoryConfig;
  private llmCall: LlmCallFn | null = null;
  private markdownPath: string;
  private logger = createSubsystemLogger("facts-memory");
  private telemetry: ExtractionTelemetry = {
    added: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    totalLatencyMs: 0,
    extractionCount: 0,
  };
  private lastExtractionAt: number = 0;

  constructor(store: FactsMemoryStore, config: FactsMemoryConfig, markdownPath: string) {
    this.store = store;
    this.config = config;
    this.markdownPath = markdownPath;
  }

  /**
   * Get the last extraction timestamp.
   */
  getLastExtractionAt(): number {
    return this.lastExtractionAt;
  }

  /**
   * Get telemetry data for extraction operations.
   */
  getTelemetry(): ExtractionTelemetry {
    return { ...this.telemetry };
  }

  /**
   * Reset telemetry counters.
   */
  resetTelemetry(): void {
    this.telemetry = {
      added: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      totalLatencyMs: 0,
      extractionCount: 0,
    };
  }

  /**
   * Set the LLM call function for extraction.
   */
  setLlmCall(fn: LlmCallFn): void {
    this.llmCall = fn;
  }

  /**
   * Log a guardrail skip event.
   */
  private logGuardrailSkip(event: GuardrailSkipEvent): void {
    this.logger.info(
      `memory.guardrail.skip: reason=${event.reason} limit=${event.limit} value=${event.value}${event.sessionId ? ` sessionId=${event.sessionId}` : ""}`,
    );
  }

  // ==========================================================================
  // CRUD Operations
  // ==========================================================================

  /**
   * Add a new memory entry.
   */
  async add(entry: MemoryEntryInput): Promise<string> {
    try {
      const id = this.store.add(entry);
      this.logger.debug(`Added memory: ${id} (${entry.type})`);

      // Sync to markdown for important entries
      if (entry.source === "explicit" || (entry.importance ?? 0.5) >= 0.7) {
        this.syncToMarkdown();
      }

      return id;
    } catch (err) {
      this.logger.error(`Failed to add memory: ${err}`);
      throw err;
    }
  }

  /**
   * Update an existing memory entry.
   */
  async update(id: string, updates: Partial<MemoryEntry>): Promise<void> {
    try {
      const success = this.store.update(id, updates);
      if (!success) {
        throw new Error(`Memory not found: ${id}`);
      }
      this.logger.debug(`Updated memory: ${id}`);
    } catch (err) {
      this.logger.error(`Failed to update memory ${id}: ${err}`);
      throw err;
    }
  }

  /**
   * Delete a memory entry.
   */
  async delete(id: string): Promise<void> {
    try {
      const success = this.store.delete(id);
      if (!success) {
        this.logger.warn(`Memory not found for deletion: ${id}`);
      } else {
        this.logger.debug(`Deleted memory: ${id}`);
      }
    } catch (err) {
      this.logger.error(`Failed to delete memory ${id}: ${err}`);
      throw err;
    }
  }

  // ==========================================================================
  // Search Operations
  // ==========================================================================

  /**
   * Search memories.
   */
  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    try {
      return await searchMemories(this.store, query, options);
    } catch (err) {
      this.logger.error(`Search failed: ${err}`);
      return [];
    }
  }

  /**
   * Get session context for prompt injection.
   */
  async getSessionContext(): Promise<string> {
    try {
      return buildSessionContext(this.store);
    } catch (err) {
      this.logger.error(`Failed to build session context: ${err}`);
      return "";
    }
  }

  // ==========================================================================
  // Extraction Operations
  // ==========================================================================

  /**
   * Extract memories from a batch of messages.
   */
  async extractFromBatch(messages: string[], sessionId?: string): Promise<MemoryEntry[]> {
    // Check if extraction is enabled
    if (!this.config.extraction?.enabled) {
      this.telemetry.skipped++;
      return [];
    }

    const limits = this.config.limits ?? {};
    const cooldownMs = limits.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const maxMessages = limits.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const maxTokens = limits.maxTokens ?? DEFAULT_MAX_TOKENS;
    const maxFacts = limits.maxFacts ?? DEFAULT_MAX_FACTS;

    // Guardrail: Cooldown check
    const now = Date.now();
    if (this.lastExtractionAt > 0 && now - this.lastExtractionAt < cooldownMs) {
      this.logGuardrailSkip({
        reason: "cooldown",
        limit: cooldownMs,
        value: now - this.lastExtractionAt,
        sessionId,
      });
      this.telemetry.skipped++;
      return [];
    }

    // Guardrail: Max messages truncation
    let processedMessages = messages;
    if (messages.length > maxMessages) {
      this.logGuardrailSkip({
        reason: "max_messages",
        limit: maxMessages,
        value: messages.length,
        sessionId,
      });
      processedMessages = messages.slice(-maxMessages); // Keep most recent
    }

    // Guardrail: Max tokens check
    const totalTokens = processedMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
    if (totalTokens > maxTokens) {
      this.logGuardrailSkip({
        reason: "max_tokens",
        limit: maxTokens,
        value: totalTokens,
        sessionId,
      });
      this.telemetry.skipped++;
      return [];
    }

    // Early exit if no messages should be extracted
    if (!shouldExtractFromBatch(processedMessages)) {
      this.logger.debug("Batch skipped by classifier");
      this.telemetry.skipped++;
      return [];
    }

    // Check if LLM is available
    if (!this.llmCall) {
      this.logger.warn("LLM call function not set, skipping extraction");
      this.telemetry.skipped++;
      return [];
    }

    const startTime = Date.now();
    this.lastExtractionAt = startTime;

    try {
      // Get existing memories and blocks for context
      const existingMemories = this.store.list({ limit: 30 });
      const currentBlocks = this.store.getAllBlocks();

      // Run extraction
      const result = await extractFromBatch(
        {
          messages: processedMessages,
          existingMemories,
          currentBlocks,
        },
        this.llmCall,
      );

      if (!result.success) {
        this.logger.warn(`memory.extraction.llm_failed: error=${result.error}`);
        this.telemetry.skipped++;
        return [];
      }

      // Guardrail: Max facts limit
      let extractionResults = result.results;
      if (extractionResults.length > maxFacts) {
        this.logGuardrailSkip({
          reason: "max_facts",
          limit: maxFacts,
          value: extractionResults.length,
          sessionId,
        });
        extractionResults = extractionResults.slice(0, maxFacts);
      }

      // Process extraction results
      const addedMemories: MemoryEntry[] = [];
      let updatedCount = 0;
      let deletedCount = 0;

      for (const extraction of extractionResults) {
        if (extraction.op === "ADD" && extraction.content && extraction.type) {
          const id = this.store.add({
            type: extraction.type,
            content: extraction.content,
            source: "conversation",
            confidence: extraction.confidence ?? 0.8,
            tags: extraction.tags,
          });
          const memory = this.store.get(id);
          if (memory) {
            addedMemories.push(memory);
          }
        } else if (extraction.op === "UPDATE" && extraction.target) {
          this.store.update(extraction.target, {
            content: extraction.content,
            confidence: extraction.confidence,
          });
          updatedCount++;
        } else if (extraction.op === "DELETE" && extraction.target) {
          this.store.delete(extraction.target);
          deletedCount++;
        }
      }

      // Extract and apply block updates
      if (addedMemories.length > 0) {
        const blockUpdates = await extractBlockUpdates(result.results, currentBlocks, this.llmCall);
        for (const [label, value] of Object.entries(blockUpdates)) {
          if (isValidBlockLabel(label) && typeof value === "string" && value.trim()) {
            this.store.upsertBlock({ label, value });
          }
        }
      }

      // Sync to markdown
      if (addedMemories.length > 0 || result.results.some((r) => r.op !== "ADD")) {
        this.syncToMarkdown();
      }

      // Update telemetry
      const latencyMs = Date.now() - startTime;
      this.telemetry.added += addedMemories.length;
      this.telemetry.updated += updatedCount;
      this.telemetry.deleted += deletedCount;
      this.telemetry.totalLatencyMs += latencyMs;
      this.telemetry.extractionCount++;

      this.logger.info(
        `Extracted ${addedMemories.length} memories (${updatedCount} updated, ${deletedCount} deleted) in ${latencyMs}ms`,
      );
      return addedMemories;
    } catch (err) {
      // Log structured event - don't propagate error, just degrade gracefully
      this.logger.error(`memory.extraction.failed: error=${err}`);
      this.telemetry.skipped++;
      return [];
    }
  }

  // ==========================================================================
  // Memory Block Operations
  // ==========================================================================

  /**
   * Upsert memory blocks.
   */
  async upsertMemoryBlocks(blocks: MemoryBlock[]): Promise<void> {
    try {
      for (const block of blocks) {
        // Prevent infinite supersession chains (max depth = 3)
        this.store.upsertBlock(block);
      }
      this.syncToMarkdown();
      this.logger.debug(`Upserted ${blocks.length} memory blocks`);
    } catch (err) {
      this.logger.error(`Failed to upsert memory blocks: ${err}`);
      throw err;
    }
  }

  /**
   * Get a memory block by label.
   */
  async getMemoryBlock(label: MemoryBlockLabel): Promise<MemoryBlock | null> {
    return this.store.getBlock(label);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Sync store to markdown file.
   */
  private syncToMarkdown(): void {
    try {
      syncBlocksToMarkdown(this.markdownPath, this.store);
    } catch (err) {
      this.logger.warn(`Failed to sync to markdown: ${err}`);
    }
  }

  /**
   * Get the underlying store (for advanced operations).
   */
  getStore(): FactsMemoryStore {
    return this.store;
  }

  /**
   * Get the markdown path.
   */
  getMarkdownPath(): string {
    return this.markdownPath;
  }

  /**
   * Get the config.
   */
  getConfig(): FactsMemoryConfig {
    return this.config;
  }

  /**
   * Close the manager and release resources.
   */
  async close(): Promise<void> {
    try {
      this.store.close();
      this.logger.debug("Facts memory manager closed");
    } catch (err) {
      this.logger.error(`Error closing manager: ${err}`);
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a facts memory manager.
 */
export function createFactsMemoryManager(config: FactsMemoryConfig = {}): FactsMemoryManager {
  const dbPath = resolvePath(config.dbPath ?? getDefaultDbPath());
  const markdownPath = resolvePath(config.markdownPath ?? getDefaultMarkdownPath());

  const store = openFactsMemoryStore(dbPath);
  const manager = new FactsMemoryManager(store, config, markdownPath);

  // Initialize markdown file
  initializeMemoryFile(markdownPath, store);

  return manager;
}

/**
 * Get or create a singleton facts memory manager.
 */
let singletonManager: FactsMemoryManager | null = null;

export function getFactsMemoryManager(config?: FactsMemoryConfig): FactsMemoryManager {
  if (!singletonManager) {
    singletonManager = createFactsMemoryManager(config);
  }
  return singletonManager;
}

/**
 * Reset the singleton manager (for testing).
 */
export function resetFactsMemoryManager(): void {
  if (singletonManager) {
    singletonManager.close().catch(() => {});
    singletonManager = null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return join(home, p.slice(1));
  }
  return p;
}

function isValidBlockLabel(label: string): label is MemoryBlockLabel {
  return label === "persona" || label === "user_profile" || label === "active_context";
}
