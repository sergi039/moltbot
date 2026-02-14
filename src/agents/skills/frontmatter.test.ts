import { describe, expect, it } from "vitest";

import { resolveSkillAliases, resolveSkillInvocationPolicy } from "./frontmatter.js";

describe("resolveSkillInvocationPolicy", () => {
  it("defaults to enabled behaviors", () => {
    const policy = resolveSkillInvocationPolicy({});
    expect(policy.userInvocable).toBe(true);
    expect(policy.disableModelInvocation).toBe(false);
  });

  it("parses frontmatter boolean strings", () => {
    const policy = resolveSkillInvocationPolicy({
      "user-invocable": "no",
      "disable-model-invocation": "yes",
    });
    expect(policy.userInvocable).toBe(false);
    expect(policy.disableModelInvocation).toBe(true);
  });
});

describe("resolveSkillAliases", () => {
  it("returns empty array when no aliases", () => {
    expect(resolveSkillAliases({})).toEqual([]);
  });

  it("parses comma-separated aliases string", () => {
    const aliases = resolveSkillAliases({ aliases: "wf, workflow, dev-cycle" });
    expect(aliases).toEqual(["wf", "workflow", "dev-cycle"]);
  });

  it("parses aliases as array", () => {
    const aliases = resolveSkillAliases({ aliases: "wf,workflow" });
    expect(aliases).toContain("wf");
    expect(aliases).toContain("workflow");
  });

  it("trims whitespace from aliases", () => {
    const aliases = resolveSkillAliases({ aliases: "  wf  ,  workflow  " });
    expect(aliases).toEqual(["wf", "workflow"]);
  });

  it("supports singular alias key", () => {
    const aliases = resolveSkillAliases({ alias: "wf" });
    expect(aliases).toEqual(["wf"]);
  });

  it("filters empty values", () => {
    const aliases = resolveSkillAliases({ aliases: "wf,,, , workflow" });
    expect(aliases).toEqual(["wf", "workflow"]);
  });
});
