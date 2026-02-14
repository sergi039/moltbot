# ADR-0005: Sandbox Defaults

- **Status:** accepted
- **Date:** 2026-02-07
- **Authors:** Security team

## Context

OpenClaw agents can execute shell commands via tool calls (exec tool). The sandbox system controls which commands are allowed, denied, or require approval. The default sandbox configuration determines the baseline security posture for all agents that don't have explicit sandbox overrides.

Key concerns:
1. New deployments should be secure by default without requiring explicit sandbox configuration
2. Tool execution is the highest-risk operation in the system (TB-3 in threat model)
3. Operators need to balance security with usability for their specific use cases
4. The exec approval manager provides a human-in-the-loop check, but only for commands that reach it

## Decision

Maintain the following sandbox defaults:

1. **Default sandbox mode: `"approve"`** - Commands not matching any allow/deny rule require operator approval via the exec approval manager. This is the safest default because it puts a human in the loop for unrecognized operations.

2. **Deny-first for dangerous commands** - The default deny list includes destructive system commands (`rm -rf /`, `mkfs`, `dd`, etc.), network exfiltration tools when targeting external hosts, and privilege escalation commands (`sudo`, `su`) unless explicitly allowed.

3. **Allow-list for common safe operations** - Read-only commands (`ls`, `cat`, `pwd`, `echo`, `date`) are allowed by default to avoid approval fatigue.

4. **Per-agent sandbox overrides** - Agents can customize their sandbox policy via `agents.<id>.sandbox` config, but cannot weaken the global deny list unless the operator sets `sandbox.allowOverrideDenyList: true`.

5. **Tool policy resolution** - Resolved per-agent via `resolveSandboxToolPolicyForAgent()`, falling back to global defaults. The resolution chain is: agent-specific policy -> global policy -> built-in defaults.

## Consequences

### Positive

- Secure by default: new deployments don't need explicit sandbox config
- Human-in-the-loop for unknown commands prevents blind execution
- Deny list prevents the most dangerous operations even if approval is granted
- Per-agent customization allows flexible deployment

### Negative

- Approval fatigue if too many commands require approval in active deployments
- Operators must configure allow lists for their specific workflows
- The approve mode adds latency to tool execution (waiting for human response)

### Neutral

- The sandbox configuration is well-documented and can be progressively relaxed
- Audit findings flag overly permissive sandbox configurations

## Alternatives Considered

### Default deny-all (no exec)

Reject all tool execution by default. Rejected because it makes the agent essentially non-functional for most use cases and creates a poor first-run experience.

### Default allow-all with logging

Allow all execution but log everything. Rejected because it provides no protection against malicious or accidental destructive commands - logging is detective, not preventive.

### Capability-based sandbox (seccomp/landlock)

Use OS-level sandboxing for spawned processes. Deferred as a future enhancement - adds complexity and platform-specific code. The current approve/deny model provides sufficient protection for the common case.

## References

- [Sandbox Configuration](https://docs.openclaw.ai/configuration#sandbox)
- [Tool Execution Security](https://docs.openclaw.ai/tools)
- [Threat Model - Tool Execution](../threat-model.md#tb-3-gateway-to-tool-execution)
