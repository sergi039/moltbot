/**
 * Facts Memory Access Control
 *
 * Role-based visibility and access control for memory entries.
 */

import type { MemoryEntry, MemoryType } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const logger = createSubsystemLogger("facts-access");

// ============================================================================
// Types
// ============================================================================

/** Predefined access roles */
export type AccessRole = "admin" | "operator" | "analyst" | "guest" | "custom";

/** Role configuration with allowed memory types */
export interface RoleConfig {
  /** Memory types this role can access (defaults to role-specific defaults if not set) */
  allowedTypes?: MemoryType[];
  /** Whether this role can see superseded entries */
  canSeeSuperseded?: boolean;
  /** Whether this role can export data */
  canExport?: boolean;
  /** Whether this role can see redacted data */
  canSeeUnredacted?: boolean;
}

/** Access control configuration */
export interface AccessConfig {
  /** Whether access control is enabled */
  enabled?: boolean;
  /** Default role when none specified */
  defaultRole?: AccessRole;
  /** Role configurations */
  roles?: Partial<Record<AccessRole, RoleConfig>>;
}

/** Access check result */
export interface AccessCheckResult {
  /** Whether access is allowed */
  allowed: boolean;
  /** Role used for the check */
  role: AccessRole;
  /** Types that are allowed */
  allowedTypes: MemoryType[];
  /** Types that were filtered out */
  filteredTypes: MemoryType[];
}

/** Access audit event */
export interface AccessAuditEvent {
  /** Event type */
  kind: "memory.access";
  /** Timestamp */
  timestamp: number;
  /** Role used */
  role: AccessRole;
  /** Query performed (if any) */
  query?: string;
  /** Number of entries included */
  included: number;
  /** Number of entries excluded by role */
  excluded: number;
  /** Types of entries included */
  includedTypes: MemoryType[];
  /** Types of entries excluded */
  excludedTypes: MemoryType[];
}

// ============================================================================
// Default Role Configurations
// ============================================================================

const ALL_MEMORY_TYPES: MemoryType[] = ["fact", "preference", "decision", "event", "todo"];

const DEFAULT_ROLES: Record<AccessRole, RoleConfig> = {
  admin: {
    allowedTypes: ALL_MEMORY_TYPES,
    canSeeSuperseded: true,
    canExport: true,
    canSeeUnredacted: true,
  },
  operator: {
    allowedTypes: ["fact", "preference", "decision", "event", "todo"],
    canSeeSuperseded: false,
    canExport: true,
    canSeeUnredacted: false,
  },
  analyst: {
    allowedTypes: ["fact", "event"],
    canSeeSuperseded: false,
    canExport: true,
    canSeeUnredacted: false,
  },
  guest: {
    allowedTypes: ["fact"],
    canSeeSuperseded: false,
    canExport: false,
    canSeeUnredacted: false,
  },
  custom: {
    allowedTypes: [],
    canSeeSuperseded: false,
    canExport: false,
    canSeeUnredacted: false,
  },
};

// ============================================================================
// Access Control Functions
// ============================================================================

/** Resolved role config with all fields guaranteed to be defined */
export interface ResolvedRoleConfig {
  allowedTypes: MemoryType[];
  canSeeSuperseded: boolean;
  canExport: boolean;
  canSeeUnredacted: boolean;
}

/**
 * Get role configuration, merging defaults with custom config.
 * Returns a fully resolved config with all fields guaranteed to be defined.
 */
export function getRoleConfig(role: AccessRole, config?: AccessConfig): ResolvedRoleConfig {
  const defaultConfig = DEFAULT_ROLES[role] ?? DEFAULT_ROLES.guest;
  const customConfig = config?.roles?.[role];

  if (!customConfig) {
    return {
      allowedTypes: defaultConfig.allowedTypes ?? ALL_MEMORY_TYPES,
      canSeeSuperseded: defaultConfig.canSeeSuperseded ?? false,
      canExport: defaultConfig.canExport ?? false,
      canSeeUnredacted: defaultConfig.canSeeUnredacted ?? false,
    };
  }

  return {
    allowedTypes: customConfig.allowedTypes ?? defaultConfig.allowedTypes ?? ALL_MEMORY_TYPES,
    canSeeSuperseded: customConfig.canSeeSuperseded ?? defaultConfig.canSeeSuperseded ?? false,
    canExport: customConfig.canExport ?? defaultConfig.canExport ?? false,
    canSeeUnredacted: customConfig.canSeeUnredacted ?? defaultConfig.canSeeUnredacted ?? false,
  };
}

/**
 * Check if a memory type is allowed for a role.
 */
export function isTypeAllowed(type: MemoryType, role: AccessRole, config?: AccessConfig): boolean {
  const roleConfig = getRoleConfig(role, config);
  return roleConfig.allowedTypes.includes(type);
}

/**
 * Filter memory entries by role access.
 */
export function filterByRole(
  entries: MemoryEntry[],
  role: AccessRole,
  config?: AccessConfig,
): MemoryEntry[] {
  const roleConfig = getRoleConfig(role, config);

  return entries.filter((entry) => {
    // Check type access
    if (!roleConfig.allowedTypes.includes(entry.type)) {
      return false;
    }

    // Check superseded access
    if (entry.supersededBy && !roleConfig.canSeeSuperseded) {
      return false;
    }

    return true;
  });
}

/**
 * Perform access check and return detailed result.
 */
export function checkAccess(
  entries: MemoryEntry[],
  role: AccessRole,
  config?: AccessConfig,
): AccessCheckResult {
  const roleConfig = getRoleConfig(role, config);
  const allowed = entries.filter((e) => roleConfig.allowedTypes.includes(e.type));
  const filtered = entries.filter((e) => !roleConfig.allowedTypes.includes(e.type));

  const filteredTypes = [...new Set(filtered.map((e) => e.type))];

  return {
    allowed: allowed.length > 0 || entries.length === 0,
    role,
    allowedTypes: roleConfig.allowedTypes,
    filteredTypes,
  };
}

/**
 * Create an audit event for memory access.
 */
export function createAuditEvent(
  role: AccessRole,
  included: MemoryEntry[],
  excluded: MemoryEntry[],
  query?: string,
): AccessAuditEvent {
  const includedTypes = [...new Set(included.map((e) => e.type))];
  const excludedTypes = [...new Set(excluded.map((e) => e.type))];

  return {
    kind: "memory.access",
    timestamp: Date.now(),
    role,
    query,
    included: included.length,
    excluded: excluded.length,
    includedTypes,
    excludedTypes,
  };
}

/**
 * Log an audit event.
 */
export function logAuditEvent(event: AccessAuditEvent): void {
  logger.info(
    `Access audit: role=${event.role} included=${event.included} excluded=${event.excluded}`,
    {
      event: event.kind,
      role: event.role,
      query: event.query,
      included: event.included,
      excluded: event.excluded,
      includedTypes: event.includedTypes,
      excludedTypes: event.excludedTypes,
    },
  );
}

/**
 * Validate role name.
 */
export function isValidRole(role: string): role is AccessRole {
  return ["admin", "operator", "analyst", "guest", "custom"].includes(role);
}

/**
 * Get default role from config.
 */
export function getDefaultRole(config?: AccessConfig): AccessRole {
  return config?.defaultRole ?? "operator";
}

/**
 * Check if role can export data.
 */
export function canExport(role: AccessRole, config?: AccessConfig): boolean {
  const roleConfig = getRoleConfig(role, config);
  return roleConfig.canExport ?? false;
}

/**
 * Check if role can see unredacted data.
 */
export function canSeeUnredacted(role: AccessRole, config?: AccessConfig): boolean {
  const roleConfig = getRoleConfig(role, config);
  return roleConfig.canSeeUnredacted ?? false;
}

/**
 * Get all available roles.
 */
export function getAvailableRoles(): AccessRole[] {
  return ["admin", "operator", "analyst", "guest"];
}
