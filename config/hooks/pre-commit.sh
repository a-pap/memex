#!/usr/bin/env bash
# Pre-commit wrapper: chains the secret scanner, the STATUS_SNAPSHOT auto-prune,
# and the structural test suite.
# Installed at .git/hooks/pre-commit by config/hooks/install-pre-commit.sh.
#
# Order matters:
#   1. Secret scan first — fast (~50ms), high-stakes block (no leaked tokens)
#   2. STATUS_SNAPSHOT auto-prune — archives oldest "Recent (harvest YYYY-MM-DD):"
#      block to references/status_archive/<date>.md when STATUS exceeds the
#      soft target (60 lines). Stages STATUS + the archive file so the trimmed
#      version is part of the in-flight commit. Prevents the recurring CI red
#      where daily routines (decision-harvest etc.) push STATUS past the hard
#      limit (65) and the next push to main fails test_status_snapshot_size.
#   3. Structural tests --quick — slower (~200ms), catches drift before commit
#      (skipped if tests/run-all.sh is absent, e.g. in the memex public mirror
#      where the structural suite is claude-memory-specific)
#
# Either failing aborts the commit. To bypass (use sparingly), run with
# git commit --no-verify. The GitHub Actions workflow at
# .github/workflows/test-structure.yml runs the full suite on push as a
# second line of defense.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"

# Secret scan
"$REPO_ROOT/config/hooks/pre-commit-secret-scan.sh"

# STATUS_SNAPSHOT auto-prune (no-op when at/below soft target)
if [ -f "$REPO_ROOT/scripts/status-snapshot-trim.sh" ] && [ -f "$REPO_ROOT/STATUS_SNAPSHOT.md" ]; then
  trim_output=$(bash "$REPO_ROOT/scripts/status-snapshot-trim.sh" 2>&1 || true)
  if [ -n "$trim_output" ]; then
    printf '%s\n' "$trim_output" >&2
    if printf '%s' "$trim_output" | grep -q '^status-snapshot-trim: archived'; then
      git add "$REPO_ROOT/STATUS_SNAPSHOT.md" "$REPO_ROOT/references/status_archive/" 2>/dev/null || true
    fi
  fi
fi

# Structural tests (fast subset only — slow tests like tsc run in CI)
if [ -f "$REPO_ROOT/tests/run-all.sh" ]; then
  bash "$REPO_ROOT/tests/run-all.sh" --quick
fi
