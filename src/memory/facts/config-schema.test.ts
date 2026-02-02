/**
 * Tests for facts memory config schema
 */

import { describe, it, expect } from "vitest";
import { OpenClawSchema } from "../../config/zod-schema.js";

describe("factsMemory config schema", () => {
  describe("redaction config", () => {
    it("validates enabled flag", () => {
      const config = {
        factsMemory: {
          redaction: {
            enabled: true,
          },
        },
      };
      const result = OpenClawSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("validates pattern types", () => {
      const config = {
        factsMemory: {
          redaction: {
            enabled: true,
            patterns: ["EMAIL", "PHONE", "API_KEY"],
          },
        },
      };
      const result = OpenClawSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("rejects invalid pattern types", () => {
      const config = {
        factsMemory: {
          redaction: {
            patterns: ["INVALID_PATTERN"],
          },
        },
      };
      const result = OpenClawSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe("access config", () => {
    it("validates enabled flag", () => {
      const config = {
        factsMemory: {
          access: {
            enabled: true,
          },
        },
      };
      const result = OpenClawSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("validates default role", () => {
      const config = {
        factsMemory: {
          access: {
            enabled: true,
            defaultRole: "analyst",
          },
        },
      };
      const result = OpenClawSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("rejects invalid default role", () => {
      const config = {
        factsMemory: {
          access: {
            defaultRole: "superuser",
          },
        },
      };
      const result = OpenClawSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("validates role configurations", () => {
      const config = {
        factsMemory: {
          access: {
            enabled: true,
            defaultRole: "operator",
            roles: {
              admin: {
                allowedTypes: ["fact", "preference", "decision", "event", "todo"],
                canSeeSuperseded: true,
                canExport: true,
                canSeeUnredacted: true,
              },
              analyst: {
                allowedTypes: ["fact", "event"],
                canExport: true,
              },
              guest: {
                allowedTypes: ["fact"],
                canExport: false,
              },
            },
          },
        },
      };
      const result = OpenClawSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("rejects invalid memory types in role config", () => {
      const config = {
        factsMemory: {
          access: {
            roles: {
              guest: {
                allowedTypes: ["secret"],
              },
            },
          },
        },
      };
      const result = OpenClawSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe("combined config", () => {
    it("validates full factsMemory config with access and redaction", () => {
      const config = {
        factsMemory: {
          enabled: true,
          dbPath: "/tmp/facts.db",
          redaction: {
            enabled: true,
            patterns: ["EMAIL", "PHONE", "JWT"],
          },
          access: {
            enabled: true,
            defaultRole: "operator",
            roles: {
              operator: {
                allowedTypes: ["fact", "preference", "decision"],
                canExport: true,
              },
            },
          },
        },
      };
      const result = OpenClawSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });
});
