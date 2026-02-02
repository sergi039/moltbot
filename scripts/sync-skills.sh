#!/usr/bin/env bash
#
# sync-skills.sh - Sync skills from repo to runtime directory
#
# Usage: ./scripts/sync-skills.sh [--profile dev|default]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default profile
PROFILE="default"

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
      echo "Sync skills from repo to runtime directory."
      echo ""
      echo "Options:"
      echo "  --profile   Profile to use (dev or default). Default: default"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Determine runtime path based on profile
if [[ "$PROFILE" == "dev" ]]; then
  RUNTIME_DIR="$HOME/.openclaw-dev"
else
  RUNTIME_DIR="$HOME/.openclaw"
fi

SKILLS_SRC="$REPO_ROOT/skills"
SKILLS_LOCAL="$REPO_ROOT/skills-local"
SKILLS_DST="$RUNTIME_DIR/skills"

echo "=== Sync Skills ==="
echo "Profile: $PROFILE"
echo "Source:  $SKILLS_SRC"
echo "Local:   $SKILLS_LOCAL (overlay if present)"
echo "Target:  $SKILLS_DST"
echo ""

# Check source exists
if [[ ! -d "$SKILLS_SRC" ]]; then
  echo "ERROR: Skills source directory not found: $SKILLS_SRC"
  exit 1
fi

# Create target directory if needed
mkdir -p "$SKILLS_DST"

# Sync each skill from repo (preserves other skills in target)
for skill_dir in "$SKILLS_SRC"/*/; do
  if [[ -d "$skill_dir" ]]; then
    skill_name=$(basename "$skill_dir")
    echo "Syncing skill: $skill_name"

    # Create target skill directory
    mkdir -p "$SKILLS_DST/$skill_name"

    # Use rsync to preserve permissions and handle updates
    # Note: trailing slash on source means "copy contents of"
    rsync -av --delete "$skill_dir" "$SKILLS_DST/$skill_name/"
  fi
done

# Overlay local skills if present
if [[ -d "$SKILLS_LOCAL" ]]; then
  echo ""
  echo "=== Overlay Local Skills ==="
  for skill_dir in "$SKILLS_LOCAL"/*/; do
    if [[ -d "$skill_dir" ]]; then
      skill_name=$(basename "$skill_dir")
      echo "Overlaying skill: $skill_name"

      mkdir -p "$SKILLS_DST/$skill_name"
      rsync -av --delete "$skill_dir" "$SKILLS_DST/$skill_name/"
    fi
  done
fi

echo ""
echo "=== Sync Complete ==="

# Verify
echo ""
echo "Skills in $SKILLS_DST:"
ls -la "$SKILLS_DST/" 2>/dev/null || echo "(empty)"

# Check if multi-agent-workflow exists
if [[ -d "$SKILLS_DST/multi-agent-workflow" ]]; then
  echo ""
  echo "✓ multi-agent-workflow skill synced successfully"
else
  echo ""
  echo "⚠ multi-agent-workflow skill not found in source"
fi
