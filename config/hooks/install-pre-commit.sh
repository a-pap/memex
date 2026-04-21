#!/usr/bin/env bash
# Install the pre-commit wrapper into .git/hooks/pre-commit.
#
# The wrapper at config/hooks/pre-commit.sh chains:
#   1. Secret scanner (config/hooks/pre-commit-secret-scan.sh)
#   2. Structural test suite quick mode (tests/run-all.sh --quick)
#
# Safe to re-run — replaces any existing hook with a symlink to the wrapper.
# Backs up any pre-existing non-symlink hook to .git/hooks/pre-commit.backup.<ts>.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOK_SRC="$REPO_ROOT/config/hooks/pre-commit.sh"
HOOK_DST="$REPO_ROOT/.git/hooks/pre-commit"

if [ ! -f "$HOOK_SRC" ]; then
  echo "ERROR: $HOOK_SRC not found. Run from claude-memory repo root." >&2
  exit 1
fi

# Verify the secret scanner exists (mandatory dependency).
if [ ! -f "$REPO_ROOT/config/hooks/pre-commit-secret-scan.sh" ]; then
  echo "ERROR: secret scanner missing at config/hooks/pre-commit-secret-scan.sh" >&2
  exit 1
fi
# Structural test runner is optional — only present in claude-memory, absent
# in the memex public mirror. pre-commit.sh handles the missing case.
HAS_RUN_ALL=0
if [ -f "$REPO_ROOT/tests/run-all.sh" ]; then
  HAS_RUN_ALL=1
fi

chmod +x "$HOOK_SRC" "$REPO_ROOT/config/hooks/pre-commit-secret-scan.sh"
if [ "$HAS_RUN_ALL" = "1" ]; then
  chmod +x "$REPO_ROOT/tests/run-all.sh"
fi

# If there's already a pre-commit hook that isn't our symlink, back it up.
if [ -e "$HOOK_DST" ] && [ ! -L "$HOOK_DST" ]; then
  mv "$HOOK_DST" "$HOOK_DST.backup.$(date +%s)"
  echo "Backed up existing pre-commit hook to $HOOK_DST.backup.*"
fi

ln -sf "$HOOK_SRC" "$HOOK_DST"
echo "✓ Pre-commit hook installed: $HOOK_DST → $HOOK_SRC"
if [ "$HAS_RUN_ALL" = "1" ]; then
  echo "  → chains: secret scan + structural tests --quick"
else
  echo "  → chains: secret scan only (tests/run-all.sh absent, skipped)"
fi
echo ""
echo "Test it (secret scan): create a file at the repo root containing the"
echo "  literal 'ghp_' followed by 30+ alphanumeric chars, stage it, attempt"
echo "  to commit. The scanner should block. Clean up the test file after."
if [ "$HAS_RUN_ALL" = "1" ]; then
  echo ""
  echo "Test it (structural tests):"
  echo "  bash tests/run-all.sh --quick"
  echo "  (should print 9 PASS, 0 FAIL, 0 SKIP)"
fi
