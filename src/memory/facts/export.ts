/**
 * Facts Memory Export
 *
 * Export facts memory to JSONL format for backup/migration.
 * Supports redaction of sensitive data and type exclusion.
 */

import { createWriteStream, writeFileSync } from "node:fs";
import type { FactsMemoryStore } from "./store.js";
import type { MemoryEntry, MemoryBlock, DailySummary, MemoryType } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  processEntriesForExport,
  type ExportRedactionOptions,
  type RedactionPatternType,
  DEFAULT_REDACTION_PATTERNS,
} from "./redaction.js";

// ============================================================================
// Types
// ============================================================================

const logger = createSubsystemLogger("facts-export");

/** Export record types */
export type ExportRecordType = "memory" | "block" | "summary" | "metadata";

/** Base export record */
interface BaseExportRecord {
  type: ExportRecordType;
  version: number;
  exportedAt: number;
}

/** Memory export record */
export interface MemoryExportRecord extends BaseExportRecord {
  type: "memory";
  data: MemoryEntry;
}

/** Block export record */
export interface BlockExportRecord extends BaseExportRecord {
  type: "block";
  data: MemoryBlock;
}

/** Summary export record */
export interface SummaryExportRecord extends BaseExportRecord {
  type: "summary";
  data: DailySummary;
}

/** Metadata export record */
export interface MetadataExportRecord extends BaseExportRecord {
  type: "metadata";
  data: {
    memoryCount: number;
    blockCount: number;
    summaryCount: number;
    dbPath: string;
  };
}

/** Any export record */
export type ExportRecord =
  | MemoryExportRecord
  | BlockExportRecord
  | SummaryExportRecord
  | MetadataExportRecord;

/** Export result */
export interface ExportResult {
  success: boolean;
  memoriesExported: number;
  blocksExported: number;
  summariesExported: number;
  outputPath: string;
  error?: string;
  /** Number of memories excluded by type filter */
  memoriesExcluded?: number;
  /** Whether redaction was applied */
  redactionApplied?: boolean;
}

/** Export options */
export interface ExportOptions {
  /** Enable redaction of sensitive data */
  redact?: boolean;
  /** Redaction patterns to apply */
  patterns?: RedactionPatternType[];
  /** Memory types to exclude */
  excludeTypes?: MemoryType[];
  /** Custom replacement string for redaction */
  replacement?: string;
}

// ============================================================================
// Export Function
// ============================================================================

const EXPORT_VERSION = 1;

/**
 * Export all facts memory data to a JSONL file.
 *
 * @param store - The facts memory store
 * @param outputPath - Output file path
 * @param options - Export options (redaction, type exclusion)
 */
export function exportToJsonl(
  store: FactsMemoryStore,
  outputPath: string,
  options: ExportOptions = {},
): ExportResult {
  const exportedAt = Date.now();
  let memoriesExported = 0;
  let memoriesExcluded = 0;
  let blocksExported = 0;
  let summariesExported = 0;
  const redactionApplied = options.redact ?? false;

  try {
    const lines: string[] = [];

    // Get all memories
    const allMemories = store.list({ limit: 1000000, includeSuperseded: true });

    // Process with redaction and exclusion
    const redactionOptions: ExportRedactionOptions = {
      redact: options.redact,
      patterns: options.patterns ?? DEFAULT_REDACTION_PATTERNS,
      excludeTypes: options.excludeTypes,
      replacement: options.replacement,
    };

    const processedMemories = processEntriesForExport(allMemories, redactionOptions);
    memoriesExcluded = allMemories.length - processedMemories.length;

    // Export processed memories
    for (const memory of processedMemories) {
      const record: MemoryExportRecord = {
        type: "memory",
        version: EXPORT_VERSION,
        exportedAt,
        data: memory,
      };
      lines.push(JSON.stringify(record));
      memoriesExported++;
    }

    // Export blocks
    const blocks = store.getAllBlocks();
    for (const block of blocks) {
      const record: BlockExportRecord = {
        type: "block",
        version: EXPORT_VERSION,
        exportedAt,
        data: block,
      };
      lines.push(JSON.stringify(record));
      blocksExported++;
    }

    // Export summaries
    const summaries = store.getAllSummaries();
    for (const summary of summaries) {
      const record: SummaryExportRecord = {
        type: "summary",
        version: EXPORT_VERSION,
        exportedAt,
        data: summary,
      };
      lines.push(JSON.stringify(record));
      summariesExported++;
    }

    // Add metadata record at the end
    const metadata: MetadataExportRecord = {
      type: "metadata",
      version: EXPORT_VERSION,
      exportedAt,
      data: {
        memoryCount: memoriesExported,
        blockCount: blocksExported,
        summaryCount: summariesExported,
        dbPath: store.getDbPath(),
      },
    };
    lines.push(JSON.stringify(metadata));

    // Write to file
    writeFileSync(outputPath, lines.join("\n") + "\n", "utf-8");

    const excludedNote = memoriesExcluded > 0 ? ` (${memoriesExcluded} excluded)` : "";
    const redactNote = redactionApplied ? " [redacted]" : "";
    logger.info(
      `Exported ${memoriesExported} memories${excludedNote}, ${blocksExported} blocks, ${summariesExported} summaries to ${outputPath}${redactNote}`,
    );

    return {
      success: true,
      memoriesExported,
      blocksExported,
      summariesExported,
      outputPath,
      memoriesExcluded,
      redactionApplied,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Export failed: ${message}`);
    return {
      success: false,
      memoriesExported,
      blocksExported,
      summariesExported,
      outputPath,
      memoriesExcluded,
      redactionApplied,
      error: message,
    };
  }
}
