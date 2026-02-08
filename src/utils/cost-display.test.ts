import { describe, expect, it, vi } from "vitest";
import type { ModelAuthMode } from "../agents/model-auth.js";
import {
  isCostVisible,
  resolveCostDisplayPolicy,
  resolveEffectiveAuthMode,
} from "./cost-display.js";

const mockResolveModelAuthMode = vi.fn<(provider?: string) => ModelAuthMode | undefined>();

vi.mock("../agents/model-auth.js", () => ({
  resolveModelAuthMode: (...args: unknown[]) =>
    mockResolveModelAuthMode(args[0] as string | undefined),
}));

describe("resolveCostDisplayPolicy", () => {
  it("returns 'auto' by default", () => {
    expect(resolveCostDisplayPolicy()).toBe("auto");
    expect(resolveCostDisplayPolicy({})).toBe("auto");
    expect(resolveCostDisplayPolicy({ usage: {} })).toBe("auto");
  });

  it("returns explicit policy when set", () => {
    expect(resolveCostDisplayPolicy({ usage: { costDisplay: "always" } })).toBe("always");
    expect(resolveCostDisplayPolicy({ usage: { costDisplay: "hide" } })).toBe("hide");
    expect(resolveCostDisplayPolicy({ usage: { costDisplay: "auto" } })).toBe("auto");
  });
});

describe("isCostVisible", () => {
  it("shows cost for api-key with auto policy", () => {
    expect(isCostVisible("api-key", {})).toBe(true);
  });

  it("shows cost for mixed with auto policy", () => {
    expect(isCostVisible("mixed", {})).toBe(true);
  });

  it("hides cost for oauth with auto policy", () => {
    expect(isCostVisible("oauth", {})).toBe(false);
  });

  it("hides cost for token with auto policy", () => {
    expect(isCostVisible("token", {})).toBe(false);
  });

  it("hides cost for undefined auth mode with auto policy", () => {
    expect(isCostVisible(undefined, {})).toBe(false);
  });

  it("hides cost for aws-sdk with auto policy", () => {
    expect(isCostVisible("aws-sdk", {})).toBe(false);
  });

  it("hides cost for unknown with auto policy", () => {
    expect(isCostVisible("unknown", {})).toBe(false);
  });

  it("respects 'hide' policy even for api-key", () => {
    expect(isCostVisible("api-key", { usage: { costDisplay: "hide" } })).toBe(false);
  });

  it("respects 'always' policy even for oauth", () => {
    expect(isCostVisible("oauth", { usage: { costDisplay: "always" } })).toBe(true);
  });

  it("respects 'always' policy for undefined auth mode", () => {
    expect(isCostVisible(undefined, { usage: { costDisplay: "always" } })).toBe(true);
  });

  it("respects 'always' policy for token", () => {
    expect(isCostVisible("token", { usage: { costDisplay: "always" } })).toBe(true);
  });
});

describe("resolveEffectiveAuthMode", () => {
  it("returns undefined when no providers configured", () => {
    expect(resolveEffectiveAuthMode()).toBeUndefined();
    expect(resolveEffectiveAuthMode({})).toBeUndefined();
    expect(resolveEffectiveAuthMode({ models: {} })).toBeUndefined();
    expect(resolveEffectiveAuthMode({ models: { providers: {} } })).toBeUndefined();
  });

  it("returns single provider mode", () => {
    mockResolveModelAuthMode.mockReturnValue("api-key");
    expect(resolveEffectiveAuthMode({ models: { providers: { anthropic: {} } } })).toBe("api-key");
  });

  it("returns oauth when sole provider is oauth", () => {
    mockResolveModelAuthMode.mockReturnValue("oauth");
    expect(resolveEffectiveAuthMode({ models: { providers: { anthropic: {} } } })).toBe("oauth");
  });

  it("returns mixed when providers span api-key and oauth", () => {
    mockResolveModelAuthMode.mockImplementation((provider) => {
      if (provider === "openai") {
        return "api-key";
      }
      return "oauth";
    });
    const cfg = { models: { providers: { openai: {}, anthropic: {} } } };
    expect(resolveEffectiveAuthMode(cfg)).toBe("mixed");
  });

  it("returns first subscription mode when all providers are subscription", () => {
    mockResolveModelAuthMode.mockImplementation((provider) => {
      if (provider === "openai") {
        return "token";
      }
      return "oauth";
    });
    const cfg = { models: { providers: { openai: {}, anthropic: {} } } };
    const mode = resolveEffectiveAuthMode(cfg);
    // Both are subscription — returns first encountered (token or oauth)
    expect(mode === "token" || mode === "oauth").toBe(true);
    expect(mode).not.toBe("api-key");
    expect(mode).not.toBe("mixed");
  });

  it("skips unknown modes", () => {
    mockResolveModelAuthMode.mockImplementation((provider) => {
      if (provider === "openai") {
        return "unknown";
      }
      return "api-key";
    });
    const cfg = { models: { providers: { openai: {}, anthropic: {} } } };
    expect(resolveEffectiveAuthMode(cfg)).toBe("api-key");
  });
});
