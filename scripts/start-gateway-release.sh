#!/usr/bin/env bash
#
# start-gateway-release.sh - The canonical way to start the production gateway
#
# This script ensures:
#   1. Working directory is ~/openclaw-prod
#   2. Branch is release/memory-v1
#   3. UI and dist are rebuilt
#   4. Gateway is restarted via LaunchAgent
#
# Usage: ./scripts/start-gateway-release.sh [--skip-build]
#
# Options:
#   --skip-build  Skip pnpm ui:build && pnpm build (use if already built)
#

set -euo pipefail

REPO_ROOT="${OPENCLAW_REPO:-$HOME/openclaw-prod}"
REQUIRED_BRANCH="release/memory-v1"
SKIP_BUILD=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[start-gateway-release]${NC} $*"; }
ok() { echo -e "${GREEN}[start-gateway-release]${NC} $*"; }
error() { echo -e "${RED}[start-gateway-release]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[start-gateway-release]${NC} $*"; }

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--skip-build]"
      echo ""
      echo "Start the production gateway from the release branch."
      echo ""
      echo "Options:"
      echo "  --skip-build  Skip pnpm ui:build && pnpm build"
      echo ""
      echo "Environment:"
      echo "  OPENCLAW_REPO  Repository path (default: ~/openclaw-prod)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ============================================================================
# Step 1: Change to repo directory
# ============================================================================

if [[ ! -d "$REPO_ROOT" ]]; then
  error "Repository not found: $REPO_ROOT"
  exit 1
fi

cd "$REPO_ROOT"
info "Working directory: $REPO_ROOT"

# ============================================================================
# Step 2: Switch to release branch
# ============================================================================

CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || echo "")"

if [[ "$CURRENT_BRANCH" != "$REQUIRED_BRANCH" ]]; then
  info "Switching from '$CURRENT_BRANCH' to '$REQUIRED_BRANCH'..."

  # Check for uncommitted changes
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    error "Working directory has uncommitted changes!"
    echo ""
    echo "Options:"
    echo "  1. Commit or stash your changes first"
    echo "  2. Use --skip-build if you're sure the build is current"
    echo ""
    exit 1
  fi

  git checkout "$REQUIRED_BRANCH"
  ok "Switched to $REQUIRED_BRANCH"
else
  ok "Already on $REQUIRED_BRANCH"
fi

# ============================================================================
# Step 3: Build UI and dist
# ============================================================================

if [[ "$SKIP_BUILD" == "false" ]]; then
  info "Building UI..."
  pnpm ui:build

  info "Building dist..."
  pnpm build

  ok "Build complete"
else
  warn "Skipping build (--skip-build)"
fi

# ============================================================================
# Step 4: Restart gateway via LaunchAgent
# ============================================================================

LAUNCHCTL_LABEL="com.moltbot.gateway.prod"

info "Restarting gateway ($LAUNCHCTL_LABEL)..."

if launchctl kickstart -k "gui/$UID/$LAUNCHCTL_LABEL" 2>/dev/null; then
  ok "Gateway restarted successfully"
else
  warn "LaunchAgent not loaded - starting directly..."
  exec ./scripts/gateway-preflight.sh --start
fi

# ============================================================================
# Done
# ============================================================================

echo ""
ok "Gateway running from $REQUIRED_BRANCH"
echo ""
echo "Verify with:"
echo "  openclaw status"
echo "  tail -f /tmp/openclaw-gateway.log"
echo ""
