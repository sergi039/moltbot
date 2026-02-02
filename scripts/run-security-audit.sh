#!/usr/bin/env bash
#
# run-security-audit.sh - Wrapper for scheduled security audits
#
# Usage: ./scripts/run-security-audit.sh [--profile dev|default] [--alert]
#
# Logs to /tmp/moltbot-security-audit.log
# Optional Telegram alert on failure (when --alert is set)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="/tmp/moltbot-security-audit.log"

# Defaults
PROFILE="default"
ALERT_ON_FAIL=false
TELEGRAM_ENABLED=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --alert)
      ALERT_ON_FAIL=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--profile dev|default] [--alert]"
      echo ""
      echo "Options:"
      echo "  --profile   Profile to audit (dev or default). Default: default"
      echo "  --alert     Send Telegram alert on failure"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Check if Telegram alerting is possible
if [[ "$ALERT_ON_FAIL" == "true" ]]; then
  # Use token from corresponding profile
  if [[ "$PROFILE" == "dev" ]]; then
    TOKEN_FILE="$HOME/.openclaw-dev/telegram/bot-token.txt"
  else
    TOKEN_FILE="$HOME/.openclaw/telegram/bot-token.txt"
  fi

  if [[ -f "$TOKEN_FILE" ]]; then
    TELEGRAM_ENABLED=true
    TELEGRAM_TOKEN=$(cat "$TOKEN_FILE")
    # Chat ID for alerts (your user ID from allowFrom)
    TELEGRAM_CHAT_ID="15589784"
  fi
fi

# Function to send Telegram alert
send_telegram_alert() {
  local message="$1"
  if [[ "$TELEGRAM_ENABLED" == "true" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
      -d chat_id="$TELEGRAM_CHAT_ID" \
      -d text="$message" \
      -d parse_mode="Markdown" > /dev/null 2>&1 || true
  fi
}

# Start logging
{
  echo "========================================"
  echo "Security Audit - $(date '+%Y-%m-%d %H:%M:%S')"
  echo "Profile: $PROFILE"
  echo "Alert on fail: $ALERT_ON_FAIL"
  echo "========================================"
  echo ""

  # Run security audit
  cd "$REPO_ROOT"

  EXIT_CODE=0
  ./scripts/security-audit.sh --profile "$PROFILE" || EXIT_CODE=$?

  echo ""
  echo "========================================"
  echo "Exit code: $EXIT_CODE"
  echo "Completed: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "========================================"
  echo ""

  # Send alert if failed
  if [[ "$EXIT_CODE" -ne 0 && "$ALERT_ON_FAIL" == "true" ]]; then
    send_telegram_alert "⚠️ *Security Audit Failed*

Profile: \`$PROFILE\`
Exit code: \`$EXIT_CODE\`
Time: $(date '+%Y-%m-%d %H:%M:%S')

Run \`./scripts/security-audit.sh --profile $PROFILE --fix\` to resolve."
  fi

  exit $EXIT_CODE

} 2>&1 | tee -a "$LOG_FILE"
