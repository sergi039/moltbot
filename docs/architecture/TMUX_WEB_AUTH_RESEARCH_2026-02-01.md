# Research: Web Auth + Local tmux for Bot Execution

Date: 2026-02-01  
Owner: Platform  
Audience: Architect #2

## Question
Can we avoid API keys and instead give the bot access to local tmux using web auth (Control UI / Gateway auth) for development, for both Codex and Claude Code?

## Summary (Short Answer)
**Partially.**  
Web auth (Control UI / Gateway auth) can secure access to the **Gateway**, but **does not replace model provider auth**.  
If you want to avoid API keys entirely, you must:

1) Use **local models**, or  
2) Use **subscription-based tokens** where supported (e.g., Anthropic setup-token).  

Web auth can protect **the control surface** and **CLI/tmux operations**, but it does **not eliminate provider credentials**.

## Evidence from Official Docs
1) Control UI (gateway dashboard) uses WS auth via `connect.params.auth.token/password`.  
   Tokens are stored in UI settings, password is not persisted.  
   Device identity is used when possible; token-only auth is allowed if explicitly enabled.  
2) Tailscale Serve can authenticate the Control UI via identity headers when enabled.  
3) FAQ: Claude Max/Pro can use a setup-token instead of API key (subscription path).  

## Architecture Options

### Option A — Keep API Keys (Current)
**Flow:** Bot → Gateway (token auth) → exec/tools → tmux session  
Pros: Stable, supported.  
Cons: Costly if using paid APIs.

### Option B — Subscription Tokens (Web Auth Alternative)
Use provider “setup-token” instead of API key where supported.  
Still a **provider credential**, but tied to subscription instead of API key.  
Best for Claude Max/Pro if policy permits.

### Option C — Local Models (No provider auth)
Run local inference; Gateway uses local provider (Ollama/LLM).  
Pros: No API keys, low cost.  
Cons: Lower quality, higher hardware requirements.

### Option D — Web Auth for Control Plane + Local Exec
Use web auth (Control UI / Tailscale Serve identity) to secure **control**,  
while the bot executes commands in tmux through the Gateway’s tools.  
Pros: Strong control surface security, no plaintext tokens in URLs.  
Cons: Still needs provider auth for remote models.

## Recommended Path (Dev)
1) Use **Control UI token or Tailscale Serve identity** for secure access.  
2) If cost is the issue, switch to **local models** or **subscription tokens**.  
3) Keep tmux access behind **exec approvals** and policy allowlists.

## Security Notes
- Control UI is an admin surface; never expose it publicly.  
- On non‑HTTPS, device identity is unavailable; token-only auth is a downgrade.  
- `gateway.auth.allowTailscale` enables identity-based auth via Serve headers.

## Decision
**Do not replace provider auth with web auth.**
Web auth secures the Gateway, but **model calls still require provider credentials** unless using local models.

---

## Architect #2 Analysis (2026-02-01)

### Existing Infrastructure

The codebase already has partial support for web-based auth:

```typescript
// src/infra/provider-usage.fetch.claude.ts
CLAUDE_AI_SESSION_KEY    // sk-ant-... from browser
CLAUDE_WEB_SESSION_KEY   // same
CLAUDE_WEB_COOKIE        // full cookie header with sessionKey

// src/infra/provider-usage.fetch.codex.ts
Authorization: Bearer ${token}  // from chatgpt.com session
ChatGPT-Account-Id: ${accountId}
```

### Cost Comparison (Estimate)

| Method | Cost/month | Quality | Complexity |
|--------|-----------|---------|------------|
| Claude API (Opus) | $50-500+ | Best | Low |
| Claude Pro subscription | $20/mo | Best (rate-limited) | Medium |
| ChatGPT Plus (Codex) | $20/mo | Good | Medium |
| Local (Ollama) | $0 | Lower | High |

### Practical Options for Dev

**Option 1: Browser Session Extraction (Semi-Automated)**
```bash
# Extract claude.ai session
CLAUDE_WEB_COOKIE=$(scripts/extract-browser-cookie.sh claude.ai sessionKey)
export CLAUDE_AI_SESSION_KEY="$CLAUDE_WEB_COOKIE"
```
Pros: Uses existing subscription, no API cost
Cons: Session expires (re-auth needed), ToS gray area

**Option 2: Setup-Token (Claude Code path)**
```bash
# Already supported via oauth flow
openclaw agents auth --provider anthropic --oauth
# Yields setup-token usable for inference
```
Pros: Official path, tied to Claude Max subscription
Cons: Rate limits apply

**Option 3: Codex via Browser Token**
```bash
# Extract chatgpt.com bearer token
export CODEX_ACCESS_TOKEN=$(scripts/extract-browser-token.sh chatgpt.com)
```
Pros: Uses ChatGPT Plus subscription
Cons: Token rotation, ToS concern

### tmux Integration

The bot already has tmux access via:
- `src/agents/tools/nodes-tool.ts` — exec in terminal
- `skills/tmux/` — tmux session management skill
- Gateway exec approvals — policy control

**Flow with web auth:**
```
User Browser → claude.ai/chatgpt.com (authenticated)
         ↓
Session Cookie → Gateway config (env var)
         ↓
Bot → Gateway → Model Provider (via session auth)
         ↓
Bot → tmux session (via exec tool)
```

### Risks

1. **ToS Violation**: Using browser session for automation may violate Terms of Service
2. **Session Expiry**: Web sessions expire; need refresh mechanism
3. **Rate Limits**: Subscription rate limits are strict (5h/7d windows)
4. **No SLA**: Consumer subscriptions have no uptime guarantees

### Recommendation

**For development/personal use:**
- Use setup-token (Claude) or Codex token extraction
- Accept rate limits as trade-off for lower cost
- Keep API keys for production/critical paths

**For production:**
- Stay on API keys (predictable cost, SLA)
- Consider Bedrock/Vertex for enterprise pricing

### Next Steps (If Proceeding)

1. [ ] Add `scripts/extract-browser-session.sh` for cookie extraction
2. [ ] Document session refresh flow
3. [ ] Add rate-limit awareness to model selection
4. [ ] Test with Claude Pro + Codex Plus subscriptions

---

**Status**: Research complete. Decision: Use subscription tokens for dev, API keys for prod.

