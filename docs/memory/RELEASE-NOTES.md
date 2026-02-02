# Facts Memory System — Release Notes

**Version:** 1.0.0
**Release Date:** 2026-02-01
**Status:** Production Ready

---

## Overview

The Facts Memory System is a complete long-term memory solution for OpenClaw, enabling persistent storage and retrieval of user facts, preferences, decisions, events, and todos. This release includes all 8 phases of development.

---

## Features

### Core Memory (Phase 1-2)

- **SQLite Storage** with FTS5 full-text search and WAL mode
- **Memory Types:**
  - `fact` — objective information about the user
  - `preference` — user preferences and likes/dislikes
  - `decision` — decisions made by or for the user
  - `event` — notable events and milestones
  - `todo` — tasks and reminders
- **Memory Blocks:** persona, user_profile, active_context
- **Supersession Chain:** facts can be updated without losing history
- **LLM Extraction:** automatic fact extraction from conversations
- **Smart Retrieval:** combines FTS, importance scoring, and recency
- **Consolidation:** daily and weekly summaries

### Reliability (Phase 3-5)

- **Pipeline Integration:** seamless extraction and retrieval in reply flow
- **Connection Pooling:** efficient SQLite connection management
- **Repair Tools:** integrity check, FTS reindex, vacuum
- **Export/Import:** JSONL format for backup and migration
- **Explainability:** trace mode shows why facts were retrieved

### Safety & Governance (Phase 6)

- **Redaction:** mask sensitive data in exports (email, phone, API keys, etc.)
- **Role-Based Access Control:**
  - `admin` — full access to all memory types
  - `operator` — all types except internal
  - `analyst` — facts and events only
  - `guest` — facts only
- **Audit Logging:** all access and modifications logged

### Operations & Monitoring (Phase 7)

- **Health Checks:** daily automated health snapshots
- **Alerts:** threshold-based alerts for db size, errors, staleness
- **CLI Commands:** `health`, `alerts`, `stats` for operations

### UI & Administration (Phase 8)

- **Dashboard Integration:**
  - Memory status panel (enabled, size, facts count, alerts)
  - Top facts table with filters
  - Search with trace (explainability)
- **Admin Actions:**
  - Delete individual facts
  - Update importance scores
  - Merge duplicate facts
- **HTTP API:** complete REST API for all operations

---

## Configuration

Add to `~/.clawdbot/config.yaml`:

```yaml
factsMemory:
  enabled: true

  extraction:
    model: "haiku"                    # LLM model for extraction
    maxMessagesPerExtraction: 10      # Max messages per batch
    cooldownMs: 60000                 # Min time between extractions

  retrieval:
    maxFacts: 20                      # Max facts in context
    maxTokens: 2000                   # Token budget for context

  retention:
    maxAgeDays: 365                   # Max age before pruning
    maxSizeMb: 100                    # Max database size
    pruneLowImportance: true          # Prune low-importance facts first

  health:
    maxDbSizeMb: 500                  # Alert threshold for DB size
    maxErrorsPerDay: 10               # Alert threshold for errors
    maxStaleDays: 7                   # Alert if no extraction for N days

  # Optional: Role-based access control
  access:
    enabled: false
    defaultRole: "operator"

  # Optional: Redaction patterns for export
  redaction:
    enabled: true
    patterns:
      - EMAIL
      - PHONE
      - API_KEY
```

### Minimal Configuration

For quick start with defaults:

```yaml
factsMemory:
  enabled: true
```

---

## Migration Guide

### From Fresh Install

No migration needed. The system creates the database automatically on first use.

### From MEMORY.md

If you have an existing `MEMORY.md` file:

```bash
# Migrate existing memories
moltbot memory facts migrate --source ~/.clawdbot/MEMORY.md

# Verify migration
moltbot memory facts stats
```

### From Previous Versions

If upgrading from a development version:

1. **Backup existing data:**
   ```bash
   moltbot memory facts export --out ~/backup-pre-upgrade.jsonl
   ```

2. **Update OpenClaw:**
   ```bash
   npm install -g openclaw@latest
   ```

3. **Run repair** (ensures schema is current):
   ```bash
   moltbot memory facts repair --check --reindex
   ```

4. **Verify:**
   ```bash
   moltbot memory facts health
   ```

---

## API Reference

### CLI Commands

| Command | Description |
|---------|-------------|
| `moltbot memory facts stats` | Show statistics |
| `moltbot memory facts health` | Health check |
| `moltbot memory facts alerts` | View recent alerts |
| `moltbot memory facts top` | List top facts |
| `moltbot memory facts trace "query"` | Search with explainability |
| `moltbot memory facts cleanup` | Run retention cleanup |
| `moltbot memory facts export` | Export to JSONL |
| `moltbot memory facts import` | Import from JSONL |
| `moltbot memory facts repair` | Database repair |

### HTTP Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/memory/facts/status` | Memory status |
| GET | `/api/memory/facts/top` | Top facts list |
| GET | `/api/memory/facts/trace` | Search with trace |
| POST | `/api/memory/facts/delete` | Delete a fact |
| POST | `/api/memory/facts/update` | Update importance |
| POST | `/api/memory/facts/merge` | Merge two facts |

---

## Breaking Changes

None. This is the initial production release.

---

## Known Limitations

1. **Single-User Design:** The current implementation assumes a single user per instance. Multi-user support would require schema changes.

2. **SQLite Concurrency:** While WAL mode helps, very high concurrency may cause brief lock contention.

3. **Embedding Fallback:** Vector similarity search falls back to FTS when embeddings are unavailable.

4. **LLM Dependency:** Extraction requires a working LLM connection. Extraction failures are logged but don't block the reply pipeline.

---

## Rollback Procedure

If issues occur after deployment:

1. **Disable memory system:**
   ```bash
   moltbot config set factsMemory.enabled false
   ```

2. **Restart gateway:**
   ```bash
   pkill -f "openclaw gateway"
   nohup openclaw gateway run > /tmp/openclaw-gateway.log 2>&1 &
   ```

3. **Restore from backup** (if data corruption):
   ```bash
   moltbot memory facts import --in ~/backup-pre-upgrade.jsonl --replace
   ```

---

## Verification Checklist

After deployment, verify:

- [ ] `moltbot memory facts health` returns `ok`
- [ ] `moltbot memory facts stats` shows expected values
- [ ] Dashboard shows Memory Status panel
- [ ] Search returns results for known content
- [ ] New messages trigger extraction (check logs)

---

## Support

- **Documentation:** `docs/memory/OPERATIONS.md`
- **Runbook:** `docs/memory/RUNBOOK.md`
- **Roadmap:** `docs/memory/ROADMAP.md`
- **Release Plan:** `docs/DEPLOYMENT.md` (section "Release plan (Dev → Prod)")

---

## Changelog

### 1.0.0 (2026-02-01)

**Phase 1: Core Memory System**
- SQLite schema with FTS5 and WAL
- Memory types: fact, preference, decision, event, todo
- Memory blocks: persona, user_profile, active_context
- LLM-based extraction
- Rule-based classifier

**Phase 2: Retrieval + Consolidation**
- Query-time retrieval with FTS + scoring
- Daily and weekly consolidation
- Importance-based pruning

**Phase 3: Integration + Reliability**
- Pipeline integration hooks
- SQLite connection pooling
- Embeddings with fallback
- MEMORY.md migration tool
- Scheduler for background jobs

**Phase 4: Retention + Guardrails**
- Retention policies (age, size, importance)
- Extraction guardrails (rate limits, cooldown)
- CLI: stats, cleanup commands

**Phase 5: Reliability + Explainability**
- Database repair (integrity, reindex, vacuum)
- JSONL export/import
- Retrieval trace (explainability)
- CLI: trace, top commands

**Phase 6: Safety + Governance**
- Redaction-safe export
- Role-based access control (admin, operator, analyst, guest)
- Access audit logging

**Phase 7: Ops + Monitoring**
- Health check snapshots
- Threshold-based alerts
- CLI: health, alerts commands
- Dashboard status integration

**Phase 8: UX + Productization**
- UI: Memory status panel
- UI: Top facts table with filters
- UI: Per-fact actions (delete, update, merge)
- UI: Search with trace panel
- HTTP API for all operations
- 200+ tests covering all features
