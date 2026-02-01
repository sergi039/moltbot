/**
 * Tests for health monitoring module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFactsMemoryManager, type FactsMemoryManager } from "./manager.js";
import {
  getHealthSnapshot,
  getHealthState,
  resetHealthState,
  checkHealth,
  runHealthCheck,
  getRecentAlerts,
  clearAlerts,
  getHealthSummary,
  getAlertThresholds,
  recordExtraction,
  recordExtractionError,
  recordCleanup,
  setExtractionTimestamp,
  type HealthSnapshot,
  type HealthAlert,
} from "./health.js";
import type { FactsMemoryConfig } from "../../config/types.openclaw.js";

describe("Health Monitoring", () => {
  let tempDir: string;
  let manager: FactsMemoryManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "health-test-"));
    resetHealthState();
    clearAlerts();
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function createManager(config: FactsMemoryConfig = {}): FactsMemoryManager {
    const dbPath = join(tempDir, "test.db");
    const markdownPath = tempDir;
    return createFactsMemoryManager({
      dbPath,
      markdownPath,
      enabled: true,
      extraction: { enabled: true },
      ...config,
    });
  }

  describe("getHealthSnapshot", () => {
    it("returns basic health snapshot", () => {
      manager = createManager();
      const store = manager.getStore();
      const markdownPath = manager.getMarkdownPath();

      const snapshot = getHealthSnapshot(store, markdownPath);

      expect(snapshot).toBeDefined();
      expect(snapshot.timestamp).toBeDefined();
      expect(typeof snapshot.dbSizeMb).toBe("number");
      expect(typeof snapshot.totalMemories).toBe("number");
      expect(typeof snapshot.extractionErrors).toBe("number");
      expect(typeof snapshot.ftsAvailable).toBe("boolean");
    });

    it("includes memory count", async () => {
      manager = createManager();
      const store = manager.getStore();

      // Add some memories
      await manager.add({
        content: "Test fact 1",
        type: "fact",
        source: "conversation",
        importance: 0.8,
      });
      await manager.add({
        content: "Test fact 2",
        type: "fact",
        source: "conversation",
        importance: 0.8,
      });

      const snapshot = getHealthSnapshot(store, manager.getMarkdownPath());
      expect(snapshot.totalMemories).toBe(2);
    });

    it("tracks extraction timestamp", () => {
      manager = createManager();
      const store = manager.getStore();

      // Initially no extraction
      let snapshot = getHealthSnapshot(store, manager.getMarkdownPath());
      expect(snapshot.lastExtractionAt).toBeNull();

      // Record extraction
      recordExtraction();

      snapshot = getHealthSnapshot(store, manager.getMarkdownPath());
      expect(snapshot.lastExtractionAt).toBeDefined();
      expect(snapshot.lastExtractionAt).not.toBeNull();
    });

    it("tracks extraction errors", () => {
      manager = createManager();
      const store = manager.getStore();

      // Record some errors
      recordExtractionError();
      recordExtractionError();

      const snapshot = getHealthSnapshot(store, manager.getMarkdownPath());
      expect(snapshot.extractionErrors).toBe(2);
    });
  });

  describe("getAlertThresholds", () => {
    it("returns defaults when no config", () => {
      const thresholds = getAlertThresholds();

      expect(thresholds.maxDbSizeMb).toBe(500);
      expect(thresholds.maxErrorsPerDay).toBe(50);
      expect(thresholds.maxStaleDays).toBe(7);
    });

    it("uses config values when provided", () => {
      const config: FactsMemoryConfig = {
        alerts: {
          maxDbSizeMb: 100,
          maxErrorsPerDay: 10,
          maxStaleDays: 3,
        },
      };

      const thresholds = getAlertThresholds(config);

      expect(thresholds.maxDbSizeMb).toBe(100);
      expect(thresholds.maxErrorsPerDay).toBe(10);
      expect(thresholds.maxStaleDays).toBe(3);
    });
  });

  describe("checkHealth", () => {
    it("returns no alerts when healthy", () => {
      manager = createManager();
      const store = manager.getStore();

      const alerts = checkHealth(store, manager.getMarkdownPath());
      expect(alerts).toEqual([]);
    });

    it("detects error rate exceeded", () => {
      manager = createManager({
        alerts: { maxErrorsPerDay: 2 },
      });
      const store = manager.getStore();

      // Trigger 3 errors
      recordExtractionError();
      recordExtractionError();
      recordExtractionError();

      const alerts = checkHealth(store, manager.getMarkdownPath(), {
        alerts: { maxErrorsPerDay: 2 },
      });

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe("error_rate");
      expect(alerts[0].currentValue).toBe(3);
      expect(alerts[0].threshold).toBe(2);
    });

    it("detects stale extraction", () => {
      manager = createManager({
        alerts: { maxStaleDays: 1 },
      });
      const store = manager.getStore();

      // Set extraction timestamp to 3 days ago
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      setExtractionTimestamp(threeDaysAgo);

      const alerts = checkHealth(store, manager.getMarkdownPath(), {
        alerts: { maxStaleDays: 1 },
      });

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe("stale_extraction");
      expect(alerts[0].currentValue).toBe(3);
      expect(alerts[0].threshold).toBe(1);
    });
  });

  describe("runHealthCheck", () => {
    it("logs health event and returns snapshot", () => {
      manager = createManager();
      const store = manager.getStore();

      const result = runHealthCheck(store, manager.getMarkdownPath());

      expect(result.snapshot).toBeDefined();
      expect(result.alerts).toBeDefined();
      expect(Array.isArray(result.alerts)).toBe(true);
    });

    it("adds alerts to recent alerts list", () => {
      manager = createManager({
        alerts: { maxErrorsPerDay: 1 },
      });
      const store = manager.getStore();

      // Trigger errors
      recordExtractionError();
      recordExtractionError();

      runHealthCheck(store, manager.getMarkdownPath(), {
        alerts: { maxErrorsPerDay: 1 },
      });

      const recentAlerts = getRecentAlerts();
      expect(recentAlerts.length).toBeGreaterThan(0);
    });
  });

  describe("getRecentAlerts", () => {
    it("returns empty array when no alerts", () => {
      const alerts = getRecentAlerts();
      expect(alerts).toEqual([]);
    });

    it("respects limit parameter", () => {
      manager = createManager();
      const store = manager.getStore();

      // Generate multiple alerts
      for (let i = 0; i < 5; i++) {
        recordExtractionError();
        runHealthCheck(store, manager.getMarkdownPath(), {
          alerts: { maxErrorsPerDay: 0 },
        });
      }

      const alerts = getRecentAlerts(2);
      expect(alerts.length).toBe(2);
    });
  });

  describe("clearAlerts", () => {
    it("clears all recent alerts", () => {
      manager = createManager();
      const store = manager.getStore();

      recordExtractionError();
      runHealthCheck(store, manager.getMarkdownPath(), {
        alerts: { maxErrorsPerDay: 0 },
      });

      expect(getRecentAlerts().length).toBeGreaterThan(0);

      clearAlerts();

      expect(getRecentAlerts()).toEqual([]);
    });
  });

  describe("getHealthSummary", () => {
    it("returns complete health summary", () => {
      manager = createManager();
      const store = manager.getStore();

      const summary = getHealthSummary(store, manager.getMarkdownPath());

      expect(summary.snapshot).toBeDefined();
      expect(summary.thresholds).toBeDefined();
      expect(summary.activeAlerts).toBeDefined();
      expect(summary.status).toBe("ok");
    });

    it("shows warning status when alerts present", () => {
      manager = createManager();
      const store = manager.getStore();

      // Trigger error alert
      recordExtractionError();
      recordExtractionError();

      const summary = getHealthSummary(store, manager.getMarkdownPath(), {
        alerts: { maxErrorsPerDay: 1 },
      });

      expect(summary.status).toBe("warning");
      expect(summary.activeAlerts.length).toBeGreaterThan(0);
    });
  });

  describe("recordCleanup", () => {
    it("updates last cleanup timestamp", () => {
      let state = getHealthState();
      expect(state.lastCleanupAt).toBeNull();

      recordCleanup();

      state = getHealthState();
      expect(state.lastCleanupAt).not.toBeNull();
      expect(typeof state.lastCleanupAt).toBe("number");
    });
  });

  describe("resetHealthState", () => {
    it("resets all state", () => {
      recordExtraction();
      recordExtractionError();
      recordCleanup();

      resetHealthState();

      const state = getHealthState();
      expect(state.lastExtractionAt).toBeNull();
      expect(state.lastCleanupAt).toBeNull();
      expect(state.extractionErrorsToday).toBe(0);
      expect(state.recentAlerts).toEqual([]);
    });
  });
});
