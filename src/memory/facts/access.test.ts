/**
 * Tests for access control module
 */

import { describe, it, expect } from "vitest";
import {
  getRoleConfig,
  isTypeAllowed,
  filterByRole,
  checkAccess,
  createAuditEvent,
  isValidRole,
  getDefaultRole,
  canExport,
  canSeeUnredacted,
  getAvailableRoles,
} from "./access.js";
import type { MemoryEntry } from "./types.js";

describe("getRoleConfig", () => {
  it("returns admin config with all permissions", () => {
    const config = getRoleConfig("admin");
    expect(config.allowedTypes).toContain("fact");
    expect(config.allowedTypes).toContain("preference");
    expect(config.allowedTypes).toContain("decision");
    expect(config.allowedTypes).toContain("event");
    expect(config.allowedTypes).toContain("todo");
    expect(config.canSeeSuperseded).toBe(true);
    expect(config.canExport).toBe(true);
    expect(config.canSeeUnredacted).toBe(true);
  });

  it("returns operator config with standard permissions", () => {
    const config = getRoleConfig("operator");
    expect(config.allowedTypes.length).toBe(5);
    expect(config.canSeeSuperseded).toBe(false);
    expect(config.canExport).toBe(true);
    expect(config.canSeeUnredacted).toBe(false);
  });

  it("returns analyst config with limited types", () => {
    const config = getRoleConfig("analyst");
    expect(config.allowedTypes).toContain("fact");
    expect(config.allowedTypes).toContain("event");
    expect(config.allowedTypes).not.toContain("preference");
    expect(config.allowedTypes).not.toContain("decision");
    expect(config.canExport).toBe(true);
  });

  it("returns guest config with minimal permissions", () => {
    const config = getRoleConfig("guest");
    expect(config.allowedTypes).toEqual(["fact"]);
    expect(config.canSeeSuperseded).toBe(false);
    expect(config.canExport).toBe(false);
  });

  it("merges custom config with defaults", () => {
    const customConfig = {
      roles: {
        operator: {
          allowedTypes: ["fact", "preference"] as const,
          canExport: false,
        },
      },
    };
    const config = getRoleConfig("operator", customConfig);
    expect(config.allowedTypes).toEqual(["fact", "preference"]);
    expect(config.canExport).toBe(false);
    expect(config.canSeeSuperseded).toBe(false); // Falls back to default
  });
});

describe("isTypeAllowed", () => {
  it("allows all types for admin", () => {
    expect(isTypeAllowed("fact", "admin")).toBe(true);
    expect(isTypeAllowed("preference", "admin")).toBe(true);
    expect(isTypeAllowed("decision", "admin")).toBe(true);
    expect(isTypeAllowed("event", "admin")).toBe(true);
    expect(isTypeAllowed("todo", "admin")).toBe(true);
  });

  it("restricts types for analyst", () => {
    expect(isTypeAllowed("fact", "analyst")).toBe(true);
    expect(isTypeAllowed("event", "analyst")).toBe(true);
    expect(isTypeAllowed("preference", "analyst")).toBe(false);
    expect(isTypeAllowed("decision", "analyst")).toBe(false);
  });

  it("restricts to facts only for guest", () => {
    expect(isTypeAllowed("fact", "guest")).toBe(true);
    expect(isTypeAllowed("preference", "guest")).toBe(false);
  });
});

describe("filterByRole", () => {
  const entries: MemoryEntry[] = [
    {
      id: "1",
      type: "fact",
      content: "A fact",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "test",
    },
    {
      id: "2",
      type: "preference",
      content: "A preference",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "test",
    },
    {
      id: "3",
      type: "decision",
      content: "A decision",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "test",
    },
    {
      id: "4",
      type: "event",
      content: "An event",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "test",
    },
    {
      id: "5",
      type: "fact",
      content: "Superseded fact",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "test",
      supersededBy: "newer-id",
    },
  ];

  it("returns all entries for admin including superseded", () => {
    const result = filterByRole(entries, "admin");
    expect(result.length).toBe(5);
  });

  it("filters by type for analyst", () => {
    const result = filterByRole(entries, "analyst");
    expect(result.length).toBe(2); // fact + event (excludes superseded)
    expect(result.every((e) => e.type === "fact" || e.type === "event")).toBe(true);
    expect(result.every((e) => !e.supersededBy)).toBe(true);
  });

  it("returns only facts for guest", () => {
    const result = filterByRole(entries, "guest");
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("fact");
    expect(result[0].supersededBy).toBeUndefined();
  });

  it("filters superseded entries for non-admin roles", () => {
    const result = filterByRole(entries, "operator");
    expect(result.find((e) => e.supersededBy)).toBeUndefined();
  });
});

describe("checkAccess", () => {
  const entries: MemoryEntry[] = [
    {
      id: "1",
      type: "fact",
      content: "A fact",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "test",
    },
    {
      id: "2",
      type: "preference",
      content: "A preference",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "test",
    },
  ];

  it("returns access allowed when entries match role", () => {
    const result = checkAccess(entries, "admin");
    expect(result.allowed).toBe(true);
    expect(result.role).toBe("admin");
    expect(result.filteredTypes).toEqual([]);
  });

  it("returns filtered types for restricted roles", () => {
    const result = checkAccess(entries, "guest");
    expect(result.allowed).toBe(true);
    expect(result.filteredTypes).toContain("preference");
  });

  it("returns allowed true for empty entries", () => {
    const result = checkAccess([], "guest");
    expect(result.allowed).toBe(true);
  });
});

describe("createAuditEvent", () => {
  const included: MemoryEntry[] = [
    {
      id: "1",
      type: "fact",
      content: "A fact",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "test",
    },
  ];
  const excluded: MemoryEntry[] = [
    {
      id: "2",
      type: "preference",
      content: "A preference",
      importance: 0.5,
      createdAt: 1000,
      accessCount: 0,
      lastAccessed: 1000,
      source: "test",
    },
  ];

  it("creates audit event with correct structure", () => {
    const event = createAuditEvent("analyst", included, excluded, "test query");
    expect(event.kind).toBe("memory.access");
    expect(event.role).toBe("analyst");
    expect(event.query).toBe("test query");
    expect(event.included).toBe(1);
    expect(event.excluded).toBe(1);
    expect(event.includedTypes).toContain("fact");
    expect(event.excludedTypes).toContain("preference");
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it("creates audit event without query", () => {
    const event = createAuditEvent("admin", included, []);
    expect(event.query).toBeUndefined();
    expect(event.excluded).toBe(0);
  });
});

describe("isValidRole", () => {
  it("validates known roles", () => {
    expect(isValidRole("admin")).toBe(true);
    expect(isValidRole("operator")).toBe(true);
    expect(isValidRole("analyst")).toBe(true);
    expect(isValidRole("guest")).toBe(true);
    expect(isValidRole("custom")).toBe(true);
  });

  it("rejects unknown roles", () => {
    expect(isValidRole("unknown")).toBe(false);
    expect(isValidRole("")).toBe(false);
    expect(isValidRole("Admin")).toBe(false); // Case sensitive
  });
});

describe("getDefaultRole", () => {
  it("returns operator by default", () => {
    expect(getDefaultRole()).toBe("operator");
    expect(getDefaultRole({})).toBe("operator");
  });

  it("returns configured default role", () => {
    expect(getDefaultRole({ defaultRole: "guest" })).toBe("guest");
    expect(getDefaultRole({ defaultRole: "admin" })).toBe("admin");
  });
});

describe("canExport", () => {
  it("returns true for admin and operator", () => {
    expect(canExport("admin")).toBe(true);
    expect(canExport("operator")).toBe(true);
    expect(canExport("analyst")).toBe(true);
  });

  it("returns false for guest", () => {
    expect(canExport("guest")).toBe(false);
  });
});

describe("canSeeUnredacted", () => {
  it("returns true only for admin", () => {
    expect(canSeeUnredacted("admin")).toBe(true);
    expect(canSeeUnredacted("operator")).toBe(false);
    expect(canSeeUnredacted("analyst")).toBe(false);
    expect(canSeeUnredacted("guest")).toBe(false);
  });
});

describe("getAvailableRoles", () => {
  it("returns standard roles", () => {
    const roles = getAvailableRoles();
    expect(roles).toContain("admin");
    expect(roles).toContain("operator");
    expect(roles).toContain("analyst");
    expect(roles).toContain("guest");
    expect(roles).not.toContain("custom");
  });
});
