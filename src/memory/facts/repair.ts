/**
 * Facts Memory Repair
 *
 * Database diagnostics, repair, and FTS rebuild functionality.
 */

import type { DatabaseSync } from "node:sqlite";
import type { FactsMemoryStore } from "./store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

// ============================================================================
// Types
// ============================================================================

const logger = createSubsystemLogger("facts-repair");

/** Repair options */
export interface RepairOptions {
  /** Check database integrity */
  check?: boolean;
  /** Rebuild FTS index */
  reindex?: boolean;
  /** Vacuum database */
  vacuum?: boolean;
}

/** Integrity check result */
export interface IntegrityCheckResult {
  /** Whether the check passed */
  ok: boolean;
  /** Integrity check messages (empty if ok) */
  messages: string[];
}

/** FTS reindex result */
export interface FtsReindexResult {
  /** Whether reindex succeeded */
  success: boolean;
  /** Number of rows reindexed */
  rowsReindexed: number;
  /** Error message if failed */
  error?: string;
}

/** Repair result */
export interface RepairResult {
  /** Overall success */
  success: boolean;
  /** Integrity check result (if requested) */
  integrityCheck?: IntegrityCheckResult;
  /** FTS reindex result (if requested) */
  ftsReindex?: FtsReindexResult;
  /** Whether vacuum was performed */
  vacuumed?: boolean;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Integrity Check
// ============================================================================

/**
 * Run SQLite integrity check on the database.
 */
export function checkIntegrity(store: FactsMemoryStore): IntegrityCheckResult {
  const db = store.getDb();

  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const messages = rows.map((r) => r.integrity_check);

    // "ok" means all is well
    const ok = messages.length === 1 && messages[0] === "ok";

    return {
      ok,
      messages: ok ? [] : messages,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      messages: [`Integrity check failed: ${message}`],
    };
  }
}

// ============================================================================
// FTS Rebuild
// ============================================================================

/**
 * Rebuild the FTS5 index from source data.
 * Drops and recreates the FTS table and triggers.
 */
export function rebuildFtsIndex(store: FactsMemoryStore): FtsReindexResult {
  const db = store.getDb();

  try {
    // Check if FTS table exists
    const ftsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get() as { name: string } | undefined;

    // Drop existing FTS table and triggers
    if (ftsExists) {
      db.exec("DROP TRIGGER IF EXISTS memories_ai");
      db.exec("DROP TRIGGER IF EXISTS memories_ad");
      db.exec("DROP TRIGGER IF EXISTS memories_au");
      db.exec("DROP TABLE IF EXISTS memories_fts");
    }

    // Recreate FTS table
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        tags,
        content=memories,
        content_rowid=rowid
      );
    `);

    // Recreate triggers
    db.exec(`
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, REPLACE(REPLACE(REPLACE(COALESCE(new.tags, ''), '"', ''), '[', ''), ']', ''));
      END;
    `);

    db.exec(`
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, REPLACE(REPLACE(REPLACE(COALESCE(old.tags, ''), '"', ''), '[', ''), ']', ''));
      END;
    `);

    db.exec(`
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, REPLACE(REPLACE(REPLACE(COALESCE(old.tags, ''), '"', ''), '[', ''), ']', ''));
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, REPLACE(REPLACE(REPLACE(COALESCE(new.tags, ''), '"', ''), '[', ''), ']', ''));
      END;
    `);

    // Populate FTS from source table
    const result = db.exec(`
      INSERT INTO memories_fts(rowid, content, tags)
      SELECT rowid, content, REPLACE(REPLACE(REPLACE(COALESCE(tags, ''), '"', ''), '[', ''), ']', '')
      FROM memories;
    `);

    // Count rows that were indexed
    const countRow = db.prepare("SELECT COUNT(*) as count FROM memories").get() as {
      count: number;
    };
    const rowsReindexed = countRow?.count ?? 0;

    logger.info(`FTS index rebuilt: ${rowsReindexed} rows indexed`);

    return {
      success: true,
      rowsReindexed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`FTS rebuild failed: ${message}`);
    return {
      success: false,
      rowsReindexed: 0,
      error: message,
    };
  }
}

// ============================================================================
// Vacuum
// ============================================================================

/**
 * Vacuum the database to reclaim space.
 */
export function vacuumDatabase(store: FactsMemoryStore): boolean {
  try {
    store.vacuum();
    logger.info("Database vacuumed successfully");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Vacuum failed: ${message}`);
    return false;
  }
}

// ============================================================================
// Combined Repair
// ============================================================================

/**
 * Run repair operations based on options.
 */
export function runRepair(store: FactsMemoryStore, options: RepairOptions = {}): RepairResult {
  const result: RepairResult = { success: true };

  try {
    // Check integrity if requested
    if (options.check) {
      result.integrityCheck = checkIntegrity(store);
      if (!result.integrityCheck.ok) {
        logger.warn(`Integrity check failed: ${result.integrityCheck.messages.join(", ")}`);
      }
    }

    // Rebuild FTS if requested
    if (options.reindex) {
      result.ftsReindex = rebuildFtsIndex(store);
      if (!result.ftsReindex.success) {
        result.success = false;
        result.error = result.ftsReindex.error;
      }
    }

    // Vacuum if requested
    if (options.vacuum) {
      result.vacuumed = vacuumDatabase(store);
      if (!result.vacuumed) {
        result.success = false;
        result.error = "Vacuum failed";
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
    };
  }
}
