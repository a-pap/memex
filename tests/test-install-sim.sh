#!/usr/bin/env bash
# Fresh-install simulation: prove that a forked memex produces a working, token-free
# Claude Code memory repo out of the box. Codifies the manual pre-distribution check
# so every change is verified. Run locally (`bash tests/test-install-sim.sh`) or in CI.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok   — $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL — $1"; }

# 1. Simulate a fork/clone: copy the repo minus VCS + build artifacts.
mkdir -p "$TMP/repo"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude '.git' --exclude 'node_modules' --exclude '.wrangler' "$ROOT/" "$TMP/repo/"
else
  cp -R "$ROOT/." "$TMP/repo/"; rm -rf "$TMP/repo/.git" "$TMP/repo/node_modules" "$TMP/repo/.wrangler"
fi
cd "$TMP/repo"

# 2. Run the documented git-only QUICKSTART seed steps, verbatim.
cp templates/STATUS_SNAPSHOT.md templates/CLAUDE.md templates/RULES.md templates/BOOTSTRAP.md . 2>/dev/null
cp -r templates/hubs templates/memory . 2>/dev/null
mkdir -p .claude/skills && cp -r templates/skills/* .claude/skills/ 2>/dev/null

# 3. The structure a Claude Code user needs must exist.
for f in CLAUDE.md STATUS_SNAPSHOT.md RULES.md BOOTSTRAP.md; do
  [ -f "$f" ] && ok "root $f present" || bad "root $f missing after seed"
done
[ -f hubs/01_example_hub.md ] && ok "example hub seeded" || bad "example hub missing"
[ -f memory/MEMORY_EDITS.md ] && ok "memory/ seeded (BOOTSTRAP refs resolve)" || bad "memory/ not seeded"
n=$(ls .claude/skills/*/SKILL.md 2>/dev/null | wc -l | tr -d ' ')
[ "${n:-0}" -ge 4 ] && ok ".claude/skills/ holds $n skills (Claude Code auto-discovers)" || bad "skills not in .claude/skills/"
fm=0
for s in .claude/skills/*/SKILL.md; do
  head -12 "$s" | grep -q '^name:' && head -12 "$s" | grep -q 'description:' || fm=1
done
[ "$fm" -eq 0 ] && ok "every skill has valid name+description frontmatter" || bad "a skill has invalid frontmatter"

# 4. Zero sandbox paths / token-in-URL / secret material in what the user runs with.
if grep -rIn -e '/home/claude' -e '@github\.com/' CLAUDE.md RULES.md BOOTSTRAP.md hubs memory .claude/skills 2>/dev/null \
     | grep -vi 'never put an access token' | grep -vi 'leaks the token' >/dev/null; then
  bad "sandbox path or token-in-URL present in seeded files"
else
  ok "no /home/claude sandbox path, no token-in-URL"
fi
if grep -rInE 'ghp_[A-Za-z0-9]{30}|cfut_[A-Za-z0-9]{20}|github_pat_[A-Za-z0-9]{20}|grn_[A-Za-z0-9]{20}' . \
     --include='*.md' --include='*.sh' --include='*.ts' 2>/dev/null \
     | grep -vE 'lint-secrets|secret-scan|weekly-backup|SECURITY\.md' >/dev/null; then
  bad "a real secret-shaped string is present"
else
  ok "no secret-shaped strings"
fi

# 5. Internal links in the CI-checked docs resolve (run from the real repo root).
cd "$ROOT"
if python3 - <<'PY'
import re, os, sys
bad = 0
for f in ["README.md","ARCHITECTURE.md","QUICKSTART.md","SETUP.md","SETUP_MCP.md","GIT_AS_RAG.md","START_HERE.md"]:
    if not os.path.exists(f): continue
    for m in re.findall(r'\[.*?\]\(([^)#]+)', open(f, encoding='utf-8').read()):
        if m.startswith('http'): continue
        t = m.split('#')[0].strip()
        if t and not os.path.exists(t):
            print(f"     broken link in {f} -> {t}"); bad += 1
sys.exit(1 if bad else 0)
PY
then ok "internal doc links resolve"; else bad "a broken internal doc link"; fi

# 6. The git-only path must never require a token in a file. The word "token" may
#    appear (as an anti-pattern warning); assert no instruction to commit one.
if grep -rIn 'TOKEN@github' QUICKSTART.md START_HERE.md ONBOARDING.md templates/CLAUDE.md 2>/dev/null \
     | grep -vi 'never' | grep -vi 'leaks' >/dev/null; then
  bad "a setup doc still instructs embedding a token in a URL"
else
  ok "no setup doc instructs a token-in-file"
fi

echo
echo "install-sim: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
