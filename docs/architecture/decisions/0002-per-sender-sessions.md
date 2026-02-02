# ADR-0002: Per-Sender Session Model

- **Status:** accepted
- **Date:** 2024-02-01
- **Authors:** OpenClaw Team

## Context

OpenClaw handles messages from multiple channels (WhatsApp, Telegram, Discord, etc.) and needs to maintain conversation context. Key requirements:

1. Preserve context across messages from the same sender
2. Isolate conversations between different users
3. Support both DMs and group chats
4. Allow shared context when appropriate (e.g., main session)
5. Persist sessions across gateway restarts

## Decision

Implement a flexible session scoping system with the following hierarchy:

```
Session Key = {provider}:{scope}:{identifier}

Examples:
- whatsapp:dm:+1234567890     (DM with specific user)
- telegram:group:123456       (Telegram group)
- discord:channel:987654      (Discord channel)
- internal:main:main          (Main shared session)
```

### Session Scope Options

Configure via `session.dmScope`:

| Scope | Behavior | Use Case |
|-------|----------|----------|
| `main` | All DMs share main session | Single-user personal assistant |
| `per-channel-peer` | Separate session per sender per channel | Multi-user with isolation |
| `per-account-channel-peer` | Separate by account + channel + sender | Multi-account setups |

### Storage

Sessions are stored as JSONL files under:
```
~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
```

Each line is a timestamped message with full context (role, content, tool calls, usage).

## Consequences

### Positive

- **Privacy**: Users don't see each other's conversations by default
- **Context preservation**: Long conversations maintain full history
- **Flexibility**: Configurable scoping for different deployments
- **Auditability**: Full transcript in human-readable JSONL
- **Resumption**: Sessions persist across restarts

### Negative

- **Storage growth**: Sessions can grow large over time
- **No cross-session context**: Insights from one session don't transfer
- **Session key complexity**: Key format requires careful handling
- **Migration complexity**: Changing scope requires session migration

### Neutral

- Session summarization added to manage context window limits
- Cleanup/rotation policy configurable but not enforced by default

## Alternatives Considered

### Single Global Session

Rejected because:
- Privacy concerns with multiple users
- Context pollution between unrelated conversations
- Difficult to reason about in group settings

### Database-Backed Sessions

Rejected because:
- JSONL is simpler and human-readable
- Easy to backup/restore/inspect
- SQLite later added specifically for Facts Memory (structured data)
- Session data is append-only, JSONL is optimal

### Per-Message Context (Stateless)

Rejected because:
- Loses conversation continuity
- Higher API costs (full context every message)
- Poor user experience for multi-turn conversations

## References

- [Session Configuration](/docs/configuration#session)
- [Session Logs Skill](/skills/session-logs/SKILL.md)
