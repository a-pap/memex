# Skill Catalog

Example skills you can create for your system. Each is a repeatable procedure Claude executes when triggered.

## Built-in (included in blueprint)

| Skill | Purpose | Trigger |
|-------|---------|---------|
| git-memory | Bootstrap context from repo | Automatic at conversation start |
| status-check | Cross-domain status report | "status check", "brief me", "catch me up" |
| weekly-backup | Diagnostic + chat archive | Auto (7-day gap) or "diagnostic", "backup" |

## Common custom skills

### Meeting Processing
**meeting-prep** — Gather context before a meeting: recent discussions with participants, related documents, open tasks, project status. Trigger: "prep for meeting with [name]"

**meeting-actions** — Extract action items, decisions, and follow-ups from meeting transcripts. Create reminders, update hubs. Trigger: "process last meeting", "extract actions"

### Work Domain
**experiment-spec** — Generate structured specs for A/B tests, rollouts, config changes. Trigger: "write a spec for...", "experiment design"

**weekly-review** — Summarize the week: what was done, what's blocked, what's next. Trigger: "weekly review", Friday afternoon

**project-tracker** — Check external project status (GitHub, Sentry, deployment). Trigger: "check [project] status"

### Personal
**health-tracker** — Log symptoms, medications, appointments. Cross-reference with hub file. Trigger: "log [symptom]", "[pet name] health update"

**language-teacher** — Switch to target language, provide corrections inline, roleplay scenarios. Trigger: writing in the target language or "lesson"

**travel-planner** — Research destination, build itinerary, track bookings. Trigger: "plan trip to [destination]"

**finance-review** — Check budgets, track expenses against plan, flag anomalies. Trigger: "finance check", "budget review"

### System
**hub-sync** — Pull fresh data from external sources (Drive, Granola, etc.) into hub files. Trigger: "sync hubs", "refresh from Drive"

**chat-archive** — Back up conversation history to archive/. Trigger: "archive chats", automatic via weekly-backup

## Creating your own skill

1. Create a directory: `skills/[skill-name]/`
2. Create `SKILL.md` with frontmatter (name, version, description with trigger phrases)
3. Follow the template in `skills/example-skill/SKILL.md`
4. Add to CLAUDE.md routing table if it maps to a hub
5. Test by using a trigger phrase in conversation

### Skill design principles

- **One skill, one job.** Don't combine meeting prep and meeting processing.
- **Declare inputs and sources.** Where does the data come from? What if it's unavailable?
- **Handle failures gracefully.** Missing MCP connector? Stale hub? Empty search results?
- **Persist results.** If the skill changes state, commit to the repo.
- **Keep it under 2K tokens.** Skills are loaded on-demand — bloated skills waste context.
