# Skill Catalog

Skills are repeatable procedures Claude runs when a trigger phrase or context
matches. Claude Code discovers them in **`.claude/skills/<name>/SKILL.md`** — that's
where the setup step copies them. (A bare `skills/` directory at the repo root is
*not* auto-discovered by Claude Code.)

## Included in the blueprint

| Skill | Purpose | Trigger |
|-------|---------|---------|
| git-memory | Load context from the repo, write changes back | On demand; "pull memory"; before status claims |
| status-check | Cross-domain status report | "status check", "brief me", "catch me up" |
| weekly-backup | Repo self-diagnostic | "diagnostic", "backup", "self-check" |
| example-skill | Scaffold for building your own | (copy it to start a new skill) |

All four are git-only — they work in Claude Code with no token and no external tools.

## Common custom skills (ideas to build)

### Meetings
- **meeting-prep** — gather context before a meeting: recent discussion, related
  docs, open tasks. Trigger: "prep for meeting with [name]".
- **meeting-actions** — extract decisions and follow-ups from notes; update hubs.

### Work
- **experiment-spec** — structured specs for A/B tests, rollouts, config changes.
- **weekly-review** — summarize the week: done, blocked, next.

### Personal
- **health-tracker** — log symptoms, meds, appointments against a hub.
- **language-teacher** — switch to a target language, correct inline.
- **travel-planner** — research, itinerary, bookings.
- **finance-review** — budgets and expenses against plan.

## Creating your own skill

1. Create a directory: `.claude/skills/[skill-name]/` (Claude Code's discovery path).
2. Add `SKILL.md` with frontmatter — a `name` and a `description` that includes the
   trigger phrases (Claude matches on the description).
3. Use `.claude/skills/example-skill/SKILL.md` as a scaffold.
4. If the skill maps to a domain, add it to the CLAUDE.md routing table.
5. Test by using a trigger phrase.

### Design principles
- **One skill, one job.**
- **Declare inputs and sources;** handle a missing one gracefully.
- **Git-only first.** If a step needs a connected tool, give a repo-native fallback.
- **Persist results** with a commit if the skill changed state.
- **Keep it under ~2K tokens** — skills load on demand.
