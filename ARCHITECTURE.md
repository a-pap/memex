# Architecture

## Why Git?

Claude's built-in memory is auto-generated, unstructured, and laggy — it synthesizes a summary of you across conversations and refreshes on its own schedule, with no way to edit individual facts precisely. It is useful for behavioral continuity, not for the structured, authoritative factual record you actually need.

A Git repo solves this:
- **Structured**: organized files vs. a blob of text
- **Versioned**: every change tracked, rollback possible
- **Cross-surface**: same repo for chat, mobile, Code, Cowork
- **User-controlled**: you decide what's stored and how
- **Disaster-proof**: full restore from repo alone
- **Auditable**: git log shows exactly what changed and when

## Design Principles

### 1. One Canonical Home Per Fact

Every fact lives in exactly one file. Other files reference it, never duplicate it. This prevents contradictions when updating — you change one place, not five.

Example: your job title lives in `hubs/personal_profile.md`. Your work hub references it but doesn't restate it.

### 2. Graduated Context Loading

Loading the entire repo into Claude's context window wastes tokens and degrades quality (a phenomenon called "context rot" — the more irrelevant text in the window, the worse Claude's responses become).

The system loads context in levels:
- **Level 0**: `STATUS_SNAPSHOT.md` (~50 lines, ~3K tokens) — covers 80% of questions
- **Level 1**: Single hub file (500–3500 tokens) — covers 90% of remaining questions
- **Level 2**: Hub + skill file (1500–5000 tokens) — for specific procedures
- **Level 3**: Multi-hub (rare) — only for explicit cross-domain analysis

Total startup cost: ~5K tokens. Everything else is on-demand.

### 3. Behavioral vs. Factual Separation

Two types of persistent information serve different purposes:

**Behavioral** (memory edits, userPreferences): How Claude should talk, what to flag, what mode to use. These govern Claude's *behavior*.

**Factual** (hub files, STATUS_SNAPSHOT): What is actually true — statuses, dates, decisions, health records. These govern *reality*.

Never apply a behavioral instruction as a factual correction. Example: a memory edit might say "use simplified title 'PM' in casual conversation" while the hub correctly records "Product Leader." The memory edit governs how Claude speaks; the hub governs what's true.

### 4. Freshness Decay Model

Not all facts age equally:

| Type | Reliable for | After that |
|------|-------------|------------|
| Settled decisions | Forever | Never re-open unless asked |
| Project status | ~7 days | Flag as potentially stale |
| Deadlines/dates | Until passed | Archive completed items |
| Intra-day progress | Hours | Distill into hubs weekly |

### 5. Pre-flight Check

Before Claude asserts anything about an ongoing topic, it must verify:
1. Pull the repo (if bash available)
2. Read the relevant hub
3. Cross-check with `conversation_search` (if available)
4. If uncertain → say "let me check"

This prevents the most dangerous failure mode: Claude confidently stating something plausible but wrong, and the user acting on it without verifying.

### 6. Token Budget

Keep startup cost (CLAUDE.md + STATUS_SNAPSHOT) under 8K tokens. Everything else loads on-demand. If STATUS_SNAPSHOT grows past ~60 lines, prune completed deadlines first.

## Memory Hierarchy (Trust Order)

1. **Current conversation** (freshest)
2. **Git repo hub files** (committed, verified) — PRIMARY for facts
3. **External tools** (cloud drive, meeting transcription, calendar — optional enrichment)
4. **userMemories** (auto-generated, may lag weeks — last resort)

## Surface-Specific Behavior

### Claude Chat & Projects (claude.ai)
- Connect the repo via the native GitHub connector (OAuth, no token).
- Chat: attach STATUS_SNAPSHOT + the relevant hub (＋ → Add from GitHub). Project: sync the repo as context.
- Read-only — the connector pulls files; writes go through Claude Code or the optional MCP worker.

### Claude Code (CLI)
- Repo IS the working directory
- At session start: `git pull` → check what changed since last sync
- After changes: commit + push

### Cowork (scheduled tasks)
- Runs on schedule (daily/weekly)
- Pulls, processes, pushes
- Updates LAST_SYNC.md timestamp

## Token Economics

Real measurements from a production Memex installation (9 domain hubs, 6+ months of data):

### Startup cost

| What loads | Size | ~Tokens | When |
|------------|------|---------|------|
| STATUS_SNAPSHOT.md | ~3.8 KB | ~950 | Every conversation (Level 0) |
| CLAUDE.md (routing) | ~6.4 KB | ~1,600 | Every conversation (Level 0) |
| **Startup total** | **~10 KB** | **~2,500** | **Always** |

### On-demand loading

| What loads | Size range | ~Tokens | When |
|------------|-----------|---------|------|
| Single hub (small) | 3-8 KB | 750-2,000 | Topic-specific question (Level 1) |
| Single hub (large) | 15-33 KB | 3,750-8,300 | Deep-dive on a domain (Level 1) |
| Hub + skill file | 20-40 KB | 5,000-10,000 | Executing a procedure (Level 2) |
| RULES.md | ~10 KB | ~2,500 | Behavioral calibration |
| All hubs combined | ~158 KB | ~39,600 | Never (Level 3, rare) |

### Typical session

| Scenario | Total tokens | % of full context |
|----------|-------------|-------------------|
| Status check (Level 0 only) | ~2,500 | 5% |
| Single-topic question (Level 0+1) | ~5,000-7,000 | 10-15% |
| Deep work session (Level 0+1+2) | ~8,000-12,000 | 20-25% |
| Full context dump (all files) | ~45,000 | 100% |

### Why this matters

Most memory systems load everything into context on every conversation — 40K-50K+ tokens of history, embeddings, and metadata. This causes:
- **Token waste** — paying for irrelevant context on every API call
- **Context rot** — model accuracy degrades as input grows, by position ([Liu et al., *Lost in the Middle*, 2023](https://aclanthology.org/2024.tacl-1.9/)) and independently by length ([Chroma, *Context Rot*, 2025](https://www.trychroma.com/research/context-rot))
- **Slower responses** — more input tokens = higher latency

Memex's graduated loading means a typical session uses **5-7K tokens** of memory context — ~10% of what a dump-everything approach would use.

## Architecture patterns (battle-tested)

These are general-purpose patterns the system leans on. None are memory-specific — they apply to any agent that writes files, runs loops, or pulls from external sources. Each is stated as a rule plus a generic example.

### 1. Generator → verifier (maker ≠ checker)

A component that produces output never grades its own output. A separate gate — a test, a second agent, or a human — validates before the result is trusted or committed. The generator optimizes for "looks done"; an independent checker optimizes for "is correct," and the two objectives must not live in the same head. This is the single most reliable guard against confident-but-wrong output.

*Example:* an automated cleanup job proposed deleting several files it judged unused. An independent pre-commit test scanned for references, found the files were still imported elsewhere, and blocked the commit. The maker proposed; a different checker disposed.

### 2. Loop inventory + per-loop kill-switch

Every autonomous loop is registered in one place, and each loop reads an explicit runtime kill-switch as step 0 of every iteration — before doing any work. No loop is "fire and forget": if you can't name it in the inventory and can't stop it without redeploying, it shouldn't be running. The kill-switch is checked at runtime (a flag, a file, an env var), not baked in at deploy time.

*Example:* a scheduled job that processes a queue checks a `paused` flag at the top of each cycle; flipping the flag halts the loop after the current item with no code change and no redeploy. A central registry lists every such loop and where its switch lives.

### 3. Environment-aware source priority

A process picks its data source based on what its environment can actually reach. A job with no privileged network access uses only the always-available source; a privileged session layers in the richer, gated source on top. Never make a no-network job chase a source it can't reach — it will hang, retry, or fail silently. Detect the capability, then choose the source.

*Example:* an unprivileged scheduled task reads from the local committed copy only. The same logic, run in an authenticated interactive session, additionally pulls from a gated internal API for fresher data. The source list is a function of the environment, not a hardcoded constant.

### 4. Single canonical home + anti-bloat (context engineering)

Each fact has exactly one home; everywhere else points to it rather than restating it. Content loads on demand, not all at once, and is distilled the moment it crosses a size budget. The goal is to fill the working context with just the right information for the next step — not everything that has ever been true. Bloat is the enemy: duplicated facts drift apart, and an over-stuffed context degrades output quality.

*Example:* a configuration value is defined in one file; three other files reference it by name. When a document exceeds its line budget, the oldest resolved items are pruned into an archive and replaced with a pointer, keeping the hot path small.

### 5. Never trust one constant for a mixed-origin feed

When a feed contains items of differing provenance, a single transform applied uniformly is wrong for some of them. Read the typed source-of-truth per item instead of assuming one rule fits all. The failure is silent: the constant is right on average and wrong on the items that differ, so nothing throws — the data is just quietly incorrect.

*Example:* a feed merges events from several origins, each carrying its own offset. Applying one fixed offset to the whole feed corrupts every event whose origin differs from the assumed default. The fix is to read each event's declared offset from its own metadata and transform per item.

### 6. Skill / prompt quality gate

Reusable components — skills, prompts, sub-agent definitions — are scored against a rubric, and a guard enforces a minimum floor before one ships. Each component carries four explicit fields: its role, its trigger, its verifier, and its output contract. A component that can't state when it fires and how its output is checked isn't ready, regardless of how good its body looks.

*Example:* a new skill is scored on a published rubric; anything below the threshold is rejected by an automated guard at commit time. Every accepted skill names what invokes it, what it produces, and how a reader confirms the output is correct.

## What NOT to Store

- API keys, tokens, passwords (except PAT in memory edits — necessary for private repo access)
- Full meeting transcripts (live in their source tool)
- Code architecture (derivable from codebase)
- Duplicate facts (one canonical home)
- Relative dates ("next week") — always convert to absolute ("2026-04-08")
- Verbose exploration history — save conclusions only
