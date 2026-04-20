#!/usr/bin/env bash
# claude-memory structural test suite (Phase 1 of P3-L)
#
# Run from repo root: bash tests/run-all.sh [--quick|--list]
#
# --quick: skip slow tests (worker tsc). Use in pre-commit hook.
# --list:  print all test names grouped by Fast/Slow and exit 0.
#
# Each test is a function returning 0 on pass, non-zero on fail.
# Final exit code is non-zero if any test failed.
#
# Add a new test:
#   1. Write `test_<name>() { ... return 0 or 1 }`
#   2. Add to TESTS_FAST or TESTS_SLOW arrays at the bottom
#   3. Re-run: bash tests/run-all.sh

set -uo pipefail  # NOT -e — we want to keep running after a failed test

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Counters
PASSED=0
FAILED=0
SKIPPED=0
FAILED_NAMES=()

# Color helpers (no-op if not a TTY)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' CYAN='' NC=''
fi

run() {
  local name="$1"
  local fn="test_${name}"
  printf "  %-40s " "$name"
  local out
  out=$("$fn" 2>&1)
  local rc=$?
  if [ $rc -eq 0 ]; then
    printf "${GREEN}PASS${NC}\n"
    PASSED=$((PASSED + 1))
  elif [ $rc -eq 77 ]; then
    printf "${YELLOW}SKIP${NC} ${out}\n"
    SKIPPED=$((SKIPPED + 1))
  else
    printf "${RED}FAIL${NC}\n"
    if [ -n "$out" ]; then
      printf "    ${RED}%s${NC}\n" "$out" | sed 's/$/\n/' | head -10
    fi
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name")
  fi
}

# ─── Tests ──────────────────────────────────────────────────────────────

# 1. All @imports in CLAUDE.md must resolve to existing files
test_imports_resolve() {
  local missing=()
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    local path="${ref#@}"
    if [ ! -f "$path" ]; then
      missing+=("$ref → $path")
    fi
  done < <(grep -oE "@[a-zA-Z][a-zA-Z0-9_./-]*\.md" CLAUDE.md | sort -u)
  if [ ${#missing[@]} -gt 0 ]; then
    printf "broken imports: %s\n" "${missing[*]}"
    return 1
  fi
  return 0
}

# 2. Hub count: exactly 9 content hubs (02-10), excluding README.md
test_hub_count() {
  local count
  count=$(ls hubs/0[2-9]_*.md hubs/10_*.md 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" != "9" ]; then
    echo "expected 9 content hubs, found $count"
    return 1
  fi
  return 0
}

# 3. Skill count: exactly 9 skill directories, each with SKILL.md
test_skill_count() {
  local dirs
  dirs=$(find skills -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  if [ "$dirs" != "9" ]; then
    echo "expected 9 skill dirs, found $dirs"
    return 1
  fi
  local missing=()
  for d in skills/*/; do
    [ -f "${d}SKILL.md" ] || missing+=("${d}SKILL.md")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "skills missing SKILL.md: ${missing[*]}"
    return 1
  fi
  return 0
}

# 4. STATUS_SNAPSHOT.md ≤ 65 lines (RULES.md says ~60, allow small slack)
test_status_snapshot_size() {
  local lines
  lines=$(wc -l < STATUS_SNAPSHOT.md | tr -d ' ')
  if [ "$lines" -gt 65 ]; then
    echo "STATUS_SNAPSHOT.md has $lines lines (limit 65, RULES.md says ~60)"
    return 1
  fi
  return 0
}

# 5. No raw secret patterns in tracked content (delegates to existing scanner regex)
test_no_secrets() {
  local patterns=(
    '(^|[^A-Za-z0-9_])cfut_[A-Za-z0-9_]{20,}'
    '(^|[^A-Za-z0-9_])ghp_[A-Za-z0-9_]{20,}'
    '(^|[^A-Za-z0-9_])gho_[A-Za-z0-9_]{20,}'
    '(^|[^A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}'
    '(^|[^A-Za-z0-9_])grn_[A-Za-z0-9_]{20,}'
    '(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{30,}'
    '(^|[^A-Za-z0-9_])[0-9a-f]{60,}([^A-Za-z0-9_]|$)'
  )
  # Allowlist same files the pre-commit scanner allows
  local allow='(^|/)(pre-commit-secret-scan\.sh|lint-secrets\.yml|SECURITY\.md|run-all\.sh|test-no-secrets\.sh|test-memex-sanitization\.sh)$|^\.claude/|^node_modules/|^\.git/'
  local hits=""
  for pat in "${patterns[@]}"; do
    local m
    m=$(git ls-files | grep -vE "$allow" | xargs grep -lInE "$pat" 2>/dev/null || true)
    if [ -n "$m" ]; then
      hits="$hits\n$pat → $m"
    fi
  done
  if [ -n "$hits" ]; then
    printf "secret patterns hit:%s\n" "$hits"
    return 1
  fi
  return 0
}

# 6. Worker TypeScript compiles cleanly. SLOW (~5-10s).
test_worker_tsc() {
  if [ ! -f config/mcp-worker/package.json ]; then
    echo "no worker package.json — skipping"
    return 77
  fi
  if [ ! -d config/mcp-worker/node_modules ]; then
    echo "node_modules missing, run: cd config/mcp-worker && npm ci"
    return 1
  fi
  local out
  out=$(cd config/mcp-worker && npx tsc --noEmit 2>&1)
  local rc=$?
  if [ $rc -ne 0 ]; then
    printf "tsc failed:\n%s\n" "$out"
    return 1
  fi
  return 0
}

# 7. dreams/ contains only .md files (no facts, no configs leaked in)
test_dreams_purity() {
  local non_md
  non_md=$(find dreams -mindepth 1 -type f ! -name '*.md' 2>/dev/null || true)
  if [ -n "$non_md" ]; then
    echo "non-markdown files in dreams/: $non_md"
    return 1
  fi
  return 0
}

# 8. hubs/README.md exists (sanity)
test_hub_readme_exists() {
  if [ ! -f hubs/README.md ]; then
    echo "hubs/README.md missing"
    return 1
  fi
  return 0
}

# 9. STATUS_SNAPSHOT references exist — every hubs/*.md path mentioned in
#    STATUS_SNAPSHOT must point to an existing file
test_status_snapshot_refs_resolve() {
  local missing=()
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    [ -f "$ref" ] || missing+=("$ref")
  done < <(grep -oE 'hubs/[a-zA-Z0-9_./-]+\.md' STATUS_SNAPSHOT.md | sort -u)
  if [ ${#missing[@]} -gt 0 ]; then
    echo "STATUS_SNAPSHOT references missing files: ${missing[*]}"
    return 1
  fi
  return 0
}

# 10. No exact duplicate non-empty content lines in STATUS_SNAPSHOT
#     (catches accidental copy-paste duplication)
test_status_snapshot_no_dupes() {
  local dupes
  dupes=$(grep -vE '^[[:space:]]*$|^---$|^#|^- $|^\*\*\*$' STATUS_SNAPSHOT.md \
    | sort | uniq -c | awk '$1 > 1 { print }')
  if [ -n "$dupes" ]; then
    echo "duplicate content lines in STATUS_SNAPSHOT:"
    echo "$dupes"
    return 1
  fi
  return 0
}

# ─── Phase 2 — protocol invariants (P3-L) ───────────────────────────────
# Date-to-epoch helper. Portable across BSD (macOS) and GNU (Linux).
# Prints epoch seconds for "YYYY-MM-DD" on stdout; returns 1 on parse failure.
_date_to_epoch() {
  local d="$1"
  date -j -f "%Y-%m-%d" "$d" +%s 2>/dev/null \
    || date -d "$d" +%s 2>/dev/null \
    || return 1
}

# Dreaming protocol full schema (Mode + tests-status + memory-delta +
# enrichment totals) stabilized 2026-04-18. Summaries from this date
# onwards must carry all four signals. Earlier post-rework summaries
# (2026-04-15..17) are frozen history — partial schema — not held to it.
DREAMING_SCHEMA_CUTOFF_DATE="2026-04-18"

# 11. Dreaming summary schema — every post-rework summary has the required
#     sections (Mode, tests-status, memory-delta, enrichment). The check is
#     loose on purpose: section headings have varied (e.g. "Delta vs last
#     cycle" vs "## Memory delta statement"), but the CONTENT is always
#     there. If any of the four signals is missing, something got dropped.
test_dreaming_summary_schema() {
  local cutoff_epoch
  cutoff_epoch=$(_date_to_epoch "$DREAMING_SCHEMA_CUTOFF_DATE") || {
    echo "cannot parse DREAMING_SCHEMA_CUTOFF_DATE=$DREAMING_SCHEMA_CUTOFF_DATE"
    return 1
  }
  local failures=()
  local checked=0
  for f in logs/dreaming/*_summary*.md; do
    [ -f "$f" ] || continue
    # Extract YYYY-MM-DD from filename.
    local base="${f##*/}"
    local date="${base%%_*}"
    [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
    local ep
    ep=$(_date_to_epoch "$date") || continue
    [ "$ep" -ge "$cutoff_epoch" ] || continue
    checked=$((checked + 1))
    local missing=()
    grep -qE '^\*\*Mode:\*\*' "$f" || missing+=("Mode")
    grep -qiE 'tests?/run-all|[0-9]+/[0-9]+[[:space:]]*(PASS|pass)|[0-9]+[[:space:]]+(passed|PASS)' "$f" \
      || missing+=("tests-status")
    grep -qiE 'memory delta|delta vs|comparison with' "$f" || missing+=("memory-delta")
    grep -qiE 'enrichment|granola|gmail|drive hits?|episodic' "$f" || missing+=("enrichment")
    if [ ${#missing[@]} -gt 0 ]; then
      failures+=("$f missing: ${missing[*]}")
    fi
  done
  if [ ${#failures[@]} -gt 0 ]; then
    echo "dreaming summary schema violations (checked $checked post-$DREAMING_SCHEMA_CUTOFF_DATE files):"
    printf "  %s\n" "${failures[@]}"
    return 1
  fi
  return 0
}

# 12. STATUS_SNAPSHOT.md must be fresh. Parse the "Last updated:" line and
#     fail if it's older than 14 days (RULES.md freshness decay model).
test_status_snapshot_freshness() {
  local line
  line=$(grep -m1 -E '^Last updated:' STATUS_SNAPSHOT.md)
  if [ -z "$line" ]; then
    echo "STATUS_SNAPSHOT.md missing 'Last updated:' line"
    return 1
  fi
  local date
  date=$(printf '%s' "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
  if [ -z "$date" ]; then
    echo "cannot parse date from line: $line"
    return 1
  fi
  local stamp_ep now_ep
  stamp_ep=$(_date_to_epoch "$date") || { echo "bad date $date"; return 1; }
  now_ep=$(date +%s)
  local age_days=$(( (now_ep - stamp_ep) / 86400 ))
  if [ "$age_days" -gt 14 ]; then
    echo "STATUS_SNAPSHOT.md is $age_days days old (Last updated: $date, limit 14)"
    return 1
  fi
  return 0
}

# 13. hubs/README.md registry table lists every content hub (02..10). Catches
#     the case where a hub file is added or renamed but the index is not
#     updated — anyone landing on README.md would think the new hub doesn't
#     exist.
test_hubs_readme_complete() {
  local missing=()
  for f in hubs/0[2-9]_*.md hubs/10_*.md; do
    [ -f "$f" ] || continue
    local base num slug
    base=$(basename "$f" .md)
    num="${base%%_*}"
    slug="${base#*_}"
    # Row shape: "| 02 | personal_profile | ..."
    if ! grep -qE "^\| $num \| $slug " hubs/README.md; then
      missing+=("$num/$slug")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "hubs/README.md missing rows for: ${missing[*]}"
    return 1
  fi
  return 0
}

# 14. Every skill has YAML frontmatter with at least `name:` and
#     `description:` fields. These are what MCP / Skill tool consumers use
#     to decide relevance — a skill without them is invisible to the
#     dispatch layer no matter how good its body is.
test_skills_have_frontmatter() {
  local broken=()
  for s in skills/*/SKILL.md; do
    [ -f "$s" ] || continue
    # Require two `---` fence lines, a `name:` key, and a `description:` key
    # in the frontmatter block (AWK state machine — stops after closing ---).
    if ! awk '
      /^---$/ { c++; if (c==2) exit; next }
      c==1 && /^name:/ { n=1 }
      c==1 && /^description:/ { d=1 }
      END { exit !(c>=2 && n && d) }
    ' "$s" 2>/dev/null; then
      broken+=("$s")
    fi
  done
  if [ ${#broken[@]} -gt 0 ]; then
    echo "skills missing name+description frontmatter:"
    printf "  %s\n" "${broken[@]}"
    return 1
  fi
  return 0
}

# 15. Every TODO section labelled "STATUS: DONE" carries a "COMPLETED:
#     YYYY-MM-DD" date on the same line. Catches the copy-paste regression
#     where a section is flipped to DONE but left undated, which then rots
#     the TODO log — no way to know when it landed.
test_todo_done_has_completed_date() {
  local missing=()
  local ln=0
  while IFS= read -r line; do
    ln=$((ln + 1))
    [[ "$line" == *"STATUS: DONE"* ]] || continue
    # Accept COMPLETED: <date> on the same line. Date must be YYYY-MM-DD.
    if ! printf '%s' "$line" | grep -qE 'COMPLETED:[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
      # Trim leading "### " / "## " / whitespace for the report.
      local title
      title=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*#+[[:space:]]*//' | cut -c1-60)
      missing+=("line $ln: $title")
    fi
  done < TODO.md
  if [ ${#missing[@]} -gt 0 ]; then
    echo "TODO.md: ${#missing[@]} DONE entries missing COMPLETED date:"
    printf "  %s\n" "${missing[@]}"
    return 1
  fi
  return 0
}

# 16. Every content hub carries a dated marker in its first 15 lines. The
#     hub convention (hubs/README.md) is "non-obvious facts carry provenance
#     dates [YYYY-MM]", and the opening block should record when the hub
#     itself was last reviewed. Catches silent drift — a hub edited without
#     any timestamp looks fresh forever.
#     Rule: require a literal 4-digit year (20XX) in the first 15 lines.
#     Keyword-only freshness markers ("обновление: recently") don't count —
#     that's exactly the regression we want to catch.
test_hubs_have_dated_header() {
  local missing=()
  for f in hubs/0[2-9]_*.md hubs/10_*.md; do
    [ -f "$f" ] || continue
    local head
    head=$(head -15 "$f")
    if ! printf '%s' "$head" | grep -qE '20[0-9]{2}'; then
      missing+=("$f")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "hubs missing 20XX year in first 15 lines:"
    printf "  %s\n" "${missing[@]}"
    return 1
  fi
  return 0
}

# 17. Every tracked `references/*.md` file must be referenced by basename
#     from at least one other tracked markdown file (hubs, CLAUDE.md,
#     RULES.md, config/, STATUS_SNAPSHOT, BOOTSTRAP, etc.). Prevents
#     orphaned research artifacts rotting in references/ with no pointer
#     back. Prior triage (commit 532689b) cleaned 7 orphans; this test
#     keeps the invariant from regressing.
test_references_not_orphaned() {
  local orphans=()
  for ref in references/*.md; do
    [ -f "$ref" ] || continue
    local base
    base=$(basename "$ref")
    # Look for the basename in any tracked .md file EXCEPT the file itself
    # and archived chat history (that's append-only historical text, not
    # a live cross-reference).
    local hits
    hits=$(git ls-files '*.md' 2>/dev/null \
      | grep -v -Fx "$ref" \
      | grep -v '^archive/' \
      | xargs grep -lF "$base" 2>/dev/null \
      | wc -l | tr -d ' ')
    if [ "$hits" = "0" ]; then
      orphans+=("$ref")
    fi
  done
  if [ ${#orphans[@]} -gt 0 ]; then
    echo "orphan references (not mentioned by any hub or config .md):"
    printf "  %s\n" "${orphans[@]}"
    return 1
  fi
  return 0
}

# 18. memory/MEMORY_EDITS.md is numbered 1, 2, 3, … — catches the
#     copy-paste regression where an edit is removed or reordered without
#     renumbering, which then breaks every reference like "memory edit #4".
test_memory_edits_sequential() {
  local f=memory/MEMORY_EDITS.md
  [ -f "$f" ] || { echo "$f missing"; return 1; }
  # Extract leading integers on lines matching "^N. " where the content
  # is a real edit (skip Markdown lists nested deeper). Stop when we hit
  # the "## Removed" header — that section is a free-form log, no strict
  # numbering invariant.
  local nums
  nums=$(awk '
    /^## Removed/ { exit }
    /^[0-9]+\. / { sub(/\..*/,""); print }
  ' "$f")
  [ -n "$nums" ] || { echo "no numbered entries found before '## Removed'"; return 1; }
  local expected=1 got gaps=()
  while IFS= read -r got; do
    [ -z "$got" ] && continue
    if [ "$got" != "$expected" ]; then
      gaps+=("expected $expected, saw $got")
    fi
    expected=$(( got + 1 ))
  done <<<"$nums"
  if [ ${#gaps[@]} -gt 0 ]; then
    echo "MEMORY_EDITS.md numbering gaps:"
    printf "  %s\n" "${gaps[@]}"
    return 1
  fi
  return 0
}

# 19. telegram-bot regression guards — delegates to the standalone script so
#     the checks live next to their domain. Post-1042 structural guarantees
#     (hallucination filter, verbatim tool errors, forward+media routing).
test_telegram_bot_fixes() {
  local out
  out=$(bash tests/test-telegram-bot-fixes.sh 2>&1)
  local rc=$?
  if [ $rc -ne 0 ]; then
    printf "%s\n" "$out"
    return 1
  fi
  return 0
}

# 20. wake_up cross-surface bundle — the MCP worker's wake_up tool must
#     surface (a) recent sessions across ALL surfaces, not just a count, and
#     (b) open blockers (TG retry-exhausted rows + unresolved high/critical
#     errors) so Chat/TG/Code see the same operational state. Source-level
#     invariants only — no live worker call needed.
test_wakeup_cross_surface() {
  local src=config/mcp-worker/src/index.ts
  [ -f "$src" ] || { echo "missing $src"; return 1; }
  local fails=()

  # Must select last 3 sessions with surface+summary+created_at — the plain
  # COUNT alone is not enough (that only nudges auto_log, doesn't surface
  # what the other surfaces did).
  grep -qE "SELECT surface, summary, created_at FROM sessions ORDER BY created_at DESC LIMIT 3" "$src" \
    || fails+=("missing last-3-sessions SELECT in wake_up")

  # Must render a dedicated section so Chat can find it predictably.
  grep -qE 'RECENT SESSIONS \(cross-surface\)' "$src" \
    || fails+=("missing '=== RECENT SESSIONS (cross-surface) ===' header")

  # Open-blockers compound SELECT must cover TG retry-exhausted + unresolved
  # errors in a single round-trip. Check for both sub-queries.
  grep -qE "status='failed' AND retry_count>=3" "$src" \
    || fails+=("missing tg_failed blocker subquery")
  grep -qE "resolved=0 AND severity IN \('high','critical'\)" "$src" \
    || fails+=("missing errors_open blocker subquery")

  grep -qE 'OPEN BLOCKERS' "$src" \
    || fails+=("missing '=== OPEN BLOCKERS ===' section header")

  # Blocker rendering must be gated on non-zero counts — printing an empty
  # 'OPEN BLOCKERS: 0' block on every wake_up is noise.
  grep -qE 'tg_failed \?\? 0\) > 0|tg_failed.*>.*0' "$src" \
    || fails+=("blocker section not gated on non-zero count")

  if [ ${#fails[@]} -gt 0 ]; then
    printf '  %s\n' "${fails[@]}"
    return 1
  fi
  return 0
}

# 21. Worker tool count must match what STATUS_SNAPSHOT + CLAUDE.md + the
#     audit doc claim. Phase 4 of P3-L test infra (integration invariants).
#     Catches the silent-drift regression: a new `server.tool(` lands in
#     index.ts but the user-facing docs still advertise the old count, or a
#     tool name appears in source but the audit doc doesn't mention it.
#     Source-level check only — no live worker call, no Cloudflare API.
test_worker_tool_count_matches_docs() {
  local src=config/mcp-worker/src/index.ts
  local audit=references/mcp_tools_audit_2026_04.md
  [ -f "$src" ] || { echo "missing $src"; return 1; }
  local fails=()

  # Canonical count: number of server.tool( registrations in the worker.
  local n_src
  n_src=$(grep -cE '^\s*server\.tool\(' "$src")
  [ "$n_src" -gt 0 ] || { echo "zero server.tool() calls in $src — parse error?"; return 1; }

  # STATUS_SNAPSHOT must name the current tool count — look for "<N> tools"
  # as a word boundary match to avoid matching "41 tools" inside "1410 tools".
  if ! grep -qE "\b${n_src} tools\b" STATUS_SNAPSHOT.md; then
    fails+=("STATUS_SNAPSHOT.md does not mention '${n_src} tools' (worker has ${n_src})")
  fi

  # CLAUDE.md MCP Infrastructure section must name the same count.
  if ! grep -qE "\b${n_src} tools\b" CLAUDE.md; then
    fails+=("CLAUDE.md does not mention '${n_src} tools' (worker has ${n_src})")
  fi

  # Audit doc must exist and cover every tool name (first arg to server.tool).
  if [ ! -f "$audit" ]; then
    fails+=("missing audit doc: $audit")
  else
    # Extract tool names: second line inside each server.tool( block is the
    # quoted name. Use awk to capture the token after server.tool( on the
    # following non-empty line.
    local missing=()
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      if ! grep -qE "\`${name}\`" "$audit"; then
        missing+=("$name")
      fi
    done < <(awk '
      /^\s*server\.tool\(/ { getline next_line; match(next_line, /"[^"]+"/);
        if (RSTART > 0) { print substr(next_line, RSTART+1, RLENGTH-2) }
      }
    ' "$src")
    if [ ${#missing[@]} -gt 0 ]; then
      fails+=("audit doc missing tool names: ${missing[*]}")
    fi
  fi

  if [ ${#fails[@]} -gt 0 ]; then
    printf '  %s\n' "${fails[@]}"
    return 1
  fi
  return 0
}

# 22. D1 schema drift guard — every table referenced in worker SQL must be
#     either (a) created by `ensureTables`, or (b) an explicitly allowlisted
#     cross-worker read (`telegram_messages` lives in the telegram-bot Worker,
#     our worker only SELECTs from it). Catches the v2.4.1-class regression
#     where a tool landed using a table that didn't exist yet and failed at
#     runtime under swallowed try/catch. Source-level check only.
test_d1_schema_drift() {
  local src=config/mcp-worker/src/index.ts
  [ -f "$src" ] || { echo "missing $src"; return 1; }

  # Tables CREATEd by ensureTables.
  local created
  created=$(awk '/^async function ensureTables\(/,/^}$/' "$src" \
    | grep -oE 'CREATE TABLE IF NOT EXISTS [a-z_]+' \
    | awk '{print $NF}' | sort -u)

  # Tables the worker reads/writes from (FROM / INTO / UPDATE / DELETE FROM).
  local referenced
  referenced=$(grep -oE '(FROM|INTO|UPDATE|DELETE FROM|INSERT INTO)[[:space:]]+[a-z_]+' "$src" \
    | awk '{print $NF}' | sort -u)

  # Allowlist: tables owned by other workers but read here.
  local allow="telegram_messages"

  local missing=()
  for t in $referenced; do
    # Allowed if (a) in created list, (b) in allowlist.
    if echo "$created" | grep -qx "$t"; then continue; fi
    if echo "$allow" | tr ' ' '\n' | grep -qx "$t"; then continue; fi
    missing+=("$t")
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo "tables referenced in SQL but NOT in ensureTables (add to ensureTables or allowlist):"
    printf "  %s\n" "${missing[@]}"
    return 1
  fi

  # Sanity: ensureTables must exist and be non-empty.
  local n_created
  n_created=$(echo "$created" | grep -c .)
  if [ "$n_created" -lt 3 ]; then
    echo "ensureTables suspiciously small ($n_created tables) — parser broken?"
    return 1
  fi
  return 0
}

# 23. KG auto-enrichment invariant — `update_file` tool MUST call
#     `autoEnrichKG` on successful writes, and `autoEnrichKG` MUST gate on
#     `path.startsWith("hubs/")`. Catches silent refactors that strip the
#     enrichment hook or widen it to non-hub paths (which would pollute the
#     knowledge graph with triples from arbitrary markdown). Source-level.
test_kg_enrichment_hook() {
  local src=config/mcp-worker/src/index.ts
  [ -f "$src" ] || { echo "missing $src"; return 1; }
  local fails=()

  # autoEnrichKG must be defined.
  grep -qE '^async function autoEnrichKG\(' "$src" \
    || fails+=("autoEnrichKG function missing from worker")

  # autoEnrichKG must be INVOKED (not just defined). Expect it in the
  # update_file handler — there should be at least 2 occurrences total
  # (definition + call site).
  local n_occ
  n_occ=$(grep -cE '\bautoEnrichKG\b' "$src")
  if [ "$n_occ" -lt 2 ]; then
    fails+=("autoEnrichKG defined but never called — enrichment is dead (found $n_occ occurrences)")
  fi

  # autoEnrichKG body MUST gate on hubs/ paths. Scope the grep to the
  # function body only by extracting lines between its header and the
  # closing brace at column 0.
  local body
  body=$(awk '/^async function autoEnrichKG\(/,/^}$/' "$src")
  if ! printf '%s\n' "$body" | grep -qE 'path\.startsWith\("hubs/"\)'; then
    fails+=("autoEnrichKG does not gate on 'hubs/' path — would enrich from any markdown")
  fi

  # Result must be surfaced in the user-visible response. Look for a
  # string that mentions "KG" or "enrich" alongside a triple count.
  local update_body
  update_body=$(awk '/server\.tool\(\s*$/{ next } /"update_file"/,/^  \);/' "$src")
  if ! printf '%s\n' "$update_body" | grep -qE 'kgAdded|KG'; then
    fails+=("update_file response does not mention KG enrichment count — signal not surfaced to caller")
  fi

  if [ ${#fails[@]} -gt 0 ]; then
    printf '  %s\n' "${fails[@]}"
    return 1
  fi
  return 0
}

# 24. memex-sync sanitization rules — delegates to the standalone test
#     battery that checks personal names, repo paths, URLs, and emails are
#     stripped correctly, and that residual secrets / raw personal
#     identifiers cause the sanitizer to REFUSE output (exit 2). Regression
#     guard for P3-O (memex public mirror sync).
test_memex_sanitization() {
  local out
  out=$(bash tests/test-memex-sanitization.sh 2>&1)
  local rc=$?
  if [ $rc -ne 0 ]; then
    printf '%s\n' "$out"
    return 1
  fi
  return 0
}

# 26. memex-sync PR pipeline integrity — manifest parseability, path
#     existence, sanitizer-passes-on-every-SAFE_TEXT-path, class consistency
#     between manifest and sync script. Regression guard for P3-O Phase 3
#     (weekly sync-PR generation). Source-level checks only — no network.
test_memex_sync_pr() {
  local out
  out=$(bash tests/test-memex-sync-pr.sh 2>&1)
  local rc=$?
  if [ $rc -ne 0 ]; then
    printf '%s\n' "$out"
    return 1
  fi
  return 0
}

# 27. Worker boot correctness — ensureTables MUST be awaited in the fetch
#     handler, not scheduled on ctx.waitUntil. The old waitUntil pattern was
#     a data race: a tool invocation on cold-start could hit the handler
#     before CREATE TABLE IF NOT EXISTS finished, causing "no such table"
#     failures under D1. Source-level invariant only.
test_worker_ensuretables_awaited() {
  local src=config/mcp-worker/src/index.ts
  [ -f "$src" ] || { echo "missing $src"; return 1; }
  # The fetch handler must not contain `ctx.waitUntil(ensureTables`.
  if grep -qE 'ctx\.waitUntil\(ensureTables\(' "$src"; then
    echo "fetch handler still schedules ensureTables on ctx.waitUntil — data race on cold start"
    return 1
  fi
  # And MUST contain `await ensureTables(` inside the fetch body.
  local fetch_body
  fetch_body=$(awk '/fetch:[[:space:]]*async[[:space:]]*\(request/,/^  }/' "$src")
  if ! printf '%s\n' "$fetch_body" | grep -qE 'await ensureTables\('; then
    echo "fetch handler does not await ensureTables — cold-start boot incomplete before tool dispatch"
    return 1
  fi
  return 0
}

# 28. Worker update_file async_mode parity — the async path MUST also run
#     `autoEnrichKG` when the write targets a hub. Otherwise bulk-updates
#     silently skip KG enrichment (test_kg_enrichment_hook only covers the
#     sync path — this closes the runtime gap).
test_worker_async_mode_kg_parity() {
  local src=config/mcp-worker/src/index.ts
  [ -f "$src" ] || { echo "missing $src"; return 1; }
  # Extract the `if (async_mode && ctx) { ... }` block from the update_file
  # handler. Between its opening and the next `return { content:` line, we
  # must see both autoEnrichKG and writeFile invocations.
  local block
  block=$(awk '/if \(async_mode && ctx\)/,/^      }/' "$src" | head -60)
  if ! printf '%s\n' "$block" | grep -qE 'autoEnrichKG\('; then
    echo "async_mode path does not call autoEnrichKG — hub writes via async skip KG enrichment"
    return 1
  fi
  if ! printf '%s\n' "$block" | grep -qE 'writeFile\('; then
    echo "async_mode path lost its writeFile call"
    return 1
  fi
  # Must still gate enrichment on hubs/ prefix — otherwise every path pollutes KG.
  if ! printf '%s\n' "$block" | grep -qE 'path\.startsWith\("hubs/"\)'; then
    echo "async_mode enrichment is not gated on hubs/ prefix — pollution risk"
    return 1
  fi
  return 0
}

# 29. STATUS_SNAPSHOT fixed sections — the snapshot is a routing file for
#     every surface. A refactor that quietly drops "Key decisions" or
#     "MCP Infrastructure" would break bootstrap without tripping the size
#     limit test. Lock in the contract: these section headers MUST exist.
test_status_snapshot_sections() {
  local file=STATUS_SNAPSHOT.md
  [ -f "$file" ] || { echo "missing $file"; return 1; }
  local required=(
    "## Critical path"
    "## MCP Infrastructure"
    "## Personal deadlines"
    "## Key decisions"
    "## Upcoming milestones"
  )
  local missing=()
  for section in "${required[@]}"; do
    if ! grep -qxF "$section" "$file" \
       && ! grep -qE "^${section} " "$file"; then
      missing+=("$section")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "STATUS_SNAPSHOT.md missing required sections:"
    printf "  %s\n" "${missing[@]}"
    return 1
  fi
  return 0
}

# 30. Auto-log session hook validity — the SessionEnd hook referenced from
#     CLAUDE.md ("SessionEnd hook: installed in ~/.claude/settings.json")
#     lives at config/hooks/auto-log-session.sh. The script must exist, be
#     executable, and invoke the `auto_log` MCP tool. A missing script here
#     means every Code session silently fails to log to D1, breaking the
#     cross-surface session timeline.
test_autolog_hook_valid() {
  local hook=config/hooks/auto-log-session.sh
  if [ ! -f "$hook" ]; then
    echo "missing $hook (referenced from CLAUDE.md MCP Infrastructure section)"
    return 1
  fi
  if [ ! -x "$hook" ]; then
    echo "$hook not executable — hook harness will skip it"
    return 1
  fi
  if ! grep -qE '\bauto_log\b' "$hook"; then
    echo "$hook does not invoke the auto_log MCP tool — hook is a no-op"
    return 1
  fi
  return 0
}

# 32. Telegram-bot migrations must stay in sync with `ensureTable` runtime
#     ALTERs. Otherwise a fresh deploy converges via CREATE TABLE, but
#     rolling a migration-only change (apply via `wrangler d1 execute`)
#     without updating the code silently fails on re-ingest because the
#     ALTER collision catch runs BEFORE the columns actually exist. And
#     vice-versa: adding a runtime ALTER without a migration file means
#     the explicit `wrangler d1` workflow can't replay the schema. Contract:
#     every ADD COLUMN in any `migrations/*.sql` file must also appear as
#     an `ALTER TABLE telegram_messages ADD COLUMN` (runtime idempotent)
#     inside `src/index.ts`.
test_telegram_bot_migrations_parity() {
  local mig_dir=config/telegram-bot/migrations
  local src=config/telegram-bot/src/index.ts
  [ -d "$mig_dir" ] || { echo "missing $mig_dir"; return 1; }
  [ -f "$src" ]    || { echo "missing $src"; return 1; }

  # Collect column names added across ALL migration files. The grep below
  # matches `ADD COLUMN <name>` tokens (SQL comments that mention the name
  # in prose are filtered by the ADD COLUMN lead-in).
  local cols=()
  while IFS= read -r col; do
    [ -z "$col" ] && continue
    cols+=("$col")
  done < <(grep -hiE 'ADD COLUMN\s+[a-z_][a-z0-9_]*' "$mig_dir"/*.sql 2>/dev/null \
           | sed -E 's/.*ADD COLUMN[[:space:]]+([a-z_][a-z0-9_]*).*/\1/i' \
           | sort -u)

  if [ ${#cols[@]} -eq 0 ]; then
    # No migrations with ADD COLUMNs — nothing to enforce. Vacuous PASS.
    return 0
  fi

  local missing=()
  for col in "${cols[@]}"; do
    # The runtime side must either have a CREATE TABLE column OR an
    # idempotent ALTER TABLE. Either pattern is acceptable — we just need
    # the column name to appear in ensureTable.
    if ! grep -qE "(ALTER TABLE telegram_messages ADD COLUMN ${col}\b|^[[:space:]]+${col}[[:space:]]+(INTEGER|TEXT|REAL|BLOB))" "$src"; then
      missing+=("$col")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo "migrations/*.sql contain ADD COLUMNs NOT covered by src/index.ts ensureTable:"
    printf "  %s\n" "${missing[@]}"
    return 1
  fi
  return 0
}

# 31. Worker cron: dreaming staleness detector.
#     The daily Cloudflare cron is the only out-of-band observer that
#     can notice a dreaming gap without a human opening the repo — before
#     this check landed, the cron logged "0 warnings" every day even when
#     the protocol had been dead for a week (real 2026-04-14 incident).
#     Guard: `scheduled(...)` must list logs/dreaming/, compare to today,
#     push a warning AND log a high-severity error row when the age is
#     above the threshold. Greps are loose enough to survive refactors but
#     specific enough to catch a drop of the feature.
test_worker_dreaming_staleness() {
  local src=config/mcp-worker/src/index.ts
  [ -f "$src" ] || { echo "missing $src"; return 1; }

  # Must pull the listing from logs/dreaming/ inside the scheduled handler.
  # awk extracts the scheduled function body and grep looks for the listDir.
  local in_scheduled
  in_scheduled=$(awk '
    /async scheduled\(/ { flag=1 }
    flag { print }
    flag && /^  },?$/ { flag=0 }
  ' "$src")
  if [ -z "$in_scheduled" ]; then
    echo "could not locate scheduled() handler in $src"
    return 1
  fi
  if ! printf '%s' "$in_scheduled" | grep -qE 'listDir\(env,\s*"logs/dreaming"\)'; then
    echo "scheduled() does not list logs/dreaming/ — staleness detector missing"
    return 1
  fi
  # Must filter to the summary-file naming convention used by the protocol.
  if ! printf '%s' "$in_scheduled" | grep -qE '\^\\d\{4\}-\\d\{2\}-\\d\{2\}_summary'; then
    echo "scheduled() does not filter logs/dreaming/*_summary*.md files"
    return 1
  fi
  # Must push a high- or critical-severity row to `errors` when age exceeds
  # the threshold. The threshold is a decision (2/3/7 days), but the write
  # path itself is the invariant.
  if ! printf '%s' "$in_scheduled" | grep -qE 'INSERT INTO errors.*dreaming_stale|dreaming_stale.*INSERT INTO errors'; then
    # Loose fallback: the error_type string must appear inside the scheduled
    # handler, and the INSERT INTO errors pattern must too.
    if ! printf '%s' "$in_scheduled" | grep -qE 'dreaming_stale' \
       || ! printf '%s' "$in_scheduled" | grep -qE 'INSERT INTO errors'; then
      echo "scheduled() does not log dreaming_stale errors to D1"
      return 1
    fi
  fi
  # Must emit a warning line to `checks[]` (the array that drives the cron
  # summary). Tolerates either the age-specific or the no-summaries branch.
  if ! printf '%s' "$in_scheduled" | grep -qE 'checks\.push\(.*[Dd]reaming'; then
    echo "scheduled() does not append dreaming status to checks[] — cron summary will miss it"
    return 1
  fi
  return 0
}

# 25. BACKLOG.md must not carry open items older than 30 days. Parses every
#     `- [ ]` line in Active sections, extracts the first (YYYY-MM-DD) date
#     stamp, fails if any is >30 days old. Per RULES.md: "review items >30
#     days old. Do, delegate, or delete."
test_backlog_no_stale_items() {
  local now_ep
  now_ep=$(date +%s)
  local stale=()
  local in_active=0
  while IFS= read -r line; do
    # Track which top-level section we're in. Only enforce on "Active" ones.
    if [[ "$line" =~ ^##[[:space:]]+Active ]]; then
      in_active=1
      continue
    elif [[ "$line" =~ ^##[[:space:]] ]]; then
      in_active=0
      continue
    fi
    [ $in_active -eq 1 ] || continue
    # Open items only (skip `[x]` done and `[~]` partial markers).
    [[ "$line" =~ ^[[:space:]]*-[[:space:]]+\[[[:space:]]\] ]] || continue
    local date
    date=$(printf '%s' "$line" | grep -oE '\([0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1 | tr -d '(')
    [ -n "$date" ] || continue
    local ep
    ep=$(_date_to_epoch "$date") || continue
    local age_days=$(( (now_ep - ep) / 86400 ))
    if [ "$age_days" -gt 30 ]; then
      # Trim the item text for the report (first 70 chars after the checkbox).
      local item
      item=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*-[[:space:]]+\[[[:space:]]\][[:space:]]*//' | cut -c1-70)
      stale+=("${age_days}d: $item")
    fi
  done < BACKLOG.md
  if [ ${#stale[@]} -gt 0 ]; then
    echo "BACKLOG has ${#stale[@]} item(s) older than 30 days (do, delegate, or delete):"
    printf "  %s\n" "${stale[@]}"
    return 1
  fi
  return 0
}

# ─── Runner ─────────────────────────────────────────────────────────────

QUICK=0
LIST=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --list)  LIST=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
  esac
done

# Fast tests run always (pre-commit, CI, manual)
TESTS_FAST=(
  imports_resolve
  hub_count
  skill_count
  status_snapshot_size
  no_secrets
  dreams_purity
  hub_readme_exists
  status_snapshot_refs_resolve
  status_snapshot_no_dupes
  dreaming_summary_schema
  status_snapshot_freshness
  backlog_no_stale_items
  hubs_readme_complete
  skills_have_frontmatter
  todo_done_has_completed_date
  hubs_have_dated_header
  references_not_orphaned
  memory_edits_sequential
  telegram_bot_fixes
  wakeup_cross_surface
  worker_tool_count_matches_docs
  d1_schema_drift
  kg_enrichment_hook
  memex_sanitization
  memex_sync_pr
  worker_ensuretables_awaited
  worker_async_mode_kg_parity
  status_snapshot_sections
  autolog_hook_valid
  worker_dreaming_staleness
  telegram_bot_migrations_parity
)

# Slow tests skipped in --quick mode (pre-commit gets the fast set only)
TESTS_SLOW=(
  worker_tsc
)

if [ $LIST -eq 1 ]; then
  printf "${CYAN}Fast tests (%d):${NC}\n" "${#TESTS_FAST[@]}"
  for t in "${TESTS_FAST[@]}"; do printf "  %s\n" "$t"; done
  printf "\n${CYAN}Slow tests (%d):${NC}\n" "${#TESTS_SLOW[@]}"
  for t in "${TESTS_SLOW[@]}"; do printf "  %s\n" "$t"; done
  exit 0
fi

printf "${CYAN}claude-memory structure test suite${NC}\n"
printf "  repo: %s\n" "$REPO_ROOT"
printf "  mode: %s\n\n" "$([ $QUICK -eq 1 ] && echo 'quick (fast tests only)' || echo 'full')"

printf "${CYAN}Fast tests:${NC}\n"
for t in "${TESTS_FAST[@]}"; do run "$t"; done

if [ $QUICK -eq 0 ]; then
  printf "\n${CYAN}Slow tests:${NC}\n"
  for t in "${TESTS_SLOW[@]}"; do run "$t"; done
fi

printf "\n${CYAN}Summary:${NC} ${GREEN}%d passed${NC}, ${RED}%d failed${NC}, ${YELLOW}%d skipped${NC}\n" \
  "$PASSED" "$FAILED" "$SKIPPED"

if [ $FAILED -gt 0 ]; then
  printf "${RED}Failed:${NC} %s\n" "${FAILED_NAMES[*]}"
  exit 1
fi
exit 0
