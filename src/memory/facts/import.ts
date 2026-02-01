/**
 * Facts Memory Import
 *
 * Import facts memory from JSONL format.
 */

import { readFileSync } from "node:fs";
import type { FactsMemoryStore } from "./store.js";
import type { MemoryEntryInput, MemoryBlock, DailySummary } from "./types.js";
import type {
  ExportRecord,
  MemoryExportRecord,
  BlockExportRecord,
  SummaryExportRecord,
} from "./export.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

// ============================================================================
// Types
// ============================================================================

const logger = createSubsystemLogger("facts-import");

/** Import mode */
export type ImportMode = "merge" | "replace";

/** Import options */
export interface ImportOptions {
  /** Import mode: merge (add to existing) or replace (clear first) */
  mode: ImportMode;
}

/** Import result */
export interface ImportResult {
  success: boolean;
  memoriesImported: number;
  blocksImported: number;
  summariesImported: number;
  memoriesSkipped: number;
  inputPath: string;
  error?: string;
}

// ============================================================================
// Import Function
// ============================================================================

/**
 * Import facts memory data from a JSONL file.
 */
export function importFromJsonl(
  store: FactsMemoryStore,
  inputPath: string,
  options: ImportOptions = { mode: "merge" },
): ImportResult {
  let memoriesImported = 0;
  let blocksImported = 0;
  let summariesImported = 0;
  let memoriesSkipped = 0;

  try {
    // Read file
    const content = readFileSync(inputPath, "utf-8");
    const lines = content
      .trim()
      .split("\n")
      .filter((line) => line.trim());

    if (lines.length === 0) {
      return {
        success: true,
        memoriesImported: 0,
        blocksImported: 0,
        summariesImported: 0,
        memoriesSkipped: 0,
        inputPath,
      };
    }

    // Clear database if replace mode
    if (options.mode === "replace") {
      clearDatabase(store);
    }

    // Parse and import each line
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as ExportRecord;

        switch (record.type) {
          case "memory": {
            const memRecord = record as MemoryExportRecord;
            const result = importMemory(store, memRecord.data, options.mode);
            if (result) {
              memoriesImported++;
            } else {
              memoriesSkipped++;
            }
            break;
          }

          case "block": {
            const blockRecord = record as BlockExportRecord;
            importBlock(store, blockRecord.data);
            blocksImported++;
            break;
          }

          case "summary": {
            const summaryRecord = record as SummaryExportRecord;
            importSummary(store, summaryRecord.data);
            summariesImported++;
            break;
          }

          case "metadata":
            // Metadata is informational only
            break;

          default:
            logger.warn(`Unknown record type: ${(record as ExportRecord).type}`);
        }
      } catch (parseErr) {
        logger.warn(`Failed to parse line: ${parseErr}`);
      }
    }

    logger.info(
      `Imported ${memoriesImported} memories (${memoriesSkipped} skipped), ${blocksImported} blocks, ${summariesImported} summaries from ${inputPath}`,
    );

    return {
      success: true,
      memoriesImported,
      blocksImported,
      summariesImported,
      memoriesSkipped,
      inputPath,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Import failed: ${message}`);
    return {
      success: false,
      memoriesImported,
      blocksImported,
      summariesImported,
      memoriesSkipped,
      inputPath,
      error: message,
    };
  }
}

// ============================================================================
// Import Helpers
// ============================================================================

/**
 * Clear all data from the database.
 */
function clearDatabase(store: FactsMemoryStore): void {
  const db = store.getDb();
  db.exec("DELETE FROM memories");
  db.exec("DELETE FROM memory_blocks");
  db.exec("DELETE FROM daily_summaries");
  logger.info("Database cleared for replace import");
}

/**
 * Import a single memory entry.
 * Returns true if imported, false if skipped (duplicate in merge mode).
 */
function importMemory(
  store: FactsMemoryStore,
  data: MemoryExportRecord["data"],
  mode: ImportMode,
): boolean {
  // In merge mode, check if ID already exists
  if (mode === "merge") {
    const existing = store.get(data.id);
    if (existing) {
      return false; // Skip duplicate
    }
  }

  // Insert with original ID
  const db = store.getDb();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT OR REPLACE INTO memories (
      id, type, content, source, importance, confidence,
      created_at, updated_at, last_accessed_at, access_count,
      expires_at, tags, related_ids, supersedes, superseded_by, chain_depth, embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.id,
    data.type,
    data.content,
    data.source,
    data.importance,
    data.confidence,
    data.createdAt,
    data.updatedAt ?? now,
    data.lastAccessedAt ?? now,
    data.accessCount ?? 0,
    data.expiresAt ?? null,
    data.tags ? JSON.stringify(data.tags) : null,
    data.relatedIds ? JSON.stringify(data.relatedIds) : null,
    data.supersedes ?? null,
    data.supersededBy ?? null,
    0, // chain_depth
    data.embedding ? Buffer.from(data.embedding.buffer) : null,
  );

  return true;
}

/**
 * Import a memory block.
 */
function importBlock(store: FactsMemoryStore, data: MemoryBlock): void {
  store.upsertBlock(data);
}

/**
 * Import a daily summary.
 */
function importSummary(store: FactsMemoryStore, data: DailySummary): void {
  store.saveDailySummary(data);
}
