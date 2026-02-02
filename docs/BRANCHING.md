# Branching Model

This repository uses a **mirror + release** branching strategy to cleanly separate upstream updates from local customizations.

## Branch Architecture

```
upstream/main ─────────────────────────────────────►
                    │
                    │ fast-forward only
                    ▼
origin/main ───────────────────────────────────────►
                    │
                    │ merge (when needed)
                    ▼
origin/release/* ──────────────────────────────────►
       │
       └── release/memory-v1  ◄── PRODUCTION
```

## Branch Roles

| Branch | Purpose | Rules |
|--------|---------|-------|
| `upstream/main` | Original OpenClaw repo | Read-only remote |
| `origin/main` | Mirror of upstream | **No local commits** |
| `origin/release/*` | Custom features + prod | All local work here |

## Rules

### 1. `main` is a pure mirror

- `origin/main` must always equal `upstream/main`
- No local commits, no custom features
- Only fast-forward merges from upstream

```bash
# Correct: update main from upstream
git fetch upstream
git checkout main
git reset --hard upstream/main
git push origin main --force-with-lease

# WRONG: committing to main
git checkout main
git commit -m "add feature"  # ❌ NEVER DO THIS
```

### 2. All custom work goes to `release/*`

- Create feature branches from release branch
- Merge features into release branch
- Never merge release into main

```bash
# Correct: add feature to release
git checkout release/memory-v1
git checkout -b feature/new-thing
# ... work ...
git checkout release/memory-v1
git merge feature/new-thing

# WRONG: merging to main
git checkout main
git merge feature/new-thing  # ❌ NEVER DO THIS
```

### 3. Production runs from `release/*` (ENFORCED)

- Gateway/bot always runs from a release branch
- Never run production from `main`
- **This is enforced by `gateway-preflight.sh`** - gateway will refuse to start from wrong branch

```bash
# Correct: use the release launcher
./scripts/start-gateway-release.sh

# Or manually:
git checkout release/memory-v1
pnpm ui:build && pnpm build
# start gateway

# WRONG - gateway-preflight.sh will BLOCK this:
git checkout main
# start gateway  # ❌ EXIT 1: wrong branch
```

**Why this matters:**
- `main` branch mirrors upstream and lacks custom features (Memory, Skills UI)
- Running from `main` will show incomplete UI
- The preflight script also validates build SHA matches git HEAD

### 4. Upstream updates flow downstream

```
upstream/main → origin/main → origin/release/*
```

When upstream has updates:

```bash
# 1. Update main mirror
git fetch upstream
git checkout main
git reset --hard upstream/main
git push origin main --force-with-lease

# 2. Merge into release branch
git checkout release/memory-v1
git merge main
# resolve conflicts if any
git push origin release/memory-v1
```

## Daily Update Script

The daily update script (`~/openclaw-ops/scripts/update-daily.sh`) only updates `origin/main`. It does NOT touch release branches.

After the script runs, manually merge main into your release branch if needed:

```bash
git checkout release/memory-v1
git merge main
pnpm install && pnpm build && pnpm ui:build
# restart gateway
```

## Current Production Branch

**Active release branch:** `release/memory-v1`

**Gateway is ENFORCED to run only from this branch.** See `scripts/gateway-preflight.sh`.

Contains:
- Facts Memory System (Phases 1-8)
- All upstream features up to sync point
- Custom UI enhancements (Memory, Skills panels)

## Recovery

If main accidentally gets local commits:

```bash
git fetch upstream
git checkout main
git reset --hard upstream/main
git push origin main --force-with-lease
```

If release branch is lost, check:
- `origin/release/*` remotes
- Local branches: `git branch -a | grep release`
- Backup tags if any
