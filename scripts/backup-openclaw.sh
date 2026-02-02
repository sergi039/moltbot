#!/usr/bin/env bash
#
# backup-openclaw.sh - Backup openclaw config, cron, skills, and workflows
#
# Usage: ./scripts/backup-openclaw.sh [--profile dev|default] [--keep N]
#
# Security: All backups are created with restrictive permissions (700/600)
#

set -euo pipefail

# SECURITY: Set restrictive umask for all created files/directories
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
PROFILE="default"
KEEP_DAYS=14
BACKUP_BASE="$HOME/Backups/openclaw"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --keep)
      KEEP_DAYS="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--profile dev|default] [--keep N]"
      echo ""
      echo "Backup openclaw configuration, cron jobs, skills, and workflows."
      echo ""
      echo "Options:"
      echo "  --profile   Profile to use (dev or default). Default: default"
      echo "  --keep      Number of backups to keep. Default: 14"
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
  CONFIG_FILE="openclaw.json"
else
  OPENCLAW_DIR="$HOME/.openclaw"
  CONFIG_FILE="openclaw.json"
fi

WORKFLOWS_DIR="$HOME/.clawdbot/workflows"
DATE=$(date +%Y-%m-%d)
BACKUP_DIR="$BACKUP_BASE/$PROFILE/$DATE"

echo "=== OpenClaw Backup ==="
echo "Profile:     $PROFILE"
echo "Source:      $OPENCLAW_DIR"
echo "Workflows:   $WORKFLOWS_DIR"
echo "Backup to:   $BACKUP_DIR"
echo "Keep:        $KEEP_DAYS backups"
echo ""

# Create backup directory
mkdir -p "$BACKUP_DIR"

# 1. Backup config
if [[ -f "$OPENCLAW_DIR/$CONFIG_FILE" ]]; then
  echo "Backing up config..."
  cp "$OPENCLAW_DIR/$CONFIG_FILE" "$BACKUP_DIR/"
  echo "  ✓ $CONFIG_FILE"
else
  echo "  ⚠ Config not found: $OPENCLAW_DIR/$CONFIG_FILE"
fi

# 2. Backup cron
if [[ -d "$OPENCLAW_DIR/cron" ]]; then
  echo "Backing up cron..."
  cp -R "$OPENCLAW_DIR/cron" "$BACKUP_DIR/"
  echo "  ✓ cron/"
else
  echo "  ⚠ Cron directory not found"
fi

# 3. Backup skills
if [[ -d "$OPENCLAW_DIR/skills" ]]; then
  echo "Backing up skills..."
  cp -R "$OPENCLAW_DIR/skills" "$BACKUP_DIR/"
  echo "  ✓ skills/"
else
  echo "  ⚠ Skills directory not found"
fi

# 4. Backup .env (if exists)
if [[ -f "$OPENCLAW_DIR/.env" ]]; then
  echo "Backing up .env..."
  cp "$OPENCLAW_DIR/.env" "$BACKUP_DIR/"
  echo "  ✓ .env"
else
  echo "  ⚠ .env not found (optional)"
fi

# 5. Backup token files (telegram, etc.)
if [[ -d "$OPENCLAW_DIR/telegram" ]]; then
  echo "Backing up telegram tokens..."
  cp -R "$OPENCLAW_DIR/telegram" "$BACKUP_DIR/"
  echo "  ✓ telegram/"
else
  echo "  ⚠ Telegram directory not found (optional)"
fi

# 6. Backup workflows (if exists)
if [[ -d "$WORKFLOWS_DIR" ]]; then
  echo "Backing up workflows..."
  cp -R "$WORKFLOWS_DIR" "$BACKUP_DIR/"
  echo "  ✓ workflows/"
else
  echo "  ⚠ Workflows directory not found (optional)"
fi

# 7. Backup memory databases (facts.db + main.sqlite)
MEMORY_DIR="$OPENCLAW_DIR/memory"
if [[ -d "$MEMORY_DIR" ]]; then
  echo "Backing up memory databases..."
  mkdir -p "$BACKUP_DIR/memory"

  # Facts DB - use sqlite3 backup for consistency (avoids copying during write)
  if [[ -f "$MEMORY_DIR/facts.db" ]]; then
    if command -v sqlite3 &> /dev/null; then
      sqlite3 "$MEMORY_DIR/facts.db" ".backup '$BACKUP_DIR/memory/facts.db'" 2>/dev/null || \
        cp "$MEMORY_DIR/facts.db" "$BACKUP_DIR/memory/"
    else
      cp "$MEMORY_DIR/facts.db" "$BACKUP_DIR/memory/"
    fi
    echo "  ✓ memory/facts.db"
  fi

  # Vector memory (main.sqlite)
  if [[ -f "$MEMORY_DIR/main.sqlite" ]]; then
    if command -v sqlite3 &> /dev/null; then
      sqlite3 "$MEMORY_DIR/main.sqlite" ".backup '$BACKUP_DIR/memory/main.sqlite'" 2>/dev/null || \
        cp "$MEMORY_DIR/main.sqlite" "$BACKUP_DIR/memory/"
    else
      cp "$MEMORY_DIR/main.sqlite" "$BACKUP_DIR/memory/"
    fi
    echo "  ✓ memory/main.sqlite"
  fi
else
  echo "  ⚠ Memory directory not found (optional)"
fi

# 8. Backup agents (sessions history)
AGENTS_DIR="$OPENCLAW_DIR/agents"
if [[ -d "$AGENTS_DIR" ]]; then
  echo "Backing up agents (sessions history)..."
  mkdir -p "$BACKUP_DIR/agents"

  # Count sessions for reporting
  SESSION_COUNT=0
  TOTAL_SIZE=0

  for agent_dir in "$AGENTS_DIR"/*/; do
    if [[ -d "$agent_dir" ]]; then
      agent_name=$(basename "$agent_dir")
      sessions_dir="$agent_dir/sessions"

      if [[ -d "$sessions_dir" ]]; then
        mkdir -p "$BACKUP_DIR/agents/$agent_name/sessions"
        cp -R "$sessions_dir"/* "$BACKUP_DIR/agents/$agent_name/sessions/" 2>/dev/null || true

        # Count files
        count=$(find "$sessions_dir" -name "*.jsonl" -o -name "sessions.json" 2>/dev/null | wc -l | tr -d ' ')
        SESSION_COUNT=$((SESSION_COUNT + count))

        # Get size
        size=$(du -sk "$sessions_dir" 2>/dev/null | cut -f1 || echo 0)
        TOTAL_SIZE=$((TOTAL_SIZE + size))
      fi
    fi
  done

  if [[ "$SESSION_COUNT" -gt 0 ]]; then
    echo "  ✓ agents/*/sessions/ ($SESSION_COUNT files, ${TOTAL_SIZE}KB)"
  else
    echo "  ⚠ No session files found"
  fi
else
  echo "  ⚠ Agents directory not found (optional)"
fi

# 9. Create VERSION file
echo "Creating VERSION file..."
VERSION=""

# Try to get version from config
if [[ -f "$OPENCLAW_DIR/$CONFIG_FILE" ]]; then
  VERSION=$(grep -o '"lastTouchedVersion"[[:space:]]*:[[:space:]]*"[^"]*"' "$OPENCLAW_DIR/$CONFIG_FILE" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' || true)
fi

# Fallback to git describe
if [[ -z "$VERSION" ]]; then
  VERSION=$(cd "$REPO_ROOT" && git describe --tags --always 2>/dev/null || echo "unknown")
fi

cat > "$BACKUP_DIR/VERSION" << EOF
version: $VERSION
profile: $PROFILE
date: $DATE
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
hostname: $(hostname)
EOF
echo "  ✓ VERSION"

# 6. Rotation - keep only N most recent backups
echo ""
echo "Rotating old backups (keeping $KEEP_DAYS)..."
PROFILE_BACKUP_DIR="$BACKUP_BASE/$PROFILE"

if [[ -d "$PROFILE_BACKUP_DIR" ]]; then
  # List directories sorted by name (date format ensures chronological order)
  # shellcheck disable=SC2012
  BACKUP_COUNT=$(ls -1d "$PROFILE_BACKUP_DIR"/????-??-?? 2>/dev/null | wc -l | tr -d ' ')

  if [[ "$BACKUP_COUNT" -gt "$KEEP_DAYS" ]]; then
    TO_DELETE=$((BACKUP_COUNT - KEEP_DAYS))
    echo "  Deleting $TO_DELETE old backup(s)..."

    # shellcheck disable=SC2012
    ls -1d "$PROFILE_BACKUP_DIR"/????-??-?? 2>/dev/null | head -n "$TO_DELETE" | while read -r old_backup; do
      echo "    Removing: $old_backup"
      rm -rf "$old_backup"
    done
  else
    echo "  No rotation needed ($BACKUP_COUNT backups)"
  fi
fi

echo ""

# SECURITY: Enforce restrictive permissions on backup
echo "Enforcing secure permissions..."
find "$BACKUP_DIR" -type d -exec chmod 700 {} \;
find "$BACKUP_DIR" -type f -exec chmod 600 {} \;
chmod 700 "$PROFILE_BACKUP_DIR" "$BACKUP_BASE" 2>/dev/null || true
echo "  ✓ Permissions set (dirs=700, files=600)"

# SECURITY: Check source directory permissions
if [[ -d "$OPENCLAW_DIR" ]]; then
  SOURCE_PERMS=$(stat -f "%Lp" "$OPENCLAW_DIR" 2>/dev/null || stat -c "%a" "$OPENCLAW_DIR" 2>/dev/null)
  if [[ "$SOURCE_PERMS" != "700" ]]; then
    echo ""
    echo "⚠ WARNING: Source directory $OPENCLAW_DIR has permissions $SOURCE_PERMS (should be 700)"
    echo "  Run: chmod 700 $OPENCLAW_DIR"
  fi
fi

echo ""
echo "=== Backup Complete ==="
echo "Backup location: $BACKUP_DIR"
echo ""
echo "Contents:"
ls -la "$BACKUP_DIR/"
