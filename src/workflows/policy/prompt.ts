/**
 * CLI Approval Prompt
 *
 * Interactive CLI prompt for requesting user approval of policy decisions.
 * Includes risk assessment, action summaries, and configurable timeout handling.
 */

import { confirm, isCancel, select, type Option } from "@clack/prompts";
import { randomUUID } from "node:crypto";
import type {
  IApprovalPrompt,
  ApprovalRequest,
  ApprovalRecord,
  ApprovalDecision,
  PolicyContext,
} from "./types.js";
import { theme } from "../../terminal/theme.js";
import { assessRisk, getRiskLevelLabel, type RiskAssessment, type RiskLevel } from "./risk.js";

// ============================================================================
// CLI Approval Prompt
// ============================================================================

/**
 * Options for CLI approval prompt.
 */
export interface CliApprovalPromptOptions {
  /** Default timeout in milliseconds (default: 60000) */
  timeoutMs?: number;

  /** Whether to show risk assessment (default: true) */
  showRisk?: boolean;

  /** Whether to show countdown timer (default: true) */
  showCountdown?: boolean;

  /** Callback when approval is requested */
  onApprovalRequested?: (request: ApprovalRequest, risk: RiskAssessment) => void;

  /** Callback when decision is made */
  onDecisionMade?: (record: ApprovalRecord) => void;
}

/**
 * Interactive CLI prompt for approvals with risk assessment.
 */
export class CliApprovalPrompt implements IApprovalPrompt {
  private timeoutMs: number;
  private showRisk: boolean;
  private showCountdown: boolean;
  private onApprovalRequested?: (request: ApprovalRequest, risk: RiskAssessment) => void;
  private onDecisionMade?: (record: ApprovalRecord) => void;

  constructor(options: CliApprovalPromptOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000; // 1 minute default
    this.showRisk = options.showRisk ?? true;
    this.showCountdown = options.showCountdown ?? true;
    this.onApprovalRequested = options.onApprovalRequested;
    this.onDecisionMade = options.onDecisionMade;
  }

  async prompt(request: ApprovalRequest): Promise<ApprovalRecord> {
    const effectiveTimeout = request.timeoutMs || this.timeoutMs;

    // Assess risk
    const risk = assessRisk(request.action);

    // Notify callback
    this.onApprovalRequested?.(request, risk);

    // Show the approval request header
    console.log();
    console.log(this.formatHeader(risk.level));
    console.log(theme.muted(`Run: ${request.runId.slice(0, 8)}... | Phase: ${request.phaseId}`));
    console.log();

    // Show risk assessment
    if (this.showRisk) {
      this.displayRiskAssessment(risk);
    }

    // Show action details
    console.log(theme.accent("Action:"), this.formatAction(request));
    console.log(theme.muted("Reason:"), request.reason);

    // Show timeout
    if (this.showCountdown) {
      console.log(theme.muted(`Timeout: ${Math.round(effectiveTimeout / 1000)}s`));
    }
    console.log();

    // Create timeout promise with optional countdown
    let timeoutId: NodeJS.Timeout | null = null;
    let countdownId: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      const startTime = Date.now();

      if (this.showCountdown && effectiveTimeout > 10000) {
        // Show countdown warnings
        const warningAt = effectiveTimeout - 10000;
        countdownId = setTimeout(() => {
          console.log(theme.warn("⏱ 10 seconds remaining..."));
        }, warningAt);
      }

      timeoutId = setTimeout(() => {
        if (countdownId) clearTimeout(countdownId);
        resolve("timeout");
      }, effectiveTimeout);
    });

    // Prompt for decision
    const decisionPromise = this.promptDecision(risk);

    // Race between user input and timeout
    const result = await Promise.race([decisionPromise, timeoutPromise]);

    // Clear timers
    if (timeoutId) clearTimeout(timeoutId);
    if (countdownId) clearTimeout(countdownId);

    let record: ApprovalRecord;

    if (result === "timeout") {
      console.log(theme.error("⏱ Approval timed out - action denied"));
      record = {
        request,
        decision: "timeout",
        decidedAt: Date.now(),
        remember: false,
      };
    } else if (result === "cancelled") {
      console.log(theme.muted("Approval cancelled"));
      record = {
        request,
        decision: "denied",
        decidedAt: Date.now(),
        remember: false,
        comment: "User cancelled",
      };
    } else {
      // Ask about remembering
      const remember = await this.promptRemember(result.approved);

      record = {
        request,
        decision: result.approved ? "approved" : "denied",
        decidedAt: Date.now(),
        remember: remember.remember,
        rememberScope: remember.scope,
      };

      // Show confirmation
      if (result.approved) {
        console.log(theme.success("✓ Action approved"));
      } else {
        console.log(theme.error("✗ Action denied"));
      }
    }

    // Notify callback
    this.onDecisionMade?.(record);

    return record;
  }

  /**
   * Format header based on risk level.
   */
  private formatHeader(level: RiskLevel): string {
    const emoji: Record<RiskLevel, string> = {
      low: "🟢",
      medium: "🟡",
      high: "🟠",
      critical: "🔴",
    };

    const colorFn: Record<RiskLevel, (s: string) => string> = {
      low: theme.success,
      medium: theme.warn,
      high: theme.warn,
      critical: theme.error,
    };

    const label = getRiskLevelLabel(level);
    return colorFn[level](`${emoji[level]} Approval Required - ${label}`);
  }

  /**
   * Display risk assessment details.
   */
  private displayRiskAssessment(risk: RiskAssessment): void {
    if (risk.factors.length > 0) {
      console.log(theme.muted("Risk factors:"));
      for (const factor of risk.factors.slice(0, 4)) {
        console.log(theme.muted(`  • ${factor.name}: ${factor.description}`));
      }
      if (risk.factors.length > 4) {
        console.log(theme.muted(`  ... and ${risk.factors.length - 4} more`));
      }
      console.log();
    }
  }

  // ==========================================================================
  // Prompts
  // ==========================================================================

  private async promptDecision(risk: RiskAssessment): Promise<{ approved: boolean } | "cancelled"> {
    // Build options based on risk
    const options: Option<string>[] = [];

    // For low/medium risk, show approve first
    if (risk.level === "low" || risk.level === "medium") {
      options.push({
        value: "approve",
        label: theme.success("✓ Approve"),
        hint: "Allow this action",
      });
      options.push({
        value: "deny",
        label: theme.error("✗ Deny"),
        hint: "Block this action",
      });
    } else {
      // For high/critical risk, show deny first
      options.push({
        value: "deny",
        label: theme.error("✗ Deny"),
        hint: "Block this action (recommended)",
      });
      options.push({
        value: "approve",
        label: theme.warn("⚠ Approve anyway"),
        hint: "Allow despite risk",
      });
    }

    options.push({
      value: "details",
      label: theme.accent("ℹ Show details"),
      hint: "View full context",
    });

    const result = await select({
      message: `Choose action (${risk.recommendation} recommended):`,
      options,
    });

    if (isCancel(result)) {
      return "cancelled";
    }

    if (result === "details") {
      // Show detailed context
      this.showDetailedContext(risk);
      return this.promptDecision(risk);
    }

    return { approved: result === "approve" };
  }

  /**
   * Show detailed context for the action.
   */
  private showDetailedContext(risk: RiskAssessment): void {
    console.log();
    console.log(theme.accent("─── Detailed Risk Assessment ───"));
    console.log(`Risk Score: ${risk.score}/100`);
    console.log(`Level: ${getRiskLevelLabel(risk.level)}`);
    console.log(`Recommendation: ${risk.recommendation}`);
    console.log();

    if (risk.factors.length > 0) {
      console.log(theme.accent("Risk Factors:"));
      for (const factor of risk.factors) {
        console.log(`  [${factor.category}] ${factor.name}`);
        console.log(`    ${factor.description}`);
        console.log(`    Impact: +${factor.impact} to risk score`);
      }
    } else {
      console.log(theme.muted("No specific risk factors identified."));
    }
    console.log(theme.accent("───────────────────────────────"));
    console.log();
  }

  private async promptRemember(
    approved: boolean,
  ): Promise<{ remember: boolean; scope?: "run" | "session" | "permanent" }> {
    const action = approved ? "approval" : "denial";
    const result = await confirm({
      message: `Remember this ${action} for similar actions?`,
      initialValue: false,
    });

    if (isCancel(result) || !result) {
      return { remember: false };
    }

    // Ask for scope
    const scope = await select({
      message: "Remember for how long?",
      options: [
        { value: "run", label: "This workflow run only" },
        { value: "session", label: "This session" },
        { value: "permanent", label: "Always (save to config)" },
      ],
    });

    if (isCancel(scope)) {
      return { remember: false };
    }

    return { remember: true, scope: scope as "run" | "session" | "permanent" };
  }

  // ==========================================================================
  // Formatting
  // ==========================================================================

  private formatAction(request: ApprovalRequest): string {
    const action = request.action;
    const parts: string[] = [theme.accent(action.actionType)];

    if (action.targetPath) {
      parts.push(`path: ${theme.muted(action.targetPath)}`);
    }
    if (action.command) {
      const cmd = action.command.length > 60 ? action.command.slice(0, 60) + "..." : action.command;
      parts.push(`command: ${theme.muted(cmd)}`);
    }
    if (action.url) {
      parts.push(`url: ${theme.muted(action.url)}`);
    }

    return parts.join(" | ");
  }
}

// ============================================================================
// Auto-Approve Prompt (for non-interactive or testing)
// ============================================================================

/**
 * Auto-approve prompt that approves all requests without user interaction.
 * Use with caution - only for testing or trusted environments.
 */
export class AutoApprovePrompt implements IApprovalPrompt {
  private decision: ApprovalDecision;
  private delay: number;

  constructor(options: { decision?: ApprovalDecision; delayMs?: number } = {}) {
    this.decision = options.decision ?? "approved";
    this.delay = options.delayMs ?? 0;
  }

  async prompt(request: ApprovalRequest): Promise<ApprovalRecord> {
    if (this.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delay));
    }

    return {
      request,
      decision: this.decision,
      decidedAt: Date.now(),
      remember: false,
      comment: `Auto-${this.decision}`,
    };
  }
}

// ============================================================================
// Batch Approval Prompt
// ============================================================================

/**
 * Batch approval prompt that collects multiple requests and prompts once.
 */
export class BatchApprovalPrompt implements IApprovalPrompt {
  private pending: ApprovalRequest[] = [];
  private results: Map<string, ApprovalRecord> = new Map();
  private batchSize: number;
  private innerPrompt: IApprovalPrompt;

  constructor(options: { batchSize?: number; innerPrompt?: IApprovalPrompt } = {}) {
    this.batchSize = options.batchSize ?? 5;
    this.innerPrompt = options.innerPrompt ?? new CliApprovalPrompt();
  }

  async prompt(request: ApprovalRequest): Promise<ApprovalRecord> {
    // If already processed, return cached result
    const cached = this.results.get(request.id);
    if (cached) return cached;

    // Add to pending
    this.pending.push(request);

    // If batch is full, process
    if (this.pending.length >= this.batchSize) {
      await this.processBatch();
    } else {
      // Process single request
      const result = await this.innerPrompt.prompt(request);
      this.results.set(request.id, result);
      return result;
    }

    // Return result
    return this.results.get(request.id)!;
  }

  private async processBatch(): Promise<void> {
    if (this.pending.length === 0) return;

    console.log();
    console.log(theme.warn(`⚠ ${this.pending.length} actions require approval:`));
    console.log();

    for (let i = 0; i < this.pending.length; i++) {
      const req = this.pending[i];
      console.log(theme.muted(`${i + 1}.`), theme.accent(req.action.actionType));
      if (req.action.targetPath) console.log(`   Path: ${req.action.targetPath}`);
      if (req.action.command) console.log(`   Command: ${req.action.command.slice(0, 50)}...`);
    }

    console.log();

    const result = await select({
      message: "Approve all actions?",
      options: [
        { value: "all", label: "Approve all" },
        { value: "none", label: "Deny all" },
        { value: "individual", label: "Review individually" },
      ],
    });

    if (isCancel(result)) {
      // Deny all on cancel
      for (const req of this.pending) {
        this.results.set(req.id, {
          request: req,
          decision: "denied",
          decidedAt: Date.now(),
          remember: false,
          comment: "Batch cancelled",
        });
      }
    } else if (result === "all") {
      for (const req of this.pending) {
        this.results.set(req.id, {
          request: req,
          decision: "approved",
          decidedAt: Date.now(),
          remember: false,
          comment: "Batch approved",
        });
      }
    } else if (result === "none") {
      for (const req of this.pending) {
        this.results.set(req.id, {
          request: req,
          decision: "denied",
          decidedAt: Date.now(),
          remember: false,
          comment: "Batch denied",
        });
      }
    } else {
      // Review individually
      for (const req of this.pending) {
        const record = await this.innerPrompt.prompt(req);
        this.results.set(req.id, record);
      }
    }

    // Clear pending
    this.pending = [];
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an approval prompt.
 */
export function createApprovalPrompt(options: {
  type: "cli" | "auto" | "batch";
  timeoutMs?: number;
  autoDecision?: ApprovalDecision;
  batchSize?: number;
}): IApprovalPrompt {
  switch (options.type) {
    case "auto":
      return new AutoApprovePrompt({
        decision: options.autoDecision,
        delayMs: 0,
      });
    case "batch":
      return new BatchApprovalPrompt({
        batchSize: options.batchSize,
        innerPrompt: new CliApprovalPrompt({ timeoutMs: options.timeoutMs }),
      });
    case "cli":
    default:
      return new CliApprovalPrompt({ timeoutMs: options.timeoutMs });
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Options for creating an approval request.
 */
export interface CreateApprovalRequestOptions {
  /** Workflow run ID */
  runId: string;

  /** Phase ID */
  phaseId: string;

  /** Timeout in milliseconds (default: 60000) */
  timeoutMs?: number;

  /** Custom action summary for display */
  actionSummary?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Create an approval request.
 */
export function createApprovalRequest(
  context: ApprovalRequest["action"],
  reason: string,
  options: CreateApprovalRequestOptions,
): ApprovalRequest {
  return {
    id: randomUUID(),
    runId: options.runId,
    phaseId: options.phaseId,
    action: context,
    reason,
    createdAt: Date.now(),
    timeoutMs: options.timeoutMs ?? 60_000,
  };
}

/**
 * Create an approval request with automatic risk assessment.
 */
export function createApprovalRequestWithRisk(
  context: PolicyContext,
  reason: string,
  options: CreateApprovalRequestOptions,
): { request: ApprovalRequest; risk: RiskAssessment } {
  const risk = assessRisk(context);

  const request: ApprovalRequest = {
    id: randomUUID(),
    runId: options.runId,
    phaseId: options.phaseId,
    action: context,
    reason: reason || risk.summary,
    createdAt: Date.now(),
    timeoutMs: options.timeoutMs ?? 60_000,
  };

  return { request, risk };
}
