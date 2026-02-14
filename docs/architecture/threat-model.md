# OpenClaw Threat Model

- **Status:** accepted
- **Date:** 2026-02-07
- **Authors:** Security team

## Overview

This document captures trust boundaries, ingress/egress points, and sensitive data paths for the OpenClaw gateway and agent system.

## System Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Internet / WAN                             │
└──────────┬──────────┬──────────┬──────────┬──────────┬─────────────┘
           │          │          │          │          │
     ┌─────▼───┐ ┌───▼────┐ ┌──▼───┐ ┌───▼───┐ ┌───▼────┐
     │Telegram │ │Discord │ │Slack │ │Signal │ │WhatsApp│  ... ext channels
     └─────┬───┘ └───┬────┘ └──┬───┘ └───┬───┘ └───┬────┘
           │         │         │         │         │
   ════════╪═════════╪═════════╪═════════╪═════════╪══════  TRUST BOUNDARY 1
           │         │         │         │         │        (channel ingress)
     ┌─────▼─────────▼─────────▼─────────▼─────────▼────┐
     │              Channel Manager                      │
     │   (src/gateway/server-channels.ts)                │
     └───────────────────────┬───────────────────────────┘
                             │
     ┌───────────────────────▼───────────────────────────┐
     │              Gateway Server                        │
     │   (src/gateway/server.impl.ts)                     │
     │                                                    │
     │  ┌──────────┐  ┌────────────┐  ┌───────────────┐  │
     │  │ Routing  │  │ Sessions   │  │ ExecApproval  │  │
     │  │          │  │            │  │  Manager      │  │
     │  └──────────┘  └────────────┘  └───────────────┘  │
     │                                                    │
     │  ┌──────────┐  ┌────────────┐  ┌───────────────┐  │
     │  │ Cron     │  │ Plugins    │  │ Node Registry │  │
     │  │          │  │            │  │               │  │
     │  └──────────┘  └────────────┘  └───────────────┘  │
     └───────┬──────────────┬──────────────┬─────────────┘
             │              │              │
   ══════════╪══════════════╪══════════════╪══════════════  TRUST BOUNDARY 2
             │              │              │               (LLM / exec)
       ┌─────▼────┐  ┌─────▼──────┐  ┌───▼──────────┐
       │ LLM APIs │  │ Tool Exec  │  │ File System  │
       │(Anthropic│  │ (sandbox)  │  │ (config,     │
       │ OpenAI,  │  │            │  │  sessions,   │
       │ Gemini)  │  │            │  │  facts DB)   │
       └──────────┘  └────────────┘  └──────────────┘
```

## Trust Boundaries

### TB-1: Channel Ingress (Internet to Gateway)

| Property | Detail |
|----------|--------|
| **Boundary** | External messaging APIs to gateway channel handlers |
| **Protocols** | HTTPS webhooks (Telegram, Slack), WebSocket (Discord, Web UI) |
| **Authentication** | Channel-specific: bot tokens, webhook signatures, gateway auth token |
| **Risks** | Spoofed messages, replay attacks, prompt injection via user input |
| **Mitigations** | Webhook signature verification, sender allowlists, per-channel auth |

### TB-2: Gateway to LLM Providers

| Property | Detail |
|----------|--------|
| **Boundary** | Gateway agent runtime to external LLM APIs |
| **Protocols** | HTTPS |
| **Authentication** | API keys or OAuth tokens (env vars / config) |
| **Risks** | Token leakage in logs, excessive token spend, prompt injection forwarding |
| **Mitigations** | Log redaction (`src/logging/redact.ts`), model config limits, tool sandboxing |

### TB-3: Gateway to Tool Execution

| Property | Detail |
|----------|--------|
| **Boundary** | Agent runtime to local shell / exec sandbox |
| **Protocols** | Local process spawn |
| **Authentication** | Exec approval manager (`src/gateway/exec-approval-manager.ts`) |
| **Risks** | Command injection, privilege escalation, file system traversal |
| **Mitigations** | Sandbox policy, tool allowlists, exec approval flow, path validation |

### TB-4: Web UI to Gateway

| Property | Detail |
|----------|--------|
| **Boundary** | Browser-based Web UI to gateway WebSocket/HTTP |
| **Protocols** | WSS / HTTPS |
| **Authentication** | Gateway auth token, optional Tailscale identity |
| **Risks** | XSS, CSRF, token theft, unauthorized access |
| **Mitigations** | Auth token validation, CORS headers, Tailscale Serve identity |

### TB-5: Plugin Boundary

| Property | Detail |
|----------|--------|
| **Boundary** | Core gateway to loaded extension plugins |
| **Protocols** | In-process JS/TS module loading |
| **Authentication** | Plugin allowlist enforcement (P0-1a) |
| **Risks** | Malicious plugin code execution, supply chain attacks |
| **Mitigations** | Mandatory allowlist for external plugins, config validation, extensions dir audit |

## Sensitive Data Paths

### API Keys and Tokens

- **Storage:** Environment variables (`process.env`), `openclaw.json` config (`env` section), `~/.openclaw/credentials/`
- **Flow:** Config load (`src/config/io.ts`) -> env substitution -> LLM provider calls
- **Risks:** Tokens in config JSON, tokens in logs, tokens in session history
- **Mitigations:** `SHELL_ENV_EXPECTED_KEYS` for expected env vars, log redaction (17+ patterns), secrets scanning in CI (`detect-secrets`)

### Session Data

- **Storage:** `~/.openclaw/sessions/`, SQLite facts DB
- **Flow:** Channel message -> session routing -> agent context -> facts memory
- **Risks:** PII in session logs, cross-session leakage, unauthorized session access
- **Mitigations:** Per-sender session isolation (ADR-0002), session key scoping

### Config Files

- **Storage:** `~/.openclaw/openclaw.json` (JSON5), includes chain
- **Flow:** File read -> JSON5 parse -> includes resolution -> env substitution -> validation
- **Risks:** Config injection via includes, sensitive data in config files, config tampering
- **Mitigations:** Include depth limit (`MAX_INCLUDE_DEPTH`), config guardrails (`PROTECTED_CONFIG_PATHS`), config backup rotation

## Ingress Points

| Ingress | Protocol | Auth | Handler |
|---------|----------|------|---------|
| Telegram webhook | HTTPS | Bot token + webhook secret | `src/telegram/` |
| Discord gateway | WSS | Bot token | `src/discord/` |
| Slack events | HTTPS | App token + signing secret | `src/slack/` |
| Signal | Local daemon | Trust-on-first-use | `src/signal/` |
| WhatsApp Web | Browser automation | QR auth | `src/web/` |
| Web UI | WSS/HTTPS | Gateway token | `ui/src/` |
| iMessage | Local AppleScript | System trust | `src/imessage/` |
| Extension channels | Plugin SDK | Plugin allowlist | `extensions/` |
| CLI | Local process | System user | `src/cli/` |

## Egress Points

| Egress | Protocol | Data | Handler |
|--------|----------|------|---------|
| LLM APIs | HTTPS | Prompts, tool results | `src/provider-web.ts`, model adapters |
| Channel replies | Various | Agent responses | Channel handlers |
| Tool execution | Local exec | Commands, file I/O | Sandbox, exec approval |
| Tailscale | WireGuard | Discovery, exposure | `src/gateway/server-tailscale.ts` |
| Update checks | HTTPS | Version info | `src/infra/update-startup.ts` |

## Attack Vectors (Prioritized)

### Critical

1. **Prompt injection via channel messages** - Attacker crafts messages that manipulate LLM behavior to exfiltrate data or execute commands
2. **Malicious plugin loading** - Unauthorized plugin placed in extensions dir executes arbitrary code (mitigated by P0-1a allowlist)
3. **Token/credential leakage** - API keys exposed through logs, config, or error messages

### High

4. **Command injection via tool exec** - Malicious tool arguments bypass sandbox
5. **Config tampering** - Unauthorized modification of `openclaw.json` to weaken security
6. **Approval flooding** - Spam approval requests to social-engineer operator into approving malicious exec

### Medium

7. **Cross-session data leakage** - Agent context bleeds between sessions
8. **Supply chain attack** - Compromised dependency in node_modules
9. **Replay attacks on webhooks** - Replayed webhook payloads trigger duplicate actions

### Low

10. **PII in logs** - Personally identifiable information persists in audit/debug logs
11. **Stale session data** - Old session data accessible beyond retention period

## Recommendations

1. **Secrets hygiene (P3-3):** Detect tokens in `openclaw.json` values at startup; refuse to boot unless explicitly overridden
2. **Approval rate limiting (P3-4):** Rate limit approval requests per channel/user to prevent flooding
3. **SBOM generation (P3-5):** Generate Software Bill of Materials in CI for supply chain visibility
4. **Log minimization (P3-6):** Enhance PII redaction in audit logs beyond current token-focused patterns
5. **Plugin allowlist enforcement (P0-1a):** Already implemented - external plugins require explicit allowlist entry

## References

- [ADR-0001: WebSocket Gateway Architecture](decisions/0001-websocket-gateway.md)
- [ADR-0002: Per-Sender Session Model](decisions/0002-per-sender-sessions.md)
- [ADR-0004: Plugin Allowlist Enforcement](decisions/0004-plugin-allowlist-enforcement.md)
- [ADR-0005: Sandbox Defaults](decisions/0005-sandbox-defaults.md)
- [ADR-0006: Proxy Header Hardening](decisions/0006-proxy-header-hardening.md)
