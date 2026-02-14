/**
 * Engine Agent Runner
 *
 * Abstraction layer for running agents within workflow engines.
 * Provides both stub (for testing/non-live mode) and live (real agent) implementations.
 * Includes policy-aware wrapper for enforcing security policies.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { AgentConfig } from "../types.js";
import { runEmbeddedPiAgent, type EmbeddedPiRunResult } from "../../agents/pi-embedded.js";
import type { IPolicyEngine, PolicyContext, WorkflowPolicy } from "../policy/types.js";
import { createApprovalRequest } from "../policy/prompt.js";
import { deriveExecOverrides, type PolicyExecOverrides } from "../policy/hooks.js";

// ============================================================================
// Runner Interface
// ============================================================================

/**
 * Parameters for running an agent within a workflow engine.
 */
export interface EngineAgentRunParams {
  /** Unique session identifier for this run */
  sessionId: string;

  /** The prompt/instructions to send to the agent */
  prompt: string;

  /** Absolute path to the workspace directory */
  workspacePath: string;

  /** Timeout in milliseconds */
  timeoutMs: number;

  /** Model to use (optional, uses default if not specified) */
  model?: string;

  /** Provider to use (claude or codex) */
  provider?: string;

  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;

  /** Progress callback */
  onProgress?: (message: string) => void;

  /** Path to store session file */
  sessionFilePath?: string;
}

/**
 * Result from an agent run.
 */
export interface EngineAgentRunResult {
  /** Whether the run completed successfully */
  success: boolean;

  /** Collected text output from the agent */
  output: string;

  /** Error message if failed */
  error?: string;

  /** Execution metrics */
  metrics: {
    durationMs: number;
    tokens?: { input: number; output: number };
    model?: string;
    provider?: string;
  };
}

/**
 * Interface for agent runners used by workflow engines.
 */
export interface EngineAgentRunner {
  /**
   * Run an agent with the given parameters.
   */
  run(params: EngineAgentRunParams): Promise<EngineAgentRunResult>;
}

// ============================================================================
// Stub Runner (Non-Live Mode)
// ============================================================================

/**
 * Stub runner that returns mock success after a delay.
 * Used when live mode is not enabled.
 */
export class StubRunner implements EngineAgentRunner {
  private delayMs: number;
  private mockResponse?: string;

  constructor(options: { delayMs?: number; mockResponse?: string } = {}) {
    this.delayMs = options.delayMs ?? 500;
    this.mockResponse = options.mockResponse;
  }

  async run(params: EngineAgentRunParams): Promise<EngineAgentRunResult> {
    const startTime = Date.now();

    // Simulate work with configurable delay
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, this.delayMs);

      // Handle abort signal
      if (params.abortSignal) {
        params.abortSignal.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("Aborted"));
        });
      }
    });

    params.onProgress?.("Stub execution completed");

    return {
      success: true,
      output: this.mockResponse ?? `Stub response for: ${params.prompt.slice(0, 100)}...`,
      metrics: {
        durationMs: Date.now() - startTime,
        model: "stub",
        provider: "stub",
      },
    };
  }
}

// ============================================================================
// Live Runner (Real Agent Execution)
// ============================================================================

/**
 * Options for creating a LiveRunner.
 */
export interface LiveRunnerOptions {
  /** Directory to store session file (phase directory) */
  phaseDir: string;

  /** Directory to store other artifacts */
  artifactsDir: string;

  /** Optional workflow policy for exec security enforcement */
  policy?: WorkflowPolicy;

  /** Run ID for logging and context */
  runId?: string;

  /** Phase ID for logging and context */
  phaseId?: string;

  /** Maximum retry attempts for recoverable errors (default: 3) */
  maxRetries?: number;

  /** Base delay for exponential backoff in ms (default: 1000) */
  retryDelayMs?: number;
}

/**
 * Live runner that wraps runEmbeddedPiAgent for real agent execution.
 * Enforces workflow policy via execOverrides when policy is provided.
 * Includes automatic retry on recoverable errors with exponential backoff.
 */
export class LiveRunner implements EngineAgentRunner {
  private phaseDir: string;
  private artifactsDir: string;
  private policy?: WorkflowPolicy;
  private execOverrides?: PolicyExecOverrides;
  private runId?: string;
  private phaseId?: string;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(options: LiveRunnerOptions) {
    this.phaseDir = options.phaseDir;
    this.artifactsDir = options.artifactsDir;
    this.policy = options.policy;
    this.runId = options.runId;
    this.phaseId = options.phaseId;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;

    // Derive exec overrides from policy if provided
    if (this.policy) {
      const mapping = deriveExecOverrides({
        policy: this.policy,
        runId: this.runId,
        phaseId: this.phaseId,
      });
      this.execOverrides = mapping.overrides;
    }
  }

  /**
   * Check if an error is recoverable (worth retrying).
   */
  private isRecoverableError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const message = err.message.toLowerCase();
    return (
      message.includes("timeout") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("econnreset") ||
      message.includes("rate limit") ||
      message.includes("429") ||
      message.includes("503") ||
      message.includes("502") ||
      message.includes("500")
    );
  }

  /**
   * Sleep helper for retry backoff.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async run(params: EngineAgentRunParams): Promise<EngineAgentRunResult> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.runOnce(params);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry if not recoverable or if it's the last attempt
        if (!this.isRecoverableError(err) || attempt === this.maxRetries) {
          return {
            success: false,
            output: "",
            error: `${lastError.message} (attempt ${attempt}/${this.maxRetries})`,
            metrics: {
              durationMs: 0,
              model: params.model,
              provider: params.provider,
            },
          };
        }

        // Exponential backoff
        const backoffMs = this.retryDelayMs * Math.pow(2, attempt - 1);
        params.onProgress?.(
          `Recoverable error, retrying in ${backoffMs}ms (attempt ${attempt}/${this.maxRetries})...`,
        );
        await this.sleep(backoffMs);
      }
    }

    // Should not reach here, but just in case
    return {
      success: false,
      output: "",
      error: lastError?.message ?? "Unknown error",
      metrics: {
        durationMs: 0,
        model: params.model,
        provider: params.provider,
      },
    };
  }

  private async runOnce(params: EngineAgentRunParams): Promise<EngineAgentRunResult> {
    const startTime = Date.now();

    // Session file goes directly in phase directory (not in artifacts/sessions)
    // Path: ~/.clawdbot/workflows/<runId>/phases/<iteration>-<phaseId>/session.jsonl
    mkdirSync(this.phaseDir, { recursive: true });
    const sessionFile = params.sessionFilePath ?? join(this.phaseDir, "session.jsonl");

    // Map provider/model from AgentConfig conventions
    // "codex" maps to "openai" provider with gpt-5.1-codex model, "claude" maps to "anthropic"
    const provider = params.provider === "codex" ? "openai" : "anthropic";
    // Default models: claude-sonnet-4-5 for Anthropic, gpt-5.1-codex for OpenAI
    const model =
      params.model ?? (provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.1-codex");

    // Track last progress text to only report deltas
    let lastProgressText = "";

    try {
      const result: EmbeddedPiRunResult = await runEmbeddedPiAgent({
        sessionId: params.sessionId,
        sessionFile,
        workspaceDir: params.workspacePath,
        prompt: params.prompt,
        provider,
        model,
        timeoutMs: params.timeoutMs,
        runId: randomUUID(),
        abortSignal: params.abortSignal,
        // Pass policy-derived exec overrides for security enforcement
        execOverrides: this.execOverrides,
        onPartialReply: (payload) => {
          // onPartialReply receives cumulative text, so report only the delta
          if (payload.text && payload.text !== lastProgressText) {
            params.onProgress?.(payload.text);
            lastProgressText = payload.text;
          }
        },
      });

      // Use final payloads for output (not streaming chunks which are cumulative)
      let output = "";
      if (result.payloads) {
        const payloadTexts: string[] = [];
        for (const payload of result.payloads) {
          if (payload.text && !payload.isError) {
            payloadTexts.push(payload.text);
          }
        }
        output = payloadTexts.join("");
      }

      // Check for errors in result
      if (result.meta.error) {
        return {
          success: false,
          output,
          error: result.meta.error.message,
          metrics: {
            durationMs: result.meta.durationMs,
            model,
            provider,
          },
        };
      }

      return {
        success: true,
        output,
        metrics: {
          durationMs: result.meta.durationMs,
          tokens: result.meta.agentMeta?.usage
            ? {
                input: result.meta.agentMeta.usage.input ?? 0,
                output: result.meta.agentMeta.usage.output ?? 0,
              }
            : undefined,
          model,
          provider,
        },
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        metrics: {
          durationMs: Date.now() - startTime,
          model,
          provider,
        },
      };
    }
  }
}

// ============================================================================
// Policy-Aware Runner
// ============================================================================

/**
 * Callback for logging approval events.
 */
export type ApprovalEventLogger = (event: {
  phaseId: string;
  requestId: string;
  actionType: string;
  decision: "approved" | "denied" | "timeout";
  remember?: boolean;
  reason?: string;
}) => void;

/**
 * Options for policy-aware runner.
 */
export interface PolicyAwareRunnerOptions {
  /** The underlying runner to wrap */
  runner: EngineAgentRunner;

  /** Policy engine for evaluating actions */
  policyEngine: IPolicyEngine;

  /** Run ID for approval requests */
  runId: string;

  /** Phase ID for approval requests */
  phaseId: string;

  /** Timeout for approval requests in milliseconds (default: 60000) */
  approvalTimeoutMs?: number;

  /** Optional logger for approval events */
  onApprovalEvent?: ApprovalEventLogger;
}

/**
 * Runner that enforces policy checks before agent execution.
 * Wraps another runner and checks policy before delegating.
 * Blocks execution until approval is received for prompt decisions.
 */
export class PolicyAwareRunner implements EngineAgentRunner {
  private runner: EngineAgentRunner;
  private policyEngine: IPolicyEngine;
  private runId: string;
  private phaseId: string;
  private approvalTimeoutMs: number;
  private onApprovalEvent?: ApprovalEventLogger;

  constructor(options: PolicyAwareRunnerOptions) {
    this.runner = options.runner;
    this.policyEngine = options.policyEngine;
    this.runId = options.runId;
    this.phaseId = options.phaseId;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 60_000;
    this.onApprovalEvent = options.onApprovalEvent;
  }

  async run(params: EngineAgentRunParams): Promise<EngineAgentRunResult> {
    // Check policy for agent spawn
    const context: PolicyContext = {
      actionType: "agent_spawn",
      workspacePath: params.workspacePath,
      runId: this.runId,
      phaseId: this.phaseId,
      metadata: {
        sessionId: params.sessionId,
        model: params.model,
        provider: params.provider,
      },
    };

    const result = await this.policyEngine.evaluate(context);

    if (result.decision === "deny") {
      // Log denial
      this.onApprovalEvent?.({
        phaseId: this.phaseId,
        requestId: "policy-deny",
        actionType: context.actionType,
        decision: "denied",
        reason: result.reason,
      });

      return {
        success: false,
        output: "",
        error: `Policy denied agent spawn: ${result.reason}`,
        metrics: {
          durationMs: 0,
          model: params.model,
          provider: params.provider,
        },
      };
    }

    if (result.decision === "prompt") {
      // Request approval - this BLOCKS until user responds or timeout
      const request = createApprovalRequest(context, result.reason, {
        runId: this.runId,
        phaseId: this.phaseId,
        timeoutMs: this.approvalTimeoutMs,
      });

      const approval = await this.policyEngine.requestApproval(request);

      // Log approval event
      this.onApprovalEvent?.({
        phaseId: this.phaseId,
        requestId: request.id,
        actionType: context.actionType,
        decision: approval.decision,
        remember: approval.remember,
        reason: approval.comment,
      });

      if (approval.decision !== "approved") {
        const errorMessage =
          approval.decision === "timeout"
            ? `Agent spawn timed out waiting for approval (${this.approvalTimeoutMs}ms)`
            : `Agent spawn denied by user`;

        return {
          success: false,
          output: "",
          error: errorMessage,
          metrics: {
            durationMs: 0,
            model: params.model,
            provider: params.provider,
          },
        };
      }
    }

    // Policy allows - delegate to underlying runner
    return this.runner.run(params);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Options for creating a runner.
 */
export interface CreateRunnerOptions {
  /** Whether to use live agent execution */
  live: boolean;

  /** Directory to store session file (phase directory) - required for live mode */
  phaseDir?: string;

  /** Directory to store other artifacts */
  artifactsDir: string;

  /** Delay for stub runner (ms) */
  stubDelayMs?: number;

  /** Mock response for stub runner */
  mockResponse?: string;

  /** Workflow policy for exec security enforcement (live mode only) */
  policy?: WorkflowPolicy;

  /** Run ID for context */
  runId?: string;

  /** Phase ID for context */
  phaseId?: string;

  /** Policy engine for agent spawn approvals (live mode only) */
  policyEngine?: IPolicyEngine;

  /** Approval timeout in milliseconds */
  approvalTimeoutMs?: number;

  /** Callback for approval events (for observability) */
  onApprovalEvent?: ApprovalEventLogger;
}

/**
 * Create a runner based on live mode flag.
 * When policy is provided in live mode, exec security is enforced.
 * When policyEngine is provided, agent spawns require approval checks.
 */
export function createRunner(options: CreateRunnerOptions): EngineAgentRunner {
  if (options.live) {
    // phaseDir is required for live mode
    if (!options.phaseDir) {
      throw new Error("phaseDir is required for live mode");
    }
    // Create base live runner with exec security from policy
    const liveRunner = new LiveRunner({
      phaseDir: options.phaseDir,
      artifactsDir: options.artifactsDir,
      policy: options.policy,
      runId: options.runId,
      phaseId: options.phaseId,
    });

    // Wrap with PolicyAwareRunner if policy engine is provided
    if (options.policyEngine && options.runId && options.phaseId) {
      return new PolicyAwareRunner({
        runner: liveRunner,
        policyEngine: options.policyEngine,
        runId: options.runId,
        phaseId: options.phaseId,
        approvalTimeoutMs: options.approvalTimeoutMs,
        onApprovalEvent: options.onApprovalEvent,
      });
    }

    return liveRunner;
  }
  return new StubRunner({
    delayMs: options.stubDelayMs,
    mockResponse: options.mockResponse,
  });
}

/**
 * Generate a session ID for workflow agent runs.
 */
export function generateSessionId(runId: string, phaseId: string, iteration: number): string {
  return `wf-${runId}-${phaseId}-${iteration}`;
}

/**
 * Create a policy-aware runner that wraps an existing runner.
 */
export function createPolicyAwareRunner(options: {
  runner: EngineAgentRunner;
  policyEngine: IPolicyEngine;
  runId: string;
  phaseId: string;
}): PolicyAwareRunner {
  return new PolicyAwareRunner(options);
}

/**
 * Map AgentConfig to runner parameters.
 */
export function mapAgentConfigToRunnerParams(
  config: AgentConfig,
): Pick<EngineAgentRunParams, "provider" | "model"> {
  return {
    provider: config.type,
    model: config.model,
  };
}
