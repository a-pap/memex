#!/usr/bin/env bash
# Regression battery for config/memex-sync.sh sanitization rules.
# For each (input, expected) pair, pipe input through `memex-sync.sh --dry-run`
# on a temp file, compare to expected, report diff.
#
# Invoked standalone or from tests/run-all.sh via the memex_sanitization test
# delegate.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNC="$REPO_ROOT/config/memex-sync.sh"

[ -x "$SYNC" ] || chmod +x "$SYNC" 2>/dev/null || true
[ -f "$SYNC" ] || { echo "FAIL: missing $SYNC"; exit 1; }

PASSED=0
FAILED=0
FAILED_CASES=()

tmpfile() {
  local f
  f=$(mktemp -t memex-sanit.XXXXXX)
  printf '%s' "$1" > "$f"
  echo "$f"
}

assert_sanitized() {
  local label="$1"
  local input="$2"
  local expected="$3"
  local src
  src=$(tmpfile "$input")
  local got
  if ! got=$(bash "$SYNC" --dry-run "$src" 2>/dev/null); then
    FAILED=$((FAILED + 1))
    FAILED_CASES+=("$label (refused or errored)")
    rm -f "$src"
    return
  fi
  rm -f "$src"
  # Strip trailing newline from got (sanitize appends one)
  got="${got%$'\n'}"
  if [ "$got" = "$expected" ]; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    FAILED_CASES+=("$label: expected='$expected' got='$got'")
  fi
}

# Asserts that the sanitizer REFUSES to produce output (exits non-zero).
# Used to verify that leaked secrets / raw personal identifiers are blocked
# by the check_residual gate even if rule set missed them.
assert_refused() {
  local label="$1"
  local input="$2"
  local src
  src=$(tmpfile "$input")
  if bash "$SYNC" --dry-run "$src" >/dev/null 2>&1; then
    FAILED=$((FAILED + 1))
    FAILED_CASES+=("$label: expected refuse (exit 2) but got success")
  else
    PASSED=$((PASSED + 1))
  fi
  rm -f "$src"
}

# ─── Positive cases: rule strips applied correctly ─────────────────────────

assert_sanitized "personal name — English, proper case" \
  "User pushed this change" \
  "User pushed this change"

assert_sanitized "personal name — English, lowercase" \
  "hey user, ping me" \
  "hey user, ping me"

assert_sanitized "personal name — Russian" \
  "User закрыл задачу" \
  "User закрыл задачу"

assert_sanitized "last name" \
  "github.com/user/project" \
  "github.com/user/project"

assert_sanitized "[pet] the dog" \
  "[pet] is doing better" \
  "[pet] is doing better"

assert_sanitized "[side-project] references" \
  "[side-project] deploys Tuesday" \
  "[side-project] deploys Tuesday"

assert_sanitized "[employer] references" \
  "[employer] hired him in 2011" \
  "[employer] hired him in 2011"

assert_sanitized "[employer-ad-network] references" \
  "[employer-ad-network] partner meeting" \
  "[employer-ad-network] partner meeting"

assert_sanitized "Collaborator / Collaborator" \
  "Collaborator pushed PR #52" \
  "Collaborator pushed PR #52"

assert_sanitized "repo path — Mac (user strip)" \
  "open /Users/<user>/projects" \
  "open /Users/<user>/projects"

assert_sanitized "github.com URL (owner strip)" \
  "clone github.com/OWNER/REPO.git" \
  "clone github.com/OWNER/REPO.git"

assert_sanitized "repo path — Linux" \
  "scripts in /home/<user>/bin" \
  "scripts in /home/<user>/bin"

assert_sanitized "worker URL" \
  "POST to OWNER.workers.dev/mcp" \
  "POST to OWNER.workers.dev/mcp"

assert_sanitized "email — personal" \
  "contact: user@example.com" \
  "contact: user@example.com"

# ─── Negative cases: sanitizer must REFUSE output with residual secrets ─────
#
# Token fixtures are ASSEMBLED at runtime from (prefix + random_hex) rather
# than written as literals — otherwise the secret-scan hook at pre-commit
# and the lint-secrets GitHub Action would both flag this file as leaking.
# The memex-sync check_residual gate catches the full pattern after
# assembly; we construct it the same way.

random_alnum() {
  # Print N alphanumerics to stdout. Works cross-platform (no /dev/random
  # assumptions, no openssl dep).
  local n="$1"
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c "$n" || {
    # Fallback: deterministic string of the right length if /dev/urandom unavailable.
    printf '%*s' "$n" '' | tr ' ' 'a'
  }
}

_cfut_token="cfut_$(random_alnum 30)"
_ghp_token="ghp_$(random_alnum 30)"
_grn_token="grn_$(random_alnum 30)"

assert_refused "residual cfut_ token" \
  "token=${_cfut_token}"

assert_refused "residual ghp_ token" \
  "env.GH_PAT=${_ghp_token}"

assert_refused "residual grn_ Granola key" \
  "bearer ${_grn_token}"

# ─── Summary ────────────────────────────────────────────────────────────────

total=$((PASSED + FAILED))
if [ $FAILED -eq 0 ]; then
  printf "memex-sanitization: %d/%d PASS\n" "$PASSED" "$total"
  exit 0
else
  printf "memex-sanitization: %d/%d FAIL\n" "$FAILED" "$total"
  printf '  %s\n' "${FAILED_CASES[@]}"
  exit 1
fi
