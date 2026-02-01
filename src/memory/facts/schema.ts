/**
 * Facts Memory Schema
 *
 * SQLite schema and migrations for the facts memory system.
 * Uses WAL mode for better concurrency and FTS5 for full-text search.
 */

import type { DatabaseSync } from "node:sqlite";

// ============================================================================
// Schema Version
// ============================================================================

const SCHEMA_VERSION = 1;

// ============================================================================
// Pragmas
// ============================================================================

/** Initialize database pragmas for optimal performance */
export function initializePragmas(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec("PRAGMA cache_size=-64000;"); // 64MB cache
  db.exec("PRAGMA temp_store=MEMORY;");
}

// ============================================================================
// Schema Creation
// ============================================================================

/** Create the memories table */
function createMemoriesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('fact','preference','decision','event','todo')),
      content TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('explicit','inferred','conversation')),
      importance REAL DEFAULT 0.5,
      confidence REAL DEFAULT 0.8,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      access_count INTEGER DEFAULT 0,
      expires_at INTEGER,
      tags TEXT,
      related_ids TEXT,
      supersedes TEXT,
      superseded_by TEXT,
      chain_depth INTEGER DEFAULT 0,
      embedding BLOB
    );
  `);

  // Indexes for common queries
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_id ON memories(id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by);");
}

/** Create the memory_blocks table */
function createMemoryBlocksTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_blocks (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);
}

/** Create the daily_summaries table */
function createDailySummariesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_summaries (
      date TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      key_decisions TEXT,
      mentioned_entities TEXT,
      token_count INTEGER
    );
  `);
}

/** Create the FTS5 virtual table for full-text search */
function createFtsTable(db: DatabaseSync): { success: boolean; error?: string } {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        tags,
        content=memories,
        content_rowid=rowid
      );
    `);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/** Create FTS triggers for automatic sync */
function createFtsTriggers(db: DatabaseSync): void {
  // Check if triggers already exist
  const existingTriggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memories_%'")
    .all() as Array<{ name: string }>;

  const triggerNames = new Set(existingTriggers.map((t) => t.name));

  // Note: We store tags as space-separated text for FTS (extract from JSON array)
  // The REPLACE removes [ ] " characters from the JSON array for better text matching
  if (!triggerNames.has("memories_ai")) {
    db.exec(`
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, REPLACE(REPLACE(REPLACE(COALESCE(new.tags, ''), '"', ''), '[', ''), ']', ''));
      END;
    `);
  }

  if (!triggerNames.has("memories_ad")) {
    db.exec(`
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, REPLACE(REPLACE(REPLACE(COALESCE(old.tags, ''), '"', ''), '[', ''), ']', ''));
      END;
    `);
  }

  if (!triggerNames.has("memories_au")) {
    db.exec(`
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, REPLACE(REPLACE(REPLACE(COALESCE(old.tags, ''), '"', ''), '[', ''), ']', ''));
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, REPLACE(REPLACE(REPLACE(COALESCE(new.tags, ''), '"', ''), '[', ''), ']', ''));
      END;
    `);
  }
}

/** Create schema version tracking table */
function createSchemaVersionTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

// ============================================================================
// Schema Initialization
// ============================================================================

export interface SchemaInitResult {
  /** Whether initialization succeeded */
  success: boolean;
  /** Schema version */
  version: number;
  /** Whether FTS is available */
  ftsAvailable: boolean;
  /** FTS error if any */
  ftsError?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Initialize the facts memory schema.
 * Creates all tables, indexes, and FTS support.
 */
export function initializeSchema(db: DatabaseSync): SchemaInitResult {
  try {
    // Initialize pragmas
    initializePragmas(db);

    // Create schema version table
    createSchemaVersionTable(db);

    // Check current version
    const currentVersion = getCurrentSchemaVersion(db);

    // Apply migrations if needed
    if (currentVersion < SCHEMA_VERSION) {
      applyMigrations(db, currentVersion);
    }

    // Create tables (idempotent)
    createMemoriesTable(db);
    createMemoryBlocksTable(db);
    createDailySummariesTable(db);

    // Create FTS
    const ftsResult = createFtsTable(db);
    if (ftsResult.success) {
      createFtsTriggers(db);
    }

    // Update schema version
    setSchemaVersion(db, SCHEMA_VERSION);

    return {
      success: true,
      version: SCHEMA_VERSION,
      ftsAvailable: ftsResult.success,
      ftsError: ftsResult.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      version: 0,
      ftsAvailable: false,
      error: message,
    };
  }
}

// ============================================================================
// Migration Helpers
// ============================================================================

/** Get current schema version */
function getCurrentSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

/** Set schema version */
function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)").run(
    version,
    Math.floor(Date.now() / 1000),
  );
}

/** Apply migrations from current version to target */
function applyMigrations(db: DatabaseSync, fromVersion: number): void {
  // Migration 0 -> 1: Initial schema (handled by table creation)
  if (fromVersion < 1) {
    // Initial schema - no migration needed, tables are created above
  }

  // Future migrations would go here:
  // if (fromVersion < 2) { ... }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if the database has the required schema.
 */
export function hasRequiredSchema(db: DatabaseSync): boolean {
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memories', 'memory_blocks', 'daily_summaries')",
      )
      .all() as Array<{ name: string }>;
    return tables.length === 3;
  } catch {
    return false;
  }
}

/**
 * Get table statistics for diagnostics.
 */
export function getTableStats(db: DatabaseSync): Record<string, { count: number; size?: number }> {
  const stats: Record<string, { count: number }> = {};

  try {
    const memoriesCount = db.prepare("SELECT COUNT(*) as count FROM memories").get() as {
      count: number;
    };
    stats.memories = { count: memoriesCount.count };
  } catch {
    stats.memories = { count: 0 };
  }

  try {
    const blocksCount = db.prepare("SELECT COUNT(*) as count FROM memory_blocks").get() as {
      count: number;
    };
    stats.memory_blocks = { count: blocksCount.count };
  } catch {
    stats.memory_blocks = { count: 0 };
  }

  try {
    const summariesCount = db.prepare("SELECT COUNT(*) as count FROM daily_summaries").get() as {
      count: number;
    };
    stats.daily_summaries = { count: summariesCount.count };
  } catch {
    stats.daily_summaries = { count: 0 };
  }

  return stats;
}
