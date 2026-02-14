#!/usr/bin/env bash
#
# security-audit.sh - Check security posture of openclaw installation
#
# Usage: ./scripts/security-audit.sh [--profile dev|default] [--fix]
#
# Exit codes:
#   0 - All checks passed
#   1 - Critical issues found
#   2 - Warnings only
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
PROFILE="default"
FIX_MODE=false
CRITICAL_ISSUES=0
WARNINGS=0

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --fix)
      FIX_MODE=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--profile dev|default] [--fix]"
      echo ""
      echo "Security audit for openclaw installation."
      echo ""
      echo "Options:"
      echo "  --profile   Profile to audit (dev or default). Default: default"
      echo "  --fix       Automatically fix permission issues"
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

BACKUP_DIR="$HOME/Backups/openclaw"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              OPENCLAW SECURITY AUDIT                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Profile: $PROFILE"
echo "Config:  $OPENCLAW_DIR"
echo "Backups: $BACKUP_DIR"
echo ""

# Function to check directory permissions
check_dir_perms() {
  local dir="$1"
  local expected="$2"
  local label="$3"

  if [[ ! -d "$dir" ]]; then
    echo -e "  ${YELLOW}SKIP${NC} $label - directory not found"
    return 0
  fi

  local perms
  perms=$(stat -f "%Lp" "$dir" 2>/dev/null || stat -c "%a" "$dir" 2>/dev/null)

  if [[ "$perms" == "$expected" ]]; then
    echo -e "  ${GREEN}PASS${NC} $label ($dir) = $perms"
    return 0
  else
    echo -e "  ${RED}FAIL${NC} $label ($dir) = $perms (expected $expected)"
    if [[ "$FIX_MODE" == "true" ]]; then
      chmod "$expected" "$dir"
      echo -e "       ${GREEN}FIXED${NC} → $expected"
    fi
    return 1
  fi
}

# Function to check file permissions
check_file_perms() {
  local file="$1"
  local expected="$2"
  local label="$3"

  if [[ ! -f "$file" ]]; then
    echo -e "  ${YELLOW}SKIP${NC} $label - file not found"
    return 0
  fi

  local perms
  perms=$(stat -f "%Lp" "$file" 2>/dev/null || stat -c "%a" "$file" 2>/dev/null)

  if [[ "$perms" == "$expected" ]]; then
    echo -e "  ${GREEN}PASS${NC} $label ($file) = $perms"
    return 0
  else
    echo -e "  ${RED}FAIL${NC} $label ($file) = $perms (expected $expected)"
    if [[ "$FIX_MODE" == "true" ]]; then
      chmod "$expected" "$file"
      echo -e "       ${GREEN}FIXED${NC} → $expected"
    fi
    return 1
  fi
}

# ============================================================================
# 1. DIRECTORY PERMISSIONS
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "1. DIRECTORY PERMISSIONS (expected: 700)"
echo "═══════════════════════════════════════════════════════════════"

check_dir_perms "$OPENCLAW_DIR" "700" "Config dir" || ((CRITICAL_ISSUES++))
check_dir_perms "$OPENCLAW_DIR/cron" "700" "Cron dir" || ((CRITICAL_ISSUES++))
check_dir_perms "$OPENCLAW_DIR/skills" "700" "Skills dir" || ((CRITICAL_ISSUES++))
check_dir_perms "$OPENCLAW_DIR/agents" "700" "Agents dir" || ((CRITICAL_ISSUES++))
check_dir_perms "$OPENCLAW_DIR/credentials" "700" "Credentials dir" || ((CRITICAL_ISSUES++))
check_dir_perms "$BACKUP_DIR" "700" "Backups root" || ((CRITICAL_ISSUES++))

echo ""

# ============================================================================
# 2. SENSITIVE FILE PERMISSIONS
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "2. SENSITIVE FILE PERMISSIONS (expected: 600)"
echo "═══════════════════════════════════════════════════════════════"

check_file_perms "$OPENCLAW_DIR/openclaw.json" "600" "Main config" || ((CRITICAL_ISSUES++))
check_file_perms "$OPENCLAW_DIR/.env" "600" "Env file" || ((CRITICAL_ISSUES++))
check_file_perms "$OPENCLAW_DIR/openclaw.json.bak" "600" "Config backup" || ((WARNINGS++))
check_file_perms "$OPENCLAW_DIR/credentials/oauth.json" "600" "OAuth creds" || ((CRITICAL_ISSUES++))

# Check auth-profiles in agents
if [[ -d "$OPENCLAW_DIR/agents" ]]; then
  while IFS= read -r -d '' auth_file; do
    check_file_perms "$auth_file" "600" "Auth profile" || ((CRITICAL_ISSUES++))
  done < <(find "$OPENCLAW_DIR/agents" -name "auth-profiles.json" -print0 2>/dev/null)
fi

echo ""

# ============================================================================
# 3. BACKUP PERMISSIONS
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "3. BACKUP PERMISSIONS"
echo "═══════════════════════════════════════════════════════════════"

if [[ -d "$BACKUP_DIR" ]]; then
  # Check backup directories
  backup_issues=0
  while IFS= read -r -d '' backup_subdir; do
    perms=$(stat -f "%Lp" "$backup_subdir" 2>/dev/null || stat -c "%a" "$backup_subdir" 2>/dev/null)
    if [[ "$perms" != "700" ]]; then
      echo -e "  ${RED}FAIL${NC} $backup_subdir = $perms (expected 700)"
      ((backup_issues++))
      if [[ "$FIX_MODE" == "true" ]]; then
        chmod 700 "$backup_subdir"
        echo -e "       ${GREEN}FIXED${NC}"
      fi
    fi
  done < <(find "$BACKUP_DIR" -type d -print0 2>/dev/null)

  # Check backup files
  while IFS= read -r -d '' backup_file; do
    perms=$(stat -f "%Lp" "$backup_file" 2>/dev/null || stat -c "%a" "$backup_file" 2>/dev/null)
    if [[ "$perms" != "600" ]]; then
      echo -e "  ${RED}FAIL${NC} $backup_file = $perms (expected 600)"
      ((backup_issues++))
      if [[ "$FIX_MODE" == "true" ]]; then
        chmod 600 "$backup_file"
        echo -e "       ${GREEN}FIXED${NC}"
      fi
    fi
  done < <(find "$BACKUP_DIR" -type f -print0 2>/dev/null)

  if [[ "$backup_issues" -eq 0 ]]; then
    echo -e "  ${GREEN}PASS${NC} All backup files/dirs have correct permissions"
  else
    ((CRITICAL_ISSUES += backup_issues))
  fi
else
  echo -e "  ${YELLOW}SKIP${NC} Backup directory not found"
fi

echo ""

# ============================================================================
# 4. REPOSITORY SECRETS SCAN
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "4. REPOSITORY SECRETS SCAN"
echo "═══════════════════════════════════════════════════════════════"

cd "$REPO_ROOT"

# Patterns to search for (real secrets, not test/doc patterns)
SECRET_PATTERNS=(
  'sk-ant-[a-zA-Z0-9_-]{20,}'      # Anthropic API key
  'sk-proj-[a-zA-Z0-9_-]{20,}'     # OpenAI project key
  'sk-[a-zA-Z0-9]{48}'             # OpenAI legacy key
  'xoxb-[0-9]{10,}-[0-9]{10,}'     # Slack bot token
  'xoxp-[0-9]{10,}-[0-9]{10,}'     # Slack user token
  'ghp_[a-zA-Z0-9]{36}'            # GitHub personal token
  'gho_[a-zA-Z0-9]{36}'            # GitHub OAuth token
  'bot[0-9]{9,}:[a-zA-Z0-9_-]{35}' # Telegram bot token
)

secrets_found=0
for pattern in "${SECRET_PATTERNS[@]}"; do
  # Search in tracked files only, exclude tests and docs
  if rg -l "$pattern" --glob '!*.test.ts' --glob '!*.test.js' --glob '!*.md' --glob '!node_modules/**' . 2>/dev/null | grep -v -E '(test|spec|mock|fixture|example)' | head -1 | grep -q .; then
    echo -e "  ${RED}FAIL${NC} Potential secret found matching: $pattern"
    ((secrets_found++))
  fi
done

if [[ "$secrets_found" -eq 0 ]]; then
  echo -e "  ${GREEN}PASS${NC} No secrets detected in repository"
else
  ((CRITICAL_ISSUES += secrets_found))
fi

echo ""

# ============================================================================
# 5. .GITIGNORE CHECK
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "5. .GITIGNORE SECURITY PATTERNS"
echo "═══════════════════════════════════════════════════════════════"

required_patterns=(
  ".env"
  "Backups/"
  "**/openclaw.json"
)

for pattern in "${required_patterns[@]}"; do
  if grep -qF "$pattern" "$REPO_ROOT/.gitignore" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} Pattern in .gitignore: $pattern"
  else
    echo -e "  ${RED}FAIL${NC} Missing from .gitignore: $pattern"
    ((WARNINGS++))
  fi
done

echo ""

# ============================================================================
# 6. SKILLS SECURITY AUDIT
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "6. SKILLS SECURITY AUDIT"
echo "═══════════════════════════════════════════════════════════════"

# Dangerous patterns to check in skills scripts
DANGEROUS_PATTERNS=(
  # Shell injection / remote code execution
  'curl.*\|.*bash'
  'curl.*\|.*sh'
  'wget.*\|.*bash'
  'wget.*\|.*sh'
  # Destructive commands
  'rm -rf /'
  'rm -rf ~'
  'rm -rf \$HOME'
  'mkfs\.'
  'dd if='
  ':\(\)\{.*:\|:&.*\};:'  # fork bomb
  # Privilege escalation
  'chmod 777'
  'chown root'
  'setcap'
  # Secrets access from skills (should use env vars instead)
  '\.openclaw/\.env'
  'auth-profiles\.json'
  'oauth\.json'
  '\.openclaw.*/openclaw\.json'
)

# Patterns that require sudo (warning, not critical)
SUDO_PATTERNS=(
  'sudo '
)

SKILLS_DIR="$REPO_ROOT/skills"
RUNTIME_SKILLS_DIR="$OPENCLAW_DIR/skills"

skills_issues=0
skills_warnings=0

scan_skills_dir() {
  local dir="$1"
  local label="$2"

  if [[ ! -d "$dir" ]]; then
    echo -e "  ${YELLOW}SKIP${NC} $label not found"
    return
  fi

  echo "  Scanning $label..."

  # Scan scripts
  while IFS= read -r -d '' script_file; do
    for pattern in "${DANGEROUS_PATTERNS[@]}"; do
      if grep -qE "$pattern" "$script_file" 2>/dev/null; then
        echo -e "    ${RED}FAIL${NC} Dangerous pattern in: $script_file"
        echo -e "         Pattern: $pattern"
        ((skills_issues++))
      fi
    done

    for pattern in "${SUDO_PATTERNS[@]}"; do
      if grep -qE "$pattern" "$script_file" 2>/dev/null; then
        echo -e "    ${YELLOW}WARN${NC} sudo usage in: $script_file"
        ((skills_warnings++))
      fi
    done
  done < <(find "$dir" -type f \( -name "*.sh" -o -name "*.py" -o -name "*.js" -o -name "*.ts" \) -print0 2>/dev/null)

  # Scan SKILL.md files for dangerous executable instructions (not config references)
  # Only check for actual dangerous commands, not documentation about config paths
  DANGEROUS_DOC_PATTERNS=(
    'curl.*\|.*bash'
    'curl.*\|.*sh'
    'wget.*\|.*bash'
    'wget.*\|.*sh'
    'rm -rf /'
    'rm -rf ~'
    ':\(\)\{.*:\|:&.*\};:'
  )
  while IFS= read -r -d '' skill_md; do
    for pattern in "${DANGEROUS_DOC_PATTERNS[@]}"; do
      if grep -qE "$pattern" "$skill_md" 2>/dev/null; then
        echo -e "    ${YELLOW}WARN${NC} Dangerous pattern in docs: $skill_md"
        echo -e "         Pattern: $pattern"
        ((skills_warnings++))
      fi
    done
  done < <(find "$dir" -type f -name "SKILL.md" -print0 2>/dev/null)
}

# Scan both repo skills and runtime skills
scan_skills_dir "$SKILLS_DIR" "Repository skills ($SKILLS_DIR)"
scan_skills_dir "$RUNTIME_SKILLS_DIR" "Runtime skills ($RUNTIME_SKILLS_DIR)"

if [[ "$skills_issues" -eq 0 && "$skills_warnings" -eq 0 ]]; then
  echo -e "  ${GREEN}PASS${NC} No dangerous patterns found in skills"
elif [[ "$skills_issues" -eq 0 ]]; then
  echo -e "  ${YELLOW}PASS with warnings${NC} ($skills_warnings warnings)"
  ((WARNINGS += skills_warnings))
else
  echo -e "  ${RED}FAIL${NC} Found $skills_issues dangerous patterns"
  ((CRITICAL_ISSUES += skills_issues))
  ((WARNINGS += skills_warnings))
fi

echo ""

# ============================================================================
# 7. DEPLOYMENT ENVIRONMENT CHECK
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "7. DEPLOYMENT ENVIRONMENT CHECK"
echo "═══════════════════════════════════════════════════════════════"

PROD_REPO="${OPENCLAW_PROD_DIR:-$HOME/openclaw-prod}"

# Check if production repo exists and is clean
if [[ -d "$PROD_REPO" ]]; then
  echo "  Checking production repo: $PROD_REPO"

  cd "$PROD_REPO"

  # Check repo is clean
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    echo -e "  ${RED}FAIL${NC} Production repo is dirty (has uncommitted changes)"
    git status --porcelain | head -5 | sed 's/^/       /'
    ((CRITICAL_ISSUES++))
  else
    echo -e "  ${GREEN}PASS${NC} Production repo is clean"
  fi

  # Check upstream remote
  if git remote get-url upstream &>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} Upstream remote configured"

    # Check if on upstream/main
    git fetch upstream --quiet 2>/dev/null || true
    CURRENT=$(git rev-parse HEAD 2>/dev/null)
    UPSTREAM=$(git rev-parse upstream/main 2>/dev/null || echo "unknown")

    if [[ "$CURRENT" == "$UPSTREAM" ]]; then
      echo -e "  ${GREEN}PASS${NC} Production is up to date with upstream/main"
    elif [[ "$UPSTREAM" != "unknown" ]]; then
      echo -e "  ${YELLOW}WARN${NC} Production is behind upstream/main"
      behind_count=$(git rev-list --count HEAD..upstream/main 2>/dev/null || echo "?")
      echo -e "       $behind_count commits behind"
      ((WARNINGS++))
    fi
  else
    echo -e "  ${YELLOW}WARN${NC} No upstream remote configured in production repo"
    ((WARNINGS++))
  fi

  cd "$REPO_ROOT"
else
  echo -e "  ${YELLOW}SKIP${NC} Production repo not found at $PROD_REPO"
  echo -e "       See docs/DEPLOYMENT.md for setup instructions"
fi

# Check state directory isolation
echo ""
echo "  State directory isolation:"

PROD_STATE="$HOME/.openclaw"
DEV_STATE="$HOME/.openclaw-dev"

if [[ -d "$PROD_STATE" ]]; then
  echo -e "  ${GREEN}PASS${NC} Production state exists: $PROD_STATE"
else
  echo -e "  ${YELLOW}WARN${NC} Production state not found: $PROD_STATE"
fi

if [[ -d "$DEV_STATE" ]]; then
  echo -e "  ${GREEN}PASS${NC} Development state exists: $DEV_STATE"
else
  echo -e "  ${YELLOW}SKIP${NC} Development state not found: $DEV_STATE"
fi

# Check for cross-contamination in sessions.json
check_state_paths() {
  local state_dir="$1"
  local expected_prefix="$2"
  local label="$3"

  if [[ ! -d "$state_dir/agents" ]]; then
    return 0
  fi

  while IFS= read -r -d '' sessions_file; do
    # Check if sessionFile paths point to wrong state directory
    if grep -q "sessionFile.*/.openclaw" "$sessions_file" 2>/dev/null; then
      local wrong_paths
      wrong_paths=$(grep -o '"sessionFile"[^,]*' "$sessions_file" | grep -v "$expected_prefix" | head -1)
      if [[ -n "$wrong_paths" ]]; then
        echo -e "  ${RED}FAIL${NC} $label sessions.json contains wrong paths"
        echo -e "       Expected prefix: $expected_prefix"
        ((CRITICAL_ISSUES++))
        return 1
      fi
    fi
  done < <(find "$state_dir/agents" -name "sessions.json" -print0 2>/dev/null)

  return 0
}

check_state_paths "$PROD_STATE" "$PROD_STATE" "Production"
check_state_paths "$DEV_STATE" "$DEV_STATE" "Development"

echo ""

# ============================================================================
# SUMMARY
# ============================================================================
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                      AUDIT SUMMARY                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

if [[ "$CRITICAL_ISSUES" -eq 0 && "$WARNINGS" -eq 0 ]]; then
  echo -e "${GREEN}✓ ALL CHECKS PASSED${NC}"
  echo ""
  exit 0
elif [[ "$CRITICAL_ISSUES" -eq 0 ]]; then
  echo -e "${YELLOW}⚠ WARNINGS: $WARNINGS${NC}"
  echo ""
  echo "Run with --fix to automatically fix issues"
  exit 2
else
  echo -e "${RED}✗ CRITICAL ISSUES: $CRITICAL_ISSUES${NC}"
  echo -e "${YELLOW}⚠ WARNINGS: $WARNINGS${NC}"
  echo ""
  echo "Run with --fix to automatically fix permission issues"
  exit 1
fi
