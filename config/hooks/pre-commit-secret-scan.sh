#!/usr/bin/env bash
# Pre-commit hook: scan staged changes for raw tokens / secrets.
# Installed at .git/hooks/pre-commit — see install-pre-commit.sh.
#
# This hook is the FIRST line of defense. The GitHub Action at
# .github/workflows/lint-secrets.yml runs the same regex on push as a second
# line. Both must pass.
#
# Scope: only staged files, not the working tree. Runs fast (~50ms).
# Exits non-zero on any hit, which blocks the commit.

set -euo pipefail

# Regex patterns — kept in sync with .github/workflows/lint-secrets.yml
#   cfut_           Cloudflare API token
#   ghp_            GitHub classic PAT
#   gho_            GitHub OAuth token
#   github_pat_     GitHub fine-grained PAT
#   grn_            Granola API key
#   sk-             OpenAI / Anthropic API key prefix
#   [0-9a-f]{60,}   long hex (generic bearer, legacy MCP token)
PATTERNS=(
  '(^|[^A-Za-z0-9_])cfut_[A-Za-z0-9_]{20,}'
  '(^|[^A-Za-z0-9_])ghp_[A-Za-z0-9_]{20,}'
  '(^|[^A-Za-z0-9_])gho_[A-Za-z0-9_]{20,}'
  '(^|[^A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}'
  '(^|[^A-Za-z0-9_])grn_[A-Za-z0-9_]{20,}'
  '(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{30,}'
  '(^|[^A-Za-z0-9_])[0-9a-f]{60,}([^A-Za-z0-9_]|$)'
)

# Only scan files that are staged for commit. An unstaged file with a leaked
# token doesn't block the commit — that's a separate problem the developer
# is already aware of.
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)
if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

# Filter to text-ish file types. Binary files are skipped (we're not going
# to find a PAT in a PNG).
SCAN_EXTS='md|ts|js|json|yml|yaml|toml|sh|bash|env|example|py|txt|mjs|cjs'
FILES_TO_SCAN=$(echo "$STAGED_FILES" | grep -E "\.($SCAN_EXTS)$" || true)

# Also scan files without extensions in specific dirs (dotfiles, config)
DOTFILES=$(echo "$STAGED_FILES" | grep -E "(^|/)(\.env|Dockerfile|Makefile)$" || true)
FILES_TO_SCAN="$FILES_TO_SCAN
$DOTFILES"
FILES_TO_SCAN=$(echo "$FILES_TO_SCAN" | sed '/^$/d' | sort -u)

if [ -z "$FILES_TO_SCAN" ]; then
  exit 0
fi

# Never self-scan the hook, the workflow that implements the same regex,
# the SECURITY.md incident report (it documents redacted prefixes), or the
# memex sanitization test battery (it contains fake token fixtures by
# design — verifying the sanitizer's refuse-gate catches them).
# Also skip .claude/settings.local.json which is gitignored but may appear
# in a staged list if something odd happens — it contains allowlist rules
# with historical token literals that are never actually committed.
ALLOWLIST='(^|/)(pre-commit-secret-scan\.sh|lint-secrets\.yml|SECURITY\.md|test-memex-sanitization\.sh)$|^\.claude/'
FILES_TO_SCAN=$(echo "$FILES_TO_SCAN" | grep -vE "$ALLOWLIST" || true)

if [ -z "$FILES_TO_SCAN" ]; then
  exit 0
fi

HITS=""
while IFS= read -r file; do
  [ -f "$file" ] || continue
  for pat in "${PATTERNS[@]}"; do
    # -I skips binary. -n gives line numbers. -E for extended regex.
    match=$(grep -InE "$pat" "$file" 2>/dev/null || true)
    if [ -n "$match" ]; then
      HITS="$HITS
$file: $match"
    fi
  done
done <<< "$FILES_TO_SCAN"

if [ -n "$HITS" ]; then
  echo "" >&2
  echo "╭─────────────────────────────────────────────────────────────╮" >&2
  echo "│  ⛔  PRE-COMMIT: POTENTIAL SECRET DETECTED                  │" >&2
  echo "╰─────────────────────────────────────────────────────────────╯" >&2
  echo "" >&2
  echo "$HITS" >&2
  echo "" >&2
  echo "  → If this is a false positive (documentation, redacted prefix," >&2
  echo "    or a test value), rename the file or add it to the allowlist" >&2
  echo "    at the top of config/hooks/pre-commit-secret-scan.sh." >&2
  echo "  → If this is a real secret, DO NOT commit. Rotate the secret" >&2
  echo "    at its source, then re-stage the scrubbed file." >&2
  echo "  → Bypass with --no-verify only if you are 100% sure. All" >&2
  echo "    bypassed commits are also scanned by the GitHub Action" >&2
  echo "    .github/workflows/lint-secrets.yml on push." >&2
  echo "" >&2
  exit 1
fi

exit 0
