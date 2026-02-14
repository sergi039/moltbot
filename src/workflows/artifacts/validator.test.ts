/**
 * Validator Tests - maxTasks Limit
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateTaskList } from "./validator.js";
import { DEFAULT_MAX_TASKS } from "../constants.js";

vi.mock("./store.js", () => ({
  loadArtifactJson: vi.fn(),
  artifactExists: vi.fn().mockResolvedValue(true),
}));

import { loadArtifactJson } from "./store.js";
const mockLoadArtifactJson = vi.mocked(loadArtifactJson);

function createValidTaskList(taskCount: number) {
  return {
    version: "1.0",
    projectName: "test-project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      id: "task-" + (i + 1),
      title: "Task " + (i + 1),
      description: "Description for task " + (i + 1),
      type: "feature",
      priority: 1,
      complexity: 2,
      status: "pending",
      dependsOn: [],
      acceptanceCriteria: ["Test passes"],
    })),
    stats: { total: taskCount, completed: 0, failed: 0, pending: taskCount },
  };
}

describe("validateTaskList - maxTasks limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should fail when tasks.json exceeds maxTasks (51 > 50)", async () => {
    mockLoadArtifactJson.mockResolvedValue(createValidTaskList(51));
    const result = await validateTaskList("test-run", "planning", 1, { maxTasks: 50 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("exceeds maxTasks");
    expect(result.errors[0]).toContain("51 > 50");
  });

  it("should pass at boundary (50 tasks with maxTasks=50)", async () => {
    mockLoadArtifactJson.mockResolvedValue(createValidTaskList(50));
    const result = await validateTaskList("test-run", "planning", 1, { maxTasks: 50 });
    expect(result.valid).toBe(true);
  });

  it("should use DEFAULT_MAX_TASKS when no option provided", async () => {
    mockLoadArtifactJson.mockResolvedValue(createValidTaskList(DEFAULT_MAX_TASKS + 1));
    const result = await validateTaskList("test-run", "planning", 1);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("exceeds maxTasks");
  });
});
