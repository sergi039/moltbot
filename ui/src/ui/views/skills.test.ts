import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../types";
import { renderSkills, type SkillsProps } from "./skills";

function createSkill(name: string, overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name,
    description: `Description for ${name}`,
    source: "bundled",
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    skillKey: name,
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
    missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

function createReport(skills: SkillStatusEntry[]): SkillStatusReport {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/skills",
    skills,
  };
}

function createProps(overrides: Partial<SkillsProps> = {}): SkillsProps {
  return {
    loading: false,
    report: null,
    error: null,
    filter: "",
    statusFilter: "all",
    edits: {},
    busyKey: null,
    messages: {},
    onFilterChange: () => undefined,
    onStatusFilterChange: () => undefined,
    onRefresh: () => undefined,
    onToggle: () => undefined,
    onEdit: () => undefined,
    onSaveKey: () => undefined,
    onInstall: () => undefined,
    ...overrides,
  };
}

describe("skills view", () => {
  describe("status filter toggle", () => {
    it("shows all skills when filter is 'all'", () => {
      const container = document.createElement("div");
      const activeSkill = createSkill("active-skill", { eligible: true, disabled: false });
      const inactiveSkill = createSkill("inactive-skill", {
        eligible: false,
        disabled: true,
      });

      render(
        renderSkills(
          createProps({
            report: createReport([activeSkill, inactiveSkill]),
            statusFilter: "all",
          }),
        ),
        container,
      );

      expect(container.textContent).toContain("active-skill");
      expect(container.textContent).toContain("inactive-skill");
      expect(container.textContent).toContain("2 shown");
    });

    it("shows only active skills when filter is 'active'", () => {
      const container = document.createElement("div");
      const activeSkill = createSkill("active-skill", { eligible: true, disabled: false });
      const inactiveSkill = createSkill("inactive-skill", {
        eligible: false,
        disabled: true,
      });

      render(
        renderSkills(
          createProps({
            report: createReport([activeSkill, inactiveSkill]),
            statusFilter: "active",
          }),
        ),
        container,
      );

      expect(container.textContent).toContain("active-skill");
      expect(container.textContent).not.toContain("inactive-skill");
      expect(container.textContent).toContain("1 shown");
    });

    it("shows only inactive skills when filter is 'inactive'", () => {
      const container = document.createElement("div");
      const activeSkill = createSkill("enabled-skill", { eligible: true, disabled: false });
      const inactiveSkill = createSkill("disabled-skill", {
        eligible: false,
        disabled: true,
      });

      render(
        renderSkills(
          createProps({
            report: createReport([activeSkill, inactiveSkill]),
            statusFilter: "inactive",
          }),
        ),
        container,
      );

      expect(container.textContent).not.toContain("enabled-skill");
      expect(container.textContent).toContain("disabled-skill");
      expect(container.textContent).toContain("1 shown");
    });

    it("calls onStatusFilterChange when clicking filter buttons", () => {
      const container = document.createElement("div");
      const onStatusFilterChange = vi.fn();

      render(
        renderSkills(
          createProps({
            report: createReport([createSkill("test")]),
            onStatusFilterChange,
          }),
        ),
        container,
      );

      const buttons = Array.from(container.querySelectorAll(".btn-group .btn"));
      expect(buttons.length).toBe(3);

      // Click "Active" button
      const activeButton = buttons.find((btn) => btn.textContent?.includes("Active"));
      activeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(onStatusFilterChange).toHaveBeenCalledWith("active");

      // Click "Inactive" button
      const inactiveButton = buttons.find((btn) => btn.textContent?.includes("Inactive"));
      inactiveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(onStatusFilterChange).toHaveBeenCalledWith("inactive");
    });

    it("preserves text filter when switching status filter", () => {
      const container = document.createElement("div");
      const skill1 = createSkill("github", { eligible: true });
      const skill2 = createSkill("slack", { eligible: true });
      const skill3 = createSkill("discord", { eligible: false, disabled: true });

      render(
        renderSkills(
          createProps({
            report: createReport([skill1, skill2, skill3]),
            filter: "git",
            statusFilter: "all",
          }),
        ),
        container,
      );

      // Only github should show due to text filter
      expect(container.textContent).toContain("github");
      expect(container.textContent).not.toContain("slack");
      expect(container.textContent).not.toContain("discord");
      expect(container.textContent).toContain("1 shown");
    });
  });

  describe("long description", () => {
    it("displays longDescription when available", () => {
      const container = document.createElement("div");
      const skill = createSkill("workflow", {
        description: "Short description",
        longDescription: "This is a much longer description with more details about the skill.",
      });

      render(
        renderSkills(
          createProps({
            report: createReport([skill]),
          }),
        ),
        container,
      );

      expect(container.textContent).toContain("This is a much longer description");
      expect(container.textContent).not.toContain("Short description");
    });

    it("falls back to description when longDescription is not available", () => {
      const container = document.createElement("div");
      const skill = createSkill("github", {
        description: "Interact with GitHub",
      });

      render(
        renderSkills(
          createProps({
            report: createReport([skill]),
          }),
        ),
        container,
      );

      expect(container.textContent).toContain("Interact with GitHub");
    });
  });
});
