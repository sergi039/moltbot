/**
 * Tests for redaction module
 */

import { describe, it, expect } from "vitest";
import {
  redactString,
  redactMemoryEntry,
  shouldExcludeEntry,
  processEntriesForExport,
  validatePatternTypes,
  getAvailablePatterns,
  DEFAULT_REDACTION_PATTERNS,
} from "./redaction.js";
import type { MemoryEntry } from "./types.js";

describe("redactString", () => {
  it("redacts emails", () => {
    const result = redactString("Contact me at user@example.com for info");
    expect(result.redacted).toBe("Contact me at [EMAIL] for info");
    expect(result.wasRedacted).toBe(true);
    expect(result.redactionCounts.EMAIL).toBe(1);
  });

  it("redacts multiple emails", () => {
    const result = redactString("From: a@b.com To: c@d.org");
    expect(result.redacted).toBe("From: [EMAIL] To: [EMAIL]");
    expect(result.redactionCounts.EMAIL).toBe(2);
  });

  it("redacts phone numbers", () => {
    // Phone regex may consume leading space/dash
    const result = redactString("Phone: (555) 123-4567", ["PHONE"]);
    expect(result.redacted).toContain("[PHONE]");
    expect(result.wasRedacted).toBe(true);
  });

  it("redacts API keys", () => {
    const result = redactString("Use api_key_abcdefghijklmnop12345", ["API_KEY"]);
    expect(result.redacted).toBe("Use [API_KEY]");
    expect(result.wasRedacted).toBe(true);
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature123";
    const result = redactString(`Token: ${jwt}`);
    expect(result.redacted).toBe("Token: [JWT]");
    expect(result.wasRedacted).toBe(true);
  });

  it("redacts Bearer tokens", () => {
    const result = redactString("Authorization: Bearer abc123xyz");
    expect(result.redacted).toBe("Authorization: Bearer [TOKEN]");
    expect(result.wasRedacted).toBe(true);
  });

  it("redacts URL credentials", () => {
    const result = redactString("Connect to https://user:secret@host.com/db", ["URL_CREDS"]);
    expect(result.redacted).toBe("Connect to https://user:[PASSWORD]@host.com/db");
    expect(result.wasRedacted).toBe(true);
  });

  it("returns original when no matches", () => {
    const result = redactString("No sensitive data here");
    expect(result.redacted).toBe("No sensitive data here");
    expect(result.wasRedacted).toBe(false);
    expect(Object.keys(result.redactionCounts).length).toBe(0);
  });

  it("uses custom replacement", () => {
    const result = redactString("Contact user@example.com", ["EMAIL"], "***");
    expect(result.redacted).toBe("Contact ***");
  });

  it("applies only specified patterns", () => {
    const result = redactString("user@example.com 555-123-4567", ["EMAIL"]);
    expect(result.redacted).toBe("[EMAIL] 555-123-4567");
  });
});

describe("redactMemoryEntry", () => {
  const baseEntry: MemoryEntry = {
    id: "test-id",
    type: "fact",
    content: "Contact user@example.com",
    importance: 0.5,
    createdAt: 1000,
    accessCount: 0,
    lastAccessed: 1000,
    source: "conversation",
  };

  it("redacts content in memory entry", () => {
    const result = redactMemoryEntry(baseEntry);
    expect(result.content).toBe("Contact [EMAIL]");
    expect(result.id).toBe(baseEntry.id);
    expect(result.type).toBe(baseEntry.type);
  });

  it("does not modify original entry", () => {
    const original = { ...baseEntry };
    redactMemoryEntry(baseEntry);
    expect(baseEntry.content).toBe(original.content);
  });
});

describe("shouldExcludeEntry", () => {
  const entry: MemoryEntry = {
    id: "test-id",
    type: "preference",
    content: "test",
    importance: 0.5,
    createdAt: 1000,
    accessCount: 0,
    lastAccessed: 1000,
    source: "conversation",
  };

  it("returns false when no exclude types", () => {
    expect(shouldExcludeEntry(entry, undefined)).toBe(false);
    expect(shouldExcludeEntry(entry, [])).toBe(false);
  });

  it("returns true when type is excluded", () => {
    expect(shouldExcludeEntry(entry, ["preference"])).toBe(true);
  });

  it("returns false when type is not excluded", () => {
    expect(shouldExcludeEntry(entry, ["fact", "event"])).toBe(false);
  });
});

describe("processEntriesForExport", () => {
  const entries: MemoryEntry[] = [
    {
      id: "1",
      type: "fact",
      content: "Email: user@example.com",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "conversation",
    },
    {
      id: "2",
      type: "preference",
      content: "No sensitive data",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "conversation",
    },
    {
      id: "3",
      type: "decision",
      content: "Call (555) 123-4567",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "conversation",
    },
  ];

  it("filters by excluded types", () => {
    const result = processEntriesForExport(entries, { excludeTypes: ["preference"] });
    expect(result.length).toBe(2);
    expect(result.find((e) => e.type === "preference")).toBeUndefined();
  });

  it("applies redaction when enabled", () => {
    const result = processEntriesForExport(entries, { redact: true });
    expect(result[0].content).toBe("Email: [EMAIL]");
    expect(result[2].content).toContain("[PHONE]");
  });

  it("does not redact when disabled", () => {
    const result = processEntriesForExport(entries, { redact: false });
    expect(result[0].content).toBe("Email: user@example.com");
  });

  it("combines filtering and redaction", () => {
    const result = processEntriesForExport(entries, {
      redact: true,
      excludeTypes: ["decision"],
    });
    expect(result.length).toBe(2);
    expect(result[0].content).toBe("Email: [EMAIL]");
    expect(result.find((e) => e.type === "decision")).toBeUndefined();
  });
});

describe("validatePatternTypes", () => {
  it("validates valid patterns", () => {
    const result = validatePatternTypes(["EMAIL", "PHONE", "API_KEY"]);
    expect(result.valid).toEqual(["EMAIL", "PHONE", "API_KEY"]);
    expect(result.invalid).toEqual([]);
  });

  it("handles case-insensitive input", () => {
    const result = validatePatternTypes(["email", "Phone"]);
    expect(result.valid).toEqual(["EMAIL", "PHONE"]);
  });

  it("separates invalid patterns", () => {
    const result = validatePatternTypes(["EMAIL", "INVALID", "PHONE", "FAKE"]);
    expect(result.valid).toEqual(["EMAIL", "PHONE"]);
    expect(result.invalid).toEqual(["INVALID", "FAKE"]);
  });
});

describe("getAvailablePatterns", () => {
  it("returns all pattern types", () => {
    const patterns = getAvailablePatterns();
    expect(patterns).toContain("EMAIL");
    expect(patterns).toContain("PHONE");
    expect(patterns).toContain("API_KEY");
    expect(patterns).toContain("JWT");
    expect(patterns).toContain("BEARER");
    expect(patterns).toContain("URL_CREDS");
  });
});

describe("DEFAULT_REDACTION_PATTERNS", () => {
  it("includes common sensitive patterns", () => {
    expect(DEFAULT_REDACTION_PATTERNS).toContain("EMAIL");
    expect(DEFAULT_REDACTION_PATTERNS).toContain("PHONE");
    expect(DEFAULT_REDACTION_PATTERNS).toContain("API_KEY");
    expect(DEFAULT_REDACTION_PATTERNS).toContain("JWT");
  });
});
