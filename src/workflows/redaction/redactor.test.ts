/**
 * Redactor Tests
 *
 * Unit tests for redaction patterns and the Redactor class.
 */

import { describe, expect, it } from "vitest";
import {
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  GITHUB_PAT,
  GOOGLE_API_KEY,
  AWS_ACCESS_KEY,
  SLACK_TOKEN,
  JWT_TOKEN,
  BEARER_TOKEN,
  URL_CREDENTIALS,
  SSH_PRIVATE_KEY,
  PRIVATE_KEY,
  ENV_API_KEY,
  ENV_TOKEN,
  ENV_SECRET,
  ENV_PASSWORD,
  getEnabledPatterns,
  getPatternsByCategory,
} from "./patterns.js";
import { createRedactor, redactString, redactObject, redact, redactWithStats } from "./redactor.js";

describe("Redaction Patterns", () => {
  describe("OpenAI API Key", () => {
    it("matches sk- prefixed keys with 20+ chars", () => {
      const text = "My key is sk-abcdefghijklmnopqrstuvwxyz1234";
      expect(text.match(OPENAI_API_KEY.pattern)).toBeTruthy();
    });

    it("matches longer keys", () => {
      const text = "sk-abcdefghijklmnopqrstuvwxyz12345678901234567890";
      expect(text.match(OPENAI_API_KEY.pattern)).toBeTruthy();
    });

    it("does not match short strings", () => {
      const text = "sk-short";
      expect(text.match(OPENAI_API_KEY.pattern)).toBeFalsy();
    });
  });

  describe("Anthropic API Key", () => {
    it("matches sk-ant- prefixed keys", () => {
      const text = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
      expect(text.match(ANTHROPIC_API_KEY.pattern)).toBeTruthy();
    });

    it("does not match regular sk- keys", () => {
      const text = "sk-regularkey12345678901234567890";
      expect(text.match(ANTHROPIC_API_KEY.pattern)).toBeFalsy();
    });
  });

  describe("GitHub PAT", () => {
    it("matches ghp_ prefixed tokens", () => {
      const text = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ab";
      expect(text.match(GITHUB_PAT.pattern)).toBeTruthy();
    });

    it("matches gho_ prefixed tokens", () => {
      const text = "gho_abcdefghijklmnopqrstuvwxyz0123456789ab";
      expect(text.match(GITHUB_PAT.pattern)).toBeTruthy();
    });
  });

  describe("Google API Key", () => {
    it("matches AIza prefixed keys", () => {
      // Google API keys: AIza + exactly 35 chars
      const text = "AIzaSyAbcdefghijklmnopqrstuvwxyz12345ab";
      expect(text.match(GOOGLE_API_KEY.pattern)).toBeTruthy();
    });

    it("does not match without AIza prefix", () => {
      const text = "somethingelse-abcdefghijklmnopqrstuvwxyz";
      expect(text.match(GOOGLE_API_KEY.pattern)).toBeFalsy();
    });
  });

  describe("AWS Access Key", () => {
    it("matches AKIA prefixed keys", () => {
      const text = "AKIAIOSFODNN7EXAMPLE";
      expect(text.match(AWS_ACCESS_KEY.pattern)).toBeTruthy();
    });

    it("matches ASIA prefixed keys", () => {
      const text = "ASIA1234567890123456";
      expect(text.match(AWS_ACCESS_KEY.pattern)).toBeTruthy();
    });
  });

  describe("Slack Token", () => {
    it("matches xoxb- tokens", () => {
      const text = "xoxb-123456789012-1234567890";
      expect(text.match(SLACK_TOKEN.pattern)).toBeTruthy();
    });

    it("matches xoxp- tokens", () => {
      const text = "xoxp-123456789012-1234567890";
      expect(text.match(SLACK_TOKEN.pattern)).toBeTruthy();
    });
  });

  describe("JWT Token", () => {
    it("matches valid JWT format", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      expect(jwt.match(JWT_TOKEN.pattern)).toBeTruthy();
    });

    it("does not match invalid JWT", () => {
      const text = "not.a.jwt";
      expect(text.match(JWT_TOKEN.pattern)).toBeFalsy();
    });
  });

  describe("Bearer Token", () => {
    it("matches Bearer prefix with token", () => {
      const text = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
      expect(text.match(BEARER_TOKEN.pattern)).toBeTruthy();
    });

    it("is case insensitive", () => {
      const text = "bearer sometoken12345678901234567890";
      expect(text.match(BEARER_TOKEN.pattern)).toBeTruthy();
    });
  });

  describe("URL Credentials", () => {
    it("matches URLs with embedded credentials", () => {
      const text = "https://user:password@example.com/path";
      expect(text.match(URL_CREDENTIALS.pattern)).toBeTruthy();
    });

    it("matches database connection strings", () => {
      const text = "postgresql://admin:secret123@localhost:5432/db";
      expect(text.match(URL_CREDENTIALS.pattern)).toBeTruthy();
    });
  });

  describe("SSH Private Key", () => {
    it("matches RSA private key", () => {
      const key = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
-----END RSA PRIVATE KEY-----`;
      expect(key.match(SSH_PRIVATE_KEY.pattern)).toBeTruthy();
    });

    it("matches OPENSSH private key", () => {
      const key = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAA...
-----END OPENSSH PRIVATE KEY-----`;
      expect(key.match(SSH_PRIVATE_KEY.pattern)).toBeTruthy();
    });
  });

  describe("Generic Private Key", () => {
    it("matches generic private key format", () => {
      const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMG...
-----END PRIVATE KEY-----`;
      expect(key.match(PRIVATE_KEY.pattern)).toBeTruthy();
    });
  });

  describe("Environment Variables", () => {
    it("matches API_KEY environment variables", () => {
      const text = "MY_API_KEY=abcdefghijklmnop1234";
      expect(text.match(ENV_API_KEY.pattern)).toBeTruthy();
    });

    it("matches TOKEN environment variables", () => {
      const text = "AUTH_TOKEN=abcdefghijklmnop1234";
      expect(text.match(ENV_TOKEN.pattern)).toBeTruthy();
    });

    it("matches SECRET environment variables", () => {
      const text = "APP_SECRET=abcdefghijklmnopqrstuvwxyz";
      expect(text.match(ENV_SECRET.pattern)).toBeTruthy();
    });

    it("matches PASSWORD environment variables", () => {
      const text = 'DB_PASSWORD="supersecret"';
      expect(text.match(ENV_PASSWORD.pattern)).toBeTruthy();
    });
  });

  describe("Pattern Registry", () => {
    it("returns all enabled patterns", () => {
      const patterns = getEnabledPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.every((p) => p.enabled)).toBe(true);
    });

    it("returns patterns by category", () => {
      const apiKeyPatterns = getPatternsByCategory("api_key");
      expect(apiKeyPatterns.length).toBeGreaterThan(0);
      expect(apiKeyPatterns.every((p) => p.category === "api_key")).toBe(true);
    });

    it("returns token patterns", () => {
      const tokenPatterns = getPatternsByCategory("token");
      expect(tokenPatterns.length).toBeGreaterThan(0);
      expect(tokenPatterns.every((p) => p.category === "token")).toBe(true);
    });
  });
});

describe("Redactor", () => {
  describe("redactString", () => {
    it("redacts OpenAI API keys", () => {
      const redactor = createRedactor();
      // Use a standalone key (not in env format) to ensure OpenAI pattern matches
      const result = redactor.redactString("Using key sk-abcdefghijklmnopqrstuvwxyz1234 for API");

      expect(result.redacted).toContain("[REDACTED:");
      expect(result.redacted).not.toContain("sk-abcdef");
      expect(result.hasRedactions).toBe(true);
      expect(result.stats.totalRedactions).toBeGreaterThanOrEqual(1);
    });

    it("redacts multiple sensitive items", () => {
      const redactor = createRedactor();
      const text = `
        First key: sk-abcdefghijklmnopqrstuvwxyz1234
        Anthropic: sk-ant-api03-xyzabcdefghijklmnop
      `;

      const result = redactor.redactString(text);

      // Both keys should be redacted
      expect(result.redacted).not.toContain("sk-abcdef");
      expect(result.redacted).not.toContain("sk-ant-api03");
      expect(result.stats.totalRedactions).toBeGreaterThanOrEqual(2);
    });

    it("redacts JWT tokens", () => {
      const redactor = createRedactor();
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

      const result = redactor.redactString(`Token: ${jwt}`);

      expect(result.redacted).toContain("[REDACTED:JWT]");
      expect(result.redacted).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    });

    it("redacts URL credentials", () => {
      const redactor = createRedactor();
      const result = redactor.redactString("postgres://admin:secret@localhost:5432/db");

      expect(result.redacted).toContain("[REDACTED:");
      expect(result.redacted).not.toContain("admin:secret");
    });

    it("tracks statistics", () => {
      const redactor = createRedactor();
      const result = redactor.redactString(
        "key1: sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa key2: sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      );

      expect(result.stats.totalRedactions).toBeGreaterThanOrEqual(2);
      expect(result.hasRedactions).toBe(true);
    });

    it("preserves non-sensitive content", () => {
      const redactor = createRedactor();
      const result = redactor.redactString("Hello world, this is safe text");

      expect(result.redacted).toBe("Hello world, this is safe text");
      expect(result.hasRedactions).toBe(false);
      expect(result.stats.totalRedactions).toBe(0);
    });
  });

  describe("redactObject", () => {
    it("redacts strings in objects", () => {
      const redactor = createRedactor();
      const obj = {
        name: "test",
        apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234",
      };

      const result = redactor.redactObject(obj);

      expect(result.redacted.name).toBe("test");
      expect(result.redacted.apiKey).toContain("[REDACTED:");
    });

    it("redacts nested objects", () => {
      const redactor = createRedactor();
      const obj = {
        config: {
          credentials: {
            apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234",
          },
        },
      };

      const result = redactor.redactObject(obj);

      expect(result.redacted.config.credentials.apiKey).toContain("[REDACTED:");
    });

    it("redacts arrays", () => {
      const redactor = createRedactor();
      const obj = {
        keys: ["sk-abcdefghijklmnopqrstuvwxyz1234", "sk-ant-api03-xyzabcdefghijklmnop"],
      };

      const result = redactor.redactObject(obj);

      expect(result.redacted.keys[0]).toContain("[REDACTED:");
      expect(result.redacted.keys[1]).toContain("[REDACTED:");
    });

    it("preserves non-string values", () => {
      const redactor = createRedactor();
      const obj = {
        count: 42,
        enabled: true,
        value: null,
      };

      const result = redactor.redactObject(obj);

      expect(result.redacted.count).toBe(42);
      expect(result.redacted.enabled).toBe(true);
      expect(result.redacted.value).toBe(null);
    });
  });

  describe("redact convenience method", () => {
    it("handles strings", () => {
      const redactor = createRedactor();
      const result = redactor.redact("key: sk-abcdefghijklmnopqrstuvwxyz1234");

      expect(result).toContain("[REDACTED:");
    });

    it("handles objects", () => {
      const redactor = createRedactor();
      const result = redactor.redact({
        apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234",
      });

      expect(result.apiKey).toContain("[REDACTED:");
    });
  });

  describe("Module-level functions", () => {
    it("redactString uses default redactor", () => {
      const result = redactString("key: sk-abcdefghijklmnopqrstuvwxyz1234");
      expect(result).toContain("[REDACTED:");
    });

    it("redactObject uses default redactor", () => {
      const result = redactObject({
        key: "sk-abcdefghijklmnopqrstuvwxyz1234",
      });
      expect(result.key).toContain("[REDACTED:");
    });

    it("redact handles both strings and objects", () => {
      const stringResult = redact("sk-abcdefghijklmnopqrstuvwxyz1234");
      expect(stringResult).toContain("[REDACTED:");

      const objResult = redact({ key: "sk-abcdefghijklmnopqrstuvwxyz1234" });
      expect(objResult.key).toContain("[REDACTED:");
    });

    it("redactWithStats returns statistics", () => {
      const result = redactWithStats("key: sk-abcdefghijklmnopqrstuvwxyz1234");

      expect(result.hasRedactions).toBe(true);
      expect(result.stats.totalRedactions).toBeGreaterThanOrEqual(1);
      expect(result.redacted).toContain("[REDACTED:");
    });
  });

  describe("Custom options", () => {
    it("allows disabling stats tracking", () => {
      const redactor = createRedactor({ trackStats: false });
      const result = redactor.redactString("sk-abcdefghijklmnopqrstuvwxyz1234");

      // Stats tracking disabled, so hasRedactions based on stats will be false
      expect(result.stats.totalRedactions).toBe(0);
    });

    it("allows custom replacement format", () => {
      const redactor = createRedactor({
        formatReplacement: (id, category) => `***${category}:${id}***`,
      });

      const result = redactor.redactString("sk-abcdefghijklmnopqrstuvwxyz1234");

      expect(result.redacted).toContain("***api_key:openai_api_key***");
    });
  });
});
