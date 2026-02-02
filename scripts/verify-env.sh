#!/usr/bin/env bash
#
# verify-env.sh - Verify dev/prod environment sanity
#
# Usage: ./scripts/verify-env.sh [--profile dev|default]
#
# Checks:
#   - OPENCLAW_STATE_DIR matches profile
#   - Config file exists and is valid
#   - UI build is up-to-date (dist/control-ui exists)
#   - Gateway process uses correct binary name
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
PROFILE="default"
PASSED=0
FAILED=0
WARNINGS=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓${NC} $*"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗${NC} $*"; FAILED=$((FAILED + 1)); }
warn() { echo -e "${YELLOW}⚠${NC} $*"; WARNINGS=$((WARNINGS + 1)); }

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--profile dev|default]"
      echo ""
      echo "Verify environment sanity for dev or prod."
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Determine expected paths based on profile
if [[ "$PROFILE" == "dev" ]]; then
  EXPECTED_STATE_DIR="$HOME/.openclaw-dev"
  EXPECTED_REPO="$HOME/moltbot"
else
  EXPECTED_STATE_DIR="$HOME/.openclaw"
  EXPECTED_REPO="$HOME/openclaw-prod"
fi

echo "=== Environment Verification ==="
echo "Profile: $PROFILE"
echo "Expected state: $EXPECTED_STATE_DIR"
echo "Expected repo: $EXPECTED_REPO"
echo ""

# 1) Check OPENCLAW_STATE_DIR
echo "--- State Directory ---"
ACTUAL_STATE="${OPENCLAW_STATE_DIR:-}"
if [[ -z "$ACTUAL_STATE" ]]; then
  warn "OPENCLAW_STATE_DIR not set (will default to ~/.openclaw)"
elif [[ "$ACTUAL_STATE" == "$EXPECTED_STATE_DIR" ]]; then
  pass "OPENCLAW_STATE_DIR matches profile: $ACTUAL_STATE"
else
  fail "OPENCLAW_STATE_DIR mismatch: $ACTUAL_STATE (expected $EXPECTED_STATE_DIR)"
fi

# Check state dir exists
if [[ -d "$EXPECTED_STATE_DIR" ]]; then
  pass "State directory exists: $EXPECTED_STATE_DIR"
else
  fail "State directory missing: $EXPECTED_STATE_DIR"
fi

# 2) Check config file
echo ""
echo "--- Configuration ---"
CONFIG_FILE="$EXPECTED_STATE_DIR/openclaw.json"
if [[ -f "$CONFIG_FILE" ]]; then
  pass "Config file exists: $CONFIG_FILE"

  # Check gateway.mode=local
  if grep -q '"mode"[[:space:]]*:[[:space:]]*"local"' "$CONFIG_FILE" 2>/dev/null; then
    pass "gateway.mode=local is set"
  else
    fail "gateway.mode=local not found in config (gateway will refuse to start)"
  fi

  # Check gateway.auth.token
  if grep -q '"token"[[:space:]]*:[[:space:]]*"[^"]\+"' "$CONFIG_FILE" 2>/dev/null; then
    pass "gateway.auth.token is set"
  else
    warn "gateway.auth.token not found (may be in env)"
  fi
else
  fail "Config file missing: $CONFIG_FILE"
fi

# 3) Check UI build (use current repo, not expected)
echo ""
echo "--- UI Build ---"
UI_DIR="$REPO_ROOT/dist/control-ui"
UI_INDEX="$UI_DIR/index.html"

if [[ -d "$UI_DIR" ]]; then
  pass "UI build directory exists: $UI_DIR"
else
  fail "UI build directory missing: $UI_DIR (run: pnpm ui:build)"
fi

if [[ -f "$UI_INDEX" ]]; then
  pass "UI index.html exists"

  # Check mtime vs source
  UI_SRC="$REPO_ROOT/ui/src/ui/app.ts"
  if [[ -f "$UI_SRC" ]]; then
    if [[ "$UI_INDEX" -ot "$UI_SRC" ]]; then
      fail "UI build is stale (index.html older than source). Run: pnpm ui:build"
    else
      pass "UI build is up-to-date"
    fi
  fi
else
  fail "UI index.html missing (run: pnpm ui:build)"
fi

# 4) Check gateway process
echo ""
echo "--- Gateway Process ---"
GATEWAY_PID=$(pgrep -f "gateway" 2>/dev/null | head -1 || true)

if [[ -n "$GATEWAY_PID" ]]; then
  pass "Gateway process running (PID: $GATEWAY_PID)"

  # Check command line
  GATEWAY_CMD=$(ps -p "$GATEWAY_PID" -o args= 2>/dev/null || true)
  if [[ "$GATEWAY_CMD" == *"openclaw"* ]] || [[ "$GATEWAY_CMD" == *"node"* ]]; then
    pass "Gateway using expected binary"
  else
    warn "Gateway command: $GATEWAY_CMD"
  fi
else
  warn "Gateway not running"
fi

# 5) Check listening ports
echo ""
echo "--- Ports ---"
if command -v lsof &>/dev/null; then
  PORT_18789=$(lsof -iTCP:18789 -sTCP:LISTEN -P 2>/dev/null | grep -v "^COMMAND" | head -1 || true)
  if [[ -n "$PORT_18789" ]]; then
    pass "Port 18789 is listening (gateway WS)"
  else
    warn "Port 18789 not listening"
  fi
fi

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed:   ${GREEN}$PASSED${NC}"
echo -e "Failed:   ${RED}$FAILED${NC}"
echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"

if [[ "$FAILED" -gt 0 ]]; then
  echo ""
  echo -e "${RED}FAIL${NC} - Fix the issues above before running gateway."
  exit 1
elif [[ "$WARNINGS" -gt 0 ]]; then
  echo ""
  echo -e "${YELLOW}WARN${NC} - Review warnings above."
  exit 0
else
  echo ""
  echo -e "${GREEN}PASS${NC} - Environment is correctly configured."
  exit 0
fi
