/**
 * Facts Memory Scheduler Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  startMemoryScheduler,
  stopMemoryScheduler,
  getMemorySchedulerState,
  isMemorySchedulerRunning,
  getMemorySchedulerStatus,
  triggerConsolidationNow,
} from "./scheduler.js";

describe("Facts Memory Scheduler", () => {
  afterEach(() => {
    stopMemoryScheduler();
  });

  describe("startMemoryScheduler", () => {
    it("starts scheduler with default config", () => {
      const state = startMemoryScheduler({});

      expect(state).toBeDefined();
      expect(state.config.dailyEnabled).toBe(true);
      expect(state.config.weeklyEnabled).toBe(true);
      expect(state.config.dailyCron).toBe("55 23 * * *");
      expect(state.config.weeklyCron).toBe("0 3 * * 0");
    });

    it("does not start jobs when facts memory disabled", () => {
      const state = startMemoryScheduler({
        factsMemory: { enabled: false },
      });

      expect(state.dailyJob).toBeNull();
      expect(state.weeklyJob).toBeNull();
    });

    it("respects custom cron expressions", () => {
      const state = startMemoryScheduler(
        {},
        {
          dailyCron: "0 0 * * *",
          weeklyCron: "0 0 * * 1",
        },
      );

      expect(state.config.dailyCron).toBe("0 0 * * *");
      expect(state.config.weeklyCron).toBe("0 0 * * 1");
    });

    it("can disable individual jobs", () => {
      const state = startMemoryScheduler(
        {},
        {
          dailyEnabled: false,
          weeklyEnabled: true,
        },
      );

      expect(state.dailyJob).toBeNull();
      expect(state.weeklyJob).not.toBeNull();
    });
  });

  describe("stopMemoryScheduler", () => {
    it("stops running scheduler", () => {
      startMemoryScheduler({});
      expect(isMemorySchedulerRunning()).toBe(true);

      stopMemoryScheduler();
      expect(isMemorySchedulerRunning()).toBe(false);
    });

    it("is idempotent", () => {
      startMemoryScheduler({});
      stopMemoryScheduler();
      stopMemoryScheduler(); // Should not throw
      expect(getMemorySchedulerState()).toBeNull();
    });
  });

  describe("getMemorySchedulerStatus", () => {
    it("returns status with next run times", () => {
      startMemoryScheduler({});

      const status = getMemorySchedulerStatus();

      expect(status.running).toBe(true);
      expect(status.dailyNextRun).toBeInstanceOf(Date);
      expect(status.weeklyNextRun).toBeInstanceOf(Date);
    });

    it("returns null dates when not running", () => {
      const status = getMemorySchedulerStatus();

      expect(status.running).toBe(false);
      expect(status.dailyNextRun).toBeNull();
      expect(status.weeklyNextRun).toBeNull();
    });
  });

  describe("triggerConsolidationNow", () => {
    it("returns error when facts memory not enabled", async () => {
      const result = await triggerConsolidationNow({
        factsMemory: { enabled: false },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not enabled");
    });
  });
});
