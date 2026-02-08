import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  renderUsage,
  type UsageProps,
  type UsageTotals,
  type UsageAggregates,
  type UsageSessionEntry,
  type CostDailyEntry,
} from "./usage.ts";

const noop = () => undefined;

function makeTotals(cost = 1.23): UsageTotals {
  return {
    input: 5000,
    output: 3000,
    cacheRead: 1000,
    cacheWrite: 500,
    totalTokens: 9500,
    totalCost: cost,
    inputCost: 0.5,
    outputCost: 0.6,
    cacheReadCost: 0.03,
    cacheWriteCost: 0.1,
    missingCostEntries: 0,
  };
}

function makeAggregates(): UsageAggregates {
  return {
    messages: { total: 10, user: 5, assistant: 5, toolCalls: 2, toolResults: 2, errors: 0 },
    tools: { totalCalls: 2, uniqueTools: 1, tools: [{ name: "bash", count: 2 }] },
    byModel: [
      {
        provider: "anthropic",
        model: "opus-4.6",
        count: 10,
        totals: makeTotals(),
      },
    ],
    byProvider: [{ provider: "anthropic", count: 10, totals: makeTotals() }],
    byAgent: [{ agentId: "main", totals: makeTotals() }],
    byChannel: [{ channel: "telegram", totals: makeTotals() }],
    daily: [
      { date: "2026-01-15", tokens: 9500, cost: 1.23, messages: 10, toolCalls: 2, errors: 0 },
    ],
  };
}

function makeSession(): UsageSessionEntry {
  return {
    key: "agent:main:test",
    label: "test session",
    usage: {
      input: 5000,
      output: 3000,
      cacheRead: 1000,
      cacheWrite: 500,
      totalTokens: 9500,
      totalCost: 1.23,
      missingCostEntries: 0,
      messageCounts: { total: 10, user: 5, assistant: 5, toolCalls: 2, errors: 0, toolResults: 2 },
      toolUsage: { totalCalls: 2, uniqueTools: 1, tools: [{ name: "bash", count: 2 }] },
      durationMs: 60000,
      firstActivity: Date.now() - 60000,
      lastActivity: Date.now(),
      activityDates: ["2026-01-15"],
      modelUsage: [{ model: "opus-4.6", count: 10, totals: makeTotals() }],
    },
  };
}

function makeDaily(): CostDailyEntry[] {
  return [{ date: "2026-01-15", ...makeTotals() }];
}

function buildProps(overrides?: Partial<UsageProps>): UsageProps {
  return {
    loading: false,
    error: null,
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    sessions: [makeSession()],
    sessionsLimitReached: false,
    totals: makeTotals(),
    aggregates: makeAggregates(),
    costDaily: makeDaily(),
    costHidden: false,
    selectedSessions: [],
    selectedDays: [],
    selectedHours: [],
    chartMode: "cost",
    dailyChartMode: "total",
    timeSeriesMode: "cumulative",
    timeSeriesBreakdownMode: "total",
    timeSeries: null,
    timeSeriesLoading: false,
    sessionLogs: null,
    sessionLogsLoading: false,
    sessionLogsExpanded: false,
    logFilterRoles: [],
    logFilterTools: [],
    logFilterHasTools: false,
    logFilterQuery: "",
    query: "",
    queryDraft: "",
    sessionSort: "tokens",
    sessionSortDir: "desc",
    recentSessions: [],
    sessionsTab: "all",
    visibleColumns: [],
    timeZone: "local",
    contextExpanded: false,
    headerPinned: false,
    onStartDateChange: noop,
    onEndDateChange: noop,
    onRefresh: noop,
    onTimeZoneChange: noop,
    onToggleContextExpanded: noop,
    onToggleHeaderPinned: noop,
    onToggleSessionLogsExpanded: noop,
    onLogFilterRolesChange: noop,
    onLogFilterToolsChange: noop,
    onLogFilterHasToolsChange: noop,
    onLogFilterQueryChange: noop,
    onLogFilterClear: noop,
    onSelectSession: noop,
    onChartModeChange: noop,
    onDailyChartModeChange: noop,
    onTimeSeriesModeChange: noop,
    onTimeSeriesBreakdownChange: noop,
    onSelectDay: noop,
    onSelectHour: noop,
    onClearDays: noop,
    onClearHours: noop,
    onClearSessions: noop,
    onClearFilters: noop,
    onQueryDraftChange: noop,
    onApplyQuery: noop,
    onClearQuery: noop,
    onSessionSortChange: noop,
    onSessionSortDirChange: noop,
    onSessionsTabChange: noop,
    onToggleColumn: noop,
    ...overrides,
  };
}

describe("usage view costHidden", () => {
  it("hides cost badge in header when costHidden=true", async () => {
    const container = document.createElement("div");
    render(renderUsage(buildProps({ costHidden: true })), container);
    await Promise.resolve();

    const badges = container.querySelectorAll(".usage-metric-badge");
    const texts = Array.from(badges).map((el) => el.textContent?.trim() ?? "");
    // Should have tokens badge and sessions badge, but no cost badge
    expect(texts.some((t) => t.includes("tokens"))).toBe(true);
    expect(texts.some((t) => t.includes("cost"))).toBe(false);
  });

  it("shows cost badge in header when costHidden=false", async () => {
    const container = document.createElement("div");
    render(renderUsage(buildProps({ costHidden: false })), container);
    await Promise.resolve();

    const badges = container.querySelectorAll(".usage-metric-badge");
    const texts = Array.from(badges).map((el) => el.textContent?.trim() ?? "");
    expect(texts.some((t) => t.includes("cost"))).toBe(true);
  });

  it("hides Tokens/Cost toggle when costHidden=true", async () => {
    const container = document.createElement("div");
    render(renderUsage(buildProps({ costHidden: true })), container);
    await Promise.resolve();

    // The main Tokens/Cost toggle uses .chart-toggle without .small class
    const allToggles = container.querySelectorAll(".chart-toggle:not(.small)");
    expect(allToggles.length).toBe(0);
  });

  it("shows Tokens/Cost toggle when costHidden=false", async () => {
    const container = document.createElement("div");
    render(renderUsage(buildProps({ costHidden: false })), container);
    await Promise.resolve();

    const allToggles = container.querySelectorAll(".chart-toggle:not(.small)");
    expect(allToggles.length).toBeGreaterThan(0);
  });

  it("hides Avg Cost / Msg card in insights when costHidden=true", async () => {
    const container = document.createElement("div");
    render(renderUsage(buildProps({ costHidden: true })), container);
    await Promise.resolve();

    const titles = container.querySelectorAll(".usage-summary-title");
    const titleTexts = Array.from(titles).map((el) => el.textContent?.trim() ?? "");
    expect(titleTexts.some((t) => t.includes("Avg Cost / Msg"))).toBe(false);
    expect(titleTexts.some((t) => t.includes("Avg Tokens / Msg"))).toBe(true);
  });

  it("shows Avg Cost / Msg card in insights when costHidden=false", async () => {
    const container = document.createElement("div");
    render(renderUsage(buildProps({ costHidden: false })), container);
    await Promise.resolve();

    const titles = container.querySelectorAll(".usage-summary-title");
    const titleTexts = Array.from(titles).map((el) => el.textContent?.trim() ?? "");
    expect(titleTexts.some((t) => t.includes("Avg Cost / Msg"))).toBe(true);
  });

  it("top models show tokens instead of cost when costHidden=true", async () => {
    const container = document.createElement("div");
    render(renderUsage(buildProps({ costHidden: true })), container);
    await Promise.resolve();

    // Find the "Top Models" insight card and check its values use token format (no $)
    const insightCards = container.querySelectorAll(".usage-insight-card");
    const modelsCard = Array.from(insightCards).find((card) =>
      card.querySelector(".usage-insight-title")?.textContent?.includes("Top Models"),
    );
    expect(modelsCard).toBeTruthy();
    const values = modelsCard!.querySelectorAll(".usage-list-value");
    expect(values.length).toBeGreaterThan(0);
    for (const val of values) {
      // Cost format uses "$"; token format does not
      expect(val.textContent).not.toContain("$");
    }
  });

  it("hides cost/min in throughput card when costHidden=true", async () => {
    const container = document.createElement("div");
    render(renderUsage(buildProps({ costHidden: true })), container);
    await Promise.resolve();

    const summaryCards = container.querySelectorAll(".usage-summary-card");
    const throughputCard = Array.from(summaryCards).find((card) =>
      card.querySelector(".usage-summary-title")?.textContent?.includes("Throughput"),
    );
    expect(throughputCard).toBeTruthy();
    const sub = throughputCard!.querySelector(".usage-summary-sub");
    // When hidden, the sub should not contain cost formatting ($ or "/ min")
    expect(sub?.textContent).not.toContain("$");
  });

  it("forces daily chart to token mode when costHidden=true and chartMode is cost", async () => {
    const container = document.createElement("div");
    render(renderUsage(buildProps({ costHidden: true, chartMode: "cost" })), container);
    await Promise.resolve();

    // The daily chart title should say "Token" not "Cost"
    const chartTitles = container.querySelectorAll(".card-title");
    const titleTexts = Array.from(chartTitles).map((el) => el.textContent?.trim() ?? "");
    const dailyTitle = titleTexts.find((t) => t.includes("Daily"));
    expect(dailyTitle).toContain("Token");
    expect(dailyTitle).not.toContain("Cost");
  });
});
