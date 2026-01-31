/**
 * Policy Engine
 *
 * Evaluates actions against workflow policies and manages approvals.
 */

import { resolve, relative } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import type {
  IPolicyEngine,
  IApprovalPrompt,
  PolicyContext,
  PolicyResult,
  PolicyRule,
  WorkflowPolicy,
  ApprovalRequest,
  ApprovalRecord,
  PathScope,
  NetworkScope,
} from "./types.js";
import type { IApprovalStore } from "./store.js";
import { DEFAULT_WORKFLOW_POLICY } from "./defaults.js";

// ============================================================================
// Simple Glob Matching
// ============================================================================

/**
 * Simple glob pattern matching (no external dependency).
 * Supports: *, **, ?
 */
function globMatch(pattern: string, str: string): boolean {
  // Escape regex special chars except * and ?
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // Convert ** to match any path
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    // Convert * to match anything except /
    .replace(/\*/g, "[^/]*")
    // Convert ? to match single char except /
    .replace(/\?/g, "[^/]")
    // Restore globstar
    .replace(/<<<GLOBSTAR>>>/g, ".*");

  // Anchor the pattern
  regexStr = `^${regexStr}$`;

  try {
    const regex = new RegExp(regexStr);
    return regex.test(str);
  } catch {
    return false;
  }
}

// ============================================================================
// Path Guard (Application-Level Sandbox)
// ============================================================================

/**
 * PathGuard enforces path-based access control at the application level.
 * Includes symlink escape detection to prevent sandbox bypass.
 */
export class PathGuard {
  private workspacePath: string;
  private tempPath: string;
  private scope: PathScope;
  private blockSymlinkEscape: boolean;

  constructor(workspacePath: string, scope: PathScope, tempPath?: string) {
    this.workspacePath = resolve(workspacePath);
    this.tempPath = tempPath ?? resolve("/tmp");
    this.scope = scope;
    // Default to true for security (block symlink escapes unless explicitly disabled)
    this.blockSymlinkEscape = scope.blockSymlinkEscape !== false;
  }

  /**
   * Check if a path is allowed by the scope.
   */
  isAllowed(targetPath: string): { allowed: boolean; reason: string } {
    const absPath = this.normalizePath(targetPath);

    // Check denied paths first (always block)
    if (this.scope.deniedPaths) {
      for (const denied of this.scope.deniedPaths) {
        const deniedAbs = this.normalizePath(denied);
        if (absPath.startsWith(deniedAbs) || globMatch(deniedAbs, absPath)) {
          return { allowed: false, reason: `Path is in denied list: ${denied}` };
        }
      }
    }

    // Check scope type
    let scopeAllowed = false;
    switch (this.scope.type) {
      case "workspaceOnly":
        if (!absPath.startsWith(this.workspacePath)) {
          return {
            allowed: false,
            reason: `Path outside workspace: ${this.workspacePath}`,
          };
        }
        scopeAllowed = true;
        break;

      case "tempOnly":
        if (!absPath.startsWith(this.tempPath)) {
          return {
            allowed: false,
            reason: `Path outside temp directory: ${this.tempPath}`,
          };
        }
        scopeAllowed = true;
        break;

      case "workspaceAndTemp":
        if (!absPath.startsWith(this.workspacePath) && !absPath.startsWith(this.tempPath)) {
          return {
            allowed: false,
            reason: `Path outside workspace and temp: ${this.workspacePath}, ${this.tempPath}`,
          };
        }
        scopeAllowed = true;
        break;

      case "custom":
        if (this.scope.allowedPaths) {
          const isInAllowed = this.scope.allowedPaths.some((allowed) => {
            const allowedAbs = this.normalizePath(allowed);
            return absPath.startsWith(allowedAbs) || globMatch(allowedAbs, absPath);
          });
          if (!isInAllowed) {
            return {
              allowed: false,
              reason: `Path not in allowed list`,
            };
          }
          scopeAllowed = true;
        }
        break;
    }

    // Symlink escape detection: resolve actual path and verify it's still in scope
    if (scopeAllowed && this.blockSymlinkEscape) {
      const symlinkCheck = this.checkSymlinkEscape(absPath);
      if (!symlinkCheck.allowed) {
        return symlinkCheck;
      }
    }

    return { allowed: true, reason: "Path is within allowed scope" };
  }

  /**
   * Check if a path attempts to escape the sandbox via symlinks.
   * Resolves the real path and verifies it's still within allowed scope.
   */
  private checkSymlinkEscape(absPath: string): { allowed: boolean; reason: string } {
    try {
      // Resolve symlinks to get real path
      const realPath = realpathSync(absPath);

      // If realPath is different, verify the resolved path is in scope
      if (realPath !== absPath) {
        // Re-check the real path against scope (without symlink check to avoid recursion)
        const realPathAllowed = this.isRealPathInScope(realPath);
        if (!realPathAllowed) {
          return {
            allowed: false,
            reason: `Symlink escape detected: ${absPath} -> ${realPath} (outside allowed scope)`,
          };
        }
      }

      return { allowed: true, reason: "No symlink escape detected" };
    } catch {
      // Path doesn't exist yet (creating new file) - allow if scope check passed
      // This is safe because we already checked the target path is in scope
      return { allowed: true, reason: "Path does not exist (new file)" };
    }
  }

  /**
   * Check if a resolved real path is within allowed scope.
   * Used for symlink escape detection (no recursion).
   */
  private isRealPathInScope(realPath: string): boolean {
    switch (this.scope.type) {
      case "workspaceOnly":
        return realPath.startsWith(this.workspacePath);

      case "tempOnly":
        return realPath.startsWith(this.tempPath);

      case "workspaceAndTemp":
        return realPath.startsWith(this.workspacePath) || realPath.startsWith(this.tempPath);

      case "custom":
        if (this.scope.allowedPaths) {
          return this.scope.allowedPaths.some((allowed) => {
            const allowedAbs = this.normalizePath(allowed);
            return realPath.startsWith(allowedAbs);
          });
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Normalize a path, expanding ~ and resolving to absolute.
   */
  private normalizePath(path: string): string {
    if (path.startsWith("~")) {
      path = path.replace(/^~/, homedir());
    }
    return resolve(path);
  }

  /**
   * Get relative path from workspace (for logging).
   */
  getRelativePath(targetPath: string): string {
    const absPath = this.normalizePath(targetPath);
    if (absPath.startsWith(this.workspacePath)) {
      return relative(this.workspacePath, absPath) || ".";
    }
    return absPath;
  }
}

// ============================================================================
// Network Guard
// ============================================================================

/**
 * NetworkGuard enforces network access control.
 * Default deny for all outbound requests unless explicitly allowed.
 */
export class NetworkGuard {
  private scope: NetworkScope;

  constructor(scope?: NetworkScope) {
    // Default to deny-all if no scope provided
    this.scope = scope ?? {
      defaultBehavior: "deny",
      allowedDomains: [],
      allowedUrls: [],
      deniedDomains: [],
    };
  }

  /**
   * Check if a URL is allowed by the network scope.
   */
  isAllowed(urlString: string): { allowed: boolean; reason: string } {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      return { allowed: false, reason: `Invalid URL: ${urlString}` };
    }

    const hostname = url.hostname.toLowerCase();

    // Check denied domains first (always block)
    if (this.scope.deniedDomains) {
      for (const denied of this.scope.deniedDomains) {
        if (this.domainMatches(hostname, denied)) {
          return { allowed: false, reason: `Domain is in denied list: ${denied}` };
        }
      }
    }

    // Check allowed URLs (exact pattern match)
    if (this.scope.allowedUrls) {
      for (const pattern of this.scope.allowedUrls) {
        if (globMatch(pattern, urlString)) {
          return { allowed: true, reason: `URL matches allowed pattern: ${pattern}` };
        }
      }
    }

    // Check allowed domains
    if (this.scope.allowedDomains) {
      for (const allowed of this.scope.allowedDomains) {
        if (this.domainMatches(hostname, allowed)) {
          return { allowed: true, reason: `Domain matches allowed pattern: ${allowed}` };
        }
      }
    }

    // Apply default behavior
    if (this.scope.defaultBehavior === "allow") {
      return { allowed: true, reason: "Default behavior is allow" };
    }

    return {
      allowed: false,
      reason: `Network request to ${hostname} not in allowlist (default deny)`,
    };
  }

  /**
   * Check if a hostname matches a domain pattern.
   * Supports:
   * - Exact match: "api.github.com"
   * - Wildcard subdomain: "*.github.com" (matches any subdomain)
   * - Root wildcard: "*.com" (matches any .com domain)
   */
  private domainMatches(hostname: string, pattern: string): boolean {
    const normalizedPattern = pattern.toLowerCase();

    // Exact match
    if (hostname === normalizedPattern) {
      return true;
    }

    // Wildcard subdomain pattern: *.example.com
    if (normalizedPattern.startsWith("*.")) {
      const baseDomain = normalizedPattern.slice(2); // Remove "*."

      // Match exact base domain or any subdomain
      if (hostname === baseDomain) {
        return true;
      }
      if (hostname.endsWith(`.${baseDomain}`)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the configured network scope.
   */
  getScope(): NetworkScope {
    return this.scope;
  }
}

// ============================================================================
// Policy Engine
// ============================================================================

/**
 * Policy engine that evaluates actions against configured policies.
 */
export class PolicyEngine implements IPolicyEngine {
  private policy: WorkflowPolicy;
  private pathGuard: PathGuard;
  private networkGuard: NetworkGuard;
  private approvalPrompt?: IApprovalPrompt;
  private approvalStore?: IApprovalStore;
  private approvalCache: Map<string, ApprovalRecord>;
  private approvalHistory: ApprovalRecord[];

  constructor(options: {
    policy?: WorkflowPolicy;
    workspacePath: string;
    tempPath?: string;
    approvalPrompt?: IApprovalPrompt;
    approvalStore?: IApprovalStore;
  }) {
    this.policy = options.policy ?? DEFAULT_WORKFLOW_POLICY;
    this.pathGuard = new PathGuard(options.workspacePath, this.policy.pathScope, options.tempPath);
    this.networkGuard = new NetworkGuard(this.policy.networkScope);
    this.approvalPrompt = options.approvalPrompt;
    this.approvalStore = options.approvalStore;
    this.approvalCache = new Map();
    this.approvalHistory = [];
  }

  /**
   * Evaluate an action against the policy.
   */
  async evaluate(context: PolicyContext): Promise<PolicyResult> {
    // Check path scope for file operations
    if (context.targetPath && this.isFileAction(context.actionType)) {
      const pathCheck = this.pathGuard.isAllowed(context.targetPath);
      if (!pathCheck.allowed) {
        return {
          decision: "deny",
          reason: pathCheck.reason,
          shouldLog: this.policy.logging.logDenials,
        };
      }
    }

    // Check network scope for network operations (pre-rule check for early denial)
    if (context.url && context.actionType === "network_request") {
      const networkCheck = this.networkGuard.isAllowed(context.url);
      if (!networkCheck.allowed) {
        return {
          decision: "deny",
          reason: networkCheck.reason,
          shouldLog: this.policy.logging.logDenials,
        };
      }
    }

    // Find matching rule (highest priority first)
    const sortedRules = [...this.policy.rules]
      .filter((r) => r.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (this.ruleMatches(rule, context)) {
        return {
          decision: rule.decision,
          matchedRule: rule,
          reason: rule.description ?? `Matched rule: ${rule.name}`,
          shouldLog: this.shouldLog(rule.decision),
        };
      }
    }

    // No rule matched - use default decision
    return {
      decision: this.policy.defaultDecision,
      reason: "No matching rule found, using default decision",
      shouldLog: this.shouldLog(this.policy.defaultDecision),
    };
  }

  /**
   * Request user approval for an action.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalRecord> {
    // Check cache first
    const cacheKey = this.getCacheKey(request.action);
    const cached = this.approvalCache.get(cacheKey);
    if (cached && cached.remember) {
      return cached;
    }

    // Check store for remembered approval
    if (this.approvalStore) {
      const storedMatch = await this.approvalStore.findMatching(request);
      if (storedMatch && storedMatch.remember) {
        // Cache it for faster access
        this.approvalCache.set(cacheKey, storedMatch);
        return storedMatch;
      }
    }

    // No prompt handler - auto-deny
    if (!this.approvalPrompt) {
      const record: ApprovalRecord = {
        request,
        decision: "denied",
        decidedAt: Date.now(),
        remember: false,
        comment: "No approval prompt handler configured",
      };
      this.approvalHistory.push(record);
      // Persist to store
      if (this.approvalStore) {
        await this.approvalStore.save(record);
      }
      return record;
    }

    // Show prompt and get decision
    const record = await this.approvalPrompt.prompt(request);

    // Cache if requested
    if (record.remember) {
      this.approvalCache.set(cacheKey, record);
    }

    // Store in history
    this.approvalHistory.push(record);

    // Persist to store
    if (this.approvalStore) {
      await this.approvalStore.save(record);
    }

    return record;
  }

  /**
   * Check if an action was previously approved.
   */
  async checkPreviousApproval(context: PolicyContext): Promise<ApprovalRecord | null> {
    const cacheKey = this.getCacheKey(context);
    return this.approvalCache.get(cacheKey) ?? null;
  }

  /**
   * Get all approval records for a run.
   */
  async getApprovalHistory(runId: string): Promise<ApprovalRecord[]> {
    return this.approvalHistory.filter((r) => r.request.runId === runId);
  }

  /**
   * Clear approval cache (for testing or reset).
   */
  clearCache(): void {
    this.approvalCache.clear();
  }

  /**
   * Get path guard instance (for external use).
   */
  getPathGuard(): PathGuard {
    return this.pathGuard;
  }

  /**
   * Get network guard instance (for external use).
   */
  getNetworkGuard(): NetworkGuard {
    return this.networkGuard;
  }

  // ==========================================================================
  // Rule Matching
  // ==========================================================================

  private ruleMatches(rule: PolicyRule, context: PolicyContext): boolean {
    // Check action type
    if (!rule.actions.includes(context.actionType)) {
      return false;
    }

    // Check path patterns for file operations
    if (context.targetPath && rule.pathPatterns) {
      const relativePath = this.pathGuard.getRelativePath(context.targetPath);
      const matchesPattern = rule.pathPatterns.some(
        (pattern) => globMatch(pattern, relativePath) || globMatch(pattern, context.targetPath!),
      );
      if (!matchesPattern) {
        return false;
      }
    }

    // Check command patterns for bash operations
    if (context.command && rule.commandPatterns) {
      const matchesCommand = rule.commandPatterns.some((pattern) => {
        const regex = new RegExp(pattern);
        return regex.test(context.command!);
      });
      if (!matchesCommand) {
        return false;
      }
    }

    // Check URL patterns for network operations
    if (context.url && rule.urlPatterns) {
      const matchesUrl = rule.urlPatterns.some((pattern) => globMatch(pattern, context.url!));
      if (!matchesUrl) {
        return false;
      }
    }

    return true;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private isFileAction(action: string): boolean {
    return action === "file_read" || action === "file_write" || action === "file_delete";
  }

  private shouldLog(decision: string): boolean {
    if (this.policy.logging.logAll) return true;
    if (decision === "deny" && this.policy.logging.logDenials) return true;
    if (decision === "prompt" && this.policy.logging.logApprovals) return true;
    return false;
  }

  private getCacheKey(context: PolicyContext): string {
    // Create a unique key based on action type and target
    const parts: string[] = [context.actionType];

    if (context.targetPath) {
      // Normalize path for consistent caching
      parts.push(`path:${context.targetPath}`);
    }
    if (context.command) {
      // Use command prefix for caching (first 50 chars)
      parts.push(`cmd:${context.command.slice(0, 50)}`);
    }
    if (context.url) {
      // Use URL origin for caching
      try {
        const url = new URL(context.url);
        parts.push(`url:${url.origin}`);
      } catch {
        parts.push(`url:${context.url}`);
      }
    }

    return parts.join("|");
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a policy engine with default configuration.
 */
export function createPolicyEngine(options: {
  policy?: WorkflowPolicy;
  workspacePath: string;
  tempPath?: string;
  approvalPrompt?: IApprovalPrompt;
  approvalStore?: IApprovalStore;
}): PolicyEngine {
  return new PolicyEngine(options);
}
