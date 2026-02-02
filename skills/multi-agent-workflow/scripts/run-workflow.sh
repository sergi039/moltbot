#!/usr/bin/env bash
#
# run-workflow.sh - Run a multi-agent workflow
#
# Usage:
#   ./run-workflow.sh [options] "task description"
#
# Options:
#   --live          Use live mode (real LLM execution)
#   --repo PATH     Target repository (default: current directory)
#   --type TYPE     Workflow type: dev-cycle, review-only (default: dev-cycle)
#   --verbose       Show detailed output
#   --help          Show this help
#
# Examples:
#   ./run-workflow.sh "Add user authentication"
#   ./run-workflow.sh --live --repo /path/to/project "Fix memory leak"
#   ./run-workflow.sh --type review-only "Review recent changes"
#

set -euo pipefail

# Defaults
LIVE_MODE=""
REPO_PATH="."
WORKFLOW_TYPE="dev-cycle"
VERBOSE=""
TASK=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --live)
            LIVE_MODE="--live"
            shift
            ;;
        --repo)
            REPO_PATH="$2"
            shift 2
            ;;
        --type)
            WORKFLOW_TYPE="$2"
            shift 2
            ;;
        --verbose)
            VERBOSE="--verbose"
            shift
            ;;
        --help|-h)
            head -25 "$0" | tail -22
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *)
            TASK="$1"
            shift
            ;;
    esac
done

# Validate task
if [[ -z "$TASK" ]]; then
    echo "Error: Task description required" >&2
    echo "Usage: $0 [options] \"task description\"" >&2
    exit 1
fi

# Resolve repo path
REPO_PATH=$(cd "$REPO_PATH" && pwd)

# Print configuration
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Multi-Agent Workflow                                      ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  Task: ${TASK:0:50}"
echo "║  Type: $WORKFLOW_TYPE"
echo "║  Repo: $REPO_PATH"
echo "║  Mode: ${LIVE_MODE:-stub}"
echo "╚════════════════════════════════════════════════════════════╝"
echo

# Check if moltbot is available
if ! command -v moltbot &> /dev/null; then
    echo "Error: moltbot command not found" >&2
    echo "Install with: npm install -g moltbot" >&2
    exit 1
fi

# Start workflow
echo "Starting workflow..."
RUN_ID=$(moltbot workflow start \
    --type "$WORKFLOW_TYPE" \
    --task "$TASK" \
    --repo "$REPO_PATH" \
    $LIVE_MODE \
    2>&1 | grep -oE 'wf-[a-zA-Z0-9]+' | head -1)

if [[ -z "$RUN_ID" ]]; then
    echo "Error: Failed to start workflow" >&2
    exit 1
fi

echo "Workflow started: $RUN_ID"
echo

# Show status
echo "Checking status..."
moltbot workflow status "$RUN_ID" $VERBOSE

echo
echo "═══════════════════════════════════════════════════════════════"
echo "Commands:"
echo "  Status:  moltbot workflow status $RUN_ID"
echo "  Logs:    moltbot workflow logs $RUN_ID"
echo "  Resume:  moltbot workflow resume $RUN_ID"
echo "  Cancel:  moltbot workflow cancel $RUN_ID"
echo
echo "Artifacts: ~/.clawdbot/workflows/$RUN_ID/"
echo "═══════════════════════════════════════════════════════════════"
