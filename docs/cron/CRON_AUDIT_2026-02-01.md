# Cron Audit — 2026-02-01

## Scope
Review of cron UI/jobs behavior in production (`~/.openclaw`, gateway on port 18789).

## Evidence Collected

### Scheduler status
```
openclaw cron status --json
enabled: true
storePath: ~/.openclaw/cron/jobs.json
jobs: 6
nextWakeAtMs: 1769968800000
```

### Job list (prod)
```
openclaw cron list --json
6 jobs present; enabled: true
```

### Run history (prod)
```
openclaw cron runs --id 83add89a... --limit 10
status: ok (multiple entries)
```

### Run history (missing entries)
- No runs stored in `~/.openclaw/cron/runs/` for:
  - `3a15dc8b...` (openclaw-update-check)
  - `f69a9ca9...` (openclaw-update-report)

Reason: prod gateway started after their scheduled windows (05:00/07:00). Next run pending.

### CLI manual run
```
openclaw cron run 3a15dc8b... --force --timeout 20000
=> timeout
```

With token:
```
openclaw cron run 3a15dc8b... --force --timeout 20000 --token $GATEWAY_TOKEN
=> { "ok": true, "ran": true }
```

## Findings

### 1) Cron scheduler is functioning
- Multiple jobs run successfully (CO2, Weather, Home Status).
- Run logs are persisted for those jobs.

### 2) CLI `cron run` fails without explicit token
- The CLI does not automatically reuse `gateway.auth.token` from config.
- Result: gateway auth fails silently → CLI reports timeout instead of auth error.

### 3) “No output” for some jobs is expected
- Several jobs have `deliver: false` and are designed to be silent unless threshold triggers.

## Root Cause (primary)
~~The `cron run` CLI does not infer a token from `gateway.auth.token` when `--token` is omitted.~~

**UPDATE 2026-02-01**: Auth from config IS working correctly. The real issue was:
- Default `--timeout 10000` (10s) is too short for `cron run` — jobs take 10-60+ seconds
- Error message didn't indicate that the job might still be running

## Recommendations / Fixes

### P0 — ✅ FIXED: Increase timeout for cron run
- Changed default timeout from 10s to 60s for `cron run` command
- Commit: `a0634d4a1` (openclaw-prod), `9ea23607a` (moltbot)

### P0 — ✅ FIXED: Improve error messages
- Added hint when timeout: "Job may still be running. Try --timeout 120000"
- Added hint for auth failures (code 1008): "check --token or config"

### P1 — UX clarity (pending)
- In UI Cron page, show a hint for silent jobs (`deliver:false`), e.g. "Runs are silent unless thresholds triggered."

### P2 — Run history visibility (pending)
- If job has not run since gateway start, show "No runs yet (next at …)" indicator.

## Owner / Status
- Owner: Platform / Gateway
- Status: **P0 fixes completed**, P1/P2 pending

