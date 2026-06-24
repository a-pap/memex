# Sync Protocol

GitHub repo is PRIMARY. Other sources (Drive, Granola, …) are optional enrichments.
The system works fully without any external tool.

## Repo operations

After any significant change:

```bash
git pull --ff-only
# edit the relevant files
git add -A && git commit -m "update: [domain] — [what]" && git push
```

In Claude Code the repo is your working directory and pushes use your local git
auth — no token in any file. Git author by surface: `Claude (Code)`, `Claude (Chat)`.

## Trigger phrases

| Phrase | Action |
|--------|--------|
| "sync" / "update repo" | git pull → update stale files → push |
| "hub refresh" | pull from sources → update hubs → push |
| "status check" | read STATUS_SNAPSHOT + recent context → report |
| "remember [X]" | append to the relevant hub (or `memory/MEMORY_EDITS.md`) → push |

## claude.ai memory (optional)

`memory/MEMORY_EDITS.md` mirrors claude.ai's memory feature — chat only. Keep it in
sync there via Settings → Memory or "remember …". Claude Code ignores it.

## What NOT to commit

Tokens, API keys, passwords. Full transcripts (they live in source tools). Temp
artifacts. Git history is permanent — keep secrets out from the start.
