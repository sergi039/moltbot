import { describe, expect, it } from "vitest";
import { ExecApprovalManager, isRateLimited } from "./exec-approval-manager.js";

describe("ExecApprovalManager", () => {
  describe("rate limiting", () => {
    it("allows requests under the limit", () => {
      const manager = new ExecApprovalManager({ windowMs: 60_000, maxPerWindow: 5 });
      for (let i = 0; i < 5; i++) {
        const result = manager.create({ command: `cmd-${i}`, sessionKey: "session-1" }, 10_000);
        expect(isRateLimited(result)).toBe(false);
      }
    });

    it("blocks requests over the limit", () => {
      const manager = new ExecApprovalManager({ windowMs: 60_000, maxPerWindow: 3 });
      for (let i = 0; i < 3; i++) {
        const result = manager.create({ command: `cmd-${i}`, sessionKey: "session-1" }, 10_000);
        expect(isRateLimited(result)).toBe(false);
      }
      const blocked = manager.create({ command: "cmd-blocked", sessionKey: "session-1" }, 10_000);
      expect(isRateLimited(blocked)).toBe(true);
      if (isRateLimited(blocked)) {
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
        expect(blocked.reason).toContain("rate limited");
      }
    });

    it("rate limits are per session key", () => {
      const manager = new ExecApprovalManager({ windowMs: 60_000, maxPerWindow: 2 });
      // Session A: fill up
      for (let i = 0; i < 2; i++) {
        manager.create({ command: `cmd-${i}`, sessionKey: "session-a" }, 10_000);
      }
      const blockedA = manager.create({ command: "extra", sessionKey: "session-a" }, 10_000);
      expect(isRateLimited(blockedA)).toBe(true);

      // Session B: should still work
      const resultB = manager.create({ command: "cmd-b", sessionKey: "session-b" }, 10_000);
      expect(isRateLimited(resultB)).toBe(false);
    });

    it("checkRateLimit returns retry info", () => {
      const manager = new ExecApprovalManager({ windowMs: 60_000, maxPerWindow: 1 });
      const rl1 = manager.checkRateLimit("test-session");
      expect(rl1.allowed).toBe(true);
      const rl2 = manager.checkRateLimit("test-session");
      expect(rl2.allowed).toBe(false);
      expect(rl2.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe("audit log", () => {
    it("records request and resolve events", () => {
      const manager = new ExecApprovalManager({ windowMs: 60_000, maxPerWindow: 100 });
      const result = manager.create({ command: "echo hello", sessionKey: "sess-1" }, 10_000);
      expect(isRateLimited(result)).toBe(false);
      if (!isRateLimited(result)) {
        manager.resolve(result.id, "allow-once", "operator");
      }
      const log = manager.getAuditLog();
      expect(log.length).toBe(2);
      expect(log[0].event).toBe("request");
      expect(log[1].event).toBe("resolved");
    });

    it("records rate limit events", () => {
      const manager = new ExecApprovalManager({ windowMs: 60_000, maxPerWindow: 1 });
      manager.create({ command: "cmd-1", sessionKey: "sess-1" }, 10_000);
      manager.create({ command: "cmd-2", sessionKey: "sess-1" }, 10_000);
      const log = manager.getAuditLog();
      const rateLimitEvents = log.filter((e) => e.event === "rate_limited");
      expect(rateLimitEvents.length).toBe(1);
    });

    it("limits audit log size", () => {
      const manager = new ExecApprovalManager({ windowMs: 60_000, maxPerWindow: 1000 });
      for (let i = 0; i < 600; i++) {
        manager.create({ command: `cmd-${i}`, sessionKey: `sess-${i}` }, 10_000);
      }
      const log = manager.getAuditLog(1000);
      expect(log.length).toBeLessThanOrEqual(500);
    });
  });

  describe("isRateLimited type guard", () => {
    it("identifies rate limited results", () => {
      expect(isRateLimited({ rateLimited: true, retryAfterMs: 1000, reason: "test" })).toBe(true);
    });

    it("identifies normal records", () => {
      const record = {
        id: "test",
        request: { command: "echo" },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 10_000,
      };
      expect(isRateLimited(record)).toBe(false);
    });
  });
});
