# Branching Model

This repository follows the **standard upstream workflow** (no custom release branches).

## Branch Roles

- `upstream/main`: original OpenClaw repo (read-only remote)
- `origin/main`: your working branch (fast-forward from upstream)

## Rules

1) **No custom release branches**
- Production runs from `main`
- Keep `main` clean and in sync with `upstream/main`

2) **Manual updates only**
- Auto-update is disabled for production
- Daily cron only checks upstream and notifies

## Update Flow (manual)

```bash
git fetch upstream
git checkout main
git reset --hard upstream/main
git push origin main --force-with-lease

pnpm install
pnpm ui:build
pnpm build
# restart gateway
```

## Recovery

If `main` diverges from upstream:

```bash
git fetch upstream
git checkout main
git reset --hard upstream/main
git push origin main --force-with-lease
```
