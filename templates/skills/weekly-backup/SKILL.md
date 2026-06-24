---
name: weekly-backup
description: >
  Self-diagnostic for the memory repo. Use on "diagnostic", "backup", "self-check",
  "health check", or after a long gap. Verifies integrity and pushes. Git-only.
---

# Weekly Diagnostic

## When to run

On request ("diagnostic", "backup", "self-check", "health check"), or when the repo
hasn't been touched in a while.

## Step 1: Pull and check

```bash
git pull --ff-only
```

### Integrity checklist (git-only)

1. Every file in CLAUDE.md's routing table exists (or is a clearly-marked CUSTOMIZE placeholder).
2. Hub count matches `hubs/README.md`.
3. No duplicate facts across hubs (spot-check a few).
4. STATUS_SNAPSHOT under ~50 lines.
5. No secrets in tracked files.

```bash
wc -l STATUS_SNAPSHOT.md                                  # under ~50
ls hubs/*.md | wc -l                                      # matches the registry
grep -rInE 'ghp_|gho_|github_pat_|cfut_|grn_|sk-' . \
  --include='*.md' | grep -v templates/ | head            # should be empty
```

## Step 2: Flag stale hubs

```bash
for f in hubs/*.md; do
  echo "$f: $(git log -1 --format='%cr' -- "$f")"
done
```
Flag any hub older than ~14 days.

## Step 3: Push

```bash
git add -A
git commit -m "sync: weekly diagnostic"
git push
```

## Step 4: Report (brief)

"Diagnostic: all OK. [Any stale hubs flagged.]"

(On claude.ai you can also archive recent chats via `recent_chats`; that tool does
not exist in Claude Code.)
