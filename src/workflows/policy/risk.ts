/**
 * Risk Scoring
 *
 * Provides risk assessment for policy actions to help users make informed approval decisions.
 */

import type { PolicyContext, PolicyActionType } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Risk level for an action.
 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Risk assessment result.
 */
export interface RiskAssessment {
  /** Overall risk level */
  level: RiskLevel;

  /** Numeric score (0-100) */
  score: number;

  /** Human-readable summary */
  summary: string;

  /** Specific risk factors identified */
  factors: RiskFactor[];

  /** Recommended action */
  recommendation: "approve" | "review" | "deny";
}

/**
 * Individual risk factor.
 */
export interface RiskFactor {
  /** Factor name */
  name: string;

  /** Description of the risk */
  description: string;

  /** Impact on score (positive increases risk) */
  impact: number;

  /** Category */
  category: "destructive" | "sensitive" | "network" | "system" | "scope";
}

// ============================================================================
// Risk Scoring Configuration
// ============================================================================

/**
 * Base risk scores by action type.
 */
const ACTION_BASE_SCORES: Record<PolicyActionType, number> = {
  file_read: 10,
  file_write: 30,
  file_delete: 50,
  bash_execute: 40,
  network_request: 35,
  agent_spawn: 25,
};

/**
 * Risk factor definitions.
 */
const RISK_FACTORS = {
  // Destructive patterns
  destructive_delete: {
    name: "Destructive Delete",
    description: "Action permanently removes data",
    impact: 30,
    category: "destructive" as const,
    patterns: {
      commands: [/^rm\s+-rf/, /^rm\s+.*-r/, /\brm\b.*\*/, /^shred\b/, /^wipe\b/],
      paths: [/\*\*/, /\*$/],
    },
  },

  // Sensitive file access
  sensitive_credentials: {
    name: "Credential Access",
    description: "Action accesses credential/key files",
    impact: 40,
    category: "sensitive" as const,
    patterns: {
      paths: [
        /\.env$/,
        /\.env\./,
        /credentials/i,
        /secrets/i,
        /\.pem$/,
        /\.key$/,
        /id_rsa/,
        /id_ed25519/,
        /\.npmrc$/,
        /\.pypirc$/,
      ],
    },
  },

  sensitive_ssh: {
    name: "SSH Key Access",
    description: "Action accesses SSH keys",
    impact: 50,
    category: "sensitive" as const,
    patterns: {
      paths: [/\.ssh\//, /id_rsa/, /id_ed25519/, /known_hosts/],
    },
  },

  // System access
  system_sudo: {
    name: "Elevated Privileges",
    description: "Action requires elevated system privileges",
    impact: 45,
    category: "system" as const,
    patterns: {
      commands: [/^sudo\b/, /^su\b/, /^doas\b/],
    },
  },

  system_modification: {
    name: "System Modification",
    description: "Action modifies system configuration",
    impact: 40,
    category: "system" as const,
    patterns: {
      commands: [/^chmod\s+[0-7]*7/, /^chown\b/, /^systemctl\b/, /^service\b/],
      paths: [/^\/etc\//, /^\/usr\//, /^\/bin\//, /^\/sbin\//],
    },
  },

  // Network risks
  network_external: {
    name: "External Network",
    description: "Action connects to external network",
    impact: 25,
    category: "network" as const,
    patterns: {
      urls: [/^https?:\/\/(?!localhost|127\.0\.0\.1|::1)/],
    },
  },

  network_download_execute: {
    name: "Download & Execute",
    description: "Action downloads and executes remote code",
    impact: 50,
    category: "network" as const,
    patterns: {
      commands: [/curl.*\|\s*(sh|bash)/, /wget.*\|\s*(sh|bash)/, /\|\s*sh\b/, /\|\s*bash\b/],
    },
  },

  // Scope violations
  scope_outside_workspace: {
    name: "Outside Workspace",
    description: "Action targets files outside workspace",
    impact: 20,
    category: "scope" as const,
    // Detected dynamically based on workspacePath
  },

  scope_recursive: {
    name: "Recursive Operation",
    description: "Action operates recursively on directories",
    impact: 15,
    category: "scope" as const,
    patterns: {
      commands: [/-r\b/, /-R\b/, /--recursive/],
      paths: [/\*\*/, /\/\*$/],
    },
  },
};

// ============================================================================
// Risk Assessment
// ============================================================================

/**
 * Assess the risk level of an action.
 */
export function assessRisk(context: PolicyContext): RiskAssessment {
  const factors: RiskFactor[] = [];
  let score = ACTION_BASE_SCORES[context.actionType] ?? 20;

  // Check each risk factor
  for (const [, factor] of Object.entries(RISK_FACTORS)) {
    const isMatched = checkFactorMatch(factor, context);
    if (isMatched) {
      factors.push({
        name: factor.name,
        description: factor.description,
        impact: factor.impact,
        category: factor.category,
      });
      score += factor.impact;
    }
  }

  // Check scope violation (outside workspace)
  if (context.targetPath && context.workspacePath) {
    const isOutside = !isPathWithinWorkspace(context.targetPath, context.workspacePath);
    if (isOutside) {
      factors.push({
        name: "Outside Workspace",
        description: "Action targets files outside workspace",
        impact: 20,
        category: "scope",
      });
      score += 20;
    }
  }

  // Cap score at 100
  score = Math.min(score, 100);

  // Determine level
  const level = scoreToLevel(score);

  // Generate summary
  const summary = generateSummary(context, factors, level);

  // Determine recommendation
  const recommendation = getRecommendation(level, factors);

  return {
    level,
    score,
    summary,
    factors,
    recommendation,
  };
}

/**
 * Check if a risk factor matches the context.
 */
function checkFactorMatch(
  factor: (typeof RISK_FACTORS)[keyof typeof RISK_FACTORS],
  context: PolicyContext,
): boolean {
  const patterns = "patterns" in factor ? factor.patterns : undefined;
  if (!patterns) return false;

  // Check command patterns
  if ("commands" in patterns && patterns.commands && context.command) {
    for (const pattern of patterns.commands) {
      if (pattern.test(context.command)) return true;
    }
  }

  // Check path patterns
  if ("paths" in patterns && patterns.paths && context.targetPath) {
    for (const pattern of patterns.paths) {
      if (pattern.test(context.targetPath)) return true;
    }
  }

  // Check URL patterns
  if ("urls" in patterns && patterns.urls && context.url) {
    for (const pattern of patterns.urls) {
      if (pattern.test(context.url)) return true;
    }
  }

  return false;
}

/**
 * Check if a path is within the workspace.
 */
function isPathWithinWorkspace(targetPath: string, workspacePath: string): boolean {
  // Normalize paths
  const normalizedTarget = targetPath.replace(/\\/g, "/");
  const normalizedWorkspace = workspacePath.replace(/\\/g, "/");

  // Simple prefix check (could be more sophisticated with realpath)
  return normalizedTarget.startsWith(normalizedWorkspace);
}

/**
 * Convert score to risk level.
 */
function scoreToLevel(score: number): RiskLevel {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  return "low";
}

/**
 * Generate human-readable summary.
 */
function generateSummary(context: PolicyContext, factors: RiskFactor[], level: RiskLevel): string {
  const parts: string[] = [];

  // Action description
  const actionDesc = formatActionDescription(context);
  parts.push(actionDesc);

  // Risk factors
  if (factors.length > 0) {
    const factorNames = factors.slice(0, 3).map((f) => f.name);
    parts.push(`Risk factors: ${factorNames.join(", ")}`);
  }

  // Level indicator
  const levelEmoji: Record<RiskLevel, string> = {
    low: "🟢",
    medium: "🟡",
    high: "🟠",
    critical: "🔴",
  };

  return `${levelEmoji[level]} ${parts.join(". ")}`;
}

/**
 * Format action description.
 */
function formatActionDescription(context: PolicyContext): string {
  switch (context.actionType) {
    case "file_read":
      return `Read file: ${truncatePath(context.targetPath)}`;
    case "file_write":
      return `Write file: ${truncatePath(context.targetPath)}`;
    case "file_delete":
      return `Delete file: ${truncatePath(context.targetPath)}`;
    case "bash_execute":
      return `Execute: ${truncateCommand(context.command)}`;
    case "network_request":
      return `Network request: ${truncateUrl(context.url)}`;
    case "agent_spawn":
      return `Spawn agent`;
    default:
      return `Action: ${context.actionType}`;
  }
}

/**
 * Get recommendation based on risk.
 */
function getRecommendation(level: RiskLevel, factors: RiskFactor[]): "approve" | "review" | "deny" {
  // Critical with destructive factors → deny
  if (level === "critical") {
    const hasDestructive = factors.some((f) => f.category === "destructive");
    if (hasDestructive) return "deny";
    return "review";
  }

  // High risk → review
  if (level === "high") return "review";

  // Medium risk with sensitive factors → review
  if (level === "medium") {
    const hasSensitive = factors.some((f) => f.category === "sensitive");
    if (hasSensitive) return "review";
  }

  // Low risk → approve
  return "approve";
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Truncate path for display.
 */
function truncatePath(path?: string): string {
  if (!path) return "(unknown)";
  if (path.length <= 50) return path;
  return "..." + path.slice(-47);
}

/**
 * Truncate command for display.
 */
function truncateCommand(command?: string): string {
  if (!command) return "(unknown)";
  if (command.length <= 60) return command;
  return command.slice(0, 57) + "...";
}

/**
 * Truncate URL for display.
 */
function truncateUrl(url?: string): string {
  if (!url) return "(unknown)";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.slice(0, 30)}...`;
  } catch {
    return url.slice(0, 50) + "...";
  }
}

/**
 * Get risk level color for terminal display.
 */
export function getRiskLevelColor(level: RiskLevel): string {
  switch (level) {
    case "low":
      return "green";
    case "medium":
      return "yellow";
    case "high":
      return "orange";
    case "critical":
      return "red";
    default:
      return "white";
  }
}

/**
 * Get risk level label for display.
 */
export function getRiskLevelLabel(level: RiskLevel): string {
  switch (level) {
    case "low":
      return "Low Risk";
    case "medium":
      return "Medium Risk";
    case "high":
      return "High Risk";
    case "critical":
      return "Critical Risk";
    default:
      return "Unknown";
  }
}
