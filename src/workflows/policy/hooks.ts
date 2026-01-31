/**
 * Policy Hooks
 *
 * Bridges WorkflowPolicy to agent runtime security controls.
 * Provides execOverrides for runEmbeddedPiAgent based on policy configuration.
 */

import type { ExecAsk, ExecSecurity } from "../../infra/exec-approvals.js";
import type { ExecToolDefaults } from "../../agents/bash-tools.exec.js";
import type { WorkflowPolicy, PolicyActionType, PolicyDecision, PolicyRule } from "./types.js";
import { DEFAULT_WORKFLOW_POLICY } from "./defaults.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Exec overrides derived from workflow policy.
 */
export type PolicyExecOverrides = Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;

/**
 * Options for deriving exec overrides.
 */
export interface DeriveExecOverridesOptions {
  /** The workflow policy to apply */
  policy?: WorkflowPolicy;

  /** Workspace path for path-based rules */
  workspacePath?: string;

  /** Phase ID for logging */
  phaseId?: string;

  /** Run ID for logging */
  runId?: string;
}

/**
 * Result of policy-to-exec mapping.
 */
export interface PolicyExecMapping {
  /** Derived exec overrides */
  overrides: PolicyExecOverrides;

  /** Security mode derived from policy */
  security: ExecSecurity;

  /** Ask mode derived from policy */
  ask: ExecAsk;

  /** Whether shell commands are allowed */
  shellAllowed: boolean;

  /** Whether network requests are allowed */
  networkAllowed: boolean;

  /** Reason for the configuration */
  reason: string;
}

// ============================================================================
// Decision Mapping
// ============================================================================

/**
 * Map PolicyDecision to ExecSecurity.
 *
 * - "allow" → "full" (no restrictions)
 * - "prompt" → "allowlist" (require approval for non-allowlisted)
 * - "deny" → "deny" (block all)
 */
function decisionToSecurity(decision: PolicyDecision): ExecSecurity {
  switch (decision) {
    case "allow":
      return "full";
    case "prompt":
      return "allowlist";
    case "deny":
      return "deny";
    default:
      return "deny";
  }
}

/**
 * Map PolicyDecision to ExecAsk.
 *
 * - "allow" → "off" (no prompting)
 * - "prompt" → "always" (always prompt)
 * - "deny" → "off" (no prompting, just deny)
 */
function decisionToAsk(decision: PolicyDecision): ExecAsk {
  switch (decision) {
    case "allow":
      return "off";
    case "prompt":
      return "always";
    case "deny":
      return "off";
    default:
      return "off";
  }
}

// ============================================================================
// Rule Analysis
// ============================================================================

/**
 * Check if a rule is a catch-all rule (no patterns to filter on).
 * Catch-all rules affect the overall security posture.
 * Rules with patterns only affect specific commands/paths/URLs at runtime.
 */
function isCatchAllRule(rule: PolicyRule): boolean {
  return !rule.commandPatterns?.length && !rule.pathPatterns?.length && !rule.urlPatterns?.length;
}

/**
 * Find the highest-priority catch-all rule for a given action type.
 * Catch-all rules (without patterns) define the overall security posture.
 * Rules with patterns are evaluated at runtime for specific commands.
 */
function findCatchAllRuleForAction(
  policy: WorkflowPolicy,
  actionType: PolicyActionType,
): PolicyRule | null {
  const applicableRules = policy.rules
    .filter((rule) => rule.enabled && rule.actions.includes(actionType) && isCatchAllRule(rule))
    .sort((a, b) => b.priority - a.priority);

  return applicableRules[0] ?? null;
}

/**
 * Find the highest-priority rule for a given action type (any rule).
 */
function findRuleForAction(
  policy: WorkflowPolicy,
  actionType: PolicyActionType,
): PolicyRule | null {
  const applicableRules = policy.rules
    .filter((rule) => rule.enabled && rule.actions.includes(actionType))
    .sort((a, b) => b.priority - a.priority);

  return applicableRules[0] ?? null;
}

/**
 * Get the effective decision for an action type.
 * Uses the highest-priority catch-all rule, or falls back to default decision.
 * Rules with patterns are not considered as they only apply to specific cases.
 */
function getEffectiveDecision(
  policy: WorkflowPolicy,
  actionType: PolicyActionType,
): PolicyDecision {
  const rule = findCatchAllRuleForAction(policy, actionType);
  return rule?.decision ?? policy.defaultDecision;
}

/**
 * Check if an action type is destructive according to policy.
 */
function isDestructiveAction(policy: WorkflowPolicy, actionType: PolicyActionType): boolean {
  return policy.destructiveActions.includes(actionType);
}

// ============================================================================
// Exec Overrides Derivation
// ============================================================================

/**
 * Derive exec overrides from a workflow policy.
 *
 * This bridges the workflow policy system to the exec tool's security model:
 * - Evaluates bash_execute rules to determine security/ask modes
 * - Considers destructive action settings
 * - Provides a unified security posture for agent execution
 */
export function deriveExecOverrides(options: DeriveExecOverridesOptions): PolicyExecMapping {
  const policy = options.policy ?? DEFAULT_WORKFLOW_POLICY;

  // Get effective decision for shell execution
  const bashDecision = getEffectiveDecision(policy, "bash_execute");
  const bashRule = findCatchAllRuleForAction(policy, "bash_execute");

  // Determine base security from bash_execute decision
  let security = decisionToSecurity(bashDecision);
  let ask = decisionToAsk(bashDecision);

  // If bash_execute is destructive and requireApprovalForDestructive is true,
  // force prompt mode even if rules allow
  if (isDestructiveAction(policy, "bash_execute") && policy.requireApprovalForDestructive) {
    if (security === "full") {
      security = "allowlist";
      ask = "always";
    }
  }

  // Check network_request decision for overall network allowance
  const networkDecision = getEffectiveDecision(policy, "network_request");
  const networkAllowed = networkDecision !== "deny";

  // Determine shell allowance
  const shellAllowed = bashDecision !== "deny";

  // Build reason string
  const reasonParts: string[] = [];
  if (bashRule) {
    reasonParts.push(`bash_execute rule "${bashRule.name}" → ${bashDecision}`);
  } else {
    reasonParts.push(`default decision → ${bashDecision}`);
  }
  if (policy.requireApprovalForDestructive && isDestructiveAction(policy, "bash_execute")) {
    reasonParts.push("destructive action approval required");
  }

  return {
    overrides: {
      host: "gateway",
      security,
      ask,
      node: undefined,
    },
    security,
    ask,
    shellAllowed,
    networkAllowed,
    reason: reasonParts.join("; "),
  };
}

/**
 * Create exec overrides that deny all shell execution.
 * Used when policy completely blocks bash_execute.
 */
export function createDenyAllExecOverrides(): PolicyExecOverrides {
  return {
    host: "gateway",
    security: "deny",
    ask: "off",
    node: undefined,
  };
}

/**
 * Create exec overrides that allow all shell execution.
 * Used for permissive policies or when policy is not enforced.
 */
export function createAllowAllExecOverrides(): PolicyExecOverrides {
  return {
    host: "gateway",
    security: "full",
    ask: "off",
    node: undefined,
  };
}

/**
 * Create exec overrides that require approval for all commands.
 * Used for strict policies with mandatory prompting.
 */
export function createPromptAllExecOverrides(): PolicyExecOverrides {
  return {
    host: "gateway",
    security: "allowlist",
    ask: "always",
    node: undefined,
  };
}

// ============================================================================
// Policy Validation
// ============================================================================

/**
 * Validate that a policy has sensible exec-related configuration.
 * Returns warnings for potentially problematic configurations.
 */
export function validatePolicyExecConfig(policy: WorkflowPolicy): string[] {
  const warnings: string[] = [];

  // Check for conflicting rules
  const bashRules = policy.rules.filter((r) => r.enabled && r.actions.includes("bash_execute"));

  if (bashRules.length > 1) {
    const decisions = new Set(bashRules.map((r) => r.decision));
    if (decisions.size > 1) {
      warnings.push(
        "Multiple bash_execute rules with different decisions; highest priority will be used",
      );
    }
  }

  // Check for deny-all with no escape
  if (policy.defaultDecision === "deny") {
    const hasAllowRule = policy.rules.some(
      (r) => r.enabled && r.decision === "allow" && r.actions.includes("bash_execute"),
    );
    if (!hasAllowRule) {
      warnings.push(
        "Default decision is deny with no allow rules for bash_execute; all commands will be blocked",
      );
    }
  }

  return warnings;
}

// ============================================================================
// Exports
// ============================================================================

export type { ExecAsk, ExecSecurity };
