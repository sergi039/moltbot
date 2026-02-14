# ADR-0006: Proxy Header Hardening

- **Status:** accepted
- **Date:** 2026-02-07
- **Authors:** Security team

## Context

The OpenClaw gateway serves HTTP and WebSocket traffic that may pass through reverse proxies (Tailscale Serve/Funnel, nginx, Cloudflare, etc.). Proxy headers like `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Real-IP` are used to determine the original client's IP address, protocol, and other connection metadata.

Key concerns:
1. An attacker can spoof proxy headers when connecting directly to the gateway, potentially bypassing IP-based access controls or logging incorrect client IPs
2. The gateway must distinguish between trusted proxy-injected headers and attacker-supplied headers
3. Tailscale Serve is the primary recommended proxy, which has a known and trusted header behavior
4. The gateway binds to loopback by default (`--bind loopback`), which limits direct external access

## Decision

Apply the following proxy header hardening rules:

1. **Trust proxy headers only from loopback by default** - When the gateway receives a request from `127.0.0.1` or `::1`, proxy headers are trusted (this covers Tailscale Serve and local reverse proxies). For all other source IPs, proxy headers are stripped/ignored and the direct connection IP is used.

2. **Configurable trusted proxies** - Operators can configure `gateway.trustedProxies` (array of CIDR ranges) for deployments behind known reverse proxies on non-loopback addresses. This is opt-in and empty by default.

3. **Header sanitization** - When proxy headers are not trusted:
   - `X-Forwarded-For` is removed from the request before processing
   - `X-Forwarded-Proto` is ignored; the actual connection protocol is used
   - `X-Real-IP` is ignored; the socket remote address is used

4. **Logging** - All requests log both the apparent client IP (from headers when trusted, from socket otherwise) and the direct connection IP. This ensures audit trails are accurate regardless of proxy configuration.

5. **Default bind to loopback** - The `--bind loopback` default ensures the gateway is not directly accessible from the network, requiring a trusted proxy (Tailscale Serve) for remote access.

## Consequences

### Positive

- Prevents IP spoofing via proxy header injection
- Accurate audit logs regardless of proxy configuration
- Secure by default (loopback + Tailscale Serve is the recommended setup)
- Configurable for non-standard proxy deployments

### Negative

- Operators behind non-standard proxies must configure `trustedProxies` explicitly
- The default loopback bind prevents direct LAN access (by design, but may surprise some users)

### Neutral

- Tailscale Serve/Funnel deployments work correctly out of the box
- The header behavior is consistent with Express.js `trust proxy` semantics

## Alternatives Considered

### Always trust proxy headers

Trust all proxy headers regardless of source. Rejected because it allows trivial IP spoofing from any client.

### Never trust proxy headers

Always use the direct socket IP. Rejected because it breaks Tailscale Serve and all reverse proxy deployments - the gateway would always see `127.0.0.1` as the client.

### Use a shared secret header

Require proxies to include a secret header value to prove they are trusted. Rejected as unnecessary complexity - the loopback + CIDR allowlist approach is simpler and sufficient.

## References

- [Gateway Configuration](https://docs.openclaw.ai/gateway)
- [Tailscale Serve Integration](https://docs.openclaw.ai/gateway#tailscale)
- [Threat Model - Web UI to Gateway](../threat-model.md#tb-4-web-ui-to-gateway)
- [OWASP: HTTP Host Header Attacks](https://owasp.org/www-project-web-security-testing-guide/)
