# Facts Memory System — Operational Runbook

This runbook covers day-to-day operations, monitoring, incident response, and maintenance procedures for the Facts Memory System.

---

**Related docs:**
- [Release Plan](/DEPLOYMENT#release-plan-dev--prod) — production deployment steps
- [Release Notes](/memory/RELEASE-NOTES) — changelog, migration guide

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Health Monitoring](#health-monitoring)
3. [Daily Operations](#daily-operations)
4. [Alert Response](#alert-response)
5. [Backup & Restore](#backup--restore)
6. [Troubleshooting](#troubleshooting)
7. [Emergency Procedures](#emergency-procedures)
8. [Maintenance Windows](#maintenance-windows)

---

## Critical Config Keys (Must Persist)

These configuration keys are **protected by guardrails** and must never be lost during config writes. If a config update would remove these keys, the guardrail automatically preserves them.

| Key | Purpose | Required For |
|-----|---------|--------------|
| `gateway.mode` | Gateway operation mode | Gateway startup (must be `"local"`) |
| `gateway.auth.token` | Authentication token | Gateway web UI access |
| `channels.telegram.enabled` | Telegram channel toggle | Telegram bot operation |
| `env.TELEGRAM_BOT_TOKEN` | Telegram bot API token | Telegram bot authentication |

### Verification

Run the recovery test suite to verify these keys are present:

```bash
pnpm vitest run --config test/recovery/vitest.config.ts
```

Or check manually:

```bash
# Check gateway mode
pnpm openclaw config get gateway.mode

# Check gateway token exists
pnpm openclaw config get gateway.auth.token

# Check Telegram token
pnpm openclaw config get env.TELEGRAM_BOT_TOKEN
```

### Recovery

If any of these keys are missing, restore from backup or set manually:

```bash
# Set gateway mode
pnpm openclaw config set gateway.mode local

# Generate and set gateway token
pnpm openclaw config set gateway.auth.token "$(openssl rand -hex 16)"

# Set Telegram token (from backup file if available)
pnpm openclaw config set env.TELEGRAM_BOT_TOKEN "$(cat ~/.openclaw/telegram/bot-token.txt)"

# Enable Telegram channel
pnpm openclaw config set channels.telegram.enabled true
```

---

## System Overview

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Gateway Process                         │
├─────────────────────────────────────────────────────────────┤
│  Reply Pipeline                                              │
│    ├── extractMemories() ──► Extractor (LLM)                │
│    └── getRelevantContext() ──► Retrieval (FTS + scoring)   │
├─────────────────────────────────────────────────────────────┤
│  Scheduler                                                   │
│    ├── Consolidation (daily/weekly)                         │
│    ├── Cleanup (retention policy)                           │
│    └── Health check (daily)                                 │
├─────────────────────────────────────────────────────────────┤
│  HTTP API (/api/memory/facts/*)                             │
│    ├── GET /status, /top, /trace                            │
│    └── POST /delete, /update, /merge                        │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  SQLite Database (~/.clawdbot/memory/facts.db)              │
│    ├── memories table (facts, preferences, decisions, etc.) │
│    ├── memory_blocks table (persona, user_profile, context) │
│    ├── memories_fts (FTS5 full-text search)                 │
│    └── WAL mode enabled                                     │
└─────────────────────────────────────────────────────────────┘
```

### Key Paths

| Path | Description |
|------|-------------|
| `~/.clawdbot/memory/facts.db` | SQLite database |
| `~/.clawdbot/memory/facts.db-wal` | WAL journal |
| `~/.clawdbot/memory/facts.db-shm` | Shared memory |
| `~/.clawdbot/backups/` | Recommended backup location |

### Configuration

Key config sections in `~/.clawdbot/config.yaml`:

```yaml
factsMemory:
  enabled: true
  extraction:
    model: "haiku"
    maxMessagesPerExtraction: 10
    cooldownMs: 60000
  retrieval:
    maxFacts: 20
    maxTokens: 2000
  retention:
    maxAgeDays: 365
    maxSizeMb: 100
    pruneLowImportance: true
  health:
    maxDbSizeMb: 500
    maxErrorsPerDay: 10
    maxStaleDays: 7
  access:
    enabled: false
    defaultRole: "operator"
```

---

## Health Monitoring

### CLI Commands

```bash
# Quick health check
moltbot memory facts health

# Health check with exit code (for scripts/monitoring)
moltbot memory facts health --check

# View recent alerts
moltbot memory facts alerts

# Detailed stats
moltbot memory facts stats
```

### Health Status Levels

| Status | Meaning | Action |
|--------|---------|--------|
| `ok` | All metrics within thresholds | None |
| `warning` | One or more soft thresholds exceeded | Review alerts |
| `critical` | Hard threshold exceeded or system error | Immediate action |
| `disabled` | Memory system disabled in config | Expected if intentional |

### Key Metrics

| Metric | Warning Threshold | Critical Threshold |
|--------|-------------------|-------------------|
| `dbSizeMb` | 80% of maxDbSizeMb | 100% of maxDbSizeMb |
| `extractionErrors` | 5/day | 10/day |
| `staleDays` | 3 days | 7 days |
| `alertCount` | 1+ | 5+ |

### Monitoring Integration

Health events are logged with structured data:

```
[memory-health] Health check  { event: "memory.health", status: "ok", dbSizeMb: 45.2, totalFacts: 1234 }
[memory-health] Alert  { event: "memory.alert", type: "db_size", message: "Database approaching limit" }
```

Filter logs:
```bash
grep "memory.health\|memory.alert" /var/log/openclaw/gateway.log
```

---

## Daily Operations

### Morning Checklist

1. **Health check**
   ```bash
   moltbot memory facts health --check
   echo $?  # 0 = ok, 1 = warning/critical
   ```

2. **Review alerts**
   ```bash
   moltbot memory facts alerts --json | jq '.alerts | length'
   ```

3. **Check extraction activity**
   ```bash
   moltbot memory facts stats --json | jq '.lastExtractionAt'
   ```

### Update Policy (CRITICAL)

**Auto-updates are DISABLED in production.** The gateway runs from `release/memory-v1` only.

Update chain:
```
upstream/main → main (mirror) → dev → release/memory-v1 → prod
```

Rules:
- **NO auto-pull** in prod repo
- Daily cron only does `git fetch` + notification (no apply)
- All updates require manual merge into `release/memory-v1`
- Gateway preflight blocks startup if branch != `release/memory-v1`

Before any cron or check, note the SHA:
```bash
cd ~/openclaw-prod
SHA_BEFORE=$(git rev-parse HEAD)
# ... run check ...
SHA_AFTER=$(git rev-parse HEAD)
[[ "$SHA_BEFORE" == "$SHA_AFTER" ]] && echo "OK: no change" || echo "ERROR: SHA changed!"
```

See: [DEPLOYMENT.md#update-policy-critical](/DEPLOYMENT#update-policy-critical)

### Weekly Maintenance

1. **Run cleanup** (if not automated)
   ```bash
   moltbot memory facts cleanup --force
   ```

2. **Vacuum database** (reclaim space)
   ```bash
   moltbot memory facts repair --vacuum
   ```

3. **Verify backups**
   ```bash
   ls -la ~/.clawdbot/backups/facts-*.jsonl | tail -5
   ```

### Monthly Maintenance

1. **Full integrity check**
   ```bash
   moltbot memory facts repair --check
   ```

2. **Review top facts** (data quality)
   ```bash
   moltbot memory facts top --limit 50 --json | jq '.items[].content'
   ```

3. **Audit access logs** (if RBAC enabled)
   ```bash
   grep "memory.access" /var/log/openclaw/gateway.log | tail -100
   ```

---

## Alert Response

### Alert: `db_size_warning`

**Symptom:** Database approaching size limit.

**Response:**
1. Check current size:
   ```bash
   moltbot memory facts stats --json | jq '.dbSizeMb'
   ```

2. Run cleanup:
   ```bash
   moltbot memory facts cleanup --force --vacuum
   ```

3. If still high, review retention policy:
   ```bash
   moltbot config get factsMemory.retention
   ```

4. Consider lowering `maxAgeDays` or enabling `pruneLowImportance`.

### Alert: `extraction_errors`

**Symptom:** Too many extraction failures.

**Response:**
1. Check recent errors:
   ```bash
   grep "extraction.*error\|extractor.*fail" /var/log/openclaw/gateway.log | tail -20
   ```

2. Common causes:
   - LLM provider rate limits
   - Invalid API key
   - Network issues

3. Verify LLM connectivity:
   ```bash
   moltbot models status
   ```

4. If persistent, increase `cooldownMs` in config.

### Alert: `stale_data`

**Symptom:** No extractions for N days.

**Response:**
1. Check if gateway is running:
   ```bash
   pgrep -f "openclaw gateway"
   ```

2. Check scheduler status:
   ```bash
   grep "scheduler" /var/log/openclaw/gateway.log | tail -10
   ```

3. Manually trigger extraction:
   ```bash
   # Extraction happens automatically on messages
   # If no messages, this is expected
   ```

4. Verify `factsMemory.enabled: true` in config.

### Alert: `integrity_error`

**Symptom:** Database corruption detected.

**Response:**
1. Stop gateway:
   ```bash
   pkill -f "openclaw gateway"
   ```

2. Run repair:
   ```bash
   moltbot memory facts repair --check --reindex --vacuum
   ```

3. If repair fails, restore from backup:
   ```bash
   moltbot memory facts import --in ~/.clawdbot/backups/facts-latest.jsonl --replace
   ```

4. Restart gateway.

---

## Backup & Restore

### Automated Backup (Cron)

Add to crontab:
```bash
# Daily backup at 3 AM
0 3 * * * moltbot memory facts export --out ~/.clawdbot/backups/facts-$(date +\%Y\%m\%d).jsonl

# Weekly cleanup of old backups (keep 30 days)
0 4 * * 0 find ~/.clawdbot/backups -name "facts-*.jsonl" -mtime +30 -delete
```

### Manual Backup

```bash
# Full export
moltbot memory facts export --out ~/backup-facts-$(date +%Y%m%d-%H%M%S).jsonl

# Redacted export (for sharing)
moltbot memory facts export --out ~/backup-redacted.jsonl --redact

# Filtered export
moltbot memory facts export --out ~/backup-facts-only.jsonl --exclude-types preference,decision
```

### Restore Procedures

**Full restore (replace all data):**
```bash
# Stop gateway first
pkill -f "openclaw gateway"

# Import with replace
moltbot memory facts import --in ~/backup-facts.jsonl --replace

# Rebuild FTS index
moltbot memory facts repair --reindex

# Restart gateway
```

**Merge restore (add missing):**
```bash
# No need to stop gateway
moltbot memory facts import --in ~/backup-facts.jsonl --merge
```

### Backup Verification

```bash
# Check backup file
wc -l ~/backup-facts.jsonl  # Count entries
head -1 ~/backup-facts.jsonl | jq .  # Verify JSON format

# Test restore to temp DB
CLAWDBOT_HOME=/tmp/test-restore moltbot memory facts import --in ~/backup-facts.jsonl --replace
CLAWDBOT_HOME=/tmp/test-restore moltbot memory facts stats
```

### Full System Backup (Recommended)

The dedicated backup scripts provide complete data protection including sessions history:

```bash
# Full backup (config, cron, skills, memory, sessions, workflows)
scripts/backup-openclaw.sh --profile default

# Dry-run restore (verify what would be restored)
scripts/restore-openclaw.sh --dry-run

# Full restore
scripts/restore-openclaw.sh --profile default
```

**Backup includes:**
| Component | Path | Description |
|-----------|------|-------------|
| Config | `openclaw.json` | Main configuration |
| Cron | `cron/` | Scheduled jobs |
| Skills | `skills/` | Custom skills |
| Telegram | `telegram/` | Bot tokens |
| Memory DBs | `memory/facts.db`, `memory/main.sqlite` | Facts + vector embeddings |
| Sessions | `agents/*/sessions/*.jsonl` | Full conversation history |
| Workflows | `workflows/` | Dev cycle workflows |

**Automated backup:**
```bash
# Install LaunchAgent for daily backups
launchctl load ~/Library/LaunchAgents/com.moltbot.backup.dev.plist
```

### Deployment Verification (2026-02-02)

**Branch:** `main` → `~/openclaw-prod`
**Commit:** `419135dc9`

**Verified:**
- Gateway startup: ✓ listening on port 18789
- Telegram: ✓ @SergioQuesada_bot running
- Cron jobs: ✓ 6 jobs, all status "ok"
- Memory facts: ✓ healthy
- Critical config keys: ✓ all protected keys present

**Key fixes deployed:**
- pi-packages 0.51.0 (API compatibility)
- 27 recovery tests (config guardrails verified)
- Config protection for `gateway.mode`, `auth.token`, `TELEGRAM_BOT_TOKEN`

---

## macOS Companion App Updates

The macOS app is a **client**. It updates independently from the Gateway.

Key points:
- Updating the macOS app does **not** update or overwrite the Gateway.
- New app features may require a newer Gateway.

Operational rule:
- Update Gateway from `main` (manual flow).
- Update the macOS app via official releases.

---

### Verification Report (2026-02-01)

**Goal:** Validate full backup/restore coverage including sessions history.

**Commands executed:**
```bash
# Verify backup contains sessions
ls ~/Backups/openclaw/default/2026-02-01/agents/dev/sessions/

# Dry-run restore and confirm sessions are included
scripts/restore-openclaw.sh --profile default --date 2026-02-01 --dry-run
```

**Results:**
- Backup contains `agents/*/sessions/*.jsonl` and `sessions.json`
- Dry-run restore reports: "Restoring agents (sessions history)"
- Memory DBs present in backup (`memory/facts.db`, `memory/main.sqlite`)

---

## Troubleshooting

### Problem: Memory not being extracted

**Diagnosis:**
```bash
# Check if enabled
moltbot config get factsMemory.enabled

# Check extraction config
moltbot config get factsMemory.extraction

# Check recent activity
grep "extractor\|extraction" /var/log/openclaw/gateway.log | tail -20
```

**Solutions:**
- Ensure `factsMemory.enabled: true`
- Check LLM model is configured and accessible
- Review `cooldownMs` (might be too high)
- Check `maxMessagesPerExtraction` (might be filtering all messages)

### Problem: Search returns no results

**Diagnosis:**
```bash
# Check FTS index
moltbot memory facts repair --check

# Test direct search
moltbot memory facts trace "test query" --json
```

**Solutions:**
```bash
# Rebuild FTS index
moltbot memory facts repair --reindex
```

### Problem: Database locked errors

**Diagnosis:**
```bash
# Check for multiple processes
lsof ~/.clawdbot/memory/facts.db

# Check WAL mode
sqlite3 ~/.clawdbot/memory/facts.db "PRAGMA journal_mode;"
```

**Solutions:**
- Ensure only one gateway instance is running
- If stuck, safely stop all processes and delete WAL files:
  ```bash
  pkill -f "openclaw gateway"
  rm ~/.clawdbot/memory/facts.db-wal ~/.clawdbot/memory/facts.db-shm
  ```

### Problem: High memory usage

**Diagnosis:**
```bash
# Check database size
moltbot memory facts stats --json | jq '.dbSizeMb'

# Check fact count
moltbot memory facts stats --json | jq '.totalFacts'
```

**Solutions:**
- Run cleanup: `moltbot memory facts cleanup --force --vacuum`
- Lower retention limits
- Enable `pruneLowImportance`

---

## Workflow Live Mode Verification

Use this checklist to validate Real Agent Integration (Phase 3b).

1) **Stub mode (default)** — completes without API keys:
```
moltbot workflow start --type dev-cycle --task "add feature" --repo .
```
Expected artifacts:
- `~/.clawdbot/workflows/<runId>/phases/01-planning/artifacts/plan.md`
- `~/.clawdbot/workflows/<runId>/phases/01-planning/artifacts/tasks.json`

2) **Live mode** — requires provider auth:
```
moltbot workflow start --type dev-cycle --task "add feature" --repo . --live
```
Expected artifacts:
- `~/.clawdbot/workflows/<runId>/phases/<n>-<phase>/handoff/`
- `~/.clawdbot/workflows/<runId>/phases/<n>-<phase>/session.jsonl`
- Orchestrator + observability logs:
  - `events.jsonl` (observability)
  - `orchestrator-events.jsonl` (orchestrator)

---

## Emergency Procedures

### Complete System Reset

**When to use:** Unrecoverable corruption, fresh start needed.

```bash
# 1. Stop gateway
pkill -f "openclaw gateway"

# 2. Backup current state (if possible)
cp ~/.clawdbot/memory/facts.db ~/emergency-backup-$(date +%s).db 2>/dev/null || true

# 3. Remove database
rm -f ~/.clawdbot/memory/facts.db*

# 4. Restart gateway (will create fresh DB)
nohup openclaw gateway run > /tmp/openclaw-gateway.log 2>&1 &

# 5. Verify
moltbot memory facts health
```

### Disable Memory System

**When to use:** Memory causing gateway issues, need to isolate.

```bash
# Disable in config
moltbot config set factsMemory.enabled false

# Restart gateway
pkill -f "openclaw gateway"
nohup openclaw gateway run > /tmp/openclaw-gateway.log 2>&1 &

# Verify disabled
moltbot memory facts health  # Should show "disabled"
```

### Emergency Cleanup

**When to use:** Disk space critical, need immediate relief.

```bash
# Aggressive cleanup
moltbot memory facts cleanup --force --vacuum

# If still need space, reduce retention
moltbot config set factsMemory.retention.maxAgeDays 30
moltbot memory facts cleanup --force --vacuum
```

---

## Maintenance Windows

### Recommended Schedule

| Task | Frequency | Duration | Impact |
|------|-----------|----------|--------|
| Health check | Daily | < 1s | None |
| Backup | Daily | 1-5 min | None |
| Cleanup | Weekly | 1-10 min | Minimal |
| Vacuum | Weekly | 1-30 min | DB locked briefly |
| Integrity check | Monthly | 1-5 min | None |
| FTS reindex | As needed | 5-30 min | Search unavailable |

### Before Maintenance

1. Notify stakeholders
2. Ensure recent backup exists
3. Check current health status
4. Plan rollback procedure

### After Maintenance

1. Verify health status
2. Test basic operations (search, extraction)
3. Check logs for errors
4. Document any issues found

---

## Appendix: Quick Reference

### CLI Commands

```bash
# Status & Health
moltbot memory facts stats
moltbot memory facts health [--check]
moltbot memory facts alerts [--json]

# Data Operations
moltbot memory facts top [--limit N] [--type TYPE]
moltbot memory facts trace "query" [--role ROLE] [--limit N]
moltbot memory facts cleanup [--force] [--vacuum]

# Backup & Restore
moltbot memory facts export --out FILE [--redact] [--exclude-types TYPES]
moltbot memory facts import --in FILE [--merge|--replace]

# Repair
moltbot memory facts repair [--check] [--reindex] [--vacuum]
```

### API Endpoints

```bash
# Status
curl http://localhost:18789/api/memory/facts/status

# Top facts
curl "http://localhost:18789/api/memory/facts/top?limit=10&type=fact"

# Search with trace
curl "http://localhost:18789/api/memory/facts/trace?query=test&limit=10"

# Actions (POST)
curl -X POST http://localhost:18789/api/memory/facts/delete -d '{"id":"fact-123"}'
curl -X POST http://localhost:18789/api/memory/facts/update -d '{"id":"fact-123","importance":0.9}'
curl -X POST http://localhost:18789/api/memory/facts/merge -d '{"sourceId":"fact-1","targetId":"fact-2"}'
```

### Log Patterns

```bash
# Health events
grep "memory.health" /var/log/openclaw/gateway.log

# Alerts
grep "memory.alert" /var/log/openclaw/gateway.log

# Extraction
grep "extractor\|extraction" /var/log/openclaw/gateway.log

# Access audit
grep "memory.access" /var/log/openclaw/gateway.log

# Actions
grep "memory.action" /var/log/openclaw/gateway.log
```
