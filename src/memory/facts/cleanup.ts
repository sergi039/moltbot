/**
 * Facts Memory Cleanup
 *
 * Retention and cleanup logic for facts memory.
 * Handles age-based pruning, size limits, and importance-based cleanup.
 */

import { statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { FactsMemoryStore } from "./store.js";
import type { FactsMemoryConfig, MemoryEntry } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

// ============================================================================
// Types
// ============================================================================

const logger = createSubsystemLogger("facts-cleanup");

/** Cleanup options */
export interface CleanupOptions {
  /** Run in dry-run mode (don't actually delete) */
  dryRun?: boolean;
  /** Override max age days */
  maxAgeDays?: number;
  /** Override max size MB */
  maxSizeMb?: number;
  /** Prune low importance memories */
  pruneLowImportance?: boolean;
  /** Minimum importance threshold */
  minImportance?: number;
  /** Truncate old summaries */
  truncateSummaries?: boolean;
  /** Days after which summaries are truncated */
  truncateSummariesDays?: number;
}

/** Cleanup result */
export interface CleanupResult {
  /** Whether cleanup succeeded */
  success: boolean;
  /** Number of memories deleted */
  memoriesDeleted: number;
  /** Number of summaries truncated */
  summariesTruncated: number;
  /** Space freed in bytes */
  bytesFreed: number;
  /** Memories that would be deleted (dry-run) */
  candidates?: MemoryEntry[];
  /** Summary files that would be deleted (dry-run) */
  summaryCandidates?: string[];
  /** Error message if failed */
  error?: string;
}

/** Cleanup statistics */
export interface CleanupStats {
  /** Current database size in bytes */
  dbSizeBytes: number;
  /** Total number of memories */
  totalMemories: number;
  /** Memories older than threshold */
  oldMemories: number;
  /** Memories with low importance */
  lowImportanceMemories: number;
  /** Daily summary count */
  dailySummaries: number;
  /** Weekly summary count */
  weeklySummaries: number;
}

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_MAX_AGE_DAYS = 90;
const DEFAULT_MAX_SIZE_MB = 500;
const DEFAULT_MIN_IMPORTANCE = 0.2;
const DEFAULT_TRUNCATE_SUMMARIES_DAYS = 60;

// ============================================================================
// Cleanup Functions
// ============================================================================

/**
 * Get cleanup statistics without making changes.
 */
export function getCleanupStats(
  store: FactsMemoryStore,
  markdownPath: string,
  options: CleanupOptions = {},
): CleanupStats {
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const minImportance = options.minImportance ?? DEFAULT_MIN_IMPORTANCE;

  // Get all memories
  const allMemories = store.list({ limit: 100000 });

  // Calculate age threshold (convert to seconds to match createdAt)
  const ageThresholdSeconds = Math.floor((Date.now() - maxAgeDays * 24 * 60 * 60 * 1000) / 1000);

  // Count old and low importance memories
  let oldCount = 0;
  let lowImportanceCount = 0;

  for (const memory of allMemories) {
    if (memory.createdAt < ageThresholdSeconds) {
      oldCount++;
    }
    if ((memory.importance ?? 0.5) < minImportance) {
      lowImportanceCount++;
    }
  }

  // Get summary counts
  const dailyPath = join(markdownPath, "daily");
  const weeklyPath = join(markdownPath, "weekly");

  let dailyCount = 0;
  let weeklyCount = 0;

  try {
    dailyCount = readdirSync(dailyPath).filter((f) => f.endsWith(".md")).length;
  } catch {
    // Directory doesn't exist
  }

  try {
    weeklyCount = readdirSync(weeklyPath).filter((f) => f.endsWith(".md")).length;
  } catch {
    // Directory doesn't exist
  }

  // Get database size
  let dbSizeBytes = 0;
  try {
    const dbPath = store.getDbPath();
    dbSizeBytes = statSync(dbPath).size;
  } catch {
    // Can't get size
  }

  return {
    dbSizeBytes,
    totalMemories: allMemories.length,
    oldMemories: oldCount,
    lowImportanceMemories: lowImportanceCount,
    dailySummaries: dailyCount,
    weeklySummaries: weeklyCount,
  };
}

/**
 * Run cleanup on the facts memory store.
 */
export function runCleanup(
  store: FactsMemoryStore,
  markdownPath: string,
  config: FactsMemoryConfig = {},
  options: CleanupOptions = {},
): CleanupResult {
  const dryRun = options.dryRun ?? false;
  const retention = config.retention ?? {};

  const maxAgeDays = options.maxAgeDays ?? retention.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxSizeMb = options.maxSizeMb ?? retention.maxSizeMb ?? DEFAULT_MAX_SIZE_MB;
  const pruneLowImportance = options.pruneLowImportance ?? retention.pruneLowImportance ?? false;
  const minImportance = options.minImportance ?? retention.minImportance ?? DEFAULT_MIN_IMPORTANCE;
  const truncateSummaries = options.truncateSummaries ?? true;
  const truncateSummariesDays =
    options.truncateSummariesDays ??
    retention.truncateSummariesDays ??
    DEFAULT_TRUNCATE_SUMMARIES_DAYS;

  try {
    const candidates: MemoryEntry[] = [];
    const summaryCandidates: string[] = [];

    // Get all memories
    const allMemories = store.list({ limit: 100000 });

    // 1. Find memories older than maxAgeDays (convert to seconds)
    const ageThresholdSeconds = Math.floor((Date.now() - maxAgeDays * 24 * 60 * 60 * 1000) / 1000);
    for (const memory of allMemories) {
      if (memory.createdAt < ageThresholdSeconds) {
        candidates.push(memory);
      }
    }

    // 2. Find low importance memories (if enabled)
    if (pruneLowImportance) {
      for (const memory of allMemories) {
        const importance = memory.importance ?? 0.5;
        if (importance < minImportance && !candidates.some((c) => c.id === memory.id)) {
          candidates.push(memory);
        }
      }
    }

    // 3. Check size limit and add more candidates if needed
    let currentSizeBytes = 0;
    try {
      const dbPath = store.getDbPath();
      currentSizeBytes = statSync(dbPath).size;
    } catch {
      // Can't get size
    }

    const maxSizeBytes = maxSizeMb * 1024 * 1024;
    if (currentSizeBytes > maxSizeBytes) {
      // Sort remaining memories by importance (lowest first)
      const remaining = allMemories
        .filter((m) => !candidates.some((c) => c.id === m.id))
        .sort((a, b) => (a.importance ?? 0.5) - (b.importance ?? 0.5));

      // Estimate bytes per memory (rough)
      const avgBytesPerMemory = currentSizeBytes / Math.max(allMemories.length, 1);
      const targetReduction = currentSizeBytes - maxSizeBytes;
      const memoriesToRemove = Math.ceil(targetReduction / avgBytesPerMemory);

      for (let i = 0; i < memoriesToRemove && i < remaining.length; i++) {
        candidates.push(remaining[i]);
      }
    }

    // 4. Find old summaries to truncate
    if (truncateSummaries) {
      const summaryAgeThreshold = Date.now() - truncateSummariesDays * 24 * 60 * 60 * 1000;

      // Check daily summaries
      const dailyPath = join(markdownPath, "daily");
      try {
        const dailyFiles = readdirSync(dailyPath).filter((f) => f.endsWith(".md"));
        for (const file of dailyFiles) {
          const filePath = join(dailyPath, file);
          try {
            const stat = statSync(filePath);
            if (stat.mtimeMs < summaryAgeThreshold) {
              summaryCandidates.push(filePath);
            }
          } catch {
            // Skip files we can't stat
          }
        }
      } catch {
        // Directory doesn't exist
      }

      // Check weekly summaries
      const weeklyPath = join(markdownPath, "weekly");
      try {
        const weeklyFiles = readdirSync(weeklyPath).filter((f) => f.endsWith(".md"));
        for (const file of weeklyFiles) {
          const filePath = join(weeklyPath, file);
          try {
            const stat = statSync(filePath);
            if (stat.mtimeMs < summaryAgeThreshold) {
              summaryCandidates.push(filePath);
            }
          } catch {
            // Skip files we can't stat
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    // If dry-run, return candidates without deleting
    if (dryRun) {
      logger.info(
        `memory.cleanup.dry_run: memories=${candidates.length} summaries=${summaryCandidates.length}`,
      );
      return {
        success: true,
        memoriesDeleted: 0,
        summariesTruncated: 0,
        bytesFreed: 0,
        candidates,
        summaryCandidates,
      };
    }

    // Delete memories
    let memoriesDeleted = 0;
    for (const memory of candidates) {
      try {
        store.delete(memory.id);
        memoriesDeleted++;
      } catch (err) {
        logger.warn(`memory.cleanup.delete_failed: id=${memory.id} error=${err}`);
      }
    }

    // Delete summary files
    let summariesTruncated = 0;
    for (const filePath of summaryCandidates) {
      try {
        unlinkSync(filePath);
        summariesTruncated++;
      } catch (err) {
        logger.warn(`memory.cleanup.summary_delete_failed: path=${filePath} error=${err}`);
      }
    }

    // Calculate bytes freed (approximate)
    let newSizeBytes = 0;
    try {
      const dbPath = store.getDbPath();
      newSizeBytes = statSync(dbPath).size;
    } catch {
      // Can't get size
    }
    const bytesFreed = Math.max(0, currentSizeBytes - newSizeBytes);

    logger.info(
      `memory.cleanup.complete: deleted=${memoriesDeleted} summaries=${summariesTruncated} freed=${bytesFreed}`,
    );

    return {
      success: true,
      memoriesDeleted,
      summariesTruncated,
      bytesFreed,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`memory.cleanup.failed: error=${error}`);
    return {
      success: false,
      memoriesDeleted: 0,
      summariesTruncated: 0,
      bytesFreed: 0,
      error,
    };
  }
}

/**
 * Vacuum the SQLite database to reclaim space.
 */
export function vacuumDatabase(store: FactsMemoryStore): boolean {
  try {
    store.vacuum();
    logger.info("memory.cleanup.vacuum: success");
    return true;
  } catch (err) {
    logger.error(`memory.cleanup.vacuum_failed: error=${err}`);
    return false;
  }
}
