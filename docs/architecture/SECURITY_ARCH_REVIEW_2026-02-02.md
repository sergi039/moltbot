# Security Architecture Review (2026-02-02)

Audience: Architect #1, Architect #2  
Scope: OpenClaw gateway + bot runtime on macOS

---

## Executive Summary

The system is functional but **operational security boundaries are weak**. The biggest risk is that the bot runs under a privileged user and has direct access to sensitive files (SSH keys, API keys, cloud credentials). This is not a code bug; it is an **architecture + operations** issue. The fix is to enforce **user isolation**, **secret scoping**, and **channel allowlists**.

Status: **High risk for public exposure**, acceptable for local/private use **only after P0 fixes**.

---

## Root Causes (Observed)

1) **No user isolation**
- Bot runs under the primary admin user with sudo access.
- Compromise of Telegram channel = full host compromise.

2) **Secrets accessible to bot**
- Anthropic/OpenAI keys and SSH keys accessible in default home dir.
- No restricted secrets directory.

3) **Weak channel allowlists**
- Telegram allowlists not enforced by default.
- `denyByDefault` missing.

4) **Single trust boundary**
- Gateway + tools + filesystem under one account with broad permissions.

---

## Risk Assessment

| Risk | Impact | Likelihood | Priority |
|------|--------|------------|----------|
| Bot runs as admin | Full host compromise | High | P0 |
| Secrets exposed in home dir | Credential exfiltration | High | P0 |
| Weak allowlists | Unauthorized access | Medium | P0 |
| No filesystem guard | Data leakage | Medium | P1 |
| No off-site backup | Recovery risk | Medium | P2 |

---

## P0 Actions (Immediate)

1) **Dedicated bot user**
- Create `openclawbot` (non-admin, no sudo).
- Run gateway under this user.

2) **Secrets isolation**
- Move API keys to `/Users/openclawbot/.config/` (chmod 700).
- Ensure `openclawbot` owns only required secrets.

3) **Telegram allowlists**
- Set:
  - `channels.telegram.denyByDefault = true`
  - `channels.telegram.allowedUsers = ["<chat_id>"]`

---

## P1 Actions (1 week)

1) **Tool policy tightening**
- Limit `exec` and filesystem to allowlist.
- Deny network by default; add explicit allowlist.

2) **Workspace minimization**
- Restrict workspace paths (read-only where possible).

3) **Role separation**
- Separate operator token from bot token.

---

## P2 Actions (1 month)

1) **Filesystem guard**
- Enforce path allowlist in runtime policy.

2) **Off-site backup**
- Add S3/rsync backup for state + memory DB.

3) **ADR**
- Document security baseline and threat model in `docs/architecture/decisions/`.

---

## Acceptance Criteria

P0 complete when:
- Gateway runs under `openclawbot`
- API keys moved to dedicated secrets dir
- Telegram deny-by-default + allowlist enforced

---

## Notes for Architect #2

This is primarily **operational hardening**, not a code refactor.  
The system becomes production-grade for local/private use **after P0**.

