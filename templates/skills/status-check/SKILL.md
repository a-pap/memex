---
name: status-check
version: "1.0"
description: >
  Quick status across all domains. Use when user says "status check",
  "what's going on", "brief me", "catch me up", "morning briefing",
  or any variation of requesting a current overview.
---

# Status Check

Produces a concise cross-domain status report from all available data sources.

## Principle: fresh data, zero fluff

Don't summarize what the user already knows. Surface what changed, what's due soon, and what needs attention.

## Step 1: Gather data

Pull everything available. Skip silently if unavailable.

### 1.1 GitHub repo
```bash
cd /home/claude/claude-memory && git pull
cat STATUS_SNAPSHOT.md
```
If STATUS_SNAPSHOT is stale (>3 days), load relevant hub files.
If no bash: use recent_chats + conversation_search + userMemories.

### 1.2 Recent chats
```
recent_chats: n=5, sort_order="desc"
```

### 1.3 Calendar (next 3 days)
```
event_search_v0: startTime=[now], endTime=[now + 3 days]
```

### 1.4 Reminders (overdue + due soon)
```
reminder_search_v0: status="incomplete"
```

### 1.5 Other tools (Granola, Gmail — if available)

## Step 2: Build report

```markdown
# Status — [Date]

## 🔴 Needs attention
[Overdue, blocked, or needs a decision TODAY]

## 📅 Coming up (3 days)
[Calendar + due reminders, chronological]

## [Domain 1]
[Status, blockers, next action]

## [Domain 2]
[Status, blockers, next action]
```

### What NOT to include
- Domains with nothing active or changed — skip the section
- Platitudes ("everything's on track") — skip
- Past decisions unless they create current actions
- Stale info presented as current — note freshness

## Step 3: Flag staleness

```
⚠️ [Domain] hub hasn't been updated in [N] days. Data may be inaccurate.
```

If repo is >7 days behind:
```
💡 Hubs are [N] days stale. Run "sync hubs"?
```
