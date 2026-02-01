/**
 * Facts Memory Connection Pool Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLitePool, createSQLitePool, getPool, closePool, closeAllPools } from "./pool.js";

describe("Facts Memory Connection Pool", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "facts-pool-test-"));
    dbPath = join(tempDir, "test.db");
  });

  afterEach(() => {
    closeAllPools();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("SQLitePool", () => {
    it("creates pool with default config", () => {
      const pool = createSQLitePool({ dbPath });

      const stats = pool.stats();
      expect(stats.total).toBe(0);
      expect(stats.maxConnections).toBe(3);

      pool.close();
    });

    it("creates pool with custom config", () => {
      const pool = createSQLitePool({
        dbPath,
        maxConnections: 5,
        busyTimeoutMs: 10000,
      });

      const stats = pool.stats();
      expect(stats.maxConnections).toBe(5);

      pool.close();
    });

    it("acquires and releases connections", () => {
      const pool = createSQLitePool({ dbPath });

      const conn = pool.acquire();
      expect(conn).toBeDefined();

      let stats = pool.stats();
      expect(stats.total).toBe(1);
      expect(stats.inUse).toBe(1);

      pool.release(conn);

      stats = pool.stats();
      expect(stats.inUse).toBe(0);
      expect(stats.available).toBe(1);

      pool.close();
    });

    it("reuses released connections", () => {
      const pool = createSQLitePool({ dbPath });

      const conn1 = pool.acquire();
      pool.release(conn1);

      const conn2 = pool.acquire();
      expect(conn2).toBe(conn1); // Same connection reused

      pool.release(conn2);
      pool.close();
    });

    it("creates new connections up to max", () => {
      const pool = createSQLitePool({ dbPath, maxConnections: 2 });

      const conn1 = pool.acquire();
      const conn2 = pool.acquire();

      expect(conn1).not.toBe(conn2);

      const stats = pool.stats();
      expect(stats.total).toBe(2);
      expect(stats.inUse).toBe(2);

      pool.release(conn1);
      pool.release(conn2);
      pool.close();
    });

    it("throws when pool exhausted", () => {
      const pool = createSQLitePool({ dbPath, maxConnections: 1 });

      const conn = pool.acquire();

      expect(() => pool.acquire()).toThrow(/exhausted/);

      pool.release(conn);
      pool.close();
    });

    it("throws when closed", () => {
      const pool = createSQLitePool({ dbPath });
      pool.close();

      expect(() => pool.acquire()).toThrow(/closed/);
    });

    describe("withConnection", () => {
      it("executes function with pooled connection", () => {
        const pool = createSQLitePool({ dbPath });

        const result = pool.withConnection((db) => {
          db.exec("CREATE TABLE IF NOT EXISTS test (id INTEGER)");
          return "success";
        });

        expect(result).toBe("success");

        // Connection should be released
        const stats = pool.stats();
        expect(stats.inUse).toBe(0);

        pool.close();
      });

      it("releases connection on error", () => {
        const pool = createSQLitePool({ dbPath });

        expect(() =>
          pool.withConnection(() => {
            throw new Error("test error");
          }),
        ).toThrow("test error");

        const stats = pool.stats();
        expect(stats.inUse).toBe(0);

        pool.close();
      });
    });

    describe("withConnectionAsync", () => {
      it("executes async function with pooled connection", async () => {
        const pool = createSQLitePool({ dbPath });

        const result = await pool.withConnectionAsync(async (db) => {
          db.exec("CREATE TABLE IF NOT EXISTS test (id INTEGER)");
          return "success";
        });

        expect(result).toBe("success");

        const stats = pool.stats();
        expect(stats.inUse).toBe(0);

        pool.close();
      });

      it("releases connection on async error", async () => {
        const pool = createSQLitePool({ dbPath });

        await expect(
          pool.withConnectionAsync(async () => {
            throw new Error("async error");
          }),
        ).rejects.toThrow("async error");

        const stats = pool.stats();
        expect(stats.inUse).toBe(0);

        pool.close();
      });
    });
  });

  describe("Pool Registry", () => {
    it("returns same pool for same path", () => {
      const pool1 = getPool(dbPath);
      const pool2 = getPool(dbPath);

      expect(pool1).toBe(pool2);
    });

    it("creates different pools for different paths", () => {
      const path1 = join(tempDir, "test1.db");
      const path2 = join(tempDir, "test2.db");

      const pool1 = getPool(path1);
      const pool2 = getPool(path2);

      expect(pool1).not.toBe(pool2);
    });

    it("closePool removes from registry", () => {
      const pool1 = getPool(dbPath);
      closePool(dbPath);

      const pool2 = getPool(dbPath);
      expect(pool2).not.toBe(pool1);
    });
  });

  describe("Concurrent Operations", () => {
    it("handles sequential operations within pool limit", async () => {
      const pool = createSQLitePool({ dbPath, maxConnections: 3 });

      // Create table
      pool.withConnection((db) => {
        db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT)");
      });

      // Sequential inserts using the pool
      for (let i = 0; i < 10; i++) {
        await pool.withConnectionAsync(async (db) => {
          db.prepare("INSERT INTO items (value) VALUES (?)").run(`value-${i}`);
          return i;
        });
      }

      // Verify all inserts succeeded
      const count = pool.withConnection((db) => {
        const row = db.prepare("SELECT COUNT(*) as count FROM items").get() as { count: number };
        return row.count;
      });

      expect(count).toBe(10);

      pool.close();
    });

    it("handles parallel operations within pool size", async () => {
      const pool = createSQLitePool({ dbPath, maxConnections: 5 });

      // Create and populate table
      pool.withConnection((db) => {
        db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT)");
        for (let i = 0; i < 100; i++) {
          db.prepare("INSERT INTO items (value) VALUES (?)").run(`item-${i}`);
        }
      });

      // Run 5 parallel reads (within pool size)
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          pool.withConnectionAsync(async (db) => {
            const rows = db.prepare("SELECT * FROM items WHERE value LIKE ?").all(`item-${i}%`);
            return rows.length;
          }),
        );
      }

      const results = await Promise.all(promises);
      expect(results.every((r) => r > 0)).toBe(true);

      pool.close();
    });

    it("maintains connection reuse across operations", async () => {
      const pool = createSQLitePool({ dbPath, maxConnections: 2 });

      pool.withConnection((db) => {
        db.exec("CREATE TABLE IF NOT EXISTS counter (n INTEGER)");
        db.exec("INSERT INTO counter VALUES (0)");
      });

      // Alternating operations should reuse connections
      for (let i = 0; i < 10; i++) {
        pool.withConnection((db) => {
          db.exec("UPDATE counter SET n = n + 1");
        });
      }

      const finalCount = pool.withConnection((db) => {
        const row = db.prepare("SELECT n FROM counter").get() as { n: number };
        return row.n;
      });

      expect(finalCount).toBe(10);

      // Pool should have created at most 2 connections
      const stats = pool.stats();
      expect(stats.total).toBeLessThanOrEqual(2);

      pool.close();
    });
  });
});
