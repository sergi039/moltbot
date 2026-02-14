import { describe, expect, it } from "vitest";
import { checkConfigSecrets } from "./secrets-check.js";

describe("checkConfigSecrets", () => {
  it("detects OpenAI API key in config", () => {
    const config = {
      env: {
        OPENAI_API_KEY: "sk-abc123def456ghi789jkl012mno345pqr678stu901vwx",
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0].path).toContain("OPENAI_API_KEY");
  });

  it("detects GitHub PAT in config", () => {
    const config = {
      env: {
        GITHUB_TOKEN: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("detects Slack token in config", () => {
    const config = {
      channels: {
        slack: {
          botToken: "FAKE_SLACK_TOKEN_FOR_TESTING_ONLY",
        },
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("detects Telegram bot token in config", () => {
    const config = {
      env: {
        TELEGRAM_BOT_TOKEN: "12345678:ABCdefGHIjklMNOpqrSTUvwxYZ1234567890",
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("ignores env var references", () => {
    const config = {
      env: {
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
        TELEGRAM_BOT_TOKEN: "${TELEGRAM_BOT_TOKEN}",
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings).toHaveLength(0);
  });

  it("ignores short values", () => {
    const config = {
      gateway: {
        mode: "local",
        port: "18789",
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings).toHaveLength(0);
  });

  it("ignores paths", () => {
    const config = {
      factsMemory: {
        dbPath: "/Users/user/.openclaw/facts/facts.db",
      },
      plugins: {
        load: {
          paths: ["./extensions/myplugin"],
        },
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings).toHaveLength(0);
  });

  it("ignores URLs without credentials", () => {
    const config = {
      gateway: {
        publicUrl: "https://my-gateway.example.com",
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings).toHaveLength(0);
  });

  it("ignores systemPrompt and instructions fields", () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            systemPrompt:
              "You are a helpful assistant. sk-abc123def456ghi789jkl012mno345pqr678stu901vwx",
            instructions:
              "Follow these rules. ghp_1234567890abcdefghijklmnopqrstuvwxyz some text here.",
          },
        ],
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings).toHaveLength(0);
  });

  it("returns empty findings for clean config", () => {
    const config = {
      gateway: { mode: "local" },
      channels: {
        telegram: { enabled: true },
      },
      env: {
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings).toHaveLength(0);
  });

  it("masks preview correctly", () => {
    const config = {
      env: {
        MY_TOKEN: "sk-abc123def456ghi789jkl012mno345pqr678stu901vwx",
      },
    };
    const result = checkConfigSecrets(config);
    expect(result.findings.length).toBeGreaterThan(0);
    const preview = result.findings[0].preview;
    expect(preview).toContain("...");
    // Should not contain the full token
    expect(preview.length).toBeLessThan(20);
  });
});
