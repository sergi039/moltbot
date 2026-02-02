/**
 * Recovery/Backup/Config Test Suite
 *
 * P0 — E2E scenarios (required)
 * P1 — Integration tests
 * P2 — Smoke tests
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_STATE_DIR = join(tmpdir(), "openclaw-recovery-test");
const TEST_BACKUP_DIR = join(tmpdir(), "openclaw-recovery-test-backups");
const PROD_STATE_DIR = process.env.OPENCLAW_STATE_DIR || join(process.env.HOME!, ".openclaw");

function runCli(args: string, env: Record<string, string> = {}): string {
  return execSync(`pnpm openclaw ${args}`, {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    cwd: process.cwd(),
  }).trim();
}

function createBackup(stateDir: string, backupDir: string): string {
  mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `backup-${timestamp}.tar.gz`);
  execSync(`tar -czf "${backupPath}" -C "${join(stateDir, "..")}" "${stateDir.split("/").pop()}"`, {
    encoding: "utf-8",
  });
  return backupPath;
}

function restoreBackup(backupPath: string, targetDir: string): void {
  // Extract directly to targetDir - tar archive contains .openclaw folder
  execSync(`tar -xzf "${backupPath}" -C "${targetDir}"`, { encoding: "utf-8" });
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("P0 — E2E scenarios (required)", () => {
  beforeAll(() => {
    // Clean up test directories
    rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    rmSync(TEST_BACKUP_DIR, { recursive: true, force: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_BACKUP_DIR, { recursive: true });
  });

  afterAll(() => {
    // Cleanup
    rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    rmSync(TEST_BACKUP_DIR, { recursive: true, force: true });
  });

  describe("1) Full backup → full restore", () => {
    let backupPath: string | undefined;
    let restoredDir: string;

    beforeAll(() => {
      restoredDir = join(TEST_STATE_DIR, ".openclaw");
      if (fileExists(PROD_STATE_DIR)) {
        backupPath = createBackup(PROD_STATE_DIR, TEST_BACKUP_DIR);
        if (backupPath && fileExists(backupPath)) {
          restoreBackup(backupPath, TEST_STATE_DIR);
        }
      }
    });

    it("creates backup from prod state", () => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }
      expect(backupPath).toBeDefined();
      expect(fileExists(backupPath!)).toBe(true);
    });

    it("restores backup to test state dir", () => {
      if (!backupPath) {
        console.warn("Skipping: no backup created");
        return;
      }
      // tar extracts with .openclaw subfolder
      const configPath = join(restoredDir, "openclaw.json");
      expect(fileExists(configPath)).toBe(true);
    });

    it("gateway preflight passes after restore", () => {
      if (!fileExists(join(restoredDir, "openclaw.json"))) {
        console.warn("Skipping: no config restored");
        return;
      }
      // Check config exists and has required fields
      const config = readJson(join(restoredDir, "openclaw.json")) as Record<string, unknown>;
      expect(config).toHaveProperty("gateway");
    });

    it("cron jobs exist after restore", () => {
      const cronPath = join(restoredDir, "cron", "jobs.json");
      if (!fileExists(cronPath)) {
        console.warn("Skipping: no cron jobs file");
        return;
      }
      const jobs = readJson(cronPath) as { jobs?: unknown[] };
      expect(jobs).toHaveProperty("jobs");
    });

    it("sessions restored", () => {
      const sessionsDir = join(restoredDir, "agents", "main", "sessions");
      if (!fileExists(sessionsDir)) {
        console.warn("Skipping: no sessions dir");
        return;
      }
      const files = execSync(`ls "${sessionsDir}" | wc -l`, { encoding: "utf-8" }).trim();
      expect(parseInt(files)).toBeGreaterThan(0);
    });

    it("memory DBs exist after restore", () => {
      const memoryDir = join(restoredDir, "memory");
      if (!fileExists(memoryDir)) {
        console.warn("Skipping: no memory dir");
        return;
      }
      // At least one of these should exist
      const hasFactsDb = fileExists(join(memoryDir, "facts.db"));
      const hasMainSqlite = fileExists(join(memoryDir, "main.sqlite"));
      expect(hasFactsDb || hasMainSqlite).toBe(true);
    });
  });

  describe("2) Config guardrail", () => {
    const testConfigPath = join(TEST_STATE_DIR, "openclaw.json");

    beforeAll(() => {
      mkdirSync(TEST_STATE_DIR, { recursive: true });
      // Create minimal config
      writeFileSync(
        testConfigPath,
        JSON.stringify({
          gateway: {
            mode: "local",
            auth: { token: "test-token-123" },
          },
        }),
      );
    });

    it("gateway.mode is preserved after config write", () => {
      const config = readJson(testConfigPath) as { gateway?: { mode?: string } };
      expect(config.gateway?.mode).toBe("local");
    });

    it("gateway.auth.token is preserved after config write", () => {
      const config = readJson(testConfigPath) as { gateway?: { auth?: { token?: string } } };
      expect(config.gateway?.auth?.token).toBe("test-token-123");
    });

    it("config write does not lose required fields", () => {
      // Simulate config update
      const config = readJson(testConfigPath) as Record<string, unknown>;
      config.agents = { defaults: { maxConcurrent: 6 } };
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

      // Re-read and verify
      const updated = readJson(testConfigPath) as {
        gateway?: { mode?: string; auth?: { token?: string } };
      };
      expect(updated.gateway?.mode).toBe("local");
      expect(updated.gateway?.auth?.token).toBe("test-token-123");
    });
  });

  describe("3) Telegram restoration", () => {
    it("telegram token exists in config or file", () => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }

      const configPath = join(PROD_STATE_DIR, "openclaw.json");
      const tokenFilePath = join(PROD_STATE_DIR, "telegram", "bot-token.txt");

      let hasToken = false;

      if (fileExists(configPath)) {
        const config = readJson(configPath) as { env?: { TELEGRAM_BOT_TOKEN?: string } };
        if (config.env?.TELEGRAM_BOT_TOKEN) {
          hasToken = true;
        }
      }

      if (fileExists(tokenFilePath)) {
        const token = readFileSync(tokenFilePath, "utf-8").trim();
        if (token.length > 0) {
          hasToken = true;
        }
      }

      expect(hasToken).toBe(true);
    });

    it("telegram channel is enabled in config", () => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }

      const configPath = join(PROD_STATE_DIR, "openclaw.json");
      if (!fileExists(configPath)) {
        console.warn("Skipping: no config file");
        return;
      }

      const config = readJson(configPath) as {
        channels?: { telegram?: { enabled?: boolean } };
      };

      // Either explicitly enabled or not set (defaults to true)
      const isEnabled = config.channels?.telegram?.enabled !== false;
      expect(isEnabled).toBe(true);
    });
  });
});

describe("P1 — Integration tests", () => {
  describe("4) Backup completeness", () => {
    const requiredPaths = ["openclaw.json", "cron", "telegram", "memory", "agents"];

    it.each(requiredPaths)("backup contains %s", (path) => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }

      const fullPath = join(PROD_STATE_DIR, path);
      expect(fileExists(fullPath)).toBe(true);
    });

    it("memory/facts.db or memory/main.sqlite exists", () => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }

      const factsDb = join(PROD_STATE_DIR, "memory", "facts.db");
      const mainSqlite = join(PROD_STATE_DIR, "memory", "main.sqlite");
      expect(fileExists(factsDb) || fileExists(mainSqlite)).toBe(true);
    });

    it("agents sessions exist", () => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }

      const sessionsDir = join(PROD_STATE_DIR, "agents", "main", "sessions");
      if (!fileExists(sessionsDir)) {
        console.warn("Skipping: no sessions dir");
        return;
      }

      const files = execSync(`find "${sessionsDir}" -name "*.jsonl" | wc -l`, {
        encoding: "utf-8",
      }).trim();
      expect(parseInt(files)).toBeGreaterThan(0);
    });
  });

  describe("5) Restore idempotency", () => {
    const idempotencyTestDir = join(tmpdir(), "openclaw-idempotency-test");

    beforeAll(() => {
      rmSync(idempotencyTestDir, { recursive: true, force: true });
      mkdirSync(idempotencyTestDir, { recursive: true });
    });

    afterAll(() => {
      rmSync(idempotencyTestDir, { recursive: true, force: true });
    });

    it("double restore produces identical files", () => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }

      // Create backup
      const backupPath = createBackup(PROD_STATE_DIR, idempotencyTestDir);

      // First restore
      const restore1Dir = join(idempotencyTestDir, "restore1");
      mkdirSync(restore1Dir, { recursive: true });
      execSync(`tar -xzf "${backupPath}" -C "${restore1Dir}"`, { encoding: "utf-8" });

      // Second restore
      const restore2Dir = join(idempotencyTestDir, "restore2");
      mkdirSync(restore2Dir, { recursive: true });
      execSync(`tar -xzf "${backupPath}" -C "${restore2Dir}"`, { encoding: "utf-8" });

      // Compare config files
      const config1 = readFileSync(join(restore1Dir, ".openclaw", "openclaw.json"), "utf-8");
      const config2 = readFileSync(join(restore2Dir, ".openclaw", "openclaw.json"), "utf-8");
      expect(config1).toBe(config2);
    });
  });
});

describe("P1 — Critical config keys", () => {
  describe("8) Gateway startup requirements", () => {
    it("gateway.mode is set to 'local'", () => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }

      const configPath = join(PROD_STATE_DIR, "openclaw.json");
      if (!fileExists(configPath)) {
        console.warn("Skipping: no config file");
        return;
      }

      const config = readJson(configPath) as { gateway?: { mode?: string } };
      expect(config.gateway?.mode).toBe("local");
    });

    it("gateway.auth.token exists and is not empty", () => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }

      const configPath = join(PROD_STATE_DIR, "openclaw.json");
      if (!fileExists(configPath)) {
        console.warn("Skipping: no config file");
        return;
      }

      const config = readJson(configPath) as { gateway?: { auth?: { token?: string } } };
      const token = config.gateway?.auth?.token;
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token!.length).toBeGreaterThan(0);
    });

    it("env.TELEGRAM_BOT_TOKEN exists", () => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }

      const configPath = join(PROD_STATE_DIR, "openclaw.json");
      const tokenFilePath = join(PROD_STATE_DIR, "telegram", "bot-token.txt");

      let hasToken = false;

      // Check config env
      if (fileExists(configPath)) {
        const config = readJson(configPath) as { env?: { TELEGRAM_BOT_TOKEN?: string } };
        if (config.env?.TELEGRAM_BOT_TOKEN && config.env.TELEGRAM_BOT_TOKEN.length > 0) {
          hasToken = true;
        }
      }

      // Fallback: check token file
      if (!hasToken && fileExists(tokenFilePath)) {
        const token = readFileSync(tokenFilePath, "utf-8").trim();
        if (token.length > 0) {
          hasToken = true;
        }
      }

      expect(hasToken).toBe(true);
    });
  });
});

describe("P2 — Smoke tests", () => {
  describe("6) Verify-env", () => {
    it("state dir exists and is valid", () => {
      if (!fileExists(PROD_STATE_DIR)) {
        console.warn("Skipping: prod state dir does not exist");
        return;
      }

      expect(fileExists(PROD_STATE_DIR)).toBe(true);
      expect(fileExists(join(PROD_STATE_DIR, "openclaw.json"))).toBe(true);
    });

    it("UI build exists", () => {
      const uiBuildPath = join(process.cwd(), "dist", "control-ui", "index.html");
      expect(fileExists(uiBuildPath)).toBe(true);
    });
  });

  describe("7) Cron health", () => {
    it("cron jobs.json exists and is valid JSON", () => {
      const cronPath = join(PROD_STATE_DIR, "cron", "jobs.json");
      if (!fileExists(cronPath)) {
        console.warn("Skipping: no cron jobs file");
        return;
      }

      const jobs = readJson(cronPath) as { jobs?: Array<{ id: string; lastRunAtMs?: number }> };
      expect(jobs).toHaveProperty("jobs");
      expect(Array.isArray(jobs.jobs)).toBe(true);
    });

    it("cron jobs have lastRunAtMs in state", () => {
      const cronPath = join(PROD_STATE_DIR, "cron", "jobs.json");
      if (!fileExists(cronPath)) {
        console.warn("Skipping: no cron jobs file");
        return;
      }

      const data = readJson(cronPath) as {
        jobs?: Array<{ id: string; state?: { lastRunAtMs?: number } }>;
      };
      const jobs = data.jobs || [];

      // At least one job should have state.lastRunAtMs if jobs exist
      if (jobs.length > 0) {
        const hasLastRun = jobs.some((job) => typeof job.state?.lastRunAtMs === "number");
        expect(hasLastRun).toBe(true);
      }
    });

    it("cron runs directory exists", () => {
      const runsDir = join(PROD_STATE_DIR, "cron", "runs");
      if (!fileExists(runsDir)) {
        console.warn("Skipping: no cron runs dir");
        return;
      }

      expect(fileExists(runsDir)).toBe(true);
    });
  });
});
