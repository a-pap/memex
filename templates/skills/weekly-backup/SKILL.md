---
name: weekly-backup
version: "1.0"
description: >
  Self-diagnostic and chat backup. Run when: (1) 7+ days since last sync for
  this surface, (2) user triggers manually with "diagnostic", "backup",
  "self-check", "health check". Verifies system integrity, backs up recent
  chats to archive, and pushes. Can run silently in background.
---

# Weekly Backup & Diagnostic

## Auto-trigger conditions

Run silently (no user trigger needed) when:
1. **Weekly staleness** — 7+ days since last sync for current surface
2. **Version upgrade** — new model/client detected
3. **New surface** — first-ever sync from this surface type

Manual triggers: "diagnostic", "backup", "self-check", "health check"

## Step 1: Pull and diagnostic

```bash
cd /home/claude/claude-memory && git pull --ff-only
```

### Non-regression checklist

1. ✅ All files referenced in CLAUDE.md exist
2. ✅ Memory edit count in git matches live system (`memory_user_edits(command="view")`)
3. ✅ Hub file count matches registry in `hubs/README.md`
4. ✅ No duplicate facts across hubs (spot-check 3 random facts)
5. ✅ STATUS_SNAPSHOT under ~60 lines
6. ✅ Startup token budget under 8K (CLAUDE.md + STATUS_SNAPSHOT)
7. ✅ No secrets in committed files (grep for common patterns)

```bash
# Quick integrity checks
wc -l STATUS_SNAPSHOT.md  # should be < 60
ls hubs/*.md | wc -l       # should match registry
grep -r "ghp_\|sk-\|password" hubs/ config/ --include="*.md" | head -5  # should be empty
```

## Step 2: Backup recent chats

```
recent_chats: n=20, sort_order="desc"
```

For each chat: extract title, date, topic summary. Append to `archive/chat_index.md`.

## Step 3: Check for stale hubs

```bash
# Check git log for each hub
for f in hubs/*.md; do
  echo "$f: $(git log -1 --format='%ai' -- "$f")"
done
```

Flag any hub not updated in >14 days.

## Step 4: Push results

```bash
git add -A
git commit -m "sync: weekly diagnostic + backup [surface]"
git push
```

## Step 5: Report (brief)

If running silently alongside user's task, report at conversation end:
```
Background diagnostic: all OK. [N] chats archived. [Any stale hubs flagged.]
```

If running manually, show full checklist results.
