/**
 * Facts Memory Store
 *
 * SQLite persistence layer for the facts memory system.
 * Provides CRUD operations for memories, blocks, and summaries.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

import { requireNodeSqlite } from "../sqlite.js";

import type {
  DailySummary,
  MemoryBlock,
  MemoryBlockLabel,
  MemoryEntry,
  MemoryEntryInput,
  MemorySearchOptions,
  MemorySearchResult,
} from "./types.js";
import { initializeSchema, type SchemaInitResult } from "./schema.js";

// ============================================================================
// Store Class
// ============================================================================

export class FactsMemoryStore {
  private db: DatabaseSync;
  private dbPath: string;
  private ftsAvailable: boolean = false;

  constructor(db: DatabaseSync, dbPath: string = ":memory:") {
    this.db = db;
    this.dbPath = dbPath;
  }

  /**
   * Initialize the store with schema.
   */
  initialize(): SchemaInitResult {
    const result = initializeSchema(this.db);
    this.ftsAvailable = result.ftsAvailable;
    return result;
  }

  /**
   * Check if FTS is available.
   */
  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  // ==========================================================================
  // Memory Entry Operations
  // ==========================================================================

  /**
   * Add a new memory entry.
   */
  add(input: MemoryEntryInput, chainDepth: number = 0): string {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO memories (
        id, type, content, source, importance, confidence,
        created_at, updated_at, last_accessed_at, access_count,
        expires_at, tags, related_ids, supersedes, superseded_by, chain_depth, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.type,
      input.content,
      input.source ?? "conversation",
      input.importance ?? 0.5,
      input.confidence ?? 0.8,
      now,
      now,
      now,
      0,
      input.expiresAt ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.relatedIds ? JSON.stringify(input.relatedIds) : null,
      input.supersedes ?? null,
      input.supersededBy ?? null,
      chainDepth,
      input.embedding ? Buffer.from(input.embedding.buffer) : null,
    );

    return id;
  }

  /**
   * Get a memory entry by ID.
   */
  get(id: string): MemoryEntry | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as unknown as
      | MemoryRow
      | undefined;
    if (!row) return null;

    // Update access stats
    this.db
      .prepare(
        "UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
      )
      .run(Math.floor(Date.now() / 1000), id);

    return this.rowToEntry(row);
  }

  /**
   * Update a memory entry.
   */
  update(id: string, updates: Partial<MemoryEntry>): boolean {
    const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(id);
    if (!existing) return false;

    const fields: string[] = [];
    const values: SQLInputValue[] = [];

    if (updates.content !== undefined) {
      fields.push("content = ?");
      values.push(updates.content);
    }
    if (updates.type !== undefined) {
      fields.push("type = ?");
      values.push(updates.type);
    }
    if (updates.source !== undefined) {
      fields.push("source = ?");
      values.push(updates.source);
    }
    if (updates.importance !== undefined) {
      fields.push("importance = ?");
      values.push(updates.importance);
    }
    if (updates.confidence !== undefined) {
      fields.push("confidence = ?");
      values.push(updates.confidence);
    }
    if (updates.createdAt !== undefined) {
      fields.push("created_at = ?");
      values.push(updates.createdAt);
    }
    if (updates.expiresAt !== undefined) {
      fields.push("expires_at = ?");
      values.push(updates.expiresAt);
    }
    if (updates.tags !== undefined) {
      fields.push("tags = ?");
      values.push(updates.tags ? JSON.stringify(updates.tags) : null);
    }
    if (updates.relatedIds !== undefined) {
      fields.push("related_ids = ?");
      values.push(updates.relatedIds ? JSON.stringify(updates.relatedIds) : null);
    }
    if (updates.supersededBy !== undefined) {
      fields.push("superseded_by = ?");
      values.push(updates.supersededBy);
    }
    if (updates.embedding !== undefined) {
      fields.push("embedding = ?");
      values.push(updates.embedding ? Buffer.from(updates.embedding.buffer) : null);
    }

    if (fields.length === 0) return true;

    values.push(id);
    this.db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...values);

    return true;
  }

  /**
   * Delete a memory entry.
   */
  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * Supersede a memory entry with a new one.
   * Marks the old entry as superseded and creates the new entry.
   * Returns null if supersession chain depth exceeds 3.
   */
  supersede(oldId: string, newInput: MemoryEntryInput): string | null {
    // Get current chain depth of the memory being superseded
    const currentDepth = this.getChainDepth(oldId);
    if (currentDepth >= 3) {
      // Chain too deep - reject supersession to prevent infinite chains
      return null;
    }

    // Create new entry with supersedes reference and incremented chain depth
    const newId = this.add(
      {
        ...newInput,
        supersedes: oldId,
      },
      currentDepth + 1,
    );

    // Delete the old entry (we keep the reference in supersedes)
    this.delete(oldId);

    return newId;
  }

  /**
   * Get the chain depth of a memory entry.
   */
  private getChainDepth(id: string): number {
    const row = this.db
      .prepare("SELECT chain_depth FROM memories WHERE id = ?")
      .get(id) as unknown as { chain_depth: number } | undefined;

    return row?.chain_depth ?? 0;
  }

  /**
   * List all memories with optional filters.
   */
  list(options?: MemorySearchOptions): MemoryEntry[] {
    let query = "SELECT * FROM memories WHERE 1=1";
    const params: SQLInputValue[] = [];

    if (options?.types && options.types.length > 0) {
      query += ` AND type IN (${options.types.map(() => "?").join(",")})`;
      params.push(...options.types);
    }

    if (options?.minImportance !== undefined) {
      query += " AND importance >= ?";
      params.push(options.minImportance);
    }

    if (options?.minConfidence !== undefined) {
      query += " AND confidence >= ?";
      params.push(options.minConfidence);
    }

    if (!options?.includeSuperseded) {
      query += " AND superseded_by IS NULL";
    }

    query += " ORDER BY created_at DESC";

    if (options?.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db.prepare(query).all(...params) as unknown as MemoryRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  // ==========================================================================
  // FTS Search
  // ==========================================================================

  /**
   * Search memories using FTS5.
   */
  searchFts(query: string, options?: MemorySearchOptions): MemorySearchResult[] {
    if (!this.ftsAvailable) {
      // Fallback to LIKE search
      return this.searchLike(query, options);
    }

    const limit = options?.limit ?? 10;
    const escapedQuery = this.escapeFtsQuery(query);

    let sql = `
      SELECT m.*, bm25(memories_fts) as score
      FROM memories_fts fts
      JOIN memories m ON fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
    `;
    const params: SQLInputValue[] = [escapedQuery];

    if (options?.types && options.types.length > 0) {
      sql += ` AND m.type IN (${options.types.map(() => "?").join(",")})`;
      params.push(...options.types);
    }

    if (options?.minImportance !== undefined) {
      sql += " AND m.importance >= ?";
      params.push(options.minImportance);
    }

    if (!options?.includeSuperseded) {
      sql += " AND m.superseded_by IS NULL";
    }

    sql += " ORDER BY score LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as unknown as (MemoryRow & {
      score: number;
    })[];

    return rows.map((row) => ({
      entry: this.rowToEntry(row),
      score: Math.abs(row.score), // BM25 returns negative scores
      matchType: "fts" as const,
    }));
  }

  /**
   * Fallback LIKE search when FTS is not available.
   */
  private searchLike(query: string, options?: MemorySearchOptions): MemorySearchResult[] {
    const limit = options?.limit ?? 10;
    const pattern = `%${query}%`;

    let sql = "SELECT * FROM memories WHERE content LIKE ?";
    const params: SQLInputValue[] = [pattern];

    if (options?.types && options.types.length > 0) {
      sql += ` AND type IN (${options.types.map(() => "?").join(",")})`;
      params.push(...options.types);
    }

    if (!options?.includeSuperseded) {
      sql += " AND superseded_by IS NULL";
    }

    sql += " ORDER BY importance DESC, created_at DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as unknown as MemoryRow[];

    return rows.map((row, index) => ({
      entry: this.rowToEntry(row),
      score: 1 - index * 0.1, // Simple ranking
      matchType: "fts" as const,
    }));
  }

  /**
   * Escape special characters for FTS5 query.
   */
  private escapeFtsQuery(query: string): string {
    // Escape special FTS5 characters and wrap in quotes
    return `"${query.replace(/"/g, '""')}"`;
  }

  // ==========================================================================
  // Memory Block Operations
  // ==========================================================================

  /**
   * Get a memory block by label.
   */
  getBlock(label: MemoryBlockLabel): MemoryBlock | null {
    const row = this.db
      .prepare("SELECT * FROM memory_blocks WHERE label = ?")
      .get(label) as unknown as MemoryBlockRow | undefined;
    if (!row) return null;

    return {
      id: row.id,
      label: row.label as MemoryBlockLabel,
      value: row.value,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Upsert a memory block.
   */
  upsertBlock(block: MemoryBlock): void {
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `
      INSERT INTO memory_blocks (label, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
      )
      .run(block.label, block.value, now);
  }

  /**
   * Get all memory blocks.
   */
  getAllBlocks(): MemoryBlock[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_blocks")
      .all() as unknown as MemoryBlockRow[];

    return rows.map((row) => ({
      id: row.id,
      label: row.label as MemoryBlockLabel,
      value: row.value,
      updatedAt: row.updated_at,
    }));
  }

  // ==========================================================================
  // Daily Summary Operations
  // ==========================================================================

  /**
   * Save a daily summary.
   */
  saveDailySummary(summary: DailySummary): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO daily_summaries (date, summary, key_decisions, mentioned_entities, token_count)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(
        summary.date,
        summary.summary,
        summary.keyDecisions ? JSON.stringify(summary.keyDecisions) : null,
        summary.mentionedEntities ? JSON.stringify(summary.mentionedEntities) : null,
        summary.tokenCount ?? null,
      );
  }

  /**
   * Get a daily summary by date.
   */
  getDailySummary(date: string): DailySummary | null {
    const row = this.db
      .prepare("SELECT * FROM daily_summaries WHERE date = ?")
      .get(date) as unknown as DailySummaryRow | undefined;
    if (!row) return null;

    return {
      date: row.date,
      summary: row.summary,
      keyDecisions: row.key_decisions ? JSON.parse(row.key_decisions) : undefined,
      mentionedEntities: row.mentioned_entities ? JSON.parse(row.mentioned_entities) : undefined,
      tokenCount: row.token_count ?? undefined,
    };
  }

  /**
   * Get all daily summaries.
   */
  getAllSummaries(): DailySummary[] {
    const rows = this.db
      .prepare("SELECT * FROM daily_summaries ORDER BY date DESC")
      .all() as unknown as DailySummaryRow[];
    return rows.map((row) => ({
      date: row.date,
      summary: row.summary,
      keyDecisions: row.key_decisions ? JSON.parse(row.key_decisions) : undefined,
      mentionedEntities: row.mentioned_entities ? JSON.parse(row.mentioned_entities) : undefined,
      tokenCount: row.token_count ?? undefined,
    }));
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Convert a database row to a MemoryEntry.
   */
  private rowToEntry(row: MemoryRow): MemoryEntry {
    return {
      id: row.id,
      type: row.type as MemoryEntry["type"],
      content: row.content,
      source: row.source as MemoryEntry["source"],
      importance: row.importance,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
      expiresAt: row.expires_at ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      relatedIds: row.related_ids ? JSON.parse(row.related_ids) : undefined,
      supersedes: row.supersedes ?? undefined,
      supersededBy: row.superseded_by ?? undefined,
      embedding: row.embedding ? new Float32Array(row.embedding.buffer) : undefined,
    };
  }

  /**
   * Get the database file path.
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Get the underlying database connection (for repair operations).
   */
  getDb(): DatabaseSync {
    return this.db;
  }

  /**
   * Vacuum the database to reclaim space.
   */
  vacuum(): void {
    this.db.exec("VACUUM");
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

// ============================================================================
// Database Row Types
// ============================================================================

interface MemoryRow {
  rowid: number;
  id: string;
  type: string;
  content: string;
  source: string;
  importance: number;
  confidence: number;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  access_count: number;
  expires_at: number | null;
  tags: string | null;
  related_ids: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  chain_depth: number;
  embedding: Buffer | null;
}

interface MemoryBlockRow {
  id: number;
  label: string;
  value: string;
  updated_at: number;
}

interface DailySummaryRow {
  date: string;
  summary: string;
  key_decisions: string | null;
  mentioned_entities: string | null;
  token_count: number | null;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Open or create a facts memory database.
 */
export function openFactsMemoryStore(dbPath: string): FactsMemoryStore {
  // Ensure directory exists
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

  const { DatabaseSync } = requireNodeSqlite();

  const db = new DatabaseSync(dbPath);
  const store = new FactsMemoryStore(db, dbPath);
  store.initialize();

  return store;
}
