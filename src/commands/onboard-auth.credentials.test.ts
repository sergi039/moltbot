import { describe, expect, it, vi } from "vitest";
import { setAnthropicApiKey } from "./onboard-auth.credentials.js";

const mockUpsertAuthProfile = vi.fn();

vi.mock("../agents/auth-profiles.js", () => ({
  upsertAuthProfile: (...args: unknown[]) => mockUpsertAuthProfile(...args),
}));

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/test-agent",
}));

describe("setAnthropicApiKey", () => {
  it("saves setup token (sk-ant-oat01-*) as type: token", async () => {
    mockUpsertAuthProfile.mockClear();
    const key =
      "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    await setAnthropicApiKey(key);
    expect(mockUpsertAuthProfile).toHaveBeenCalledOnce();
    const call = mockUpsertAuthProfile.mock.calls[0][0];
    expect(call.credential.type).toBe("token");
    expect(call.credential.token).toBe(key);
    expect(call.credential).not.toHaveProperty("key");
  });

  it("saves regular API key (sk-ant-api03-*) as type: api_key", async () => {
    mockUpsertAuthProfile.mockClear();
    const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await setAnthropicApiKey(key);
    expect(mockUpsertAuthProfile).toHaveBeenCalledOnce();
    const call = mockUpsertAuthProfile.mock.calls[0][0];
    expect(call.credential.type).toBe("api_key");
    expect(call.credential.key).toBe(key);
    expect(call.credential).not.toHaveProperty("token");
  });

  it("saves unknown-prefix key as type: api_key", async () => {
    mockUpsertAuthProfile.mockClear();
    const key = "some-random-key-value";
    await setAnthropicApiKey(key);
    expect(mockUpsertAuthProfile).toHaveBeenCalledOnce();
    const call = mockUpsertAuthProfile.mock.calls[0][0];
    expect(call.credential.type).toBe("api_key");
    expect(call.credential.key).toBe(key);
  });

  it("trims whitespace before detecting prefix", async () => {
    mockUpsertAuthProfile.mockClear();
    const key =
      "  sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  ";
    await setAnthropicApiKey(key);
    expect(mockUpsertAuthProfile).toHaveBeenCalledOnce();
    const call = mockUpsertAuthProfile.mock.calls[0][0];
    expect(call.credential.type).toBe("token");
    expect(call.credential.token).toBe(key.trim());
  });

  it("trims whitespace for regular API keys too", async () => {
    mockUpsertAuthProfile.mockClear();
    const key = "  sk-ant-api03-AAAAAAAAAA  ";
    await setAnthropicApiKey(key);
    const call = mockUpsertAuthProfile.mock.calls[0][0];
    expect(call.credential.type).toBe("api_key");
    expect(call.credential.key).toBe(key.trim());
  });

  it("always uses profileId anthropic:default", async () => {
    mockUpsertAuthProfile.mockClear();
    await setAnthropicApiKey(
      "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    );
    expect(mockUpsertAuthProfile.mock.calls[0][0].profileId).toBe("anthropic:default");

    mockUpsertAuthProfile.mockClear();
    await setAnthropicApiKey("sk-ant-api03-normal-key");
    expect(mockUpsertAuthProfile.mock.calls[0][0].profileId).toBe("anthropic:default");
  });
});
