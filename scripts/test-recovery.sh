#!/usr/bin/env bash
#
# Recovery/Backup/Config Test Runner
# Runs the test suite and generates a report
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
REPORT_DIR="${REPO_DIR}/test/recovery/reports"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PROFILE="${1:-prod}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[recovery-test]${NC} $*"; }
warn() { echo -e "${YELLOW}[recovery-test]${NC} $*"; }
error() { echo -e "${RED}[recovery-test]${NC} $*"; }

mkdir -p "$REPORT_DIR"
REPORT_FILE="${REPORT_DIR}/report-${PROFILE}-${TIMESTAMP}.md"

# Header
cat > "$REPORT_FILE" << EOF
# Recovery Test Report

- **Date:** $(date -Iseconds)
- **Profile:** ${PROFILE}
- **State Dir:** ${OPENCLAW_STATE_DIR:-~/.openclaw}
- **Branch:** $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
- **Commit:** $(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

---

## Test Results

EOF

log "Running recovery tests (profile: $PROFILE)..."

# Run tests and capture output
cd "$REPO_DIR"
TEST_OUTPUT=$(pnpm vitest run --config test/recovery/vitest.config.ts --reporter=verbose 2>&1) || true
EXIT_CODE=$?

# Parse results
PASSED=$(echo "$TEST_OUTPUT" | grep -c "✓" || echo "0")
FAILED=$(echo "$TEST_OUTPUT" | grep -c "✗\|×" || echo "0")
SKIPPED=$(echo "$TEST_OUTPUT" | grep -c "↓\|skipped" || echo "0")

if [[ $EXIT_CODE -eq 0 ]]; then
  RESULT="✅ PASS"
else
  RESULT="❌ FAIL"
fi

# Write summary
cat >> "$REPORT_FILE" << EOF
### Summary

| Metric | Value |
|--------|-------|
| **Result** | ${RESULT} |
| **Passed** | ${PASSED} |
| **Failed** | ${FAILED} |
| **Skipped** | ${SKIPPED} |

---

## P0 — E2E Scenarios

| Test | Status |
|------|--------|
| Full backup → restore | $(echo "$TEST_OUTPUT" | grep -q "Full backup.*✓" && echo "✅" || echo "⚠️") |
| Config guardrail | $(echo "$TEST_OUTPUT" | grep -q "Config guardrail.*✓" && echo "✅" || echo "⚠️") |
| Telegram restoration | $(echo "$TEST_OUTPUT" | grep -q "Telegram restoration.*✓" && echo "✅" || echo "⚠️") |

## P1 — Integration

| Test | Status |
|------|--------|
| Backup completeness | $(echo "$TEST_OUTPUT" | grep -q "Backup completeness.*✓" && echo "✅" || echo "⚠️") |
| Restore idempotency | $(echo "$TEST_OUTPUT" | grep -q "Restore idempotency.*✓" && echo "✅" || echo "⚠️") |

## P2 — Smoke Tests

| Test | Status |
|------|--------|
| Verify-env | $(echo "$TEST_OUTPUT" | grep -q "Verify-env.*✓" && echo "✅" || echo "⚠️") |
| Cron health | $(echo "$TEST_OUTPUT" | grep -q "Cron health.*✓" && echo "✅" || echo "⚠️") |

---

## Paths

- **Backup Dir:** ~/openclaw-ops/backups/
- **State Dir:** ${OPENCLAW_STATE_DIR:-~/.openclaw}
- **Report:** ${REPORT_FILE}

---

## Raw Output

\`\`\`
${TEST_OUTPUT}
\`\`\`
EOF

log "Report saved: $REPORT_FILE"

if [[ $EXIT_CODE -eq 0 ]]; then
  log "All tests passed!"
else
  error "Some tests failed. Check report: $REPORT_FILE"
fi

exit $EXIT_CODE
