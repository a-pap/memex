---
name: status-check
description: >
  Quick status across all domains. Use on "status check", "what's going on",
  "brief me", "catch me up", "morning briefing", or any request for a current
  overview. Git-only — reads the repo; calendar/reminder data is optional.
---

# Status Check

A concise cross-domain status report from the repo, plus any connected tools.

## Principle: fresh data, zero fluff

Surface what changed, what's due soon, and what needs attention. Don't restate what
the user already knows.

## Step 1: Gather data

### 1.1 The repo (always available)
```bash
git pull --ff-only 2>/dev/null
cat STATUS_SNAPSHOT.md
```
If STATUS_SNAPSHOT looks stale (`git log -1 --format=%cr -- STATUS_SNAPSHOT.md`),
read the relevant hub files for detail.

### 1.2 Optional enrichment (claude.ai / connected tools only)
If — and only if — calendar/reminder tools are connected, pull upcoming events and
due items for the next 3 days. In Claude Code these tools are absent; rely on the
"Upcoming deadlines" section of STATUS_SNAPSHOT instead.

## Step 2: Build the report

```markdown
# Status — [Date]

## Needs attention
[Overdue, blocked, or needs a decision today]

## Coming up
[Deadlines from STATUS_SNAPSHOT + any connected calendar, chronological]

## [Domain]
[Status, blocker, next action]
```

Skip domains with nothing active. Skip platitudes. Note any stale data.

## Step 3: Flag staleness

```bash
git log -1 --format='%cr' -- hubs/01_example_hub.md
```
If a hub is more than ~7 days old, say so: "⚠️ [domain] hub last updated [N] days ago."
