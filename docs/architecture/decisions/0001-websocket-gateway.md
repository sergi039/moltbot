# ADR-0001: WebSocket Gateway Architecture

- **Status:** accepted
- **Date:** 2024-01-15
- **Authors:** OpenClaw Team

## Context

OpenClaw needs a communication layer between the gateway (central hub) and various clients:
- Native apps (macOS, iOS, Android)
- Web UI (Control Panel)
- Channel plugins (Telegram, Discord, WhatsApp, etc.)
- CLI tools

Requirements:
1. Real-time bidirectional communication for streaming responses
2. Low latency for interactive AI conversations
3. Support for long-running operations (tool execution, thinking)
4. Connection state awareness (detect disconnects quickly)
5. Single port for all communication

## Decision

Use WebSocket as the primary transport protocol for the gateway server, with HTTP endpoints for specific use cases (hooks, health checks, static assets).

The gateway runs on a single port (default: 18789) and handles both WebSocket upgrades and HTTP requests through the same server.

### Protocol Design

```
Client <--WebSocket--> Gateway <--Internal--> Agent Runtime
         (JSON-RPC)              (Events)
```

- JSON-RPC-style message format for request/response patterns
- Event streaming for real-time updates (thinking, tool calls, partial responses)
- Heartbeat mechanism for connection health
- Reconnection with session resumption

## Consequences

### Positive

- **Real-time streaming**: Native support for streaming AI responses token-by-token
- **Bidirectional**: Gateway can push events without polling
- **Single connection**: Reduces overhead vs multiple HTTP connections
- **State awareness**: Built-in ping/pong for connection health
- **Protocol flexibility**: Can add new message types without API versioning

### Negative

- **Complexity**: WebSocket connection management is more complex than REST
- **Debugging**: Harder to inspect than HTTP (need WebSocket-aware tools)
- **Proxy challenges**: Some proxies/firewalls may not support WebSocket
- **Reconnection logic**: Clients must handle reconnection and state sync

### Neutral

- HTTP endpoints still available for webhooks and static content
- Tailscale Serve/Funnel works well with WebSocket

## Alternatives Considered

### HTTP/REST with Polling

Rejected because:
- High latency for real-time updates
- Inefficient for streaming responses
- Poor UX for long-running operations

### HTTP/2 Server-Sent Events (SSE)

Rejected because:
- Unidirectional only (server to client)
- Would need separate HTTP endpoint for client-to-server
- Less mature client library support

### gRPC

Rejected because:
- Adds complexity (protobuf compilation)
- Browser support requires grpc-web proxy
- Overkill for our use case

## References

- [WebSocket RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)
- [Gateway Architecture](/docs/gateway/architecture.md)
- [Protocol Documentation](/docs/gateway/protocol.md)
