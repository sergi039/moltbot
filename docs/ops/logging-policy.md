# Logging & Redaction Policy

## Overview

OpenClaw applies automatic redaction to sensitive data in logs and tool output. This document describes the redaction policy, PII handling, and operator configuration options.

## Redaction Modes

| Mode | Behavior | Config Key |
|------|----------|------------|
| `tools` (default) | Redact sensitive data in tool call details and log output | `logging.redactSensitive: "tools"` |
| `off` | No redaction (use only in isolated dev environments) | `logging.redactSensitive: "off"` |

## Default Redaction Categories

### Secrets & Tokens (always redacted in `tools` mode)

| Category | Pattern Examples | Behavior |
|----------|-----------------|----------|
| ENV-style assignments | `API_KEY=sk-...`, `TOKEN: ghp_...` | Mask value, keep key |
| JSON credential fields | `"apiKey": "..."`, `"token": "..."` | Mask value |
| CLI flags | `--api-key sk-...`, `--token xox-...` | Mask value |
| Authorization headers | `Bearer eyJ...` | Mask token |
| PEM private keys | `-----BEGIN PRIVATE KEY-----` | Show boundaries only |
| Known token prefixes | `sk-*`, `ghp_*`, `xox*-*`, `AIza*`, `gsk_*`, `pplx-*`, `npm_*` | Mask entire token |
| Telegram bot tokens | `123456:ABC-...` | Mask token |

### PII (Personally Identifiable Information)

| Category | Pattern | Example | Redacted As |
|----------|---------|---------|-------------|
| Email addresses | `user@domain.tld` | `alice@example.com` | `alice@...e.com` |
| Phone numbers | International format | `+1-555-123-4567` | `+1-555...4567` |
| Credit card numbers | 16-digit patterns | `4111-1111-1111-1111` | `4111-1...1111` |
| SSN / national IDs | `NNN-NN-NNNN` | `123-45-6789` | `***` |
| IPv4 addresses | `N.N.N.N` | `192.168.1.1` | `***` |

## Masking Behavior

- Tokens >= 18 characters: first 6 + `...` + last 4 characters
- Tokens < 18 characters: replaced with `***`
- PEM blocks: show `-----BEGIN` and `-----END` lines, body replaced with `...redacted...`

## Custom Patterns

Operators can add custom redaction patterns via config:

```json5
{
  logging: {
    redactSensitive: "tools",
    redactPatterns: [
      // Add custom regex patterns (in addition to defaults)
      "\\b(CUSTOM_PREFIX_[A-Za-z0-9]{10,})\\b"
    ]
  }
}
```

When `redactPatterns` is provided, it **replaces** the default patterns. To extend defaults, include the default patterns plus your additions.

## Log Retention Guidelines

| Log Type | Recommended Retention | Notes |
|----------|-----------------------|-------|
| Gateway startup logs | 30 days | Contains config validation results |
| Chat session logs | 7-14 days | May contain user messages |
| Tool execution logs | 14 days | Contains command output (redacted) |
| Audit logs | 90 days | Security events, approval decisions |
| Error/crash logs | 30 days | May contain stack traces with data |

## Sensitive Channels

The following channels may carry PII and require extra care:

- **Chat sessions**: User messages are stored in session history. Avoid logging full message bodies outside of session storage.
- **Approval requests**: Command strings may contain sensitive paths or arguments. Redact before forwarding to notification channels.
- **Tool output**: Command stdout/stderr may contain credentials or user data. Always apply `redactToolDetail()` before logging.

## Implementation

- Core redaction: `src/logging/redact.ts`
- Config: `logging.redactSensitive`, `logging.redactPatterns`
- Tool detail redaction: `redactToolDetail()` — applied to all tool call results before logging
- Sensitive text redaction: `redactSensitiveText()` — general-purpose, used in audit and chat surfaces

## Operator Checklist

- [ ] Verify `logging.redactSensitive` is not set to `"off"` in production
- [ ] Review custom `redactPatterns` if any domain-specific PII patterns are needed
- [ ] Set appropriate log retention in your log aggregation system
- [ ] Ensure session logs are not backed up to unencrypted storage
- [ ] Review approval forwarding targets — PII may appear in forwarded approval messages
