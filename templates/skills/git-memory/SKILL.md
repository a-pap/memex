---
name: git-memory
version: "1.0"
description: >
  Bootstrap shared memory from GitHub repo. INFRASTRUCTURE skill — loads context,
  does not produce user-facing output. Trigger SILENTLY at conversation start when
  persistent context is needed. Also trigger on "pull memory", "what do you remember",
  "bootstrap", or when another skill needs hub data. ALWAYS trigger before asserting
  current status of ongoing topics.
---

# Git Memory — Shared Context Bootstrap

Single source of truth for all Claude surfaces: Chat, Projects, Cowork, Code.

## When to use

| Situation | Action |
|-----------|--------|
| Start of conversation needing context | Pull → read relevant hubs |
| User asks about current status | Pull → read hub → conversation_search |
| Significant decision or status change | Update hub → commit → push |
| User says "remember" / "запомни" | memory_user_edits + update memory/MEMORY_EDITS.md → push |
| Other skill needs context | Read relevant hub file(s) from local clone |

## Step 1: Access the repo

### Claude Chat (clone or pull)
```bash
if [ -d /home/claude/claude-memory/.git ]; then
  cd /home/claude/claude-memory && git pull --ff-only 2>/dev/null
else
  # TOKEN from memory edit — use EXACT clone URL
  git clone https://TOKEN@github.com/USER/claude-memory.git /home/claude/claude-memory
  cd /home/claude/claude-memory
fi
```

### Claude Code
```bash
pwd  # should be inside claude-memory/
git pull --ff-only 2>/dev/null
```

### No bash available
Use `conversation_search` + userMemories as fallback. Note data may be stale.

## Step 2: Graduated context loading

Load the minimum context needed. Total hubs may be 10K-25K tokens — loading all wastes context and degrades quality.

### Level 0: Quick status (~3K tokens)
```bash
cat STATUS_SNAPSHOT.md
```
Covers 80% of questions.

### Level 1: Single hub (500-3500 tokens)
Read ONE hub based on topic. Covers 90% of remaining questions.

### Level 2: Hub + skill (1500-5000 tokens)
When a skill is triggered, read hub + skill SKILL.md.

### Level 3: Multi-hub (rare)
Max 3-4 hubs. Only for explicit cross-domain analysis.

### Optimization: scan before full load
```bash
# Scan all hub headers — ~500 tokens total
for f in hubs/*.md; do head -2 "$f"; echo "---"; done
```
For single-hub questions, `head -30` gets Current Status:
```bash
head -30 hubs/01_work.md
```

## Step 3: Verify freshness

Hub files lag by 1-7 days. Cross-check with:

### conversation_search (keyword-based)
```
conversation_search: "project deadline"
```

### recent_chats (time-based)
```
recent_chats: n=5, sort_order="desc"
```

**Freshness assertion rule:** Always cite source and age:
- "Per hub (updated [date]): ..."
- "Per recent chat ([date]): ..."
- "Not sure — hub from [date], no fresh chats found. Can you confirm?"

## Step 4: Write changes

```bash
cd /home/claude/claude-memory
git pull --ff-only
# Edit relevant file(s)
git add -A
git commit -m "update: [domain] — [what changed]"
git push
```

### Commit message format
```
update: work — Q2 planning deadline confirmed
update: health — test results normal
update: memory — synced edits from Chat
sync: weekly hub refresh
```

## Step 5: Sync memory edits (bidirectional)

### Chat → Repo
After any `memory_user_edits(add/replace/remove)`:
1. `memory_user_edits(command="view")`
2. Update `memory/MEMORY_EDITS.md`
3. Commit and push

### Repo → Chat
If repo has edits not in Chat:
1. Read `memory/MEMORY_EDITS.md`
2. Compare with `memory_user_edits(command="view")`
3. Sync using add/replace/remove

## Edge cases

- **No network:** Fall back to userMemories + conversation_search
- **Push rejected:** `git pull --rebase` then retry
- **Token expired:** Ask user for new PAT
- **Large diff (>50 lines):** Show summary before committing
