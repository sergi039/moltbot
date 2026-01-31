/**
 * Policy Runtime Wiring
 *
 * Creates and configures PolicyEngine for live workflow runs.
 * Integrates approval prompts, stores, and observability logging.
 */

import type { WorkflowLogger } from "../observability/logger.js";
import type { IPolicyEngine, WorkflowPolicy } from "./types.js";
import { PolicyEngine, createPolicyEngine } from "./engine.js";
import { CliApprovalPrompt } from "./prompt.js";
import { createApprovalStore, type IApprovalStore } from "./store.js";
import { DEFAULT_WORKFLOW_POLICY } from "./defaults.js";
import type { ApprovalEventLogger } from "../engines/runner.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a policy runtime.
 */
export interface PolicyRuntimeOptions {
  /** Workflow run ID */
  runId: string;

  /** Workspace path for path scope enforcement */
  workspacePath: string;

  /** Base directory for approval storage (usually workflow storage path) */
  storageBasePath: string;

  /** Custom policy (uses default if not provided) */
  policy?: WorkflowPolicy;

  /** Approval timeout in milliseconds (default: 60000) */
  approvalTimeoutMs?: number;

  /** WorkflowLogger for observability (optional) */
  logger?: WorkflowLogger;

  /** Enable CLI prompts (false for non-interactive mode) */
  interactive?: boolean;
}

/**
 * Policy runtime instance with all configured components.
 */
export interface PolicyRuntime {
  /** Configured policy engine */
  engine: IPolicyEngine;

  /** The workflow policy used */
  policy: WorkflowPolicy;

  /** Approval store for persistence */
  store: IApprovalStore;

  /** Approval event logger callback for runners */
  onApprovalEvent: ApprovalEventLogger;

  /** Configured timeout in milliseconds */
  approvalTimeoutMs: number;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Default approval timeout (1 minute).
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

/**
 * Create a fully configured policy runtime for a workflow run.
 *
 * This wires together:
 * - PolicyEngine with workspace path scope
 * - CliApprovalPrompt for interactive approval
 * - CompositeApprovalStore for persistence
 * - ApprovalEventLogger for observability
 */
export function createPolicyRuntime(options: PolicyRuntimeOptions): PolicyRuntime {
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  // Create approval store with composite (memory + file) backend
  const store = createApprovalStore({
    type: "composite",
    baseDir: options.storageBasePath,
  });

  // Create approval prompt (CLI or auto based on interactive flag)
  const approvalPrompt =
    options.interactive !== false
      ? new CliApprovalPrompt({
          timeoutMs: approvalTimeoutMs,
          showRisk: true,
          showCountdown: true,
          // Connect to logger for request events
          onApprovalRequested: (request, risk) => {
            options.logger?.logEvent({
              runId: options.runId,
              phaseId: request.phaseId,
              type: "policy.prompt",
              payload: {
                requestId: request.id,
                actionType: request.action.actionType,
                riskLevel: risk.level,
                riskScore: risk.score,
                reason: request.reason,
              },
            });
          },
          // Connect to logger for decision events
          onDecisionMade: (record) => {
            options.logger?.logApproval(
              record.request.phaseId,
              record.request.id,
              record.request.action.actionType,
              record.decision,
              record.remember,
            );
          },
        })
      : undefined;

  // Create policy engine
  const engine = createPolicyEngine({
    policy: options.policy ?? DEFAULT_WORKFLOW_POLICY,
    workspacePath: options.workspacePath,
    approvalPrompt,
    approvalStore: store,
  });

  // Create approval event logger callback for runners
  const onApprovalEvent: ApprovalEventLogger = (event) => {
    options.logger?.logApproval(
      event.phaseId,
      event.requestId,
      event.actionType,
      event.decision,
      event.remember,
    );
  };

  const policy = options.policy ?? DEFAULT_WORKFLOW_POLICY;

  return {
    engine,
    policy,
    store,
    onApprovalEvent,
    approvalTimeoutMs,
  };
}

/**
 * Create a minimal policy runtime for non-interactive/testing use.
 * Uses auto-deny for all prompts.
 */
export function createNonInteractivePolicyRuntime(options: {
  runId: string;
  workspacePath: string;
  storageBasePath: string;
  policy?: WorkflowPolicy;
}): PolicyRuntime {
  const store = createApprovalStore({
    type: "memory",
  });

  const policy = options.policy ?? DEFAULT_WORKFLOW_POLICY;

  const engine = createPolicyEngine({
    policy,
    workspacePath: options.workspacePath,
    approvalStore: store,
    // No prompt = auto-deny
  });

  return {
    engine,
    policy,
    store,
    onApprovalEvent: () => {}, // No-op for non-interactive
    approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
  };
}
