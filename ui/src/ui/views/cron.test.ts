import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types";
import { DEFAULT_CRON_FORM } from "../app-defaults";
import { renderCron, type CronProps } from "./cron";

function createJob(id: string): CronJob {
  return {
    id,
    name: "Daily ping",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
  };
}

function createProps(overrides: Partial<CronProps> = {}): CronProps {
  return {
    loading: false,
    status: null,
    jobs: [],
    error: null,
    busy: false,
    form: { ...DEFAULT_CRON_FORM },
    channels: [],
    channelLabels: {},
    runsJobId: null,
    runs: [],
    onFormChange: () => undefined,
    onRefresh: () => undefined,
    onAdd: () => undefined,
    onToggle: () => undefined,
    onRun: () => undefined,
    onRemove: () => undefined,
    onLoadRuns: () => undefined,
    ...overrides,
  };
}

describe("cron view", () => {
  it("prompts to select a job before showing run history", () => {
    const container = document.createElement("div");
    render(renderCron(createProps()), container);

    expect(container.textContent).toContain("Select a job to inspect run history.");
  });

  it("loads run history when clicking a job row", () => {
    const container = document.createElement("div");
    const onLoadRuns = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          onLoadRuns,
        }),
      ),
      container,
    );

    const row = container.querySelector(".list-item-clickable") as HTMLElement | null;
    expect(row).not.toBeNull();
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onLoadRuns).toHaveBeenCalledWith("job-1");
  });

  it("marks the selected job and keeps Runs button to a single call", () => {
    const container = document.createElement("div");
    const onLoadRuns = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          runsJobId: "job-1",
          onLoadRuns,
        }),
      ),
      container,
    );

    const selected = container.querySelector(".list-item-selected");
    expect(selected).not.toBeNull();

    const runsButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Runs",
    );
    expect(runsButton).not.toBeUndefined();
    runsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onLoadRuns).toHaveBeenCalledTimes(1);
    expect(onLoadRuns).toHaveBeenCalledWith("job-1");
  });

  // P1: Silent job hint
  it("shows silent hint for jobs with deliver:false", () => {
    const container = document.createElement("div");
    const silentJob: CronJob = {
      id: "silent-job",
      name: "Silent checker",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron", expr: "0 * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Check silently", deliver: false },
    };
    render(renderCron(createProps({ jobs: [silentJob] })), container);

    expect(container.textContent).toContain("Silent");
    expect(container.textContent).toContain("no output unless thresholds");
  });

  it("does not show silent hint for jobs with deliver:true", () => {
    const container = document.createElement("div");
    const deliverJob: CronJob = {
      id: "deliver-job",
      name: "Normal job",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron", expr: "0 * * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Normal message", deliver: true },
    };
    render(renderCron(createProps({ jobs: [deliverJob] })), container);

    expect(container.textContent).not.toContain("Silent");
  });

  // P2: No runs yet indicator
  it("shows 'No runs yet' with next run time when runs are empty", () => {
    const container = document.createElement("div");
    const job: CronJob = {
      id: "new-job",
      name: "New job",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "test" },
      state: { nextRunAtMs: Date.now() + 3600000 },
    };
    render(
      renderCron(createProps({ jobs: [job], runsJobId: "new-job", runs: [] })),
      container,
    );

    expect(container.textContent).toContain("No runs yet");
    expect(container.textContent).toContain("Next run");
  });

  it("shows disabled warning for disabled jobs with no runs", () => {
    const container = document.createElement("div");
    const disabledJob: CronJob = {
      id: "disabled-job",
      name: "Disabled job",
      enabled: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "test" },
    };
    render(
      renderCron(createProps({ jobs: [disabledJob], runsJobId: "disabled-job", runs: [] })),
      container,
    );

    expect(container.textContent).toContain("No runs yet");
    expect(container.textContent).toContain("Job is disabled");
  });
});
