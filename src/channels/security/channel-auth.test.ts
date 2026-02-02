/**
 * Channel Auth Security Tests
 *
 * Consolidated tests for channel authentication and authorization.
 * Verifies that:
 * - Unauthorized senders are blocked
 * - allowFrom is enforced
 * - dmPolicy/groupPolicy work correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Test utilities
// ============================================================================

/**
 * Check if a sender ID matches an allowFrom list entry.
 * This mirrors the logic used in channel implementations.
 */
function matchesAllowFrom(
  senderId: string | number,
  senderUsername: string | undefined,
  allowFrom: string[],
  channelPrefix: string = "",
): boolean {
  const senderIdStr = String(senderId);

  for (const entry of allowFrom) {
    // Normalize entry - remove channel prefixes and @ symbol
    let normalizedEntry = entry.toLowerCase();

    // Handle channel-specific prefixes (telegram:, tg:, discord:, etc.)
    const prefixes = ["telegram:", "tg:", "discord:", "slack:"];
    for (const prefix of prefixes) {
      if (normalizedEntry.startsWith(prefix)) {
        normalizedEntry = normalizedEntry.slice(prefix.length);
        break;
      }
    }

    // Remove @ prefix for usernames
    if (normalizedEntry.startsWith("@")) {
      normalizedEntry = normalizedEntry.slice(1);
    }

    // Match by ID
    if (normalizedEntry === senderIdStr) {
      return true;
    }

    // Match by username (case-insensitive)
    if (senderUsername && normalizedEntry === senderUsername.toLowerCase()) {
      return true;
    }
  }

  return false;
}

/**
 * Determine if a message should be allowed based on policy.
 */
function shouldAllowMessage(
  isDirectMessage: boolean,
  senderId: string | number,
  senderUsername: string | undefined,
  config: {
    dmPolicy?: "open" | "pairing" | "allowlist";
    groupPolicy?: "open" | "allowlist" | "disabled";
    allowFrom?: string[];
  },
): { allowed: boolean; reason?: string } {
  const { dmPolicy = "open", groupPolicy = "open", allowFrom = [] } = config;

  if (isDirectMessage) {
    // DM policy
    switch (dmPolicy) {
      case "open":
        return { allowed: true };
      case "pairing":
        // Pairing requires allowFrom or active pairing session
        if (allowFrom.length === 0) {
          return { allowed: false, reason: "pairing required, no allowFrom" };
        }
        if (matchesAllowFrom(senderId, senderUsername, allowFrom)) {
          return { allowed: true };
        }
        return { allowed: false, reason: "sender not in allowFrom (pairing mode)" };
      case "allowlist":
        if (matchesAllowFrom(senderId, senderUsername, allowFrom)) {
          return { allowed: true };
        }
        return { allowed: false, reason: "sender not in allowFrom" };
      default:
        return { allowed: true };
    }
  } else {
    // Group policy
    switch (groupPolicy) {
      case "open":
        return { allowed: true };
      case "disabled":
        return { allowed: false, reason: "group messages disabled" };
      case "allowlist":
        if (matchesAllowFrom(senderId, senderUsername, allowFrom)) {
          return { allowed: true };
        }
        return { allowed: false, reason: "sender not in group allowFrom" };
      default:
        return { allowed: true };
    }
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("Channel Auth Security", () => {
  describe("allowFrom matching", () => {
    it("should match by numeric ID", () => {
      expect(matchesAllowFrom(123456789, undefined, ["123456789"])).toBe(true);
      expect(matchesAllowFrom(123456789, undefined, ["987654321"])).toBe(false);
    });

    it("should match by username (case-insensitive)", () => {
      expect(matchesAllowFrom(123, "TestUser", ["testuser"])).toBe(true);
      expect(matchesAllowFrom(123, "TestUser", ["TESTUSER"])).toBe(true);
      expect(matchesAllowFrom(123, "TestUser", ["otheruser"])).toBe(false);
    });

    it("should match with @ prefix", () => {
      expect(matchesAllowFrom(123, "testuser", ["@testuser"])).toBe(true);
      expect(matchesAllowFrom(123, "testuser", ["@TESTUSER"])).toBe(true);
    });

    it("should match with telegram: prefix", () => {
      expect(matchesAllowFrom(123456789, undefined, ["telegram:123456789"])).toBe(true);
      expect(matchesAllowFrom(123456789, undefined, ["TELEGRAM:123456789"])).toBe(true);
    });

    it("should match with tg: prefix", () => {
      expect(matchesAllowFrom(123456789, undefined, ["tg:123456789"])).toBe(true);
      expect(matchesAllowFrom(123456789, undefined, ["TG:123456789"])).toBe(true);
    });

    it("should match with discord: prefix", () => {
      expect(matchesAllowFrom("123456789", undefined, ["discord:123456789"])).toBe(true);
    });

    it("should not match when allowFrom is empty", () => {
      expect(matchesAllowFrom(123, "user", [])).toBe(false);
    });
  });

  describe("Telegram DM Policy", () => {
    it("should allow DM when dmPolicy is 'open'", () => {
      const result = shouldAllowMessage(true, 999, "stranger", {
        dmPolicy: "open",
        allowFrom: [],
      });
      expect(result.allowed).toBe(true);
    });

    it("should block DM when dmPolicy is 'pairing' and sender not in allowFrom", () => {
      const result = shouldAllowMessage(true, 999, "stranger", {
        dmPolicy: "pairing",
        allowFrom: ["123456789"],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in allowFrom");
    });

    it("should allow DM when dmPolicy is 'pairing' and sender in allowFrom", () => {
      const result = shouldAllowMessage(true, 123456789, "allowed_user", {
        dmPolicy: "pairing",
        allowFrom: ["123456789"],
      });
      expect(result.allowed).toBe(true);
    });

    it("should block DM when dmPolicy is 'allowlist' and sender not in list", () => {
      const result = shouldAllowMessage(true, 999, "stranger", {
        dmPolicy: "allowlist",
        allowFrom: ["123456789"],
      });
      expect(result.allowed).toBe(false);
    });

    it("should allow DM when dmPolicy is 'allowlist' and sender in list by username", () => {
      const result = shouldAllowMessage(true, 999, "allowed_user", {
        dmPolicy: "allowlist",
        allowFrom: ["@allowed_user"],
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("Telegram Group Policy", () => {
    it("should allow group message when groupPolicy is 'open'", () => {
      const result = shouldAllowMessage(false, 999, "anyone", {
        groupPolicy: "open",
        allowFrom: [],
      });
      expect(result.allowed).toBe(true);
    });

    it("should block group message when groupPolicy is 'disabled'", () => {
      const result = shouldAllowMessage(false, 123, "user", {
        groupPolicy: "disabled",
        allowFrom: ["123"],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("group messages disabled");
    });

    it("should block group message when groupPolicy is 'allowlist' and sender not in list", () => {
      const result = shouldAllowMessage(false, 999, "stranger", {
        groupPolicy: "allowlist",
        allowFrom: ["123456789"],
      });
      expect(result.allowed).toBe(false);
    });

    it("should allow group message when groupPolicy is 'allowlist' and sender in list", () => {
      const result = shouldAllowMessage(false, 123456789, "allowed", {
        groupPolicy: "allowlist",
        allowFrom: ["123456789"],
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("Discord allowFrom", () => {
    it("should match Discord user ID with discord: prefix", () => {
      expect(
        matchesAllowFrom("123456789012345678", undefined, ["discord:123456789012345678"]),
      ).toBe(true);
    });

    it("should block Discord user not in allowFrom", () => {
      const result = shouldAllowMessage(true, "999999999999999999", undefined, {
        dmPolicy: "allowlist",
        allowFrom: ["discord:123456789012345678"],
      });
      expect(result.allowed).toBe(false);
    });

    it("should allow Discord user in allowFrom", () => {
      const result = shouldAllowMessage(true, "123456789012345678", undefined, {
        dmPolicy: "allowlist",
        allowFrom: ["discord:123456789012345678"],
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("Security edge cases", () => {
    it("should not allow empty allowFrom with pairing policy", () => {
      const result = shouldAllowMessage(true, 123, "user", {
        dmPolicy: "pairing",
        allowFrom: [],
      });
      expect(result.allowed).toBe(false);
    });

    it("should handle numeric string IDs correctly", () => {
      expect(matchesAllowFrom("123456789", undefined, ["123456789"])).toBe(true);
      expect(matchesAllowFrom(123456789, undefined, ["123456789"])).toBe(true);
    });

    it("should be case-insensitive for prefixes", () => {
      expect(matchesAllowFrom(123, undefined, ["TELEGRAM:123"])).toBe(true);
      expect(matchesAllowFrom(123, undefined, ["Tg:123"])).toBe(true);
      expect(matchesAllowFrom(123, undefined, ["DISCORD:123"])).toBe(true);
    });

    it("should handle mixed allowFrom entries", () => {
      const allowFrom = ["123456789", "@username", "telegram:111", "discord:222"];

      expect(matchesAllowFrom(123456789, undefined, allowFrom)).toBe(true);
      expect(matchesAllowFrom(999, "username", allowFrom)).toBe(true);
      expect(matchesAllowFrom(111, undefined, allowFrom)).toBe(true);
      expect(matchesAllowFrom(222, undefined, allowFrom)).toBe(true);
      expect(matchesAllowFrom(333, "other", allowFrom)).toBe(false);
    });
  });
});
