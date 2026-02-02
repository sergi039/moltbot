/**
 * Facts Memory Scheduler
 *
 * Internal scheduler for memory consolidation and health check jobs.
 * Runs independently of the cron system since consolidation
 * doesn't require an agent turn.
 */

import { Cron } from "croner";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runHealthCheck } from "./health.js";
import { runMemoryConsolidation, getFactsMemoryManagerInstance } from "./integration.js";

// ============================================================================
// Types
// ============================================================================

const logger = createSubsystemLogger("facts-scheduler");

export interface MemorySchedulerConfig {
  /** Enable daily consolidation job */
  dailyEnabled?: boolean;
  /** Daily cron expression (default: "55 23 * * *" - 23:55 every day) */
  dailyCron?: string;
  /** Enable weekly consolidation job */
  weeklyEnabled?: boolean;
  /** Weekly cron expression (default: "0 3 * * 0" - 03:00 every Sunday) */
  weeklyCron?: string;
  /** Timezone for cron expressions */
  timezone?: string;
  /** Enable health check job */
  healthCheckEnabled?: boolean;
  /** Health check cron expression (default: "0 6 * * *" - 06:00 every day) */
  healthCheckCron?: string;
}

export interface MemorySchedulerState {
  dailyJob: Cron | null;
  weeklyJob: Cron | null;
  healthJob: Cron | null;
  config: MemorySchedulerConfig;
  appConfig: OpenClawConfig | undefined;
}

// ============================================================================
// Singleton State
// ============================================================================

let schedulerState: MemorySchedulerState | null = null;

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_DAILY_CRON = "55 23 * * *"; // 23:55 every day
const DEFAULT_WEEKLY_CRON = "0 3 * * 0"; // 03:00 every Sunday
const DEFAULT_HEALTH_CHECK_CRON = "0 6 * * *"; // 06:00 every day

// ============================================================================
// Scheduler Functions
// ============================================================================

/**
 * Start the memory scheduler with the given configuration.
 */
export function startMemoryScheduler(
  appConfig?: OpenClawConfig,
  schedulerConfig?: MemorySchedulerConfig,
): MemorySchedulerState {
  // Stop existing scheduler if running
  if (schedulerState) {
    stopMemoryScheduler();
  }

  const factsConfig = appConfig?.factsMemory;

  // Check if facts memory is enabled
  if (factsConfig?.enabled === false) {
    logger.debug("Facts memory disabled, scheduler not started");
    schedulerState = {
      dailyJob: null,
      weeklyJob: null,
      healthJob: null,
      config: schedulerConfig ?? {},
      appConfig,
    };
    return schedulerState;
  }

  const config: MemorySchedulerConfig = {
    dailyEnabled: schedulerConfig?.dailyEnabled ?? true,
    dailyCron: schedulerConfig?.dailyCron ?? DEFAULT_DAILY_CRON,
    weeklyEnabled: schedulerConfig?.weeklyEnabled ?? true,
    weeklyCron: schedulerConfig?.weeklyCron ?? DEFAULT_WEEKLY_CRON,
    timezone: schedulerConfig?.timezone ?? "UTC",
    healthCheckEnabled:
      schedulerConfig?.healthCheckEnabled ?? factsConfig?.alerts?.healthCheckEnabled ?? true,
    healthCheckCron:
      schedulerConfig?.healthCheckCron ??
      factsConfig?.alerts?.healthCheckCron ??
      DEFAULT_HEALTH_CHECK_CRON,
  };

  let dailyJob: Cron | null = null;
  let weeklyJob: Cron | null = null;
  let healthJob: Cron | null = null;

  // Schedule daily consolidation
  if (config.dailyEnabled) {
    try {
      dailyJob = new Cron(
        config.dailyCron!,
        {
          timezone: config.timezone,
          catch: (err) => {
            logger.error(`Daily consolidation error: ${err}`);
          },
        },
        async () => {
          logger.info("Running scheduled daily memory consolidation");
          try {
            const result = await runMemoryConsolidation(appConfig);
            if (result) {
              logger.info(
                `Daily consolidation complete: summary=${result.dailySummary ? "yes" : "no"}, pruned=${result.pruned.deleted + result.pruned.expired}`,
              );
            }
          } catch (err) {
            logger.error(`Daily consolidation failed: ${err}`);
          }
        },
      );
      const nextRun = dailyJob.nextRun();
      logger.info(
        `Daily consolidation scheduled: ${config.dailyCron} (next: ${nextRun?.toISOString() ?? "none"})`,
      );
    } catch (err) {
      logger.error(`Failed to schedule daily job: ${err}`);
    }
  }

  // Schedule weekly consolidation
  if (config.weeklyEnabled) {
    try {
      weeklyJob = new Cron(
        config.weeklyCron!,
        {
          timezone: config.timezone,
          catch: (err) => {
            logger.error(`Weekly consolidation error: ${err}`);
          },
        },
        async () => {
          logger.info("Running scheduled weekly memory consolidation");
          try {
            const result = await runMemoryConsolidation(appConfig);
            if (result?.weeklySummary) {
              logger.info(`Weekly consolidation complete: ${result.weeklySummary.weekId}`);
            }
          } catch (err) {
            logger.error(`Weekly consolidation failed: ${err}`);
          }
        },
      );
      const nextRun = weeklyJob.nextRun();
      logger.info(
        `Weekly consolidation scheduled: ${config.weeklyCron} (next: ${nextRun?.toISOString() ?? "none"})`,
      );
    } catch (err) {
      logger.error(`Failed to schedule weekly job: ${err}`);
    }
  }

  // Schedule health check
  if (config.healthCheckEnabled) {
    try {
      healthJob = new Cron(
        config.healthCheckCron!,
        {
          timezone: config.timezone,
          catch: (err) => {
            logger.error(`Health check error: ${err}`);
          },
        },
        async () => {
          logger.info("Running scheduled health check");
          try {
            const manager = getFactsMemoryManagerInstance(appConfig);
            if (manager) {
              const result = runHealthCheck(
                manager.getStore(),
                manager.getMarkdownPath(),
                factsConfig,
              );
              logger.info(
                `Health check complete: dbSize=${result.snapshot.dbSizeMb}MB, alerts=${result.alerts.length}`,
              );
            }
          } catch (err) {
            logger.error(`Health check failed: ${err}`);
          }
        },
      );
      const nextRun = healthJob.nextRun();
      logger.info(
        `Health check scheduled: ${config.healthCheckCron} (next: ${nextRun?.toISOString() ?? "none"})`,
      );
    } catch (err) {
      logger.error(`Failed to schedule health check job: ${err}`);
    }
  }

  schedulerState = {
    dailyJob,
    weeklyJob,
    healthJob,
    config,
    appConfig,
  };

  return schedulerState;
}

/**
 * Stop the memory scheduler.
 */
export function stopMemoryScheduler(): void {
  if (!schedulerState) return;

  if (schedulerState.dailyJob) {
    schedulerState.dailyJob.stop();
    logger.debug("Stopped daily consolidation job");
  }

  if (schedulerState.weeklyJob) {
    schedulerState.weeklyJob.stop();
    logger.debug("Stopped weekly consolidation job");
  }

  if (schedulerState.healthJob) {
    schedulerState.healthJob.stop();
    logger.debug("Stopped health check job");
  }

  schedulerState = null;
  logger.info("Memory scheduler stopped");
}

/**
 * Get the current scheduler state.
 */
export function getMemorySchedulerState(): MemorySchedulerState | null {
  return schedulerState;
}

/**
 * Check if the scheduler is running.
 */
export function isMemorySchedulerRunning(): boolean {
  return (
    schedulerState !== null &&
    (schedulerState.dailyJob !== null ||
      schedulerState.weeklyJob !== null ||
      schedulerState.healthJob !== null)
  );
}

/**
 * Get status information about the scheduler.
 */
export function getMemorySchedulerStatus(): {
  running: boolean;
  dailyNextRun: Date | null;
  weeklyNextRun: Date | null;
  healthCheckNextRun: Date | null;
} {
  return {
    running: isMemorySchedulerRunning(),
    dailyNextRun: schedulerState?.dailyJob?.nextRun() ?? null,
    weeklyNextRun: schedulerState?.weeklyJob?.nextRun() ?? null,
    healthCheckNextRun: schedulerState?.healthJob?.nextRun() ?? null,
  };
}

/**
 * Trigger consolidation manually (for testing or CLI).
 */
export async function triggerConsolidationNow(
  appConfig?: OpenClawConfig,
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await runMemoryConsolidation(appConfig ?? schedulerState?.appConfig);
    if (!result) {
      return { success: false, error: "Facts memory not enabled" };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Trigger health check manually (for testing or CLI).
 */
export function triggerHealthCheckNow(appConfig?: OpenClawConfig): {
  success: boolean;
  error?: string;
  snapshot?: import("./health.js").HealthSnapshot;
  alerts?: import("./health.js").HealthAlert[];
} {
  try {
    const cfg = appConfig ?? schedulerState?.appConfig;
    const manager = getFactsMemoryManagerInstance(cfg);
    if (!manager) {
      return { success: false, error: "Facts memory not enabled" };
    }
    const result = runHealthCheck(manager.getStore(), manager.getMarkdownPath(), cfg?.factsMemory);
    return { success: true, snapshot: result.snapshot, alerts: result.alerts };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
