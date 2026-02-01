# Facts Memory Operations

This document covers operational aspects of the facts memory system: configuration, cleanup, guardrails, and troubleshooting.

Roadmap and backlog: [/memory/ROADMAP](/memory/ROADMAP)
Deployment rules (dev vs prod): [/DEPLOYMENT](/DEPLOYMENT)
SRE runbook: [/memory/RUNBOOK](/memory/RUNBOOK)
Release notes: [/memory/RELEASE-NOTES](/memory/RELEASE-NOTES)

## Configuration

Facts memory is configured in `openclaw.json` under the `factsMemory` key:

```json
{
  "factsMemory": {
    "enabled": true,
    "dbPath": "~/.clawdbot/memory/facts.db",
    "markdownPath": "~/.clawdbot/memory",
    "extraction": {
      "enabled": true,
      "provider": "openai",
      "model": "gpt-4o-mini"
    },
    "limits": {
      "maxMessages": 25,
      "maxFacts": 50,
      "maxTokens": 1500,
      "cooldownMs": 30000
    },
    "retention": {
      "maxAgeDays": 90,
      "maxSizeMb": 500,
      "pruneLowImportance": true,
      "minImportance": 0.2,
      "truncateSummariesDays": 60
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable facts memory system |
| `dbPath` | string | `~/.clawdbot/memory/facts.db` | SQLite database path |
| `markdownPath` | string | `~/.clawdbot/memory` | Directory for markdown exports |

#### Extraction Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `extraction.enabled` | boolean | `true` | Enable LLM-based extraction |
| `extraction.provider` | string | - | LLM provider (e.g., `openai`, `anthropic`) |
| `extraction.model` | string | - | Model ID for extraction |

#### Guardrail Limits

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limits.maxMessages` | number | `25` | Maximum messages per extraction batch |
| `limits.maxFacts` | number | `50` | Maximum facts extracted per batch |
| `limits.maxTokens` | number | `1500` | Token budget per extraction |
| `limits.cooldownMs` | number | `30000` | Cooldown between extractions (ms) |

#### Retention Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `retention.maxAgeDays` | number | `90` | Maximum age for memories |
| `retention.maxSizeMb` | number | `500` | Maximum database size |
| `retention.pruneLowImportance` | boolean | `false` | Auto-prune low importance |
| `retention.minImportance` | number | `0.2` | Minimum importance threshold |
| `retention.truncateSummariesDays` | number | `60` | Days before truncating summaries |

## CLI Commands

### Status

Check operational status of facts memory:

```bash
moltbot memory facts status
moltbot memory facts status --json
```

Shows:
- Enabled/disabled state
- Extraction configuration
- Database path, size, and fact count
- FTS availability
- Guardrail limits

### Statistics

View detailed statistics:

```bash
moltbot memory facts stats
moltbot memory facts stats --json
```

Shows:
- Database metrics (size, total memories, old/low-importance counts)
- Summary counts (daily/weekly)
- Extraction telemetry (added/updated/deleted/skipped, avg latency)

### Cleanup

Clean up old memories based on retention policy:

```bash
# Dry run - show what would be deleted
moltbot memory facts cleanup --dry-run

# Run cleanup with confirmation
moltbot memory facts cleanup

# Skip confirmation
moltbot memory facts cleanup --force

# Custom options
moltbot memory facts cleanup --max-age-days 60 --prune-low-importance --vacuum
```

Options:
- `--dry-run, -n`: Preview without deleting
- `--max-age-days <days>`: Override max age
- `--max-size-mb <mb>`: Override max size
- `--prune-low-importance`: Prune low importance memories
- `--min-importance <value>`: Importance threshold (0-1)
- `--truncate-summaries`: Delete old summary files
- `--truncate-summaries-days <days>`: Days threshold for summaries
- `--vacuum`: Vacuum database after cleanup
- `--force, -f`: Skip confirmation prompt
- `--json`: Output as JSON

### Top Facts

View top facts by importance and recency:

```bash
moltbot memory facts top
moltbot memory facts top --limit 20
moltbot memory facts top --json
```

Shows facts sorted by a combined score of importance and recency decay.

### Trace (Explainability)

Understand why specific memories are retrieved for a query:

```bash
moltbot memory facts trace "user's work"
moltbot memory facts trace "preferences" --limit 5
moltbot memory facts trace "coding style" --json
```

Shows:
- Query and timestamp
- Total memories considered vs included
- For each retrieved memory:
  - Source (fts, importance, recency)
  - Score
  - Content snippet
  - Metadata (importance, access count, FTS score)
- Generated context string

This is useful for debugging retrieval quality and understanding why certain memories are surfaced.

### Repair

Diagnose and repair the facts memory database:

```bash
# Run integrity check (default)
moltbot memory facts repair

# Run integrity check explicitly
moltbot memory facts repair --check

# Rebuild FTS index
moltbot memory facts repair --reindex

# Vacuum database
moltbot memory facts repair --vacuum

# Run all operations
moltbot memory facts repair --check --reindex --vacuum
```

Options:
- `--check`: Run SQLite integrity check
- `--reindex`: Rebuild FTS5 full-text search index
- `--vacuum`: Reclaim unused space in database
- `--json`: Output as JSON

### Export

Export facts memory to JSONL file for backup or migration:

```bash
moltbot memory facts export --out ~/backup/facts.jsonl
moltbot memory facts export --out /tmp/facts.jsonl --json
```

Exports:
- All memory entries with full metadata
- Memory blocks (persona, user_profile, active_context)
- Daily and weekly summaries
- Export metadata (timestamp, version)

### Import

Import facts memory from JSONL file:

```bash
# Merge with existing data (default, skips duplicates)
moltbot memory facts import --in ~/backup/facts.jsonl

# Replace existing data (clears database first)
moltbot memory facts import --in ~/backup/facts.jsonl --replace

# Skip confirmation for replace mode
moltbot memory facts import --in ~/backup/facts.jsonl --replace --force
```

Options:
- `--in <path>`: Input JSONL file (required)
- `--merge`: Merge with existing data, skip duplicates (default)
- `--replace`: Clear database before importing
- `--force, -f`: Skip confirmation for replace mode
- `--json`: Output as JSON

## Guardrails

The guardrails system prevents runaway resource usage during extraction:

### Message Batch Limit (`maxMessages`)

Limits the number of messages sent to the LLM per extraction. When exceeded:
- Most recent N messages are kept
- Older messages are discarded
- Event logged: `memory.guardrail.skip: reason=max_messages`

### Token Budget (`maxTokens`)

Estimates token count before calling LLM. When exceeded:
- Extraction is skipped entirely
- Event logged: `memory.guardrail.skip: reason=max_tokens`

### Facts Limit (`maxFacts`)

Limits LLM response to first N facts. When exceeded:
- Facts beyond limit are discarded
- Event logged: `memory.guardrail.skip: reason=max_facts`

### Cooldown (`cooldownMs`)

Enforces minimum time between extractions. When in cooldown:
- Extraction is skipped
- Event logged: `memory.guardrail.skip: reason=cooldown`

### Monitoring Guardrails

Check guardrail activity via structured logs:

```bash
# View guardrail skip events
grep "memory.guardrail.skip" ~/.clawdbot/logs/openclaw.log
```

Log format:
```
memory.guardrail.skip: reason=cooldown limit=30000 value=5000 sessionId=abc123
```

## Troubleshooting

### Facts memory not storing anything

1. Check if enabled:
   ```bash
   moltbot memory facts status
   ```

2. Verify extraction is configured:
   ```bash
   moltbot config get factsMemory.extraction
   ```

3. Check if messages match extraction patterns:
   - Messages need phrases like "remember my...", "note that...", etc.
   - Plain statements may not trigger extraction

### Database growing too large

1. Check current size:
   ```bash
   moltbot memory facts stats
   ```

2. Run cleanup:
   ```bash
   moltbot memory facts cleanup --vacuum
   ```

3. Configure automatic retention:
   ```bash
   moltbot config set factsMemory.retention.maxSizeMb 100
   moltbot config set factsMemory.retention.maxAgeDays 30
   ```

### Extraction too slow or expensive

1. Reduce batch size:
   ```bash
   moltbot config set factsMemory.limits.maxMessages 10
   moltbot config set factsMemory.limits.maxTokens 500
   ```

2. Increase cooldown:
   ```bash
   moltbot config set factsMemory.limits.cooldownMs 60000
   ```

3. Use a faster/cheaper model:
   ```bash
   moltbot config set factsMemory.extraction.model "gpt-4o-mini"
   ```

### FTS search not working

1. Check FTS availability:
   ```bash
   moltbot memory facts status --json | jq .database.ftsAvailable
   ```

2. FTS requires SQLite with FTS5 extension. If unavailable:
   - Search falls back to LIKE-based matching
   - Results may be slower and less accurate

### Guardrails skipping too many extractions

1. Check skip events:
   ```bash
   moltbot memory facts stats --json | jq .extraction.skipped
   ```

2. If cooldown is too aggressive:
   ```bash
   moltbot config set factsMemory.limits.cooldownMs 10000
   ```

3. If token budget too low:
   ```bash
   moltbot config set factsMemory.limits.maxTokens 3000
   ```

### Database corruption

1. Run integrity check:
   ```bash
   moltbot memory facts repair --check
   ```

2. If corruption detected, try rebuilding indexes:
   ```bash
   moltbot memory facts repair --reindex --vacuum
   ```

3. As last resort, export what you can and reimport:
   ```bash
   moltbot memory facts export --out /tmp/backup.jsonl
   # Delete corrupted database
   rm ~/.clawdbot/memory/facts.db
   # Reimport
   moltbot memory facts import --in /tmp/backup.jsonl
   ```

### Retrieval not returning expected memories

1. Use trace to debug:
   ```bash
   moltbot memory facts trace "your query"
   ```

2. Check why specific memories aren't surfaced:
   - Low importance score
   - Old creation date (high decay)
   - FTS not matching query terms

3. Consider reindexing if FTS seems broken:
   ```bash
   moltbot memory facts repair --reindex
   ```

## HTTP API

The gateway exposes HTTP endpoints for facts memory management. All endpoints require authentication.

### GET /api/memory/facts/status

Returns facts memory status and health information.

**Response:**
```json
{
  "enabled": true,
  "dbSizeMb": 1.5,
  "totalFacts": 100,
  "lastExtractionAt": 1704067200000,
  "lastCleanupAt": 1704153600000,
  "alertCount": 0,
  "status": "ok"
}
```

### GET /api/memory/facts/top

Returns top facts sorted by importance and recency.

**Query Parameters:**
- `limit` (optional): Number of facts to return (1-100, default: 10)
- `type` (optional): Filter by type (fact, preference, decision, event, todo)

**Response:**
```json
{
  "items": [
    {
      "id": "fact-1",
      "type": "preference",
      "content": "User prefers dark mode",
      "importance": 0.8,
      "lastAccessedAt": 1704067200000,
      "accessCount": 5
    }
  ]
}
```

### POST /api/memory/facts/delete

Delete a fact by ID.

**Request:**
```json
{
  "id": "fact-1"
}
```

**Response:**
```json
{
  "success": true
}
```

**Errors:**
- 404: Fact not found
- 400: Invalid request (missing id)

### POST /api/memory/facts/update

Update a fact's importance.

**Request:**
```json
{
  "id": "fact-1",
  "importance": 0.9
}
```

**Response:**
```json
{
  "success": true,
  "entry": {
    "id": "fact-1",
    "type": "preference",
    "content": "User prefers dark mode",
    "importance": 0.9,
    "lastAccessedAt": 1704067200000,
    "accessCount": 5
  }
}
```

**Errors:**
- 404: Fact not found
- 400: Invalid importance (must be 0-1)

### POST /api/memory/facts/merge

Mark a fact as superseded by another fact (merge).

**Request:**
```json
{
  "sourceId": "fact-1",
  "targetId": "fact-2"
}
```

**Response:**
```json
{
  "success": true,
  "source": {
    "id": "fact-1",
    "type": "fact",
    "content": "Old information",
    "importance": 0.5,
    "supersededBy": "fact-2"
  },
  "target": {
    "id": "fact-2",
    "type": "fact",
    "content": "Updated information",
    "importance": 0.8
  }
}
```

**Errors:**
- 404: Source or target fact not found
- 400: sourceId and targetId must be different

### Search with Trace (Explainability)

Search memories with full explainability - returns matching facts with scores, sources, and reasons.

**Endpoint:** `GET /api/memory/facts/trace`

**Query Parameters:**
- `query` (required): Search query string
- `limit` (optional): Maximum results (1-100, default: 10)
- `role` (optional): Access role filter (admin, operator, analyst, guest; default: operator)
- `type` (optional): Filter by fact type (fact, preference, decision, event, todo)

**Response:**
```json
{
  "query": "user preferences",
  "timestamp": 1706745600000,
  "included": 5,
  "excluded": 2,
  "reasons": [
    {
      "id": "fact-abc123",
      "type": "preference",
      "content": "User prefers dark mode",
      "score": 0.92,
      "source": "fts",
      "snippet": "...prefers dark mode for all interfaces...",
      "metadata": {
        "importance": 0.8,
        "accessCount": 15
      }
    }
  ],
  "context": "## Relevant Memories\n\n- User prefers dark mode..."
}
```

**Response Fields:**
- `query`: The original search query
- `timestamp`: When the search was performed (Unix ms)
- `included`: Number of facts included in results
- `excluded`: Number of facts excluded by role permissions
- `reasons[]`: Array of matching facts with explainability:
  - `id`: Fact ID
  - `type`: Fact type (fact/preference/decision/event/todo)
  - `content`: Full fact content
  - `score`: Relevance score (0-1)
  - `source`: How the fact was found (fts, importance, recent, etc.)
  - `snippet`: Context snippet around match
  - `metadata`: Additional metadata (importance, accessCount, etc.)
- `context`: Generated context string for prompt injection

**Example:**
```bash
curl "http://localhost:18789/api/memory/facts/trace?query=dark+mode&limit=5&role=analyst" \
  -H "Authorization: Bearer $TOKEN"
```

**Errors:**
- 400: Query parameter required
- 400: Invalid limit (must be 1-100)
- 400: Invalid role
- 400: Invalid type

### Audit Logging

All modification actions (delete, update, merge) generate audit events:

```
[memory-http] Memory action: delete  { event: "memory.action", action: "delete", factId: "fact-1", success: true }
[memory-http] Memory action: update  { event: "memory.action", action: "update", factId: "fact-1", importance: 0.9, success: true }
[memory-http] Memory action: merge   { event: "memory.action", action: "merge", sourceId: "fact-1", targetId: "fact-2", success: true }
```

Failed actions log with `success: false` and include the error reason.

---

## Best Practices

1. **Start with defaults**: The default guardrails are tuned for typical usage.

2. **Monitor regularly**: Check `moltbot memory facts stats` periodically.

3. **Schedule cleanup**: Run cleanup weekly or set up a cron job:
   ```bash
   0 3 * * 0 moltbot memory facts cleanup --force --vacuum
   ```

4. **Use appropriate model**: Balance cost vs quality for extraction model.

5. **Back up database**: Export to JSONL for portable backups:
   ```bash
   moltbot memory facts export --out ~/.clawdbot/backups/facts-$(date +%Y%m%d).jsonl
   ```

6. **Use trace for debugging**: When retrieval seems wrong, trace explains why:
   ```bash
   moltbot memory facts trace "your query"
   ```

7. **Repair periodically**: Run integrity check monthly:
   ```bash
   0 3 1 * * moltbot memory facts repair --check --vacuum
   ```
