#!/usr/bin/env bash
# Pre-commit wrapper: chains the secret scanner and the structural test suite.
# Installed at .git/hooks/pre-commit by config/hooks/install-pre-commit.sh.
#
# Order matters:
#   1. Secret scan first — fast (~50ms), high-stakes block (no leaked tokens)
#   2. Structural tests --quick — slower (~200ms), catches drift before commit
#
# Either failing aborts the commit. To bypass (use sparingly), run with
# git commit --no-verify. The GitHub Actions workflow at
# .github/workflows/test-structure.yml runs the full suite on push as a
# second line of defense.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"

# Secret scan
"$REPO_ROOT/config/hooks/pre-commit-secret-scan.sh"

# Structural tests (fast subset only — slow tests like tsc run in CI)
bash "$REPO_ROOT/tests/run-all.sh" --quick
