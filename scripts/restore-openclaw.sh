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
SAFE_MERGE=true  # Preserve gateway config if missing from backup (default: on for safety)

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
    --safe-merge)
      SAFE_MERGE=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--profile dev|default] [--date YYYY-MM-DD] [--dry-run] [--safe-merge]"
      echo ""
      echo "Restore openclaw configuration from backup."
      echo ""
      echo "Options:"
      echo "  --profile     Profile to restore (dev or default). Default: default"
      echo "  --date        Backup date to restore (YYYY-MM-DD). Default: latest"
      echo "  --dry-run     Show what would be restored without making changes"
      echo "  --safe-merge  Preserve gateway.mode and gateway.auth.token if missing from backup"
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

# 1. Restore config (with safe-merge support)
if [[ -f "$BACKUP_DIR/openclaw.json" ]]; then
  echo "Restoring config..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Would copy openclaw.json to $OPENCLAW_DIR/"
    if [[ "$SAFE_MERGE" == "true" ]]; then
      echo "  [dry-run] Would preserve gateway.mode and gateway.auth.token if missing"
    fi
  else
    mkdir -p "$OPENCLAW_DIR"

    # Safe-merge: preserve gateway config if missing from backup
    if [[ "$SAFE_MERGE" == "true" && -f "$OPENCLAW_DIR/openclaw.json" ]]; then
      # Extract current gateway config
      CURRENT_MODE=$(grep -o '"mode"[[:space:]]*:[[:space:]]*"[^"]*"' "$OPENCLAW_DIR/openclaw.json" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)
      CURRENT_TOKEN=$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$OPENCLAW_DIR/openclaw.json" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)

      # Copy backup config
      cp "$BACKUP_DIR/openclaw.json" "$OPENCLAW_DIR/"

      # Check if backup has gateway config
      BACKUP_HAS_MODE=$(grep -c '"mode"[[:space:]]*:[[:space:]]*"local"' "$OPENCLAW_DIR/openclaw.json" 2>/dev/null || echo 0)
      BACKUP_HAS_TOKEN=$(grep -c '"token"[[:space:]]*:[[:space:]]*"[^"]\+"' "$OPENCLAW_DIR/openclaw.json" 2>/dev/null || echo 0)

      # Restore missing gateway config via CLI
      if [[ "$BACKUP_HAS_MODE" -eq 0 && -n "$CURRENT_MODE" ]]; then
        echo "  ℹ Preserving gateway.mode=$CURRENT_MODE (missing from backup)"
        cd "$REPO_ROOT" && pnpm openclaw config set gateway.mode "$CURRENT_MODE" 2>/dev/null || true
      fi
      if [[ "$BACKUP_HAS_TOKEN" -eq 0 && -n "$CURRENT_TOKEN" ]]; then
        echo "  ℹ Preserving gateway.auth.token (missing from backup)"
        cd "$REPO_ROOT" && pnpm openclaw config set gateway.auth.token "$CURRENT_TOKEN" 2>/dev/null || true
      fi
    else
      cp "$BACKUP_DIR/openclaw.json" "$OPENCLAW_DIR/"
    fi
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

# 7. Restore memory databases (facts.db + main.sqlite)
if [[ -d "$BACKUP_DIR/memory" ]]; then
  echo "Restoring memory databases..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Would copy memory/ to $OPENCLAW_DIR/memory/"
  else
    mkdir -p "$OPENCLAW_DIR/memory"
    if [[ -f "$BACKUP_DIR/memory/facts.db" ]]; then
      cp "$BACKUP_DIR/memory/facts.db" "$OPENCLAW_DIR/memory/"
      echo "  ✓ memory/facts.db"
    fi
    if [[ -f "$BACKUP_DIR/memory/main.sqlite" ]]; then
      cp "$BACKUP_DIR/memory/main.sqlite" "$OPENCLAW_DIR/memory/"
      echo "  ✓ memory/main.sqlite"
    fi
  fi
else
  echo "  ⚠ Memory databases not in backup (optional)"
fi

# 8. Restore agents (sessions history)
if [[ -d "$BACKUP_DIR/agents" ]]; then
  echo "Restoring agents (sessions history)..."
  if [[ "$DRY_RUN" == "true" ]]; then
    # Count what would be restored
    session_count=$(find "$BACKUP_DIR/agents" -name "*.jsonl" -o -name "sessions.json" 2>/dev/null | wc -l | tr -d ' ')
    echo "  [dry-run] Would restore agents/*/sessions/ ($session_count files)"
  else
    for agent_backup in "$BACKUP_DIR/agents"/*/; do
      if [[ -d "$agent_backup" ]]; then
        agent_name=$(basename "$agent_backup")
        sessions_backup="$agent_backup/sessions"

        if [[ -d "$sessions_backup" ]]; then
          mkdir -p "$OPENCLAW_DIR/agents/$agent_name/sessions"
          cp -R "$sessions_backup"/* "$OPENCLAW_DIR/agents/$agent_name/sessions/" 2>/dev/null || true
        fi
      fi
    done

    # Count restored
    session_count=$(find "$OPENCLAW_DIR/agents" -name "*.jsonl" -o -name "sessions.json" 2>/dev/null | wc -l | tr -d ' ')
    echo "  ✓ agents/*/sessions/ ($session_count files restored)"
  fi
else
  echo "  ⚠ Sessions history not in backup (optional)"
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

# 6. Rebuild UI + gateway (ensures UI is up-to-date after restore)
echo "=== Rebuilding ==="
cd "$REPO_ROOT"

if [[ -f "package.json" ]]; then
  echo "Rebuilding UI..."
  pnpm ui:build 2>/dev/null || echo "  ⚠ UI build skipped (not in repo dir)"

  echo "Rebuilding gateway..."
  pnpm build 2>/dev/null || echo "  ⚠ Build skipped (not in repo dir)"
fi

# 7. Validate config before restarting gateway
echo "=== Config Validation ==="

OPENCLAW_STATE_DIR="$OPENCLAW_DIR" "$SCRIPT_DIR/gateway-preflight.sh"
PREFLIGHT_STATUS=$?

if [[ "$PREFLIGHT_STATUS" -ne 0 ]]; then
  echo ""
  echo -e "\033[0;31m[CONFIG_INVALID]\033[0m Gateway will NOT be started."
  echo "Fix the config issues above, then start gateway manually:"
  echo "  nohup pnpm openclaw gateway run --port 18789 > /tmp/gateway.log 2>&1 &"
  exit 1
fi

# 8. Restart gateway
echo "=== Restarting Gateway ==="

if [[ "$PROFILE" == "dev" ]]; then
  nohup node ./openclaw.mjs --profile dev gateway run --port 19001 > /tmp/gateway.log 2>&1 &
else
  nohup node ./openclaw.mjs gateway run --port 18789 > /tmp/gateway.log 2>&1 &
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
