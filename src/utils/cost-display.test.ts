import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCostVisible } from "./cost-display.js";

function cfg(costDisplay?: "auto" | "always" | "hide"): OpenClawConfig {
  return costDisplay ? { usage: { costDisplay } } : {};
}

describe("isCostVisible", () => {
  it("returns true for api-key auth (auto mode)", () => {
    expect(isCostVisible("api-key", cfg())).toBe(true);
  });

  it("returns false for oauth auth (auto mode)", () => {
    expect(isCostVisible("oauth", cfg())).toBe(false);
  });

  it("returns false for token auth (auto mode)", () => {
    expect(isCostVisible("token", cfg())).toBe(false);
  });

  it("returns true for undefined auth (auto mode)", () => {
    expect(isCostVisible(undefined, cfg())).toBe(true);
  });

  it('returns true for any auth when setting is "always"', () => {
    expect(isCostVisible("oauth", cfg("always"))).toBe(true);
    expect(isCostVisible("token", cfg("always"))).toBe(true);
    expect(isCostVisible("api-key", cfg("always"))).toBe(true);
  });

  it('returns false for any auth when setting is "hide"', () => {
    expect(isCostVisible("api-key", cfg("hide"))).toBe(false);
    expect(isCostVisible("oauth", cfg("hide"))).toBe(false);
    expect(isCostVisible(undefined, cfg("hide"))).toBe(false);
  });

  it("returns true for mixed auth (auto mode)", () => {
    expect(isCostVisible("mixed", cfg())).toBe(true);
  });

  it("handles undefined config", () => {
    expect(isCostVisible("api-key", undefined)).toBe(true);
    expect(isCostVisible("oauth", undefined)).toBe(false);
  });
});
