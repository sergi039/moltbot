/**
 * Default Policy Configuration
 *
 * Provides sensible default policies for workflow execution.
 * These can be overridden by user configuration.
 */

import type { WorkflowPolicy, PolicyRule, PathScope, NetworkScope } from "./types.js";

// ============================================================================
// Default Path Scope
// ============================================================================

/**
 * Default path scope: workspace and temp directories only.
 */
export const DEFAULT_PATH_SCOPE: PathScope = {
  type: "workspaceAndTemp",
  deniedPaths: [
    // System directories
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    // User sensitive directories
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.config/gcloud",
    // Package managers (global)
    "/usr/local",
    "/opt/homebrew",
  ],
  // Block symlink escape attempts by default
  blockSymlinkEscape: true,
};

// ============================================================================
// Default Network Scope
// ============================================================================

/**
 * Default network scope: deny all except common trusted domains.
 * More restrictive than rules - enforced before rule evaluation.
 */
export const DEFAULT_NETWORK_SCOPE: NetworkScope = {
  defaultBehavior: "deny",
  allowedDomains: [
    // Package registries
    "registry.npmjs.org",
    "*.npmjs.com",
    "pypi.org",
    "*.pypi.org",
    "crates.io",
    "*.crates.io",
    // Source code hosts
    "github.com",
    "*.github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "gitlab.com",
    "*.gitlab.com",
    "bitbucket.org",
    "*.bitbucket.org",
    // Common APIs
    "api.anthropic.com",
    "api.openai.com",
  ],
  allowedUrls: [],
  deniedDomains: [],
};

// ============================================================================
// Default Rules
// ============================================================================

/**
 * Default policy rules with sensible security defaults.
 */
export const DEFAULT_RULES: PolicyRule[] = [
  // Allow reading any file in workspace
  {
    id: "allow-workspace-read",
    name: "Allow Workspace Reads",
    actions: ["file_read"],
    decision: "allow",
    pathPatterns: ["**/*"],
    priority: 100,
    enabled: true,
    description: "Allow reading any file within the workspace",
  },

  // Allow writing to workspace (non-sensitive files)
  {
    id: "allow-workspace-write",
    name: "Allow Workspace Writes",
    actions: ["file_write"],
    decision: "allow",
    pathPatterns: ["**/*"],
    priority: 90,
    enabled: true,
    description: "Allow writing to workspace files",
  },

  // Block sensitive file patterns
  {
    id: "block-sensitive-files",
    name: "Block Sensitive Files",
    actions: ["file_read", "file_write", "file_delete"],
    decision: "deny",
    pathPatterns: [
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      "**/id_rsa",
      "**/id_ed25519",
      "**/.npmrc",
      "**/.pypirc",
      "**/credentials.json",
      "**/secrets.json",
      "**/.git/config",
    ],
    priority: 200,
    enabled: true,
    description: "Block access to sensitive files containing secrets",
  },

  // Prompt for file deletions
  {
    id: "prompt-file-delete",
    name: "Prompt for File Deletion",
    actions: ["file_delete"],
    decision: "prompt",
    priority: 80,
    enabled: true,
    description: "Require approval for file deletions",
  },

  // Allow safe bash commands
  {
    id: "allow-safe-bash",
    name: "Allow Safe Commands",
    actions: ["bash_execute"],
    decision: "allow",
    commandPatterns: [
      "^(ls|cat|head|tail|grep|find|wc|echo|pwd|cd|mkdir|cp|mv|touch)\\b",
      "^(git\\s+(status|diff|log|branch|show|rev-parse))\\b",
      "^(npm|pnpm|yarn|bun)\\s+(install|test|build|run|lint|format)\\b",
      "^(node|bun|ts-node|tsx)\\s+",
      "^(python|python3)\\s+",
      "^(cargo|rustc)\\s+(build|test|check|clippy)\\b",
      "^(go\\s+(build|test|run|fmt|vet))\\b",
    ],
    priority: 100,
    enabled: true,
    description: "Allow common safe commands",
  },

  // Block dangerous bash commands
  {
    id: "block-dangerous-bash",
    name: "Block Dangerous Commands",
    actions: ["bash_execute"],
    decision: "deny",
    commandPatterns: [
      "^rm\\s+-rf\\s+/",
      "^sudo\\b",
      "^su\\b",
      "^chmod\\s+777",
      "^curl.*\\|\\s*(sh|bash)",
      "^wget.*\\|\\s*(sh|bash)",
      "\\|\\s*sh\\b",
      "\\|\\s*bash\\b",
      "^dd\\s+",
      "^mkfs\\b",
      "^fdisk\\b",
      ">\\s*/dev/",
    ],
    priority: 300,
    enabled: true,
    description: "Block dangerous system commands",
  },

  // Prompt for network requests to unknown domains
  {
    id: "prompt-network",
    name: "Prompt for Network Requests",
    actions: ["network_request"],
    decision: "prompt",
    priority: 50,
    enabled: true,
    description: "Require approval for network requests",
  },

  // Allow common trusted domains
  {
    id: "allow-trusted-domains",
    name: "Allow Trusted Domains",
    actions: ["network_request"],
    decision: "allow",
    urlPatterns: [
      "https://github.com/**",
      "https://api.github.com/**",
      "https://raw.githubusercontent.com/**",
      "https://registry.npmjs.org/**",
      "https://pypi.org/**",
      "https://crates.io/**",
    ],
    priority: 100,
    enabled: true,
    description: "Allow requests to common trusted package registries",
  },

  // Prompt for agent spawning
  {
    id: "prompt-agent-spawn",
    name: "Prompt for Agent Spawn",
    actions: ["agent_spawn"],
    decision: "prompt",
    priority: 50,
    enabled: true,
    description: "Require approval for spawning sub-agents",
  },
];

// ============================================================================
// Default Policy
// ============================================================================

/**
 * Default workflow policy configuration.
 */
export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  version: "1.0",
  pathScope: DEFAULT_PATH_SCOPE,
  networkScope: DEFAULT_NETWORK_SCOPE,
  rules: DEFAULT_RULES,
  defaultDecision: "prompt",
  requireApprovalForDestructive: true,
  destructiveActions: ["file_delete", "bash_execute"],
  logging: {
    logAll: false,
    logDenials: true,
    logApprovals: true,
  },
};

// ============================================================================
// Policy Presets
// ============================================================================

/**
 * Strict policy - requires approval for most actions.
 */
export const STRICT_POLICY: WorkflowPolicy = {
  ...DEFAULT_WORKFLOW_POLICY,
  defaultDecision: "deny",
  requireApprovalForDestructive: true,
  rules: DEFAULT_RULES.map((rule) => ({
    ...rule,
    // Convert allows to prompts for non-read operations
    decision:
      rule.decision === "allow" && !rule.actions.includes("file_read") ? "prompt" : rule.decision,
  })),
  logging: {
    logAll: true,
    logDenials: true,
    logApprovals: true,
  },
};

/**
 * Permissive policy - allows most operations within workspace.
 */
export const PERMISSIVE_POLICY: WorkflowPolicy = {
  ...DEFAULT_WORKFLOW_POLICY,
  defaultDecision: "allow",
  requireApprovalForDestructive: false,
  rules: DEFAULT_RULES.filter(
    // Keep only security-critical blocks
    (rule) => rule.id === "block-sensitive-files" || rule.id === "block-dangerous-bash",
  ),
  logging: {
    logAll: false,
    logDenials: true,
    logApprovals: false,
  },
};

// ============================================================================
// Factory
// ============================================================================

/**
 * Get a policy by preset name.
 */
export function getPolicyPreset(name: "default" | "strict" | "permissive"): WorkflowPolicy {
  switch (name) {
    case "strict":
      return STRICT_POLICY;
    case "permissive":
      return PERMISSIVE_POLICY;
    default:
      return DEFAULT_WORKFLOW_POLICY;
  }
}

/**
 * Merge custom rules with default policy.
 */
export function mergePolicy(
  base: WorkflowPolicy,
  overrides: Partial<WorkflowPolicy>,
): WorkflowPolicy {
  return {
    ...base,
    ...overrides,
    pathScope: overrides.pathScope ?? base.pathScope,
    rules: overrides.rules ?? base.rules,
    logging: {
      ...base.logging,
      ...overrides.logging,
    },
  };
}
