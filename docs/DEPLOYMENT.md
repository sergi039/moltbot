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

### Production

```
OPENCLAW_STATE_DIR=~/.openclaw openclaw gateway run
```

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
pnpm build
launchctl kickstart -k gui/$UID/com.moltbot.gateway.prod
```

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

## 6) Required Documentation Links

This document must be linked from:

- `docs/start/openclaw.md`
- `docs/cli/index.md`
- `docs/memory/OPERATIONS.md`

### Related Memory Documentation

- [Facts Memory Operations](/memory/OPERATIONS) — configuration, cleanup, guardrails
- [SRE Runbook](/memory/RUNBOOK) — daily ops, alerts, backup/restore, troubleshooting
- [Release Notes](/memory/RELEASE-NOTES) — changelog, migration, rollback

---

## 7) Verification Checklist

- [ ] `git status` clean in prod repo
- [ ] `OPENCLAW_STATE_DIR=~/.openclaw` for prod
- [ ] `OPENCLAW_STATE_DIR=~/.openclaw-dev` for dev
- [ ] `~/.openclaw/cron/jobs.json` contains expected jobs
- [ ] `~/.openclaw/agents/*/sessions/` contains active sessions

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
