# CLAUDE.md — Shared Memory

Persistent context for Claude. This repo is the **single source of truth**. It works
with nothing but git — no access token in any file, no MCP connector, no external
service. Those are optional enrichments, never requirements.

## Pre-flight check (MANDATORY)

Before ANY assertion about ongoing topics:
1. Read `STATUS_SNAPSHOT.md` (if not already in context).
2. Read the relevant hub from `hubs/` (routing table below).
3. Check freshness: `git log -1 --format=%cd -- <hub>` — hubs can lag a few days.
4. Uncertain → "let me check", never guess.

## Route by topic

<!-- CUSTOMIZE: replace these rows with your own domains. Each hub is a file you
     create in hubs/ by copying hubs/01_example_hub.md. Delete unused rows.
     Only hubs/01_example_hub.md ships by default — the rest are yours to create. -->

| Topic | Hub |
|-------|-----|
| Work, projects | hubs/01_work.md |
| Health | hubs/02_health.md |
| Side project | hubs/03_side_project.md |
| Learning | hubs/04_learning.md |
| Personal profile | hubs/05_personal.md |
| Cross-domain status | STATUS_SNAPSHOT.md |

## Repo structure

```
STATUS_SNAPSHOT.md   # Cross-domain status (~50 lines) — read first
CLAUDE.md            # This file — routing and rules
BOOTSTRAP.md         # Full restoration after a wipe
RULES.md             # Behavioral rules, failure patterns
hubs/                # Domain hub files (on-demand)
.claude/skills/      # Optional procedures Claude Code auto-discovers
memory/              # Optional: behavioral notes for claude.ai (Code ignores)
config/, references/ # Optional: projects, connectors, deep research
archive/             # Optional: history backups
```

**Startup cost** is just this file + STATUS_SNAPSHOT (a few thousand tokens).
Everything else loads on demand. If STATUS_SNAPSHOT grows past ~50 lines, prune it.

## Key rules

1. **Read before acting.** STATUS_SNAPSHOT → hub → answer.
2. **One canonical home.** Each fact lives in ONE hub; others reference it.
3. **Absolute dates only.** "Thursday" → "2026-04-03". Relative dates rot.
4. **Don't store the derivable.** If it's computable from existing data, don't write it.
5. **Commit after changes.** `git add -A && git commit -m "update: [domain] — [what]" && git push` — uses your local git auth.
6. **Never commit secrets.** No tokens, passwords, or API keys in any file — including this one. Git history is permanent.

## Freshness decay model

| Type | Reliable for | After that |
|------|-------------|------------|
| Settled decisions | Forever | Never re-open unless asked |
| Project status | ~7 days | Flag as potentially stale |
| Deadlines/dates | Until passed | Archive completed items |
| Intra-day progress | Hours | Distill weekly, then clear |

## Memory hierarchy (trust order)

1. Current conversation (freshest).
2. Repo hub files (committed, verified) — PRIMARY for facts.
3. External tools (Drive, Granola, Calendar — optional enrichment, if connected).

## Surface-specific behavior

### Claude Code (CLI) — the default, git-only

- The repo IS your project root; all files are local.
- Session start: `git pull` to see what changed.
- Write changes: edit the file, then `git add -A && git commit && git push`.
- No access token anywhere — your local git auth handles pushes.
- Git author: `Claude (Code)`.

### Claude.ai chat / mobile — optional

Chat has no persistent local clone and a different tool set (`conversation_search`,
`memory_user_edits`, `recent_chats` — none of which exist in Claude Code). To use
the repo from chat, deploy the optional MCP worker (see `SETUP_MCP.md`) or clone
per session. If you clone in chat, the access token lives in claude.ai's settings —
**never in a repo file**.

## Optional enrichments

Use if connected; skip if not. Never error on a missing tool.
- **Google Drive / Granola** — meeting notes, document edits.
- **Calendar / Reminders** — schedule context.

## On-demand reading

Load only when the topic comes up (no auto-import — keep startup small):
- `RULES.md` — failure patterns, behavioral nudges.
- `references/` — deep research artifacts (read specific files).
- `config/SYNC_PROTOCOL.md` — sync mechanics, if present.
