# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for OpenClaw.

## What is an ADR?

An ADR is a document that captures an important architectural decision made along with its context and consequences.

## Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0000](0000-adr-template.md) | ADR Template | - | - |
| [0001](0001-websocket-gateway.md) | WebSocket Gateway Architecture | accepted | 2024-01-15 |
| [0002](0002-per-sender-sessions.md) | Per-Sender Session Model | accepted | 2024-02-01 |
| [0003](0003-sqlite-facts-memory.md) | SQLite for Facts Memory | accepted | 2024-06-01 |

## Status Definitions

- **proposed**: Under discussion, not yet decided
- **accepted**: Approved and in effect
- **deprecated**: No longer recommended, but may still be in use
- **superseded**: Replaced by a newer ADR (reference the replacement)

## Creating a New ADR

1. Copy `0000-adr-template.md` to a new file with the next number
2. Fill in the template sections
3. Set status to `proposed`
4. Submit for review
5. Update status to `accepted` when approved
6. Add to the index table above

## References

- [ADR GitHub Organization](https://adr.github.io/)
- [Documenting Architecture Decisions (Michael Nygard)](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
