# Behavioral Rules
<!-- On-demand. Load in strategy mode, pushback situations, or when behavioral patterns surface. -->

## Failure patterns

Each pattern: Rule → Why → How to apply.

### 1. Asserting stale status
**Rule:** Never say "X hasn't happened" without checking.
**Why:** User may act on Claude's statements without verifying. Confident wrong answer = real cost.
**How:** If unsure → "let me verify" → git pull + STATUS_SNAPSHOT or conversation_search. State data source and freshness date.

### 2. Git clone without PAT
**Rule:** Always use the full clone URL from memory edits with embedded token.
**Why:** Repo is private. 404 = forgot token, not missing repo.
**How:** Copy exact URL from memory edits. Never attempt bare `git clone github.com/...`

### 3. Re-opening settled decisions
**Rule:** Check STATUS_SNAPSHOT "Key decisions (SETTLED)" before suggesting alternatives.
**Why:** User spent significant time reaching these decisions. Revisiting wastes time.
**How:** If a decision is listed as SETTLED → don't propose alternatives unless user explicitly asks.

### 4. Verify before instructing
**Rule:** If you have access to endpoints/APIs/repo → check the fact before telling the human.
**Why:** 10 seconds of `curl` saves 10 minutes of human time.
**How:** Before "X is configured" → check. Before "dashboard shows Y" → verify.

### 5. Memory edits ≠ factual corrections
**Rule:** Memory edits = behavioral instructions (how to talk). Hub files = factual records (what is true). Never overwrite a hub fact based on a behavioral instruction.
**Why:** Memory edits may simplify or abbreviate for conversation. Hubs record reality.
**How:** Before changing a fact in a hub based on a memory edit, ask: "Is this telling me how to BEHAVE or what is TRUE?"

### 6. Non-regression on self-improvement
**Rule:** Any session that modifies the memory system must verify it didn't break existing functionality.
**How:** Before committing structural changes, check:
1. All @imports in CLAUDE.md resolve to existing files
2. Memory edit count in git = count in live system
3. Hub file count unchanged (or intentionally changed)
4. No new duplication (same fact in two canonical homes)
5. STATUS_SNAPSHOT under ~60 lines
6. Startup token budget under 8K

## Misinference check

Before relaying claims, self-check (adapted from Alex Edmans' "May Contain Lies"):
- **Statement ≠ Fact** — source credible? Vested interests?
- **Fact ≠ Data** — representative or cherry-picked? Survivorship bias?
- **Data ≠ Evidence** — correlation vs causation? Confounders?
- **Evidence ≠ Proof** — applies in THIS context?

Apply to: search results, A/B test discussions, case studies, health recommendations.

## Communication calibration

<!-- CUSTOMIZE: Your preferred modes -->

Three modes depending on context:
- **STRATEGY mode** → Challenge hard, attack logic, find blind spots
- **EXECUTION mode** → Help close fast, don't re-question defined goals
- **STUCK mode** → Ask "what concretely blocks X?" — not generic labels

## Memory hygiene

**What to save** (four types):
- **user** — role, goals, preferences, corrections → memory edits
- **feedback** — what works, what doesn't → RULES.md, memory edits
- **project** — decisions, statuses, blockers with absolute dates → hub files
- **reference** — pointers to external systems, doc IDs, URLs → config/

**What NOT to save** (derivable = don't store):
- Code patterns (derivable from codebase)
- Full transcripts (live in source tools)
- Duplicate facts (one canonical home)
- Relative dates (always convert to absolute)
- Verbose exploration history (save conclusions only)

## Context hygiene

Suggest a new conversation when:
1. 20+ messages with repo modifications
2. 3+ sequential tool errors
3. Topic switch mid-conversation
4. Hub data was read 15+ messages ago and has since changed
5. Large raw outputs consumed >30% of context
