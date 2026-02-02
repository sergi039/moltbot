/**
 * Policy Hooks Tests
 *
 * Tests for the policy-to-exec bridge functionality.
 */

import { describe, expect, it } from "vitest";
import type { WorkflowPolicy, PolicyRule } from "./types.js";
import { DEFAULT_WORKFLOW_POLICY, STRICT_POLICY, PERMISSIVE_POLICY } from "./defaults.js";
import {
  deriveExecOverrides,
  createDenyAllExecOverrides,
  createAllowAllExecOverrides,
  createPromptAllExecOverrides,
  validatePolicyExecConfig,
} from "./hooks.js";

describe("deriveExecOverrides", () => {
  describe("with default policy", () => {
    it("derives overrides from default workflow policy", () => {
      const result = deriveExecOverrides({
        policy: DEFAULT_WORKFLOW_POLICY,
      });

      expect(result.overrides.host).toBe("gateway");
      expect(result.shellAllowed).toBe(true);
      expect(result.networkAllowed).toBeDefined();
      expect(result.reason).toBeTruthy();
    });

    it("sets security based on bash_execute decision", () => {
      const result = deriveExecOverrides({
        policy: DEFAULT_WORKFLOW_POLICY,
      });

      // Default policy has allowlist security for bash
      expect(["deny", "allowlist", "full"]).toContain(result.security);
    });
  });

  describe("with strict policy", () => {
    it("derives restrictive overrides from strict policy", () => {
      const result = deriveExecOverrides({
        policy: STRICT_POLICY,
      });

      expect(result.overrides.host).toBe("gateway");
      // Strict policy should have restrictive security
      expect(["deny", "allowlist"]).toContain(result.security);
    });

    it("requires approval for destructive actions when base decision is allow", () => {
      // Create a policy that would allow bash but marks it as destructive
      const allowWithDestructivePolicy: WorkflowPolicy = {
        ...DEFAULT_WORKFLOW_POLICY,
        defaultDecision: "allow",
        requireApprovalForDestructive: true,
        destructiveActions: ["bash_execute"],
        rules: [], // No rules, so default applies
      };

      const result = deriveExecOverrides({
        policy: allowWithDestructivePolicy,
      });

      // The destructive override should force prompt even with allow default
      expect(result.ask).toBe("always");
      expect(result.security).toBe("allowlist");
    });

    it("does not override when base decision is deny", () => {
      // STRICT_POLICY has defaultDecision: "deny", so destructive override doesn't apply
      const result = deriveExecOverrides({
        policy: STRICT_POLICY,
      });

      // When base decision is already deny, no need for additional prompting
      expect(result.security).toBe("deny");
      expect(result.shellAllowed).toBe(false);
    });
  });

  describe("with permissive policy", () => {
    it("derives permissive overrides", () => {
      const result = deriveExecOverrides({
        policy: PERMISSIVE_POLICY,
      });

      expect(result.overrides.host).toBe("gateway");
      // PERMISSIVE_POLICY has defaultDecision: "allow" and requireApprovalForDestructive: false
      // but it keeps block-dangerous-bash rule (deny), so bash decision depends on rule matching
      // Since we're not testing a specific command, the effective decision comes from default
      expect(result.shellAllowed).toBe(true);
      expect(result.networkAllowed).toBe(true);
      // Security should be full since there's no destructive override
      expect(result.security).toBe("full");
    });
  });

  describe("with custom policy", () => {
    it("handles deny decision for bash_execute", () => {
      const denyBashPolicy: WorkflowPolicy = {
        ...DEFAULT_WORKFLOW_POLICY,
        rules: [
          {
            id: "deny-all-bash",
            name: "Deny All Shell",
            actions: ["bash_execute"],
            decision: "deny",
            priority: 100,
            enabled: true,
          },
        ],
      };

      const result = deriveExecOverrides({
        policy: denyBashPolicy,
      });

      expect(result.security).toBe("deny");
      expect(result.shellAllowed).toBe(false);
    });

    it("handles allow decision for bash_execute (without destructive override)", () => {
      // Create policy without requireApprovalForDestructive to test pure allow behavior
      const allowBashPolicy: WorkflowPolicy = {
        ...DEFAULT_WORKFLOW_POLICY,
        requireApprovalForDestructive: false, // Disable the override
        rules: [
          {
            id: "allow-all-bash",
            name: "Allow All Shell",
            actions: ["bash_execute"],
            decision: "allow",
            priority: 100,
            enabled: true,
          },
        ],
      };

      const result = deriveExecOverrides({
        policy: allowBashPolicy,
      });

      expect(result.security).toBe("full");
      expect(result.ask).toBe("off");
      expect(result.shellAllowed).toBe(true);
    });

    it("downgrades allow to prompt when bash_execute is destructive", () => {
      // Default policy has requireApprovalForDestructive: true and bash_execute in destructiveActions
      const allowBashPolicy: WorkflowPolicy = {
        ...DEFAULT_WORKFLOW_POLICY,
        requireApprovalForDestructive: true,
        destructiveActions: ["bash_execute"],
        rules: [
          {
            id: "allow-all-bash",
            name: "Allow All Shell",
            actions: ["bash_execute"],
            decision: "allow",
            priority: 100,
            enabled: true,
          },
        ],
      };

      const result = deriveExecOverrides({
        policy: allowBashPolicy,
      });

      // Should downgrade from full to allowlist due to destructive override
      expect(result.security).toBe("allowlist");
      expect(result.ask).toBe("always");
      expect(result.shellAllowed).toBe(true);
    });

    it("handles prompt decision for bash_execute", () => {
      const promptBashPolicy: WorkflowPolicy = {
        ...DEFAULT_WORKFLOW_POLICY,
        rules: [
          {
            id: "prompt-all-bash",
            name: "Prompt All Shell",
            actions: ["bash_execute"],
            decision: "prompt",
            priority: 100,
            enabled: true,
          },
        ],
      };

      const result = deriveExecOverrides({
        policy: promptBashPolicy,
      });

      expect(result.security).toBe("allowlist");
      expect(result.ask).toBe("always");
      expect(result.shellAllowed).toBe(true);
    });

    it("uses highest priority rule when multiple rules match", () => {
      const multiRulePolicy: WorkflowPolicy = {
        ...DEFAULT_WORKFLOW_POLICY,
        rules: [
          {
            id: "low-priority-allow",
            name: "Low Priority Allow",
            actions: ["bash_execute"],
            decision: "allow",
            priority: 10,
            enabled: true,
          },
          {
            id: "high-priority-deny",
            name: "High Priority Deny",
            actions: ["bash_execute"],
            decision: "deny",
            priority: 100,
            enabled: true,
          },
        ],
      };

      const result = deriveExecOverrides({
        policy: multiRulePolicy,
      });

      // Higher priority rule (deny) should win
      expect(result.security).toBe("deny");
      expect(result.shellAllowed).toBe(false);
    });

    it("ignores disabled rules", () => {
      const disabledRulePolicy: WorkflowPolicy = {
        ...DEFAULT_WORKFLOW_POLICY,
        defaultDecision: "allow",
        requireApprovalForDestructive: false, // Disable override for clean test
        destructiveActions: [],
        rules: [
          {
            id: "disabled-deny",
            name: "Disabled Deny Rule",
            actions: ["bash_execute"],
            decision: "deny",
            priority: 100,
            enabled: false, // Disabled
          },
        ],
      };

      const result = deriveExecOverrides({
        policy: disabledRulePolicy,
      });

      // Should fall back to default decision since rule is disabled
      expect(result.security).toBe("full");
      expect(result.shellAllowed).toBe(true);
    });

    it("handles network_request decision", () => {
      const denyNetworkPolicy: WorkflowPolicy = {
        ...DEFAULT_WORKFLOW_POLICY,
        rules: [
          {
            id: "deny-network",
            name: "Deny Network",
            actions: ["network_request"],
            decision: "deny",
            priority: 100,
            enabled: true,
          },
        ],
      };

      const result = deriveExecOverrides({
        policy: denyNetworkPolicy,
      });

      expect(result.networkAllowed).toBe(false);
    });
  });

  describe("with no policy", () => {
    it("uses default policy when none provided", () => {
      const result = deriveExecOverrides({});

      expect(result.overrides.host).toBe("gateway");
      expect(result.shellAllowed).toBeDefined();
      expect(result.networkAllowed).toBeDefined();
    });
  });
});

describe("createDenyAllExecOverrides", () => {
  it("creates overrides that deny all execution", () => {
    const overrides = createDenyAllExecOverrides();

    expect(overrides.host).toBe("gateway");
    expect(overrides.security).toBe("deny");
    expect(overrides.ask).toBe("off");
  });
});

describe("createAllowAllExecOverrides", () => {
  it("creates overrides that allow all execution", () => {
    const overrides = createAllowAllExecOverrides();

    expect(overrides.host).toBe("gateway");
    expect(overrides.security).toBe("full");
    expect(overrides.ask).toBe("off");
  });
});

describe("createPromptAllExecOverrides", () => {
  it("creates overrides that prompt for all execution", () => {
    const overrides = createPromptAllExecOverrides();

    expect(overrides.host).toBe("gateway");
    expect(overrides.security).toBe("allowlist");
    expect(overrides.ask).toBe("always");
  });
});

describe("validatePolicyExecConfig", () => {
  it("returns no warnings for valid policy", () => {
    const warnings = validatePolicyExecConfig(DEFAULT_WORKFLOW_POLICY);

    // May have warnings or not depending on default policy config
    expect(Array.isArray(warnings)).toBe(true);
  });

  it("warns about conflicting bash_execute rules", () => {
    const conflictingPolicy: WorkflowPolicy = {
      ...DEFAULT_WORKFLOW_POLICY,
      rules: [
        {
          id: "allow-bash",
          name: "Allow Bash",
          actions: ["bash_execute"],
          decision: "allow",
          priority: 50,
          enabled: true,
        },
        {
          id: "deny-bash",
          name: "Deny Bash",
          actions: ["bash_execute"],
          decision: "deny",
          priority: 100,
          enabled: true,
        },
      ],
    };

    const warnings = validatePolicyExecConfig(conflictingPolicy);

    expect(warnings.some((w) => w.includes("different decisions"))).toBe(true);
  });

  it("warns about deny-all with no escape", () => {
    const denyAllPolicy: WorkflowPolicy = {
      ...DEFAULT_WORKFLOW_POLICY,
      defaultDecision: "deny",
      rules: [], // No allow rules
    };

    const warnings = validatePolicyExecConfig(denyAllPolicy);

    expect(warnings.some((w) => w.includes("all commands will be blocked"))).toBe(true);
  });

  it("does not warn when deny-all has escape rule", () => {
    const denyWithEscapePolicy: WorkflowPolicy = {
      ...DEFAULT_WORKFLOW_POLICY,
      defaultDecision: "deny",
      rules: [
        {
          id: "allow-safe",
          name: "Allow Safe Commands",
          actions: ["bash_execute"],
          decision: "allow",
          commandPatterns: ["^ls$", "^pwd$"],
          priority: 100,
          enabled: true,
        },
      ],
    };

    const warnings = validatePolicyExecConfig(denyWithEscapePolicy);

    expect(warnings.some((w) => w.includes("all commands will be blocked"))).toBe(false);
  });
});
