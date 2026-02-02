/**
 * Facts Memory Health Monitoring
 *
 * Provides health check events and threshold-based alerts.
 * Publishes periodic health snapshots and alerts when thresholds are exceeded.
 */

import { statSync } from "node:fs";
import type { FactsMemoryConfig } from "../../config/types.openclaw.js";
import type { FactsMemoryStore } from "./store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCleanupStats } from "./cleanup.js";

// ============================================================================
// Types
// ============================================================================

const logger = createSubsystemLogger("facts-health");

/** Health snapshot for facts memory */
export interface HealthSnapshot {
  /** Timestamp of the health check (ISO string) */
  timestamp: string;
  /** Database size in MB */
  dbSizeMb: number;
  /** Total number of memories */
  totalMemories: number;
  /** Last extraction timestamp (ISO string or null if never) */
  lastExtractionAt: string | null;
  /** Extraction errors in the last 24 hours */
  extractionErrors: number;
  /** Last cleanup timestamp (ISO string or null if never) */
  lastCleanupAt: string | null;
  /** FTS availability */
  ftsAvailable: boolean;
  /** Daily summaries count */
  dailySummaries: number;
  /** Weekly summaries count */
  weeklySummaries: number;
}

/** Alert event */
export interface HealthAlert {
  /** Alert type */
  type: "db_size" | "error_rate" | "stale_extraction";
  /** Severity level */
  severity: "warning" | "critical";
  /** Alert message */
  message: string;
  /** Current value that triggered the alert */
  currentValue: number;
  /** Threshold that was exceeded */
  threshold: number;
  /** Timestamp of the alert (ISO string) */
  timestamp: string;
}

/** Alert thresholds configuration */
export interface AlertThresholds {
  /** Maximum database size in MB */
  maxDbSizeMb: number;
  /** Maximum extraction errors per day */
  maxErrorsPerDay: number;
  /** Maximum days without extraction (stale) */
  maxStaleDays: number;
}

/** Health state persisted between runs */
export interface HealthState {
  /** Last health check timestamp (ms since epoch) */
  lastHealthCheckAt: number | null;
  /** Last extraction timestamp (ms since epoch) */
  lastExtractionAt: number | null;
  /** Last cleanup timestamp (ms since epoch) */
  lastCleanupAt: number | null;
  /** Extraction errors in the current day */
  extractionErrorsToday: number;
  /** Day of the error count (YYYY-MM-DD) */
  errorCountDate: string | null;
  /** Recent alerts (for display) */
  recentAlerts: HealthAlert[];
}

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_MAX_DB_SIZE_MB = 500;
const DEFAULT_MAX_ERRORS_PER_DAY = 50;
const DEFAULT_MAX_STALE_DAYS = 7;
const MAX_RECENT_ALERTS = 50;

// ============================================================================
// In-Memory State
// ============================================================================

let healthState: HealthState = {
  lastHealthCheckAt: null,
  lastExtractionAt: null,
  lastCleanupAt: null,
  extractionErrorsToday: 0,
  errorCountDate: null,
  recentAlerts: [],
};

// ============================================================================
// Health Functions
// ============================================================================

/**
 * Get current health state.
 */
export function getHealthState(): HealthState {
  return { ...healthState };
}

/**
 * Reset health state (for testing).
 */
export function resetHealthState(): void {
  healthState = {
    lastHealthCheckAt: null,
    lastExtractionAt: null,
    lastCleanupAt: null,
    extractionErrorsToday: 0,
    errorCountDate: null,
    recentAlerts: [],
  };
}

/**
 * Record an extraction timestamp.
 */
export function recordExtraction(): void {
  healthState.lastExtractionAt = Date.now();
}

/**
 * Set extraction timestamp (for testing).
 */
export function setExtractionTimestamp(timestamp: number | null): void {
  healthState.lastExtractionAt = timestamp;
}

/**
 * Record an extraction error.
 */
export function recordExtractionError(): void {
  const today = new Date().toISOString().slice(0, 10);

  if (healthState.errorCountDate !== today) {
    healthState.errorCountDate = today;
    healthState.extractionErrorsToday = 0;
  }

  healthState.extractionErrorsToday++;
}

/**
 * Record a cleanup timestamp.
 */
export function recordCleanup(): void {
  healthState.lastCleanupAt = Date.now();
}

/**
 * Get alert thresholds from config with defaults.
 */
export function getAlertThresholds(config?: FactsMemoryConfig): AlertThresholds {
  const alerts = config?.alerts;
  return {
    maxDbSizeMb: alerts?.maxDbSizeMb ?? DEFAULT_MAX_DB_SIZE_MB,
    maxErrorsPerDay: alerts?.maxErrorsPerDay ?? DEFAULT_MAX_ERRORS_PER_DAY,
    maxStaleDays: alerts?.maxStaleDays ?? DEFAULT_MAX_STALE_DAYS,
  };
}

/**
 * Get a health snapshot of the facts memory system.
 */
export function getHealthSnapshot(store: FactsMemoryStore, markdownPath: string): HealthSnapshot {
  const now = new Date();
  const stats = getCleanupStats(store, markdownPath);

  return {
    timestamp: now.toISOString(),
    dbSizeMb: Math.round((stats.dbSizeBytes / (1024 * 1024)) * 100) / 100,
    totalMemories: stats.totalMemories,
    lastExtractionAt: healthState.lastExtractionAt
      ? new Date(healthState.lastExtractionAt).toISOString()
      : null,
    extractionErrors: healthState.extractionErrorsToday,
    lastCleanupAt: healthState.lastCleanupAt
      ? new Date(healthState.lastCleanupAt).toISOString()
      : null,
    ftsAvailable: store.isFtsAvailable(),
    dailySummaries: stats.dailySummaries,
    weeklySummaries: stats.weeklySummaries,
  };
}

/**
 * Check health and return any alerts.
 */
export function checkHealth(
  store: FactsMemoryStore,
  markdownPath: string,
  config?: FactsMemoryConfig,
): HealthAlert[] {
  const snapshot = getHealthSnapshot(store, markdownPath);
  const thresholds = getAlertThresholds(config);
  const alerts: HealthAlert[] = [];
  const now = new Date();

  // Check database size
  if (snapshot.dbSizeMb > thresholds.maxDbSizeMb) {
    const severity = snapshot.dbSizeMb > thresholds.maxDbSizeMb * 1.5 ? "critical" : "warning";
    alerts.push({
      type: "db_size",
      severity,
      message: `Database size (${snapshot.dbSizeMb.toFixed(1)} MB) exceeds threshold (${thresholds.maxDbSizeMb} MB)`,
      currentValue: snapshot.dbSizeMb,
      threshold: thresholds.maxDbSizeMb,
      timestamp: now.toISOString(),
    });
  }

  // Check extraction errors
  if (snapshot.extractionErrors > thresholds.maxErrorsPerDay) {
    const severity =
      snapshot.extractionErrors > thresholds.maxErrorsPerDay * 2 ? "critical" : "warning";
    alerts.push({
      type: "error_rate",
      severity,
      message: `Extraction errors today (${snapshot.extractionErrors}) exceed threshold (${thresholds.maxErrorsPerDay})`,
      currentValue: snapshot.extractionErrors,
      threshold: thresholds.maxErrorsPerDay,
      timestamp: now.toISOString(),
    });
  }

  // Check stale extraction
  if (healthState.lastExtractionAt) {
    const daysSinceExtraction = (Date.now() - healthState.lastExtractionAt) / (1000 * 60 * 60 * 24);
    if (daysSinceExtraction > thresholds.maxStaleDays) {
      const severity = daysSinceExtraction > thresholds.maxStaleDays * 2 ? "critical" : "warning";
      alerts.push({
        type: "stale_extraction",
        severity,
        message: `No extraction for ${Math.floor(daysSinceExtraction)} days (threshold: ${thresholds.maxStaleDays} days)`,
        currentValue: Math.floor(daysSinceExtraction),
        threshold: thresholds.maxStaleDays,
        timestamp: now.toISOString(),
      });
    }
  }

  return alerts;
}

/**
 * Run a full health check and log events.
 * Returns the snapshot and any new alerts.
 */
export function runHealthCheck(
  store: FactsMemoryStore,
  markdownPath: string,
  config?: FactsMemoryConfig,
): { snapshot: HealthSnapshot; alerts: HealthAlert[] } {
  const snapshot = getHealthSnapshot(store, markdownPath);
  const alerts = checkHealth(store, markdownPath, config);

  // Update state
  healthState.lastHealthCheckAt = Date.now();

  // Log health event
  logger.info(
    `Health check: dbSize=${snapshot.dbSizeMb}MB, memories=${snapshot.totalMemories}, errors=${snapshot.extractionErrors}`,
    {
      event: "memory.health",
      ...snapshot,
    },
  );

  // Log any alerts
  for (const alert of alerts) {
    if (alert.severity === "critical") {
      logger.error(`Alert: ${alert.message}`, {
        event: "memory.alert",
        ...alert,
      });
    } else {
      logger.warn(`Alert: ${alert.message}`, {
        event: "memory.alert",
        ...alert,
      });
    }

    // Add to recent alerts
    healthState.recentAlerts.unshift(alert);
    if (healthState.recentAlerts.length > MAX_RECENT_ALERTS) {
      healthState.recentAlerts = healthState.recentAlerts.slice(0, MAX_RECENT_ALERTS);
    }
  }

  return { snapshot, alerts };
}

/**
 * Get recent alerts.
 */
export function getRecentAlerts(limit: number = 20): HealthAlert[] {
  return healthState.recentAlerts.slice(0, limit);
}

/**
 * Clear all recent alerts.
 */
export function clearAlerts(): void {
  healthState.recentAlerts = [];
}

/**
 * Get health summary for CLI/status display.
 */
export function getHealthSummary(
  store: FactsMemoryStore,
  markdownPath: string,
  config?: FactsMemoryConfig,
): {
  snapshot: HealthSnapshot;
  thresholds: AlertThresholds;
  activeAlerts: HealthAlert[];
  status: "ok" | "warning" | "critical";
} {
  const snapshot = getHealthSnapshot(store, markdownPath);
  const thresholds = getAlertThresholds(config);
  const activeAlerts = checkHealth(store, markdownPath, config);

  let status: "ok" | "warning" | "critical" = "ok";
  if (activeAlerts.some((a) => a.severity === "critical")) {
    status = "critical";
  } else if (activeAlerts.length > 0) {
    status = "warning";
  }

  return { snapshot, thresholds, activeAlerts, status };
}
