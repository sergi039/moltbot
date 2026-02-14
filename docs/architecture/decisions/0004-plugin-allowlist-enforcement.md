# ADR-0004: Plugin Allowlist Enforcement

- **Status:** accepted
- **Date:** 2026-02-07
- **Authors:** Security team

## Context

External (non-bundled) plugins loaded via `plugins.load.paths` or discovered under `extensions/` could previously load without an explicit `plugins.allow` entry. The allowlist check in `resolveEnableState()` only fired when the allowlist was non-empty. If `plugins.allow` was omitted entirely, external plugins fell through to the default-enable path, meaning a malicious plugin placed in the extensions directory would auto-load without user consent.

This was rated as a HIGH-severity security gap because:
1. File-drop attacks in the extensions directory could achieve code execution
2. No operator consent was required for external plugin loading
3. The gap was silent - no warning or audit finding at the appropriate severity level

## Decision

Enforce a mandatory allowlist for all non-bundled plugins. Specifically:

1. **`resolveEnableState()` in `src/plugins/config-state.ts`**: External plugins always require an allowlist entry, even when the allowlist array is empty/absent. Bundled plugins retain their existing enable/disable logic (entries, slots, `BUNDLED_ENABLED_BY_DEFAULT`).

2. **Config validation in `src/config/validation.ts`**: Emit a validation error when `plugins.load.paths` is configured but `plugins.allow` is empty/missing and `plugins.enabled` is true. This catches misconfiguration at config-load time rather than silently disabling plugins at runtime.

3. **Audit severity in `src/security/audit-extra.ts`**: The `plugins.extensions_no_allowlist` audit finding upgraded from `"warn"` to `"error"` severity.

## Consequences

### Positive

- Eliminates file-drop attacks via the extensions directory
- Operators must explicitly consent to each external plugin
- Misconfiguration caught early at config validation time
- Audit findings clearly flag missing allowlists as errors

### Negative

- Existing deployments with external plugins but no `plugins.allow` will need config updates
- Slightly more configuration overhead for plugin users

### Neutral

- Bundled plugins are unaffected by this change
- The `plugins.allow` array is already a documented configuration option

## Alternatives Considered

### Warn-only approach

Log a warning when external plugins load without allowlist. Rejected because warnings are easily ignored and the risk of arbitrary code execution is too high for a soft enforcement.

### Disable all external plugins by default

Require `plugins.enabled: true` explicitly. Rejected because it would break existing deployments that rely on the current default behavior for bundled plugins.

### Code signing for plugins

Verify plugin signatures before loading. Deferred as a future enhancement - more infrastructure required (signing keys, verification chain) and allowlist enforcement covers the immediate risk.

## References

- [SECURITY_BACKLOG.md - P0-1a](../../SECURITY_BACKLOG.md)
- [Plugin Configuration](https://docs.openclaw.ai/configuration#plugins)
- [Threat Model - Plugin Boundary](../threat-model.md#tb-5-plugin-boundary)
