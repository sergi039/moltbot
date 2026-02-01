#!/usr/bin/env bash
#
# Update production environment from upstream
#
# Usage: ./scripts/update-prod.sh [--dry-run]
#

set -euo pipefail

PROD_DIR="${OPENCLAW_PROD_DIR:-$HOME/openclaw-prod}"
PROD_STATE="${OPENCLAW_PROD_STATE:-$HOME/.openclaw}"
DRY_RUN=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[update-prod]${NC} $*"; }
warn() { echo -e "${YELLOW}[update-prod]${NC} $*"; }
error() { echo -e "${RED}[update-prod]${NC} $*" >&2; }

# Parse args
for arg in "$@"; do
  case $arg in
    --dry-run)
      DRY_RUN=true
      ;;
  esac
done

# Preflight checks
if [[ ! -d "$PROD_DIR" ]]; then
  error "Production directory not found: $PROD_DIR"
  error "Run initial setup first. See docs/DEPLOYMENT.md"
  exit 1
fi

cd "$PROD_DIR"

# Check upstream remote exists
if ! git remote get-url upstream &>/dev/null; then
  error "No 'upstream' remote configured."
  error "Add it with: git remote add upstream https://github.com/openclaw/openclaw.git"
  exit 1
fi

log "Updating production at $PROD_DIR"

# Fetch upstream
log "Fetching upstream..."
git fetch upstream

# Show what will change
CURRENT=$(git rev-parse HEAD)
UPSTREAM=$(git rev-parse upstream/main)

if [[ "$CURRENT" == "$UPSTREAM" ]]; then
  log "Already up to date (${CURRENT:0:8})"
  exit 0
fi

log "Current:  ${CURRENT:0:8}"
log "Upstream: ${UPSTREAM:0:8}"
log ""
log "Changes:"
git log --oneline HEAD..upstream/main | head -20

if $DRY_RUN; then
  warn "Dry run mode - not applying changes"
  exit 0
fi

# Check for local changes
if [[ -n "$(git status --porcelain)" ]]; then
  warn "Working directory is dirty. Discarding local changes..."
  git reset --hard HEAD
  git clean -fd
fi

# Reset to upstream
log "Resetting to upstream/main..."
git reset --hard upstream/main

# Install dependencies
log "Installing dependencies..."
pnpm install --frozen-lockfile

# Build UI first (required for control panel)
log "Building UI..."
pnpm ui:build

# Build CLI/gateway
log "Building..."
pnpm build

# Restart gateway if running
if pgrep -f "openclaw.*gateway" >/dev/null; then
  log "Restarting gateway..."
  OPENCLAW_STATE_DIR="$PROD_STATE" openclaw gateway stop 2>/dev/null || true
  sleep 2
  # Gateway will be started by launchd or user manually
  warn "Gateway stopped. Start it manually or via launchd."
fi

log "Update complete!"
log "New version: $(git describe --tags --always)"
