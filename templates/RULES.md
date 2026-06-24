# Behavioral Rules
<!-- On-demand. Load in strategy mode, pushback situations, or when behavioral patterns surface. -->

## Failure patterns

Each pattern: Rule → Why → How to apply.

### 1. Asserting stale status
**Rule:** Never say "X hasn't happened" without checking.
**Why:** User may act on Claude's statements without verifying. Confident wrong answer = real cost.
**How:** If unsure → "let me verify" → git pull + read STATUS_SNAPSHOT (on claude.ai you can also use conversation_search). State data source and freshness date.

### 2. Repo access (git-only)
**Rule:** In Claude Code the repo is your working directory — use your local git auth; put no token in any file.
**Why:** A token committed to the repo leaks (git history is permanent), and Code never needs one.
**How:** `git pull` / `git push` directly. Only claude.ai chat (which clones per session) needs a token, and it lives in claude.ai settings — never in the repo.

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
1. Every file in CLAUDE.md's routing table exists (or is a marked CUSTOMIZE placeholder)
2. Hub file count matches hubs/README.md (or changed intentionally)
3. No new duplication (same fact in two canonical homes)
4. STATUS_SNAPSHOT under ~50 lines
5. Startup stays small (CLAUDE.md + STATUS_SNAPSHOT only)
6. (claude.ai only) memory/MEMORY_EDITS.md matches the live memory

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
