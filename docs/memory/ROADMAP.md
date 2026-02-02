# Facts Memory Roadmap

This file tracks the official backlog for the Facts Memory System. Each item includes a checklist and acceptance criteria.

## Update Template

Use this block when updating status:

```
Status: <planned|in_progress|blocked|done>
Owner: <name>
Date: YYYY-MM-DD
Notes: <short summary of change or blocker>
```

---

## Phase 5: Reliability + UX

### P0. Recovery / Repair

- [x] Add repair API with integrity check, FTS rebuild, and vacuum
- [x] CLI: `moltbot memory facts repair [--check] [--reindex] [--vacuum]`
- [x] Log events for repair start/finish/fail

Acceptance criteria:
- `repair --check` returns `ok` or a descriptive error
- `repair --reindex` restores FTS search results for existing facts
- `repair --vacuum` is safe on empty DB and does not corrupt data

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: repair.ts + repair.test.ts (9 tests), CLI command implemented
```

---

### P0. Export / Import (JSONL)

- [x] Export all facts + blocks to JSONL
- [x] Import JSONL with `--merge` and `--replace` modes
- [x] CLI: `moltbot memory facts export --out <file>` / `import --in <file>`

Acceptance criteria:
- Export creates 1 JSON object per line
- Import `--replace` clears DB before restore
- Import `--merge` retains existing facts and adds missing entries

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: export.ts + import.ts + export-import.test.ts (8 tests), CLI commands implemented
```

---

### P1. Retrieval Explainability

- [x] Return retrieval trace alongside context
- [x] Surface trace in JSON CLI output when requested
- [x] Include reasons: FTS, importance, recent

Acceptance criteria:
- `getFactsRelevantContext()` returns `{ context, reasons[] }`
- JSON output includes reason metadata for each fact
- No changes to default prompt output unless `--json`/`--verbose` is used

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: RetrievalTrace types, getRelevantContextWithTrace(), CLI `facts trace`, retrieval-trace.test.ts (9 tests)
```

---

### P2. CLI UX Improvements

- [x] `moltbot memory facts top --limit N` (top facts by score)
- [x] Optional `--type` filter (fact/preference/decision/event/todo)

Acceptance criteria:
- `top` output sorted by score and stable across runs
- `--type` only returns matching categories

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: `top --limit` and `--type` filter implemented, 5 new tests added
```

---

## Phase 6: Safety / Governance

### P0. Redaction-Safe Export

- [x] Add `--redact` flag to export command
- [x] Add `--exclude-types <types>` flag to export command
- [x] Implement redaction patterns: EMAIL, PHONE, API_KEY, JWT, BEARER, URL_CREDS, IP_ADDRESS, CREDIT_CARD, SSN
- [x] Export result reports redaction applied and memories excluded

Acceptance criteria:
- `export --redact` masks sensitive data in JSONL output
- `export --exclude-types preference,decision` excludes those types
- Original DB data is unchanged; only export is redacted

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: redaction.ts + export.ts updated, redaction.test.ts (24 tests)
```

---

### P0. Role-Based Visibility

- [x] Define access roles: admin, operator, analyst, guest
- [x] Each role has allowed memory types
- [x] `--role` flag for `trace` and `top` commands
- [x] Audit events logged for memory access

Acceptance criteria:
- `top --role analyst` only shows fact + event types
- `trace --role guest` only shows facts in retrieval results
- Audit events logged with role, included/excluded counts

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: access.ts + access.test.ts (25 tests), CLI commands updated
```

---

### Phase 6.1: Config Integration & Runtime Enforcement

- [x] Add `factsMemory.redaction` config schema
- [x] Add `factsMemory.access` config schema with role configs
- [x] Runtime retrieval respects access control when enabled
- [x] Export respects role permissions (canExport, canSeeUnredacted)
- [x] Config schema validation tests

Acceptance criteria:
- Config validates correctly with access/redaction settings
- `getFactsRelevantContextWithTrace()` filters by role when `access.enabled=true`
- Export blocked for roles without `canExport`
- Export forces redaction for roles without `canSeeUnredacted`

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: Config schema in types.openclaw.ts + zod-schema.ts, runtime filtering in retrieval.ts + integration.ts, config-schema.test.ts (9 tests), retrieval-trace.test.ts access tests (4 tests)
```

---

## Phase 7: Ops + Monitoring

### P0. Health Events + Threshold Alerts

- [x] Periodic health-event: memory.health
- [x] Fields: dbSizeMb, totalMemories, lastExtractionAt, extractionErrors, lastCleanupAt
- [x] Threshold alerts: maxDbSizeMb, maxErrorsPerDay, maxStaleDays

Acceptance criteria:
- Health event published once daily
- When threshold exceeded → warning event memory.alert
- Alerts written to logs

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: health.ts + health.test.ts (18 tests), scheduler.ts updated for health check job, config types + zod schema updated
```

---

### P1. Ops CLI

- [x] `moltbot memory facts health` command
- [x] `moltbot memory facts alerts` command

Acceptance criteria:
- health → last health snapshot + thresholds
- alerts → list of recent alert events
- JSON output is correct
- CLI works even when memory disabled

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: CLI commands added to memory-cli.ts with --json and --check options
```

---

### P2. Dashboard Integration

- [x] Connect health/alerts to existing status view

Acceptance criteria:
- /status shows Memory health summary

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: Facts Memory row added to status command overview table, shows status/facts count/db size/alerts
```

---

## Phase 8: UX + Productization

### P0. UI Panel for Memory Status + Top Facts

- [x] HTTP API endpoints: GET /api/memory/facts/status, GET /api/memory/facts/top
- [x] UI controller for facts memory (facts-memory.ts)
- [x] UI view components (facts-memory.ts)
- [x] Integration into Overview dashboard
- [x] Tests for memory HTTP endpoints (12 tests)

Acceptance criteria:
- UI shows memory status (enabled, dbSize, totalFacts, alerts, status)
- Top facts displayed in table with type/content/importance/lastAccessed
- Type and limit filters for top facts
- Refresh buttons to reload data

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: memory-http.ts + memory-http.test.ts (12 tests), UI controller/view in ui/src/ui, integrated into Overview dashboard
```

---

### P1. Manual Per-Fact Delete/Merge/Edit Actions

- [x] API endpoints: POST /api/memory/facts/delete, /update, /merge
- [x] Audit logging for manual actions (memory.action events)
- [x] Tests for API endpoints (17 new tests)
- [x] UI actions in facts table (delete, edit importance)
- [x] Confirmation dialogs (delete confirmation via browser confirm)

Acceptance criteria:
- Actions modify DB and are reflected in status
- API validates inputs (importance 0-1, sourceId != targetId)
- Audit events logged for success/failure
- UI confirms before destructive actions

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: Backend API (memory-http.ts + 31 tests), UI controller with optimistic updates, facts-memory.ts view with action buttons and inline importance editor
```

---

### P2. Search + Trace UI

- [x] HTTP API endpoint: GET /api/memory/facts/trace
- [x] UI Memory Search panel with query input and filters
- [x] Results display with content, source, score
- [x] Collapsible context preview
- [x] Tests for trace endpoint (8 new tests, 39 total)

Acceptance criteria:
- Trace endpoint returns query, timestamp, included/excluded counts, reasons[], context
- UI search panel has query input, role/limit filters, search/clear buttons
- Results show type chip, content, score, importance, access count
- Context preview is collapsible

```
Status: done
Owner: Claude
Date: 2026-02-01
Notes: GET /api/memory/facts/trace endpoint (memory-http.ts + 39 tests), UI controller search functions, renderMemorySearch view, integrated into Overview dashboard
```

---

## Notes

- Phases are ordered by risk and operational impact.
- Each phase must include tests before being marked complete.
