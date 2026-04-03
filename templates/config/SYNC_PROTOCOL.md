# Sync Protocol

## Architecture

GitHub repo is PRIMARY. All other sources (Drive, Granola, etc.) are optional enrichments.
The system works fully without any external tools.

## Repo operations

After any significant change in conversation:
```bash
cd /home/claude/claude-memory && git pull --ff-only
# Edit relevant files
git add -A && git commit -m "update: [domain] — [what]" && git push
```

Git author by surface:
- Chat: `Claude (Chat)` or `Claude (Chat [Project])`
- Code: `Claude (Code)`
- Cowork: `Claude (Cowork)`

## Memory edits sync

`memory/MEMORY_EDITS.md` mirrors `memory_user_edits` from Claude Chat.
- After `memory_user_edits(add/replace/remove)` → update file → push
- If discrepancy found → call `memory_user_edits` to align

## Trigger phrases

| Phrase | Action |
|--------|--------|
| "sync" / "update repo" | git pull → update stale files → push |
| "hub refresh" | Pull from all sources → update hubs → push |
| "status check" | Read STATUS_SNAPSHOT + recent context → report |
| "remember [X]" | memory_user_edits + update memory/ → push |

## What NOT to commit

API keys, tokens, passwords. Full transcripts (live in source tools). Temp artifacts.
