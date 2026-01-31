/**
 * Approval Store
 *
 * Persists approval decisions for workflow runs.
 * Supports dual storage: in-memory state + artifacts for durability.
 */

import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

import type { ApprovalRecord, ApprovalRequest } from "./types.js";

// ============================================================================
// Store Interface
// ============================================================================

/**
 * Interface for approval storage implementations.
 */
export interface IApprovalStore {
  /**
   * Save an approval record.
   */
  save(record: ApprovalRecord): Promise<void>;

  /**
   * Get all approvals for a run.
   */
  getByRun(runId: string): Promise<ApprovalRecord[]>;

  /**
   * Get a specific approval by request ID.
   */
  getById(requestId: string): Promise<ApprovalRecord | null>;

  /**
   * Find matching approval for similar action.
   */
  findMatching(request: ApprovalRequest): Promise<ApprovalRecord | null>;

  /**
   * Clear all approvals for a run.
   */
  clearRun(runId: string): Promise<void>;
}

// ============================================================================
// In-Memory Store
// ============================================================================

/**
 * In-memory approval store (for testing and session-scoped approvals).
 */
export class InMemoryApprovalStore implements IApprovalStore {
  private records: Map<string, ApprovalRecord> = new Map();
  private byRun: Map<string, Set<string>> = new Map();

  async save(record: ApprovalRecord): Promise<void> {
    const requestId = record.request.id;
    const runId = record.request.runId;

    this.records.set(requestId, record);

    if (!this.byRun.has(runId)) {
      this.byRun.set(runId, new Set());
    }
    this.byRun.get(runId)!.add(requestId);
  }

  async getByRun(runId: string): Promise<ApprovalRecord[]> {
    const requestIds = this.byRun.get(runId);
    if (!requestIds) return [];

    return Array.from(requestIds)
      .map((id) => this.records.get(id))
      .filter((r): r is ApprovalRecord => r !== undefined);
  }

  async getById(requestId: string): Promise<ApprovalRecord | null> {
    return this.records.get(requestId) ?? null;
  }

  async findMatching(request: ApprovalRequest): Promise<ApprovalRecord | null> {
    // Look for a remembered approval with matching action pattern
    const runRecords = await this.getByRun(request.runId);

    for (const record of runRecords) {
      if (!record.remember) continue;

      // Check if action types match
      if (record.request.action.actionType !== request.action.actionType) continue;

      // Check scope-based matching
      if (record.rememberScope === "run" && record.request.runId !== request.runId) continue;

      // Match by target (path, command, or URL)
      if (this.actionsMatch(record.request.action, request.action)) {
        return record;
      }
    }

    return null;
  }

  async clearRun(runId: string): Promise<void> {
    const requestIds = this.byRun.get(runId);
    if (requestIds) {
      for (const id of requestIds) {
        this.records.delete(id);
      }
      this.byRun.delete(runId);
    }
  }

  /**
   * Check if two actions are similar enough to use cached approval.
   */
  private actionsMatch(a: ApprovalRequest["action"], b: ApprovalRequest["action"]): boolean {
    // Same target path
    if (a.targetPath && b.targetPath && a.targetPath === b.targetPath) {
      return true;
    }

    // Same command prefix (for bash)
    if (a.command && b.command) {
      const aPrefix = a.command.split(/\s+/)[0];
      const bPrefix = b.command.split(/\s+/)[0];
      if (aPrefix === bPrefix) return true;
    }

    // Same URL origin (for network)
    if (a.url && b.url) {
      try {
        const aOrigin = new URL(a.url).origin;
        const bOrigin = new URL(b.url).origin;
        if (aOrigin === bOrigin) return true;
      } catch {
        // Invalid URLs - no match
      }
    }

    return false;
  }
}

// ============================================================================
// File-Based Store
// ============================================================================

/**
 * File-based approval store (for durability across restarts).
 * Uses append-only JSONL format for efficient writes.
 */
export class FileApprovalStore implements IApprovalStore {
  private baseDir: string;
  private memoryCache: InMemoryApprovalStore;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.memoryCache = new InMemoryApprovalStore();
  }

  async save(record: ApprovalRecord): Promise<void> {
    // Save to memory cache
    await this.memoryCache.save(record);

    // Append to file (efficient JSONL append, not load-all-save-all)
    await this.appendToFile(record);
  }

  async getByRun(runId: string): Promise<ApprovalRecord[]> {
    // Try memory cache first
    const cached = await this.memoryCache.getByRun(runId);
    if (cached.length > 0) return cached;

    // Load from file
    return this.loadFromFile(runId);
  }

  async getById(requestId: string): Promise<ApprovalRecord | null> {
    // Check memory cache first
    const cached = await this.memoryCache.getById(requestId);
    if (cached) return cached;

    // Would need to scan all files - expensive, so return null
    // In practice, getById is called after save, so cache should have it
    return null;
  }

  async findMatching(request: ApprovalRequest): Promise<ApprovalRecord | null> {
    // Check memory cache first
    const cached = await this.memoryCache.findMatching(request);
    if (cached) return cached;

    // Load from file and check
    const records = await this.loadFromFile(request.runId);
    for (const record of records) {
      if (!record.remember) continue;
      if (record.request.action.actionType !== request.action.actionType) continue;

      // Simple path/command/url matching
      if (
        record.request.action.targetPath === request.action.targetPath ||
        record.request.action.command?.split(/\s+/)[0] === request.action.command?.split(/\s+/)[0]
      ) {
        // Cache it for future
        await this.memoryCache.save(record);
        return record;
      }
    }

    return null;
  }

  async clearRun(runId: string): Promise<void> {
    await this.memoryCache.clearRun(runId);

    // Delete file
    const filePath = this.getFilePath(runId);
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(filePath);
    } catch {
      // File doesn't exist - ok
    }
  }

  // ==========================================================================
  // File Operations
  // ==========================================================================

  private getFilePath(runId: string): string {
    // Store approvals.jsonl inside the run directory (baseDir is workflow storage path)
    return join(this.baseDir, runId, "approvals.jsonl");
  }

  private async loadFromFile(runId: string): Promise<ApprovalRecord[]> {
    const filePath = this.getFilePath(runId);
    try {
      const content = await readFile(filePath, "utf-8");
      // Parse JSONL format
      const lines = content.trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as ApprovalRecord);
    } catch {
      return [];
    }
  }

  /**
   * Append a single record to the JSONL file (efficient append-only).
   */
  private async appendToFile(record: ApprovalRecord): Promise<void> {
    const filePath = this.getFilePath(record.request.runId);

    // Ensure directory exists
    const { dirname } = await import("node:path");
    const { appendFile } = await import("node:fs/promises");
    await mkdir(dirname(filePath), { recursive: true });

    // Append single line (atomic-ish)
    const line = JSON.stringify(record) + "\n";
    await appendFile(filePath, line, "utf-8");
  }

  /**
   * Write all records to file (used for migrations or clear+rewrite).
   */
  private async saveToFile(runId: string, records: ApprovalRecord[]): Promise<void> {
    const filePath = this.getFilePath(runId);

    // Ensure directory exists
    const { dirname } = await import("node:path");
    await mkdir(dirname(filePath), { recursive: true });

    // Write as JSONL
    const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");
  }
}

// ============================================================================
// Composite Store
// ============================================================================

/**
 * Composite store that combines memory and file storage.
 * Uses memory for fast lookups, file for durability.
 */
export class CompositeApprovalStore implements IApprovalStore {
  private memory: InMemoryApprovalStore;
  private file: FileApprovalStore;

  constructor(baseDir: string) {
    this.memory = new InMemoryApprovalStore();
    this.file = new FileApprovalStore(baseDir);
  }

  async save(record: ApprovalRecord): Promise<void> {
    await Promise.all([this.memory.save(record), this.file.save(record)]);
  }

  async getByRun(runId: string): Promise<ApprovalRecord[]> {
    // Memory is faster and should be up-to-date during session
    const memoryRecords = await this.memory.getByRun(runId);
    if (memoryRecords.length > 0) return memoryRecords;

    // Fall back to file
    return this.file.getByRun(runId);
  }

  async getById(requestId: string): Promise<ApprovalRecord | null> {
    return this.memory.getById(requestId);
  }

  async findMatching(request: ApprovalRequest): Promise<ApprovalRecord | null> {
    // Check memory first (fast)
    const memoryMatch = await this.memory.findMatching(request);
    if (memoryMatch) return memoryMatch;

    // Check file (may have records from previous session)
    return this.file.findMatching(request);
  }

  async clearRun(runId: string): Promise<void> {
    await Promise.all([this.memory.clearRun(runId), this.file.clearRun(runId)]);
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an approval store with appropriate backing.
 */
export function createApprovalStore(options: {
  type: "memory" | "file" | "composite";
  baseDir?: string;
}): IApprovalStore {
  switch (options.type) {
    case "memory":
      return new InMemoryApprovalStore();
    case "file":
      if (!options.baseDir) {
        throw new Error("baseDir required for file store");
      }
      return new FileApprovalStore(options.baseDir);
    case "composite":
      if (!options.baseDir) {
        throw new Error("baseDir required for composite store");
      }
      return new CompositeApprovalStore(options.baseDir);
    default:
      return new InMemoryApprovalStore();
  }
}
