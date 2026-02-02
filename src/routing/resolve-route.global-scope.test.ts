import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentRoute } from "./resolve-route.js";

function makeConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    ...overrides,
  } as OpenClawConfig;
}

describe("resolveAgentRoute with session.scope=global", () => {
  it("routes telegram DM to main session when scope=global", () => {
    const cfg = makeConfig({
      session: { scope: "global" },
    });

    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "dm", id: "123456789" },
    });

    expect(route.sessionKey).toBe("agent:main:main");
    expect(route.mainSessionKey).toBe("agent:main:main");
  });

  it("routes telegram group to main session when scope=global", () => {
    const cfg = makeConfig({
      session: { scope: "global" },
    });

    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "group", id: "-1001234567890" },
    });

    expect(route.sessionKey).toBe("agent:main:main");
    expect(route.mainSessionKey).toBe("agent:main:main");
  });

  it("routes webchat to main session when scope=global", () => {
    const cfg = makeConfig({
      session: { scope: "global" },
    });

    const route = resolveAgentRoute({
      cfg,
      channel: "webchat",
      accountId: "default",
      peer: { kind: "dm", id: "web-user-1" },
    });

    expect(route.sessionKey).toBe("agent:main:main");
  });

  it("uses per-peer session when scope is not set (default behavior)", () => {
    const cfg = makeConfig({
      session: { dmScope: "per-peer" },
    });

    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "dm", id: "123456789" },
    });

    // With dmScope=per-peer, DMs get unique session keys
    expect(route.sessionKey).not.toBe("agent:main:main");
    expect(route.sessionKey).toContain("123456789");
  });

  it("uses main session for DMs when scope not set and dmScope=main (default)", () => {
    const cfg = makeConfig({});

    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "dm", id: "123456789" },
    });

    // Default dmScope=main collapses DMs to main session
    expect(route.sessionKey).toBe("agent:main:main");
  });

  it("keeps group sessions separate when scope not set", () => {
    const cfg = makeConfig({});

    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "group", id: "-1001234567890" },
    });

    // Groups are NOT collapsed to main by default
    expect(route.sessionKey).not.toBe("agent:main:main");
    expect(route.sessionKey).toContain("group");
  });

  it("collapses group sessions to main when scope=global", () => {
    const cfg = makeConfig({
      session: { scope: "global" },
    });

    const routeDm = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "dm", id: "123456789" },
    });

    const routeGroup = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "group", id: "-1001234567890" },
    });

    // Both should be the same main session
    expect(routeDm.sessionKey).toBe(routeGroup.sessionKey);
    expect(routeDm.sessionKey).toBe("agent:main:main");
  });

  it("respects scope=global with per-sender fallback value", () => {
    const cfg = makeConfig({
      session: { scope: "per-sender" },
    });

    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "dm", id: "123456789" },
    });

    // per-sender with dmScope=main (default) still collapses DMs
    expect(route.sessionKey).toBe("agent:main:main");
  });
});
