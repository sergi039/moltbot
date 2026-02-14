import { randomUUID } from "node:crypto";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";

export type ExecApprovalRequestPayload = {
  command: string;
  cwd?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
};

export type ExecApprovalRecord = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
  decision?: ExecApprovalDecision;
  resolvedBy?: string | null;
};

type PendingEntry = {
  record: ExecApprovalRecord;
  resolve: (decision: ExecApprovalDecision | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Rate limiting: max requests per window per session key
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 20;

type RateLimitEntry = {
  timestamps: number[];
  backoffUntilMs: number;
};

export type ApprovalRateLimitConfig = {
  windowMs?: number;
  maxPerWindow?: number;
};

export type ApprovalRateLimitResult = {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
};

export class ExecApprovalManager {
  private pending = new Map<string, PendingEntry>();
  private rateLimits = new Map<string, RateLimitEntry>();
  private rateLimitWindowMs: number;
  private rateLimitMax: number;
  private auditLog: Array<{
    ts: number;
    sessionKey: string;
    event: "rate_limited" | "request" | "resolved";
    detail?: string;
  }> = [];
  private static readonly MAX_AUDIT_LOG = 500;

  constructor(rateConfig?: ApprovalRateLimitConfig) {
    this.rateLimitWindowMs = rateConfig?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    this.rateLimitMax = rateConfig?.maxPerWindow ?? DEFAULT_RATE_LIMIT_MAX;
  }

  /** Check rate limit for a session key. Returns whether the request is allowed. */
  checkRateLimit(sessionKey: string): ApprovalRateLimitResult {
    const now = Date.now();
    const key = sessionKey || "__global__";
    let entry = this.rateLimits.get(key);
    if (!entry) {
      entry = { timestamps: [], backoffUntilMs: 0 };
      this.rateLimits.set(key, entry);
    }

    // Check backoff
    if (now < entry.backoffUntilMs) {
      return {
        allowed: false,
        retryAfterMs: entry.backoffUntilMs - now,
        reason: "rate limited (backoff active)",
      };
    }

    // Prune old timestamps outside window
    const windowStart = now - this.rateLimitWindowMs;
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

    if (entry.timestamps.length >= this.rateLimitMax) {
      // Apply exponential backoff: double the window for next attempt
      const overCount = entry.timestamps.length - this.rateLimitMax + 1;
      const backoffMs = Math.min(this.rateLimitWindowMs * 2 ** overCount, 300_000);
      entry.backoffUntilMs = now + backoffMs;
      this.logAudit(key, "rate_limited", `${entry.timestamps.length} requests in window`);
      return {
        allowed: false,
        retryAfterMs: backoffMs,
        reason: `rate limited: ${entry.timestamps.length} requests in ${this.rateLimitWindowMs}ms window`,
      };
    }

    entry.timestamps.push(now);
    return { allowed: true };
  }

  private logAudit(
    sessionKey: string,
    event: "rate_limited" | "request" | "resolved",
    detail?: string,
  ): void {
    this.auditLog.push({ ts: Date.now(), sessionKey, event, detail });
    if (this.auditLog.length > ExecApprovalManager.MAX_AUDIT_LOG) {
      this.auditLog = this.auditLog.slice(-ExecApprovalManager.MAX_AUDIT_LOG);
    }
  }

  /** Get recent audit log entries for monitoring. */
  getAuditLog(limit = 50): typeof this.auditLog {
    return this.auditLog.slice(-limit);
  }

  create(
    request: ExecApprovalRequestPayload,
    timeoutMs: number,
    id?: string | null,
  ): ExecApprovalRecord | { rateLimited: true; retryAfterMs: number; reason: string } {
    const sessionKey = request.sessionKey ?? "";
    const rl = this.checkRateLimit(sessionKey);
    if (!rl.allowed) {
      return {
        rateLimited: true,
        retryAfterMs: rl.retryAfterMs ?? 0,
        reason: rl.reason ?? "rate limited",
      };
    }

    const now = Date.now();
    const resolvedId = id && id.trim().length > 0 ? id.trim() : randomUUID();
    const record: ExecApprovalRecord = {
      id: resolvedId,
      request,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
    this.logAudit(sessionKey, "request", `id=${resolvedId} cmd=${request.command}`);
    return record;
  }

  async waitForDecision(
    record: ExecApprovalRecord,
    timeoutMs: number,
  ): Promise<ExecApprovalDecision | null> {
    return await new Promise<ExecApprovalDecision | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(record.id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(record.id, { record, resolve, reject, timer });
    });
  }

  resolve(recordId: string, decision: ExecApprovalDecision, resolvedBy?: string | null): boolean {
    const pending = this.pending.get(recordId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = Date.now();
    pending.record.decision = decision;
    pending.record.resolvedBy = resolvedBy ?? null;
    this.pending.delete(recordId);
    pending.resolve(decision);
    this.logAudit(
      pending.record.request.sessionKey ?? "",
      "resolved",
      `id=${recordId} decision=${decision} by=${resolvedBy ?? "unknown"}`,
    );
    return true;
  }

  getSnapshot(recordId: string): ExecApprovalRecord | null {
    const entry = this.pending.get(recordId);
    return entry?.record ?? null;
  }
}

/** Type guard: check if create() returned a rate-limit result. */
export function isRateLimited(
  result: ExecApprovalRecord | { rateLimited: true; retryAfterMs: number; reason: string },
): result is { rateLimited: true; retryAfterMs: number; reason: string } {
  return "rateLimited" in result && result.rateLimited === true;
}
