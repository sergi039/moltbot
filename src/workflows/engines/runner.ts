/**
 * Engine Agent Runner
 *
 * Abstraction layer for running agents within workflow engines.
 * Provides both stub (for testing/non-live mode) and live (real agent) implementations.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { AgentConfig } from "../types.js";
import { runEmbeddedPiAgent, type EmbeddedPiRunResult } from "../../agents/pi-embedded.js";

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
 * Live runner that wraps runEmbeddedPiAgent for real agent execution.
 */
export class LiveRunner implements EngineAgentRunner {
  private artifactsDir: string;

  constructor(options: { artifactsDir: string }) {
    this.artifactsDir = options.artifactsDir;
  }

  async run(params: EngineAgentRunParams): Promise<EngineAgentRunResult> {
    const startTime = Date.now();

    // Ensure session directory exists
    const sessionDir = join(this.artifactsDir, "sessions");
    mkdirSync(sessionDir, { recursive: true });

    // Create session file path
    const sessionFile = params.sessionFilePath ?? join(sessionDir, `${params.sessionId}.jsonl`);

    // Map provider/model from AgentConfig conventions
    // "codex" maps to "openai-codex" (OAuth provider), "claude" stays as-is
    const provider = params.provider === "codex" ? "openai-codex" : "claude";
    // Default models: claude-sonnet-4 for Claude, gpt-5.1-codex for Codex
    const model = params.model ?? (provider === "claude" ? "claude-sonnet-4" : "gpt-5.1-codex");

    // Collect output from streaming
    const outputChunks: string[] = [];

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
        onPartialReply: (payload) => {
          if (payload.text) {
            outputChunks.push(payload.text);
            params.onProgress?.(payload.text);
          }
        },
      });

      // Collect final output from payloads
      if (result.payloads) {
        for (const payload of result.payloads) {
          if (payload.text && !payload.isError) {
            outputChunks.push(payload.text);
          }
        }
      }

      const output = outputChunks.join("");

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
        output: outputChunks.join(""),
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
// Factory Functions
// ============================================================================

/**
 * Create a runner based on live mode flag.
 */
export function createRunner(options: {
  live: boolean;
  artifactsDir: string;
  stubDelayMs?: number;
  mockResponse?: string;
}): EngineAgentRunner {
  if (options.live) {
    return new LiveRunner({ artifactsDir: options.artifactsDir });
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
