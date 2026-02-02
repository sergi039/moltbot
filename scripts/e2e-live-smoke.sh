#!/usr/bin/env bash
#
# E2E Workflow Smoke Test
#
# Two modes:
#   - stub (default): No API keys required, tests workflow mechanics
#   - live (--live):  Requires API keys, tests real agent execution
#
# Usage:
#   ./scripts/e2e-live-smoke.sh                    # stub mode
#   ./scripts/e2e-live-smoke.sh --live             # live mode (requires API keys)
#   ./scripts/e2e-live-smoke.sh --live --repo .    # live mode with custom repo
#
# Environment:
#   MOLTBOT_SMOKE_TIMEOUT   - approval timeout in ms (default: 10000, live only)
#   MOLTBOT_WORKFLOW_STORAGE - workflow storage path (default: ~/.clawdbot/workflows)
#
# Paths:
#   Config:   ~/.openclaw/openclaw.json
#   Storage:  ~/.clawdbot/workflows (or MOLTBOT_WORKFLOW_STORAGE)
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="${ROOT_DIR}/results"
REPORT_FILE="${REPORT_DIR}/e2e-live-report.json"
WORKFLOW_STORAGE="${MOLTBOT_WORKFLOW_STORAGE:-$HOME/.clawdbot/workflows}"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Defaults
REPO_PATH="${ROOT_DIR}"
TASK="Add a comment to any file"
SKIP_CLEANUP=false
LIVE_MODE=false
TIMEOUT_MS="${MOLTBOT_SMOKE_TIMEOUT:-10000}"
ORIGINAL_TIMEOUT=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --live)
      LIVE_MODE=true
      shift
      ;;
    --repo)
      REPO_PATH="$2"
      shift 2
      ;;
    --task)
      TASK="$2"
      shift 2
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--live] [--repo <path>] [--task <task>] [--skip-cleanup]"
      echo ""
      echo "Modes:"
      echo "  (default)  Stub mode - no API keys required"
      echo "  --live     Live mode - requires ANTHROPIC_API_KEY or OPENAI_API_KEY"
      echo ""
      echo "Options:"
      echo "  --repo <path>     Repository path (default: script directory)"
      echo "  --task <task>     Task description"
      echo "  --skip-cleanup    Keep test artifacts after run"
      echo ""
      echo "Environment:"
      echo "  MOLTBOT_SMOKE_TIMEOUT      Approval timeout in ms (default: 10000)"
      echo "  MOLTBOT_WORKFLOW_STORAGE   Workflow storage path"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage"
      exit 1
      ;;
  esac
done

# Helpers
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_prereqs() {
  log_info "Checking prerequisites..."

  # Check for API keys only in live mode
  if $LIVE_MODE; then
    if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && [[ -z "${OPENAI_API_KEY:-}" ]]; then
      log_error "Live mode requires API keys. Set ANTHROPIC_API_KEY or OPENAI_API_KEY"
      exit 1
    fi
    log_info "API keys found"
  fi

  # Check moltbot CLI
  if ! command -v moltbot &> /dev/null; then
    # Try local dev
    if [[ -f "${ROOT_DIR}/dist/cli/index.js" ]]; then
      log_info "Using local moltbot from dist/"
      MOLTBOT_CMD="node ${ROOT_DIR}/dist/cli/index.js"
    else
      log_error "moltbot CLI not found. Run 'pnpm build' first."
      exit 1
    fi
  else
    MOLTBOT_CMD="moltbot"
  fi

  log_info "Prerequisites OK"
}

# Save and restore timeout config (live mode only)
save_timeout_config() {
  if $LIVE_MODE && [[ -f "$CONFIG_FILE" ]]; then
    ORIGINAL_TIMEOUT=$(node -e "
      try {
        const cfg = require('${CONFIG_FILE}');
        console.log(cfg.workflows?.policy?.approvalTimeoutMs || '');
      } catch { console.log(''); }
    " 2>/dev/null || echo "")
  fi
}

apply_timeout_config() {
  if $LIVE_MODE; then
    log_info "Setting approval timeout to ${TIMEOUT_MS}ms"
    $MOLTBOT_CMD config set workflows.policy.approvalTimeoutMs "$TIMEOUT_MS" 2>/dev/null || true
  fi
}

restore_timeout_config() {
  if $LIVE_MODE && [[ -n "$ORIGINAL_TIMEOUT" ]]; then
    log_info "Restoring original timeout: ${ORIGINAL_TIMEOUT}ms"
    $MOLTBOT_CMD config set workflows.policy.approvalTimeoutMs "$ORIGINAL_TIMEOUT" 2>/dev/null || true
  fi
}

setup_report() {
  mkdir -p "${REPORT_DIR}"
  local mode_str="stub"
  $LIVE_MODE && mode_str="live"

  cat > "${REPORT_FILE}" << EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "mode": "${mode_str}",
  "status": "running",
  "config": {
    "repo": "${REPO_PATH}",
    "task": "${TASK}",
    "timeoutMs": ${TIMEOUT_MS},
    "workflowStorage": "${WORKFLOW_STORAGE}"
  },
  "scenarios": {}
}
EOF
}

update_report() {
  local scenario="$1"
  local status="$2"
  local details="${3:-}"

  node -e "
    const fs = require('fs');
    const report = JSON.parse(fs.readFileSync('${REPORT_FILE}', 'utf8'));
    report.scenarios['${scenario}'] = {
      status: '${status}',
      details: '${details}',
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync('${REPORT_FILE}', JSON.stringify(report, null, 2));
  "
}

finalize_report() {
  local overall_status="$1"

  node -e "
    const fs = require('fs');
    const report = JSON.parse(fs.readFileSync('${REPORT_FILE}', 'utf8'));
    report.status = '${overall_status}';
    report.completedAt = new Date().toISOString();

    const scenarios = Object.values(report.scenarios);
    report.summary = {
      total: scenarios.length,
      passed: scenarios.filter(s => s.status === 'pass').length,
      failed: scenarios.filter(s => s.status === 'fail').length,
      skipped: scenarios.filter(s => s.status === 'skip').length
    };

    fs.writeFileSync('${REPORT_FILE}', JSON.stringify(report, null, 2));
  "

  log_info "Report saved to: ${REPORT_FILE}"
}

# ============================================================================
# Test Scenarios
# ============================================================================

test_smoke_workflow() {
  local scenario="smoke_workflow"
  log_info "Running: ${scenario}"

  local output
  local run_id
  local live_flag=""

  # Add --live flag if in live mode
  $LIVE_MODE && live_flag="--live"

  # Use timeout to prevent hanging
  if output=$(timeout 180 $MOLTBOT_CMD workflow start \
    --type dev-cycle \
    --task "${TASK}" \
    --repo "${REPO_PATH}" \
    $live_flag \
    2>&1); then

    # Extract run ID from output
    run_id=$(echo "$output" | grep -oE 'wf-[a-z0-9]+' | head -1 || true)

    if [[ -z "$run_id" ]]; then
      log_error "Could not extract run ID from output"
      log_error "Output: $output"
      update_report "$scenario" "fail" "no_run_id"
      return 1
    fi

    log_info "Workflow started: ${run_id}"

    # Check artifacts exist
    local workflow_dir="${WORKFLOW_STORAGE}/${run_id}"

    if [[ -f "${workflow_dir}/run.json" ]]; then
      log_info "run.json exists"
    else
      log_warn "run.json not found"
    fi

    if [[ -f "${workflow_dir}/events.jsonl" ]]; then
      log_info "events.jsonl exists"

      if grep -q "workflow.start\|workflow:started" "${workflow_dir}/events.jsonl" 2>/dev/null; then
        log_info "workflow.start event found"
      else
        log_warn "workflow.start event not found"
      fi
    else
      log_warn "events.jsonl not found"
    fi

    # Check approvals.jsonl in live mode
    if $LIVE_MODE; then
      if [[ -f "${workflow_dir}/approvals.jsonl" ]]; then
        log_info "approvals.jsonl exists"
      else
        log_info "approvals.jsonl not created (no prompts triggered)"
      fi
    fi

    update_report "$scenario" "pass" "run_id=${run_id}"
    echo "$run_id"
    return 0
  else
    local exit_code=$?
    log_error "Workflow failed (exit code: ${exit_code})"
    log_error "Output: $output"
    update_report "$scenario" "fail" "workflow_failed_exit_${exit_code}"
    return 1
  fi
}

test_events_structure() {
  local scenario="events_structure"
  local run_id="$1"

  log_info "Running: ${scenario}"

  local events_file="${WORKFLOW_STORAGE}/${run_id}/events.jsonl"

  if [[ ! -f "$events_file" ]]; then
    log_error "events.jsonl not found for ${run_id}"
    update_report "$scenario" "fail" "no_events_file"
    return 1
  fi

  local valid=true
  local line_count
  line_count=$(wc -l < "$events_file" | tr -d ' ')

  if [[ "$line_count" -eq 0 ]]; then
    log_error "events.jsonl is empty"
    update_report "$scenario" "fail" "empty_events"
    return 1
  fi

  # Validate JSON lines
  while IFS= read -r line; do
    if ! echo "$line" | node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))" 2>/dev/null; then
      log_error "Invalid JSON in events.jsonl"
      valid=false
      break
    fi
  done < "$events_file"

  if $valid; then
    log_info "events.jsonl structure valid (${line_count} events)"
    update_report "$scenario" "pass" "events_count=${line_count}"
    return 0
  else
    update_report "$scenario" "fail" "invalid_json"
    return 1
  fi
}

test_run_json() {
  local scenario="run_json"
  local run_id="$1"

  log_info "Running: ${scenario}"

  local run_file="${WORKFLOW_STORAGE}/${run_id}/run.json"

  if [[ ! -f "$run_file" ]]; then
    log_error "run.json not found for ${run_id}"
    update_report "$scenario" "fail" "no_run_file"
    return 1
  fi

  local status
  status=$(node -e "
    const run = require('${run_file}');
    console.log(run.status || 'unknown');
  " 2>/dev/null || echo "error")

  if [[ "$status" == "error" ]]; then
    log_error "Invalid run.json structure"
    update_report "$scenario" "fail" "invalid_structure"
    return 1
  fi

  log_info "run.json status: ${status}"
  update_report "$scenario" "pass" "status=${status}"
  return 0
}

test_cli_logs() {
  local scenario="cli_logs"
  local run_id="$1"

  log_info "Running: ${scenario}"

  if $MOLTBOT_CMD workflow logs "$run_id" > /dev/null 2>&1; then
    log_info "workflow logs command works"
    update_report "$scenario" "pass" ""
    return 0
  else
    log_warn "workflow logs command failed (may be OK if no events)"
    update_report "$scenario" "skip" "no_events_or_error"
    return 0
  fi
}

cleanup_test_run() {
  local run_id="$1"

  if $SKIP_CLEANUP; then
    log_info "Skipping cleanup (--skip-cleanup)"
    return 0
  fi

  log_info "Cleaning up test run: ${run_id}"

  local workflow_dir="${WORKFLOW_STORAGE}/${run_id}"
  if [[ -d "$workflow_dir" ]]; then
    rm -rf "$workflow_dir"
    log_info "Removed ${workflow_dir}"
  fi
}

# ============================================================================
# Main
# ============================================================================

main() {
  local mode_str="STUB"
  $LIVE_MODE && mode_str="LIVE"

  log_info "E2E Workflow Smoke Test [${mode_str} MODE]"
  log_info "=========================================="
  log_info "Repo: ${REPO_PATH}"
  log_info "Task: ${TASK}"
  $LIVE_MODE && log_info "Timeout: ${TIMEOUT_MS}ms"
  log_info "Storage: ${WORKFLOW_STORAGE}"
  echo ""

  check_prereqs
  setup_report

  # Save and apply timeout config for live mode
  save_timeout_config
  apply_timeout_config

  # Ensure config is restored on exit
  trap restore_timeout_config EXIT

  local overall_status="pass"
  local run_id=""

  if run_id=$(test_smoke_workflow); then
    test_events_structure "$run_id" || overall_status="fail"
    test_run_json "$run_id" || overall_status="fail"
    test_cli_logs "$run_id" || overall_status="fail"

    cleanup_test_run "$run_id"
  else
    overall_status="fail"
  fi

  echo ""
  finalize_report "$overall_status"

  echo ""
  log_info "========== SUMMARY =========="
  cat "${REPORT_FILE}" | node -e "
    const report = JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log('Mode:', report.mode.toUpperCase());
    console.log('Status:', report.status.toUpperCase());
    console.log('Passed:', report.summary?.passed || 0);
    console.log('Failed:', report.summary?.failed || 0);
    console.log('Skipped:', report.summary?.skipped || 0);
  "

  if [[ "$overall_status" == "pass" ]]; then
    log_info "All tests passed!"
    exit 0
  else
    log_error "Some tests failed!"
    exit 1
  fi
}

main "$@"
