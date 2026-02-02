/**
 * Policy Module
 *
 * Exports all policy-related types, engines, and utilities.
 */

// Types
export type {
  PolicyDecision,
  PolicyActionType,
  PolicyContext,
  PolicyResult,
  PolicyRule,
  PathScopeType,
  PathScope,
  NetworkScope,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalRecord,
  WorkflowPolicy,
  IPolicyEngine,
  IApprovalPrompt,
} from "./types.js";

// Engine
export { PolicyEngine, PathGuard, NetworkGuard, createPolicyEngine } from "./engine.js";

// Defaults
export {
  DEFAULT_PATH_SCOPE,
  DEFAULT_NETWORK_SCOPE,
  DEFAULT_RULES,
  DEFAULT_WORKFLOW_POLICY,
  STRICT_POLICY,
  PERMISSIVE_POLICY,
  getPolicyPreset,
  mergePolicy,
} from "./defaults.js";

// Store
export type { IApprovalStore } from "./store.js";
export {
  InMemoryApprovalStore,
  FileApprovalStore,
  CompositeApprovalStore,
  createApprovalStore,
} from "./store.js";

// Prompt
export {
  CliApprovalPrompt,
  AutoApprovePrompt,
  BatchApprovalPrompt,
  createApprovalPrompt,
  createApprovalRequest,
} from "./prompt.js";

// Hooks (policy-to-exec bridge)
export type {
  PolicyExecOverrides,
  DeriveExecOverridesOptions,
  PolicyExecMapping,
} from "./hooks.js";
export {
  deriveExecOverrides,
  createDenyAllExecOverrides,
  createAllowAllExecOverrides,
  createPromptAllExecOverrides,
  validatePolicyExecConfig,
} from "./hooks.js";

// Risk assessment
export type { RiskLevel, RiskAssessment, RiskFactor } from "./risk.js";
export { assessRisk, getRiskLevelColor, getRiskLevelLabel } from "./risk.js";
