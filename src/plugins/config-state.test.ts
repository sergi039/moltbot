import { describe, expect, it } from "vitest";
import { normalizePluginsConfig, resolveEnableState } from "./config-state.js";

describe("normalizePluginsConfig", () => {
  it("uses default memory slot when not specified", () => {
    const result = normalizePluginsConfig({});
    expect(result.slots.memory).toBe("memory-core");
  });

  it("respects explicit memory slot value", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "custom-memory" },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("disables memory slot when set to 'none'", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "none" },
    });
    expect(result.slots.memory).toBeNull();
  });

  it("disables memory slot when set to 'None' (case insensitive)", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "None" },
    });
    expect(result.slots.memory).toBeNull();
  });

  it("trims whitespace from memory slot value", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "  custom-memory  " },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("uses default when memory slot is empty string", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "" },
    });
    expect(result.slots.memory).toBe("memory-core");
  });

  it("uses default when memory slot is whitespace only", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "   " },
    });
    expect(result.slots.memory).toBe("memory-core");
  });
});

describe("resolveEnableState", () => {
  const baseConfig = normalizePluginsConfig({});

  it("denies external plugin when allowlist is empty", () => {
    const result = resolveEnableState("ext-plugin", "config", baseConfig);
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("allowlist required for external plugins");
  });

  it("allows external plugin when in allowlist", () => {
    const config = normalizePluginsConfig({
      allow: ["ext-plugin"],
      entries: { "ext-plugin": { enabled: true } },
    });
    const result = resolveEnableState("ext-plugin", "config", config);
    expect(result.enabled).toBe(true);
  });

  it("bundled plugin unaffected by empty allowlist", () => {
    const config = normalizePluginsConfig({
      entries: { "bundled-plugin": { enabled: true } },
    });
    const result = resolveEnableState("bundled-plugin", "bundled", config);
    expect(result.enabled).toBe(true);
  });
});
