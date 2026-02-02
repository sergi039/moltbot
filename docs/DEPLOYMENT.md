# Deployment Rules (Dev vs Prod)

This document is the source of truth for how to run OpenClaw in development and production without state conflicts.

---

## 1) Environments

### Production

- Repo: `~/openclaw-prod`
- State: `~/.openclaw`
- Must be clean: `git status` shows no local changes.

### Development

- Repo: `~/moltbot`
- State: `~/.openclaw-dev`
- Local changes are allowed.

---

## 2) Gateway Start Commands

### Production (REQUIRED: use release branch)

**Gateway MUST run from `release/memory-v1` branch.** Running from `main` will cause Memory/Skills UI to be missing.

The recommended way to start the gateway:

```bash
./scripts/start-gateway-release.sh
```

This script:
1. Switches to `release/memory-v1`
2. Rebuilds UI and dist
3. Restarts the gateway via LaunchAgent

Manual start (if you're already on the correct branch):

```bash
git checkout release/memory-v1
pnpm ui:build && pnpm build
OPENCLAW_STATE_DIR=~/.openclaw openclaw gateway run
```

**Guardrails:** The `gateway-preflight.sh` script will block gateway startup if:
- Branch is not `release/memory-v1`
- Build SHA doesn't match git HEAD (stale build)

### Development

```
OPENCLAW_STATE_DIR=~/.openclaw-dev pnpm openclaw-dev gateway run
```

---

## 3) Production Update Flow (Upstream)

Only update prod from a clean repo.

```
cd ~/openclaw-prod
git fetch upstream
git reset --hard upstream/main
pnpm install
pnpm ui:build   # REQUIRED: rebuild control panel UI
pnpm build
launchctl kickstart -k gui/$UID/com.moltbot.gateway.prod
```

**Important:** `pnpm ui:build` is required after every update. Without it, the control panel UI will show the old version.

---

## 4) Dev → Prod Promotion

**Approved flow (recommended):**

1. Dev changes on feature branch.
2. Tests pass.
3. Merge or cherry-pick into prod branch.
4. Deploy from prod repo only.

No direct edits on the prod repo.

---

## 5) State Directories

Each environment uses its own isolated state directory:

- `~/.openclaw` → production state
- `~/.openclaw-dev` → development state

**Never** mix them.

---

## 5.1) Skills Overlay (Upstream + Local)

We keep upstream skills in `skills/` and local/custom skills in `skills-local/`.
During deployment, both are merged into the runtime skills directory.

Sync command:
```bash
./scripts/sync-skills.sh --profile default
```

Overlay behavior:
- `skills/` is the base (upstream)
- `skills-local/` overrides or adds custom skills

---

## 6) Gateway Config Requirements

Gateway **will not start** without these config values:

| Key | Required Value | Description |
|-----|---------------|-------------|
| `gateway.mode` | `local` | Enables local gateway mode |
| `gateway.auth.token` | any non-empty string | Auth token for gateway API |

### Setting config

```bash
pnpm openclaw config set gateway.mode local
pnpm openclaw config set gateway.auth.mode token
pnpm openclaw config set gateway.auth.token "your-secret-token"
```

### Verifying config

```bash
./scripts/verify-env.sh --profile default
# or
./scripts/gateway-preflight.sh
```

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `gateway.mode must be 'local'` | Config missing or reset | Set `gateway.mode local` |
| `gateway.auth.token is missing` | Token not set | Set `gateway.auth.token` |
| `CONFIG_INVALID` | Restore/update wiped config | Re-run config set commands |

### LaunchAgent

To install the LaunchAgent (auto-start gateway):

```bash
cp scripts/com.moltbot.gateway.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.moltbot.gateway.plist
```

The LaunchAgent uses `gateway-preflight.sh` which:
- Validates config before starting gateway
- Exits with code 1 if config invalid (prevents infinite restart loop)
- Only restarts if gateway crashed (exit 0)

---

## 7) macOS Companion App Updates

The macOS companion app (DMG/ZIP) is a **client** and updates **independently** of the Gateway.

Rules:
- Updating the macOS app does **not** update or overwrite the Gateway code.
- Custom features live in the Gateway (release branch), not the client.
- If the app gains new UI features, the Gateway may need to be updated to support them.

Operational guidance:
- Update Gateway via the release pipeline (main → release → prod).
- Update the macOS app via the official releases channel.

---

## 8) Required Documentation Links

This document must be linked from:

- `docs/start/openclaw.md`
- `docs/cli/index.md`
- `docs/memory/OPERATIONS.md`

### Related Memory Documentation

- [Facts Memory Operations](/memory/OPERATIONS) — configuration, cleanup, guardrails
- [SRE Runbook](/memory/RUNBOOK) — daily ops, alerts, backup/restore, troubleshooting
- [Release Notes](/memory/RELEASE-NOTES) — changelog, migration, rollback

---

## 9) Verification Checklist

- [ ] `git status` clean in prod repo
- [ ] `OPENCLAW_STATE_DIR=~/.openclaw` for prod
- [ ] `OPENCLAW_STATE_DIR=~/.openclaw-dev` for dev
- [ ] `~/.openclaw/cron/jobs.json` contains expected jobs
- [ ] `~/.openclaw/agents/*/sessions/` contains active sessions

---

## UI shows old version after update

**Symptom:** Control panel UI shows old design (missing features, filters, etc.) after update/restore.
**Root cause:** `pnpm ui:build` was not run after update.
**Fix:**

```bash
cd ~/openclaw-prod
pnpm ui:build
launchctl kickstart -k gui/$UID/com.moltbot.gateway.prod
```

**Verification:** Check that `dist/control-ui/index.html` is newer than `ui/src/ui/app.ts`:

```bash
ls -la dist/control-ui/index.html ui/src/ui/app.ts
```

Or use the verification script:

```bash
./scripts/verify-env.sh --profile default
```

---

## Update failures (dirty repo)

**Symptom:** update checker reports `dirty repo` and skips pulling updates.  
**Root cause:** local edits in the production repo (`~/openclaw-prod`).  
**Fix:** move changes to dev or feature branch, then reset prod to upstream.

### Recovery steps

1) Save local changes for review:

```
cd ~/openclaw-prod
git diff > /tmp/prod.patch
```

2) Reset prod to upstream:

```
git fetch upstream
git reset --hard upstream/main
```

3) Apply changes in dev repo (if needed):

```
cd ~/moltbot
git checkout -b prod-hotfix
git apply /tmp/prod.patch
```

4) Rebuild + restart gateway:

```
pnpm install
pnpm ui:build   # Don't forget UI build!
pnpm build
launchctl kickstart -k gui/$UID/com.moltbot.gateway.prod
```

---

## Release plan (Dev → Prod)

This section is the shared source of truth for production releases. Architect #2 should review and confirm before rollout.

### 0) Preconditions

- Dev repo: `~/moltbot` has all changes committed on a release branch.
- Prod repo: `~/openclaw-prod` is clean and matches `upstream/main`.
- State dirs are isolated:
  - prod: `~/.openclaw`
  - dev: `~/.openclaw-dev`

### 1) Freeze window

- Announce release window.
- Pause cron jobs if needed.

### 2) Build + test (dev)

```
cd ~/moltbot
pnpm install
pnpm build
pnpm test
```

### 3) Tag release (dev)

```
git checkout -b release/memory-v1
git status
git commit -am "release: memory system"
```

### 4) Promote to prod

```
cd ~/openclaw-prod
git fetch upstream
git reset --hard upstream/main
git fetch ~/moltbot release/memory-v1
git merge --ff-only FETCH_HEAD
pnpm install
pnpm ui:build   # REQUIRED: rebuild control panel UI
pnpm build
```

### 5) Restart prod gateway

```
launchctl kickstart -k gui/$UID/com.moltbot.gateway.prod
```

### 6) Post‑deploy verification

- `openclaw status` shows Facts Memory row.
- `openclaw memory facts health --json` returns ok.
- UI dashboard loads Facts Memory panels.
- Cron jobs visible in `~/.openclaw/cron/jobs.json`.

### 7) Rollback procedure

```
cd ~/openclaw-prod
git reset --hard upstream/main
pnpm install
pnpm ui:build
pnpm build
launchctl kickstart -k gui/$UID/com.moltbot.gateway.prod
```

### Architect #2 sign‑off

```
Status: approved
Owner: Claude (Architect #2)
Date: 2026-02-01
Notes:
  Review completed. All phases (1-8) implemented and tested.

  Checklist:
  ✓ 200+ tests pass
  ✓ Build succeeds
  ✓ Documentation complete (OPERATIONS, ROADMAP, RUNBOOK, RELEASE-NOTES)
  ✓ API endpoints documented and tested
  ✓ UI components integrated
  ✓ Rollback procedure documented

  Concerns: None blocking.

  Recommendation: Proceed with release after Architect #1 approval.

  Addendum (2026-02-02):
  - Docs updated for macOS app update rules.
  - RUNBOOK includes upstream update checklist + macOS app notes.
  - Commit: c3cc2de5e (release/memory-v1).
```

### Architect #1 sign‑off

```
Status: approved
Owner: Peter (Architect #1)
Date: 2026-02-01
Notes:
  - Все фазы памяти закрыты по docs/memory/ROADMAP.md
  - Все тесты пройдены, build успешен
  - Документация и rollback присутствуют
  - Риски: приемлемые, процедура отката зафиксирована

  Decision: APPROVED for production release.
```
