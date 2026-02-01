/**
 * Facts Memory Connection Pool
 *
 * Simple connection pool for SQLite databases.
 * Uses WAL mode and busy_timeout for concurrent access.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { requireNodeSqlite } from "../sqlite.js";
import { initializePragmas, initializeSchema } from "./schema.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

// ============================================================================
// Types
// ============================================================================

const logger = createSubsystemLogger("facts-pool");

export interface PoolConfig {
  /** Database file path */
  dbPath: string;
  /** Maximum connections in pool (default: 3) */
  maxConnections?: number;
  /** Busy timeout in milliseconds (default: 5000) */
  busyTimeoutMs?: number;
}

interface PooledConnection {
  db: DatabaseSync;
  inUse: boolean;
  createdAt: number;
  lastUsedAt: number;
}

// ============================================================================
// Pool Class
// ============================================================================

export class SQLitePool {
  private dbPath: string;
  private maxConnections: number;
  private busyTimeoutMs: number;
  private connections: PooledConnection[] = [];
  private closed: boolean = false;

  constructor(config: PoolConfig) {
    this.dbPath = config.dbPath;
    this.maxConnections = config.maxConnections ?? 3;
    this.busyTimeoutMs = config.busyTimeoutMs ?? 5000;

    // Ensure directory exists
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
  }

  /**
   * Acquire a connection from the pool.
   * Creates a new connection if pool isn't full.
   */
  acquire(): DatabaseSync {
    if (this.closed) {
      throw new Error("Pool is closed");
    }

    // Find an available connection
    for (const conn of this.connections) {
      if (!conn.inUse) {
        conn.inUse = true;
        conn.lastUsedAt = Date.now();
        return conn.db;
      }
    }

    // Create new connection if pool isn't full
    if (this.connections.length < this.maxConnections) {
      const conn = this.createConnection();
      this.connections.push(conn);
      return conn.db;
    }

    // Pool is full and all connections are in use
    // In a sync context, we can't wait, so throw
    throw new Error("Connection pool exhausted");
  }

  /**
   * Release a connection back to the pool.
   */
  release(db: DatabaseSync): void {
    const conn = this.connections.find((c) => c.db === db);
    if (conn) {
      conn.inUse = false;
      conn.lastUsedAt = Date.now();
    }
  }

  /**
   * Execute a function with a pooled connection.
   * Automatically acquires and releases the connection.
   */
  withConnection<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.acquire();
    try {
      return fn(db);
    } finally {
      this.release(db);
    }
  }

  /**
   * Execute an async function with a pooled connection.
   */
  async withConnectionAsync<T>(fn: (db: DatabaseSync) => Promise<T>): Promise<T> {
    const db = this.acquire();
    try {
      return await fn(db);
    } finally {
      this.release(db);
    }
  }

  /**
   * Get pool statistics.
   */
  stats(): {
    total: number;
    inUse: number;
    available: number;
    maxConnections: number;
  } {
    const inUse = this.connections.filter((c) => c.inUse).length;
    return {
      total: this.connections.length,
      inUse,
      available: this.connections.length - inUse,
      maxConnections: this.maxConnections,
    };
  }

  /**
   * Close all connections in the pool.
   */
  close(): void {
    if (this.closed) return;

    this.closed = true;

    for (const conn of this.connections) {
      try {
        conn.db.close();
      } catch (err) {
        logger.warn(`Error closing connection: ${err}`);
      }
    }

    this.connections = [];
    logger.debug(`Pool closed (${this.dbPath})`);
  }

  /**
   * Create a new database connection.
   */
  private createConnection(): PooledConnection {
    const { DatabaseSync } = requireNodeSqlite();

    const db = new DatabaseSync(this.dbPath);

    // Initialize pragmas for optimal performance
    initializePragmas(db);

    // Set custom busy timeout
    db.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs};`);

    // Initialize schema
    initializeSchema(db);

    const now = Date.now();
    logger.debug(`Created new pooled connection (total: ${this.connections.length + 1})`);

    return {
      db,
      inUse: true,
      createdAt: now,
      lastUsedAt: now,
    };
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new SQLite connection pool.
 */
export function createSQLitePool(config: PoolConfig): SQLitePool {
  return new SQLitePool(config);
}

// ============================================================================
// Global Pool Registry
// ============================================================================

const poolRegistry = new Map<string, SQLitePool>();

/**
 * Get or create a pool for a database path.
 */
export function getPool(dbPath: string, config?: Omit<PoolConfig, "dbPath">): SQLitePool {
  let pool = poolRegistry.get(dbPath);
  if (!pool) {
    pool = createSQLitePool({ dbPath, ...config });
    poolRegistry.set(dbPath, pool);
  }
  return pool;
}

/**
 * Close and remove a pool from the registry.
 */
export function closePool(dbPath: string): void {
  const pool = poolRegistry.get(dbPath);
  if (pool) {
    pool.close();
    poolRegistry.delete(dbPath);
  }
}

/**
 * Close all pools in the registry.
 */
export function closeAllPools(): void {
  for (const pool of poolRegistry.values()) {
    pool.close();
  }
  poolRegistry.clear();
}
