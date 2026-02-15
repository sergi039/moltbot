import { describe, it, expect, vi, beforeEach } from "vitest";
import { ANTHROPIC_SETUP_TOKEN_PREFIX } from "./auth-token.js";

const upsertAuthProfile = vi.fn();
vi.mock("../agents/auth-profiles.js", () => ({
  upsertAuthProfile: (...args: unknown[]) => upsertAuthProfile(...args),
}));
vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/mock-agent-dir",
}));

beforeEach(() => {
  upsertAuthProfile.mockClear();
});

describe("setAnthropicApiKey", () => {
  it("saves setup token as type=token", async () => {
    const { setAnthropicApiKey } = await import("./onboard-auth.credentials.js");
    const setupToken = `${ANTHROPIC_SETUP_TOKEN_PREFIX}abc123`;
    await setAnthropicApiKey(setupToken);
    expect(upsertAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "anthropic:default",
        credential: expect.objectContaining({
          type: "token",
          provider: "anthropic",
          token: setupToken,
        }),
      }),
    );
  });

  it("saves regular API key as type=api_key", async () => {
    const { setAnthropicApiKey } = await import("./onboard-auth.credentials.js");
    await setAnthropicApiKey("sk-ant-api01-AAAA");
    expect(upsertAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({
          type: "api_key",
          key: "sk-ant-api01-AAAA",
        }),
      }),
    );
  });

  it("trims whitespace from key", async () => {
    const { setAnthropicApiKey } = await import("./onboard-auth.credentials.js");
    await setAnthropicApiKey("  sk-ant-api01-BBBB  ");
    expect(upsertAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({
          type: "api_key",
          key: "sk-ant-api01-BBBB",
        }),
      }),
    );
  });

  it("trims whitespace from setup token", async () => {
    const { setAnthropicApiKey } = await import("./onboard-auth.credentials.js");
    const setupToken = `${ANTHROPIC_SETUP_TOKEN_PREFIX}xyz789`;
    await setAnthropicApiKey(`  ${setupToken}  `);
    expect(upsertAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({
          type: "token",
          token: setupToken,
        }),
      }),
    );
  });
});
