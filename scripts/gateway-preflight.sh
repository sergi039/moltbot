#!/usr/bin/env bash
#
# gateway-preflight.sh - Validate config before starting gateway
#
# Usage: ./scripts/gateway-preflight.sh [--start] [--port PORT]
#
# Exit codes:
#   0 - Config valid (and gateway started if --start)
#   1 - Config invalid (gateway NOT started)
#
# This script should be used:
#   - By LaunchAgent to prevent infinite restart loops
#   - By restore/update scripts to verify config after changes
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_FILE="$STATE_DIR/openclaw.json"
START_GATEWAY=false
PORT="${GATEWAY_PORT:-18789}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

error() { echo -e "${RED}[CONFIG_INVALID]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[gateway-preflight]${NC} $*"; }
ok() { echo -e "${GREEN}[gateway-preflight]${NC} $*"; }

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --start)
      START_GATEWAY=true
      shift
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--start] [--port PORT]"
      echo ""
      echo "Validate gateway config before starting."
      echo ""
      echo "Options:"
      echo "  --start   Start gateway if config is valid"
      echo "  --port    Port to use (default: 18789 or GATEWAY_PORT env)"
      echo ""
      echo "Environment:"
      echo "  OPENCLAW_STATE_DIR  State directory (default: ~/.openclaw)"
      echo "  GATEWAY_PORT        Default port (default: 18789)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ============================================================================
# Branch Validation (P0)
# ============================================================================

REQUIRED_BRANCH="release/memory-v1"
CURRENT_BRANCH="$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || echo "")"

if [[ "$CURRENT_BRANCH" != "$REQUIRED_BRANCH" ]]; then
  echo ""
  error "Gateway cannot start - wrong branch!"
  echo ""
  echo -e "  Current:  ${RED}$CURRENT_BRANCH${NC}"
  echo -e "  Required: ${GREEN}$REQUIRED_BRANCH${NC}"
  echo ""
  echo "Fix:"
  echo "  cd $REPO_ROOT"
  echo "  git checkout $REQUIRED_BRANCH"
  echo "  pnpm ui:build && pnpm build"
  echo ""
  echo "Or use the release launcher:"
  echo "  ./scripts/start-gateway-release.sh"
  echo ""
  exit 1
fi

ok "Branch: $CURRENT_BRANCH"

# ============================================================================
# Build SHA Validation (P0)
# ============================================================================

BUILD_INFO_FILE="$REPO_ROOT/dist/build-info.json"
GIT_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")"

if [[ -f "$BUILD_INFO_FILE" ]]; then
  BUILD_SHA="$(grep -o '"commit"[[:space:]]*:[[:space:]]*"[^"]*"' "$BUILD_INFO_FILE" | sed 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"

  if [[ -n "$BUILD_SHA" && -n "$GIT_HEAD" && "$BUILD_SHA" != "$GIT_HEAD" ]]; then
    echo ""
    error "Gateway cannot start - build SHA mismatch!"
    echo ""
    echo -e "  Build SHA: ${RED}${BUILD_SHA:0:12}${NC}"
    echo -e "  Git HEAD:  ${GREEN}${GIT_HEAD:0:12}${NC}"
    echo ""
    echo "The UI/dist was built from a different commit than current HEAD."
    echo "Memory/Skills UI may be missing or outdated."
    echo ""
    echo "Fix:"
    echo "  cd $REPO_ROOT"
    echo "  pnpm ui:build && pnpm build"
    echo "  launchctl kickstart -k gui/\$UID/com.moltbot.gateway.prod"
    echo ""
    exit 1
  fi

  ok "Build SHA: ${BUILD_SHA:0:12} (matches HEAD)"
else
  warn "No build-info.json found - skipping SHA check"
fi

# ============================================================================
# Config Validation
# ============================================================================

ERRORS=()

# Check config file exists
if [[ ! -f "$CONFIG_FILE" ]]; then
  ERRORS+=("Config file not found: $CONFIG_FILE")
else
  # Check gateway.mode = local
  if ! grep -q '"mode"[[:space:]]*:[[:space:]]*"local"' "$CONFIG_FILE" 2>/dev/null; then
    ERRORS+=("gateway.mode must be 'local' (not set or invalid)")
  fi

  # Check gateway.auth.token exists and is non-empty
  if ! grep -q '"token"[[:space:]]*:[[:space:]]*"[^"]\+"' "$CONFIG_FILE" 2>/dev/null; then
    ERRORS+=("gateway.auth.token is missing or empty")
  fi
fi

# ============================================================================
# Report Results
# ============================================================================

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo ""
  error "Gateway cannot start - config is invalid:"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}✗${NC} $err"
  done
  echo ""
  echo "Fix config before starting gateway:"
  echo "  pnpm openclaw config set gateway.mode local"
  echo "  pnpm openclaw config set gateway.auth.mode token"
  echo "  pnpm openclaw config set gateway.auth.token \"<your-token>\""
  echo ""
  exit 1
fi

ok "Config valid: gateway.mode=local, gateway.auth.token=set"

# ============================================================================
# Start Gateway (if requested)
# ============================================================================

if [[ "$START_GATEWAY" == "true" ]]; then
  ok "Starting gateway on port $PORT..."

  cd "$REPO_ROOT"

  # Remove stale lock
  rm -f "$STATE_DIR/gateway.lock" 2>/dev/null || true

  # Start gateway (foreground for LaunchAgent)
  exec pnpm openclaw gateway run --bind loopback --port "$PORT"
fi
