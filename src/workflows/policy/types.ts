/**
 * Policy Engine Types
 *
 * Defines types for workflow policy enforcement, approval flows,
 * and sandbox path scoping.
 */

// ============================================================================
// Policy Decisions
// ============================================================================

/**
 * Possible outcomes of a policy evaluation.
 */
export type PolicyDecision = "allow" | "deny" | "prompt";

/**
 * Types of actions that policies can govern.
 */
export type PolicyActionType =
  | "file_read"
  | "file_write"
  | "file_delete"
  | "bash_execute"
  | "network_request"
  | "agent_spawn";

/**
 * Context provided to policy evaluation.
 */
export interface PolicyContext {
  /** The type of action being evaluated */
  actionType: PolicyActionType;

  /** Target path for file operations */
  targetPath?: string;

  /** Command for bash operations */
  command?: string;

  /** URL for network operations */
  url?: string;

  /** Current workspace path */
  workspacePath: string;

  /** Workflow run ID */
  runId: string;

  /** Current phase ID */
  phaseId: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of policy evaluation.
 */
export interface PolicyResult {
  /** The decision */
  decision: PolicyDecision;

  /** Rule that matched (if any) */
  matchedRule?: PolicyRule;

  /** Reason for the decision */
  reason: string;

  /** Whether to log this action */
  shouldLog: boolean;
}

// ============================================================================
// Policy Rules
// ============================================================================

/**
 * A single policy rule that can match actions.
 */
export interface PolicyRule {
  /** Unique rule ID */
  id: string;

  /** Human-readable name */
  name: string;

  /** Action types this rule applies to */
  actions: PolicyActionType[];

  /** Decision when rule matches */
  decision: PolicyDecision;

  /** Optional path patterns (glob) for file operations */
  pathPatterns?: string[];

  /** Optional command patterns (regex) for bash operations */
  commandPatterns?: string[];

  /** Optional URL patterns (glob) for network operations */
  urlPatterns?: string[];

  /** Priority (higher = evaluated first) */
  priority: number;

  /** Whether this rule is enabled */
  enabled: boolean;

  /** Description of why this rule exists */
  description?: string;
}

// ============================================================================
// Path Scoping
// ============================================================================

/**
 * Path scope configuration for sandbox enforcement.
 */
export type PathScopeType = "workspaceOnly" | "tempOnly" | "workspaceAndTemp" | "custom";

/**
 * Path scope configuration.
 */
export interface PathScope {
  /** Scope type */
  type: PathScopeType;

  /** Allowed paths (absolute) - used when type is "custom" */
  allowedPaths?: string[];

  /** Denied paths (absolute) - always blocked regardless of scope */
  deniedPaths?: string[];

  /** Block symlink escape attempts (resolve symlinks and verify target). Default: true */
  blockSymlinkEscape?: boolean;
}

// ============================================================================
// Network Scoping
// ============================================================================

/**
 * Network scope configuration for controlling outbound requests.
 */
export interface NetworkScope {
  /** Default behavior for network requests: "allow" or "deny". Default: "deny" */
  defaultBehavior: "allow" | "deny";

  /** Allowed domain patterns (glob syntax: *.example.com, api.github.com) */
  allowedDomains?: string[];

  /** Allowed URL patterns (glob syntax) */
  allowedUrls?: string[];

  /** Explicitly denied domains (checked first, even if in allowedDomains) */
  deniedDomains?: string[];
}

// ============================================================================
// Approvals
// ============================================================================

/**
 * A request for user approval.
 */
export interface ApprovalRequest {
  /** Unique request ID */
  id: string;

  /** Workflow run ID */
  runId: string;

  /** Phase ID where approval was requested */
  phaseId: string;

  /** Action that triggered the approval request */
  action: PolicyContext;

  /** Reason approval is needed */
  reason: string;

  /** When the request was created */
  createdAt: number;

  /** Timeout for approval (ms) */
  timeoutMs: number;
}

/**
 * User's decision on an approval request.
 */
export type ApprovalDecision = "approved" | "denied" | "timeout";

/**
 * Record of an approval decision.
 */
export interface ApprovalRecord {
  /** The original request */
  request: ApprovalRequest;

  /** User's decision */
  decision: ApprovalDecision;

  /** When the decision was made */
  decidedAt: number;

  /** Whether to remember this decision for similar actions */
  remember: boolean;

  /** Scope of remembering (if remember=true) */
  rememberScope?: "run" | "session" | "permanent";

  /** Optional user comment */
  comment?: string;
}

// ============================================================================
// Workflow Policy Configuration
// ============================================================================

/**
 * Complete policy configuration for a workflow.
 */
export interface WorkflowPolicy {
  /** Policy version for compatibility */
  version: "1.0";

  /** Path scope settings */
  pathScope: PathScope;

  /** Network scope settings (optional, default: deny all) */
  networkScope?: NetworkScope;

  /** Custom rules (evaluated in priority order) */
  rules: PolicyRule[];

  /** Default decision when no rule matches */
  defaultDecision: PolicyDecision;

  /** Whether to require approval for destructive operations */
  requireApprovalForDestructive: boolean;

  /** Actions considered destructive */
  destructiveActions: PolicyActionType[];

  /** Logging settings */
  logging: {
    /** Log all policy evaluations */
    logAll: boolean;
    /** Log only denials */
    logDenials: boolean;
    /** Log approvals */
    logApprovals: boolean;
  };
}

// ============================================================================
// Policy Engine Interface
// ============================================================================

/**
 * Interface for policy engine implementations.
 */
export interface IPolicyEngine {
  /**
   * Evaluate an action against the policy.
   */
  evaluate(context: PolicyContext): Promise<PolicyResult>;

  /**
   * Request user approval for an action.
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalRecord>;

  /**
   * Check if an action was previously approved.
   */
  checkPreviousApproval(context: PolicyContext): Promise<ApprovalRecord | null>;

  /**
   * Get all approval records for a run.
   */
  getApprovalHistory(runId: string): Promise<ApprovalRecord[]>;
}

/**
 * Interface for approval prompt implementations.
 */
export interface IApprovalPrompt {
  /**
   * Show approval prompt to user and get decision.
   */
  prompt(request: ApprovalRequest): Promise<ApprovalRecord>;
}
