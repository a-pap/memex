# CLAUDE.md — Shared Memory

Persistent context for all Claude surfaces. This repo is the **single source of truth**.
Works standalone — no Google Drive, no MCP connectors required. Both are optional enrichments.

## Pre-flight check (MANDATORY)

Before ANY assertion about ongoing topics:
1. Read `STATUS_SNAPSHOT.md` (if not already in context)
2. Read relevant hub file from `hubs/`
3. If `conversation_search` available → cross-check (hubs lag 1-7 days)
4. When uncertain → "let me check", never guess

## Route by topic

<!-- CUSTOMIZE: Replace with your domains and hub files -->

| Topic | Hub | Skill |
|-------|-----|-------|
| Work, projects | hubs/01_work.md | — |
| Health | hubs/02_health.md | — |
| Side project | hubs/03_side_project.md | — |
| Major life event | hubs/04_life_event.md | — |
| Learning | hubs/05_learning.md | — |
| Personal profile | hubs/06_personal.md | — |
| Cross-domain status | STATUS_SNAPSHOT.md | status-check |

## Repo structure

```
STATUS_SNAPSHOT.md       # Cross-domain status (~50 lines, read first)  [~3K tokens]
CLAUDE.md                # This file — routing and rules                [~1.5K tokens]
BOOTSTRAP.md             # Full memory restoration after wipe           [on-demand]
RULES.md                 # Behavioral rules, failure patterns           [on-demand]
hubs/                    # Domain hub files                             [on-demand]
skills/                  # Repeatable procedures                        [on-demand]
config/                  # Projects, connectors, sync protocol          [on-demand]
references/              # Deep research artifacts                      [on-demand]
memory/                  # Memory edits + preferences snapshots         [on-demand]
archive/                 # Chat history backups                         [on-demand]
```

**Startup token budget: ~5K tokens** (CLAUDE.md + STATUS_SNAPSHOT). Everything else loads on-demand. If total exceeds 8K, prune STATUS_SNAPSHOT first.

## Key rules

1. **Read before acting.** STATUS_SNAPSHOT → hub → answer.
2. **One canonical home.** Facts live in ONE hub. Others reference, not duplicate.
3. **Absolute dates only.** "Thursday" → "2026-04-03". Relative dates rot within days.
4. **Don't store derivable.** If computable from existing data, don't write it down.
5. **Commit after changes.** `git add -A && git commit -m "update: [domain] — [what]" && git push`
6. **Never commit secrets.** No tokens, passwords, API keys in hub content.

## Freshness decay model

| Type | Reliable for | After that |
|------|-------------|------------|
| Settled decisions | Forever | Never re-open unless asked |
| Project status | ~7 days | Flag as potentially stale |
| Deadlines/dates | Until passed | Archive completed items |
| Intra-day progress | Hours | Distill weekly, then clear |

## Memory hierarchy (trust order)

1. Current conversation (freshest)
2. This repo hub files (committed, verified) — PRIMARY for **facts**
3. External tools (Google Drive, Granola, Calendar — optional enrichment)
4. `userMemories` snapshot (auto-generated, may lag weeks)

**Memory edits** and **userPreferences** govern Claude's **behavior**. Hub files govern **reality**. Never overwrite a hub fact based on a behavioral instruction.

## Surface-specific behavior

### Claude Chat (web/mobile)
```bash
# Clone or pull
if [ -d /home/claude/claude-memory/.git ]; then
  cd /home/claude/claude-memory && git pull --ff-only
else
  git clone https://TOKEN@github.com/USER/claude-memory.git /home/claude/claude-memory
  cd /home/claude/claude-memory
fi
```
Git author: `Claude (Chat)`

### Claude Code (CLI)
- Repo IS your project root — all files are local
- At session start: `git pull` → check what changed
- Git author: `Claude (Code)`

### Cowork (scheduled tasks)
- Git author: `Claude (Cowork)`

## Optional enrichments

These tools improve freshness but are NOT required:
- **Google Drive** → meeting transcripts, latest doc edits
- **Granola** → meeting data
- **Calendar / Reminders** → schedule context

If any tool is unavailable: proceed with repo data alone. Never error on missing tools.

## On-demand references

Load ONLY when the topic comes up:
- @RULES.md — failure patterns, behavioral nudges
- @references/ — deep research artifacts
- @config/SYNC_PROTOCOL.md — sync mechanics
