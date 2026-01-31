#!/usr/bin/env bash
#
# restore-openclaw.sh - Restore openclaw from backup
#
# Usage: ./scripts/restore-openclaw.sh [--profile dev|default] [--date YYYY-MM-DD]
#
# Security: All restored files get restrictive permissions (700/600)
#

set -euo pipefail

# SECURITY: Set restrictive umask for all created files/directories
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
PROFILE="default"
RESTORE_DATE=""
BACKUP_BASE="$HOME/Backups/openclaw"
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --date)
      RESTORE_DATE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--profile dev|default] [--date YYYY-MM-DD] [--dry-run]"
      echo ""
      echo "Restore openclaw configuration from backup."
      echo ""
      echo "Options:"
      echo "  --profile   Profile to restore (dev or default). Default: default"
      echo "  --date      Backup date to restore (YYYY-MM-DD). Default: latest"
      echo "  --dry-run   Show what would be restored without making changes"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Determine paths based on profile
if [[ "$PROFILE" == "dev" ]]; then
  OPENCLAW_DIR="$HOME/.openclaw-dev"
else
  OPENCLAW_DIR="$HOME/.openclaw"
fi

WORKFLOWS_DIR="$HOME/.clawdbot/workflows"
PROFILE_BACKUP_DIR="$BACKUP_BASE/$PROFILE"

echo "=== OpenClaw Restore ==="
echo "Profile: $PROFILE"
echo "Target:  $OPENCLAW_DIR"
echo ""

# Find backup to restore
if [[ -z "$RESTORE_DATE" ]]; then
  # Use latest backup
  if [[ ! -d "$PROFILE_BACKUP_DIR" ]]; then
    echo "ERROR: No backups found for profile '$PROFILE' at $PROFILE_BACKUP_DIR"
    exit 1
  fi

  # shellcheck disable=SC2012
  RESTORE_DATE=$(ls -1d "$PROFILE_BACKUP_DIR"/????-??-?? 2>/dev/null | tail -1 | xargs basename 2>/dev/null || true)

  if [[ -z "$RESTORE_DATE" ]]; then
    echo "ERROR: No backups found in $PROFILE_BACKUP_DIR"
    exit 1
  fi

  echo "Using latest backup: $RESTORE_DATE"
fi

BACKUP_DIR="$PROFILE_BACKUP_DIR/$RESTORE_DATE"

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "ERROR: Backup not found: $BACKUP_DIR"
  echo ""
  echo "Available backups:"
  ls -1d "$PROFILE_BACKUP_DIR"/????-??-?? 2>/dev/null || echo "  (none)"
  exit 1
fi

echo "Restoring from: $BACKUP_DIR"
echo ""

# Show VERSION info
if [[ -f "$BACKUP_DIR/VERSION" ]]; then
  echo "Backup info:"
  cat "$BACKUP_DIR/VERSION"
  echo ""
fi

# Pre-flight: Check if gateway is running
echo "=== Pre-flight Checks ==="

GATEWAY_PID=$(pgrep -f "gateway" || true)
if [[ -n "$GATEWAY_PID" ]]; then
  echo "⚠ Gateway is running (PID: $GATEWAY_PID)"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Would stop gateway"
  else
    echo "Stopping gateway..."
    pkill -9 -f "gateway" || true
    sleep 2

    # Verify stopped
    if pgrep -f "gateway" > /dev/null; then
      echo "ERROR: Failed to stop gateway"
      exit 1
    fi
    echo "  ✓ Gateway stopped"
  fi
else
  echo "✓ Gateway not running"
fi

echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  echo "=== Dry Run - Would Restore ==="
else
  echo "=== Restoring ==="
fi

# 1. Restore config
if [[ -f "$BACKUP_DIR/openclaw.json" ]]; then
  echo "Restoring config..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Would copy openclaw.json to $OPENCLAW_DIR/"
  else
    mkdir -p "$OPENCLAW_DIR"
    cp "$BACKUP_DIR/openclaw.json" "$OPENCLAW_DIR/"
    echo "  ✓ openclaw.json"
  fi
else
  echo "  ⚠ Config not in backup"
fi

# 2. Restore cron
if [[ -d "$BACKUP_DIR/cron" ]]; then
  echo "Restoring cron..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Would copy cron/ to $OPENCLAW_DIR/"
  else
    mkdir -p "$OPENCLAW_DIR"
    rm -rf "$OPENCLAW_DIR/cron"
    cp -R "$BACKUP_DIR/cron" "$OPENCLAW_DIR/"
    echo "  ✓ cron/"
  fi
else
  echo "  ⚠ Cron not in backup"
fi

# 3. Restore skills
if [[ -d "$BACKUP_DIR/skills" ]]; then
  echo "Restoring skills..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Would copy skills/ to $OPENCLAW_DIR/"
  else
    mkdir -p "$OPENCLAW_DIR"
    rm -rf "$OPENCLAW_DIR/skills"
    cp -R "$BACKUP_DIR/skills" "$OPENCLAW_DIR/"
    echo "  ✓ skills/"
  fi
else
  echo "  ⚠ Skills not in backup"
fi

# 4. Restore .env (if in backup)
if [[ -f "$BACKUP_DIR/.env" ]]; then
  echo "Restoring .env..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Would copy .env to $OPENCLAW_DIR/"
  else
    cp "$BACKUP_DIR/.env" "$OPENCLAW_DIR/"
    echo "  ✓ .env"
  fi
else
  echo "  ⚠ .env not in backup (optional)"
fi

# 5. Restore telegram tokens (if in backup)
if [[ -d "$BACKUP_DIR/telegram" ]]; then
  echo "Restoring telegram tokens..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Would copy telegram/ to $OPENCLAW_DIR/"
  else
    rm -rf "$OPENCLAW_DIR/telegram"
    cp -R "$BACKUP_DIR/telegram" "$OPENCLAW_DIR/"
    echo "  ✓ telegram/"
  fi
else
  echo "  ⚠ Telegram not in backup (optional)"
fi

# 6. Restore workflows (optional)
if [[ -d "$BACKUP_DIR/workflows" ]]; then
  echo "Restoring workflows..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Would copy workflows/ to $WORKFLOWS_DIR"
  else
    mkdir -p "$(dirname "$WORKFLOWS_DIR")"
    rm -rf "$WORKFLOWS_DIR"
    cp -R "$BACKUP_DIR/workflows" "$WORKFLOWS_DIR"
    echo "  ✓ workflows/"
  fi
else
  echo "  ⚠ Workflows not in backup (optional)"
fi

echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  echo "=== Dry Run Complete ==="
  echo "Run without --dry-run to perform actual restore"
  exit 0
fi

# 5. Enforce secure permissions
echo "=== Enforcing Secure Permissions ==="
echo "Setting permissions (dirs=700, files=600)..."
find "$OPENCLAW_DIR" -type d -exec chmod 700 {} \; 2>/dev/null || true
find "$OPENCLAW_DIR" -type f -exec chmod 600 {} \; 2>/dev/null || true
if [[ -d "$WORKFLOWS_DIR" ]]; then
  find "$WORKFLOWS_DIR" -type d -exec chmod 700 {} \; 2>/dev/null || true
  find "$WORKFLOWS_DIR" -type f -exec chmod 600 {} \; 2>/dev/null || true
fi
echo "✓ Permissions enforced"

echo ""

# 6. Restart gateway
echo "=== Restarting Gateway ==="
cd "$REPO_ROOT"

if [[ "$PROFILE" == "dev" ]]; then
  nohup node ./openclaw.mjs --profile dev gateway run --port 19001 > /tmp/gateway.log 2>&1 &
else
  nohup node ./openclaw.mjs gateway run --port 19001 > /tmp/gateway.log 2>&1 &
fi

sleep 3

# Verify gateway started
if pgrep -f "gateway" > /dev/null; then
  echo "✓ Gateway started"
else
  echo "⚠ Gateway may not have started. Check /tmp/gateway.log"
fi

echo ""
echo "=== Restore Complete ==="

# 6. Verification
echo ""
echo "=== Verification ==="

# Check cron jobs
echo "Cron jobs:"
node ./openclaw.mjs --profile "$PROFILE" cron list 2>/dev/null | head -10 || echo "  (unable to list)"

# Check skills
echo ""
echo "Skills directory:"
ls -la "$OPENCLAW_DIR/skills/" 2>/dev/null || echo "  (empty)"

# Check channels
echo ""
echo "Channel status:"
node ./openclaw.mjs --profile "$PROFILE" channels status --probe 2>/dev/null | head -5 || echo "  (unable to check)"

echo ""
echo "Restore completed successfully!"
