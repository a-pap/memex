---
name: git-memory
description: >
  Load shared memory from the git repo and write changes back. Use when a
  conversation needs persistent context, on "pull memory" / "what do you remember"
  / "bootstrap", or before asserting the current status of an ongoing topic. In
  Claude Code the repo is the working directory; this skill is git-only and needs
  no access token.
---

# Git Memory — Shared Context

Single source of truth for every Claude surface. Git-only: no token in any file.

## When to use

| Situation | Action |
|-----------|--------|
| Need context for the conversation | Pull → read STATUS_SNAPSHOT → relevant hub |
| User asks about current status | Pull → read hub → check `git log` freshness |
| Significant decision or status change | Update hub → commit → push |
| User says "remember X" | Append to the relevant hub (or `memory/MEMORY_EDITS.md`) → commit → push |

## Step 1: Access the repo

### Claude Code (default)
The repo is your working directory. Just:
```bash
git pull --ff-only 2>/dev/null
```

### Claude.ai chat (optional)
Chat has no persistent local clone. Use the optional MCP worker, or clone per
session with the token kept in claude.ai settings — never in a repo file. Skip this
skill's bash steps there.

## Step 2: Graduated context loading

Load the minimum needed — reading every hub wastes context and degrades quality.

- **Level 0 (~3K tokens):** `cat STATUS_SNAPSHOT.md` — covers most questions.
- **Level 1:** one hub, by topic (the routing table in CLAUDE.md).
- **Level 2:** hub + a skill, when a procedure runs.
- **Level 3 (rare):** 3–4 hubs, only for explicit cross-domain analysis.

Scan before a full load:
```bash
for f in hubs/*.md; do head -2 "$f"; echo "---"; done   # ~500 tokens
head -30 hubs/01_example_hub.md                          # Current Status of one hub
```

## Step 3: Verify freshness

Hubs can lag a few days. Cross-check, and always cite source + age:
```bash
git log -1 --format='%ci' -- hubs/01_example_hub.md      # when this hub last changed
```
- "Per hub (updated [date]): …"
- "Not sure — hub from [date], no newer commits. Can you confirm?"

(On claude.ai you can also use `conversation_search` / `recent_chats`; those tools
do not exist in Claude Code — use `git log` and the files instead.)

## Step 4: Write changes

```bash
git pull --ff-only
# edit the relevant file(s)
git add -A
git commit -m "update: [domain] — [what changed]"
git push
```

Commit message examples:
```
update: work — Q2 planning deadline confirmed
update: health — test results normal
sync: weekly hub refresh
```

## Edge cases
- **Push rejected:** `git pull --rebase` then retry.
- **Large diff (>50 lines):** show a summary before committing.
- **No network:** work from the local files; sync when back online.
