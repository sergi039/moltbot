import { describe, expect, it } from "vitest";
import { getDefaultRedactPatterns, redactSensitiveText } from "./redact.js";

const defaults = getDefaultRedactPatterns();

describe("redactSensitiveText", () => {
  it("masks env assignments while keeping the key", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("OPENAI_API_KEY=sk-123…cdef");
  });

  it("masks CLI flags", () => {
    const input = "curl --token abcdef1234567890ghij https://api.test";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("curl --token abcdef…ghij https://api.test");
  });

  it("masks JSON fields", () => {
    const input = '{"token":"abcdef1234567890ghij"}';
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe('{"token":"abcdef…ghij"}');
  });

  it("masks bearer tokens", () => {
    const input = "Authorization: Bearer abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("Authorization: Bearer abcdef…ghij");
  });

  it("masks Telegram-style tokens", () => {
    const input = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("123456…cdef");
  });

  it("redacts short tokens fully", () => {
    const input = "TOKEN=shortvalue";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("TOKEN=***");
  });

  it("redacts private key blocks", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "ABCDEF1234567890",
      "ZYXWVUT987654321",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe(
      ["-----BEGIN PRIVATE KEY-----", "…redacted…", "-----END PRIVATE KEY-----"].join("\n"),
    );
  });

  it("honors custom patterns with flags", () => {
    const input = "token=abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["/token=([A-Za-z0-9]+)/i"],
    });
    expect(output).toBe("token=abcdef…ghij");
  });

  it("skips redaction when mode is off", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "off",
      patterns: defaults,
    });
    expect(output).toBe(input);
  });

  it("redacts email addresses", () => {
    const input = "Contact user alice@example.com for details";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).not.toContain("alice@example.com");
    // Email is <18 chars so gets fully masked as ***
    expect(output).toContain("***");
  });

  it("redacts phone numbers", () => {
    const input = "Call me at +1-555-123-4567 tomorrow";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).not.toContain("+1-555-123-4567");
  });

  it("redacts credit card numbers", () => {
    const input = "Payment card: 4111-1111-1111-1111";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).not.toContain("4111-1111-1111-1111");
  });

  it("redacts SSN patterns", () => {
    const input = "SSN: 123-45-6789";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).not.toContain("123-45-6789");
  });

  it("redacts IPv4 addresses", () => {
    const input = "Server at 192.168.1.100 is down";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).not.toContain("192.168.1.100");
  });
});
