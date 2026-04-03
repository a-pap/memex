# Architecture

## Why Git?

Claude's built-in memory (`userMemories`) is auto-generated, unstructured, and laggy — it can take days to reflect recent conversations and there's no way to edit it precisely. Memory edits help but are limited to behavioral instructions (14 items, ~500 chars each).

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
3. **External tools** (Google Drive, Granola, Calendar — optional enrichment)
4. **userMemories** (auto-generated, may lag weeks — last resort)

## Surface-Specific Behavior

### Claude Chat (claude.ai web/mobile)
- Clone or pull repo via bash tool
- Read STATUS_SNAPSHOT → relevant hub → answer
- After changes: commit + push
- If no bash: fall back to conversation_search + userMemories

### Claude Code (CLI)
- Repo IS the working directory
- At session start: `git pull` → check what changed since last sync
- After changes: commit + push

### Cowork (scheduled tasks)
- Runs on schedule (daily/weekly)
- Pulls, processes, pushes
- Updates LAST_SYNC.md timestamp

## What NOT to Store

- API keys, tokens, passwords (except PAT in memory edits — necessary for private repo access)
- Full meeting transcripts (live in their source tool)
- Code architecture (derivable from codebase)
- Duplicate facts (one canonical home)
- Relative dates ("next week") — always convert to absolute ("2026-04-08")
- Verbose exploration history — save conclusions only
