# MCP Connectors & Tools

<!-- CUSTOMIZE: List your connected MCP tools and their use cases. -->

## Principle

All connectors are optional. The system works on the repo alone. Each adds freshness/richness when available.

## Active connectors

| Connector | Use case | Priority |
|-----------|----------|----------|
| [e.g., Google Drive] | [e.g., Document search, transcripts] | High |
| [e.g., Google Calendar] | [e.g., Schedule context] | Medium |
| [e.g., Reminders] | [e.g., Task tracking] | Medium |

## How to add connectors

1. Enable in Claude Settings → Connected Tools
2. Add a row to this table
3. If a skill depends on the connector, note it in the skill's SKILL.md

## Connector-down behavior

If any connector is unavailable → proceed with repo data alone. Never error on missing tools. Never apologize for missing access.
