import { describe, expect, it } from "vitest";
import { type UsageState, loadUsage } from "./usage.ts";

function createMockState(overrides?: Partial<UsageState>): UsageState {
  return {
    client: null,
    connected: false,
    usageLoading: false,
    usageResult: null,
    usageCostSummary: null,
    usageCostHidden: false,
    usageError: null,
    usageStartDate: "2026-01-01",
    usageEndDate: "2026-01-31",
    usageSelectedSessions: [],
    usageSelectedDays: [],
    usageTimeSeries: null,
    usageTimeSeriesLoading: false,
    usageSessionLogs: null,
    usageSessionLogsLoading: false,
    ...overrides,
  };
}

function createMockClient(responses: Record<string, unknown>) {
  return {
    request: async (method: string) => responses[method] ?? null,
  } as unknown as UsageState["client"];
}

describe("loadUsage", () => {
  it("sets usageCostHidden=true when costVisible is false", async () => {
    const client = createMockClient({
      "sessions.usage": { sessions: [], totals: null, aggregates: null },
      "usage.cost": { costVisible: false, reason: "subscription-auth" },
    });
    const state = createMockState({ client, connected: true });

    await loadUsage(state);

    expect(state.usageCostHidden).toBe(true);
    expect(state.usageCostSummary).toBeNull();
    expect(state.usageLoading).toBe(false);
  });

  it("sets usageCostSummary when costVisible is true", async () => {
    const summary = {
      costVisible: true,
      updatedAt: Date.now(),
      days: 30,
      daily: [],
      totals: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
        missingCostEntries: 0,
      },
    };
    const client = createMockClient({
      "sessions.usage": { sessions: [], totals: null, aggregates: null },
      "usage.cost": summary,
    });
    const state = createMockState({ client, connected: true });

    await loadUsage(state);

    expect(state.usageCostHidden).toBe(false);
    expect(state.usageCostSummary).not.toBeNull();
    expect(state.usageCostSummary?.days).toBe(30);
    expect(state.usageLoading).toBe(false);
  });

  it("sets usageCostSummary when response has no costVisible field (legacy)", async () => {
    const summary = {
      updatedAt: Date.now(),
      days: 30,
      daily: [],
      totals: {
        input: 100,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 300,
        totalCost: 0.05,
        missingCostEntries: 0,
      },
    };
    const client = createMockClient({
      "sessions.usage": { sessions: [], totals: null, aggregates: null },
      "usage.cost": summary,
    });
    const state = createMockState({ client, connected: true });

    await loadUsage(state);

    expect(state.usageCostHidden).toBe(false);
    expect(state.usageCostSummary).not.toBeNull();
    expect(state.usageCostSummary?.totals.totalCost).toBe(0.05);
  });

  it("does nothing when not connected", async () => {
    const state = createMockState({ connected: false });
    await loadUsage(state);
    expect(state.usageLoading).toBe(false);
    expect(state.usageCostHidden).toBe(false);
  });
});
