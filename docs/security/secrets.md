# Secrets & Credentials Management

This document describes the security policies and best practices for managing secrets and credentials in openclaw.

## Storage Locations

### Primary Locations

| Type | Location | Permissions |
|------|----------|-------------|
| Main config | `~/.openclaw/openclaw.json` | 600 |
| Environment vars | `~/.openclaw/.env` | 600 |
| OAuth credentials | `~/.openclaw/credentials/oauth.json` | 600 |
| Agent auth profiles | `~/.openclaw/agents/<id>/agent/auth-profiles.json` | 600 |
| Backups | `~/Backups/openclaw/` | 700 (dirs), 600 (files) |

### Directory Permissions

All directories containing sensitive data must have `700` permissions:

```bash
chmod 700 ~/.openclaw
chmod 700 ~/.openclaw/credentials
chmod 700 ~/.openclaw/agents
chmod 700 ~/Backups/openclaw
```

## Environment Variables

### Recommended Approach

Store API keys in `~/.openclaw/.env` instead of directly in config files:

```bash
# ~/.openclaw/.env
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-proj-xxx
GOOGLE_PLACES_API_KEY=AIzaSyxxx
TELEGRAM_BOT_TOKEN=123456:ABCxxx
DISCORD_BOT_TOKEN=xxx
SLACK_BOT_TOKEN=xoxb-xxx
```

### Security Requirements

1. **File permissions**: `.env` must be `600` (owner read/write only)
2. **Never commit**: `.env` must be in `.gitignore`
3. **No sharing**: Never share `.env` files via email, chat, or public repos

## Channel Tokens

### Telegram

Preferred: Use environment variable
```json
{
  "channels": {
    "telegram": {
      "botToken": "${TELEGRAM_BOT_TOKEN}"
    }
  }
}
```

Alternative: Use tokenFile
```json
{
  "channels": {
    "telegram": {
      "tokenFile": "~/.openclaw/credentials/telegram.token"
    }
  }
}
```

### Discord / Slack

Same pattern - prefer env vars or tokenFile over inline tokens.

## What NOT to Do

❌ **Never store tokens directly in openclaw.json**
```json
{
  "channels": {
    "telegram": {
      "botToken": "123456:ABCxxx"  // BAD!
    }
  }
}
```

❌ **Never commit credentials to git**
- API keys
- Bot tokens
- OAuth secrets
- Database passwords

❌ **Never use 644/755 permissions on config files**

## Security Audit

Run the security audit to check your installation:

```bash
# Check for issues
./scripts/security-audit.sh --profile dev

# Auto-fix permission issues
./scripts/security-audit.sh --profile dev --fix
```

## Backup Security

Backups contain sensitive data and must be protected:

1. **Location**: `~/Backups/openclaw/` (local only, not in git)
2. **Permissions**: 700 for directories, 600 for files
3. **Rotation**: Keep 14 days by default
4. **Never upload**: Don't upload backups to cloud storage without encryption

## Incident Response

If credentials are leaked:

1. **Rotate immediately**: Generate new API keys/tokens
2. **Revoke old credentials**: In provider dashboards
3. **Audit access**: Check for unauthorized usage
4. **Update config**: Deploy new credentials
5. **Restart services**: Gateway, bot

## Checklist

- [ ] `~/.openclaw` directory is `700`
- [ ] `~/.openclaw/.env` is `600`
- [ ] `~/.openclaw/openclaw.json` is `600`
- [ ] `.env` is in `.gitignore`
- [ ] No secrets in repository
- [ ] Backups have restrictive permissions
- [ ] `./scripts/security-audit.sh` passes
