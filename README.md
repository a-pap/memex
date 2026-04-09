# Claude Persistent Memory System

A blueprint for building persistent, cross-surface memory for Claude using a private GitHub repo as the single source of truth. Optionally backed by a Cloudflare MCP server with D1 database.

## Two levels

| | **Lite** | **Full** |
|---|----------|----------|
| **What** | GitHub repo only | Repo + Cloudflare MCP Worker + D1 |
| **Setup time** | 10 min | 15 min |
| **Tools** | Git read/write via Claude | 22 MCP tools (wake_up, search, KG, session logs...) |
| **Best for** | Claude Code, simple workflows | Claude.ai chat, multi-surface, automated monitoring |
| **Guide** | [QUICKSTART.md](QUICKSTART.md) | [SETUP_MCP.md](SETUP_MCP.md) |

## What you get

- **Persistent context** that survives conversation resets and platform changes
- **Structured domain knowledge** organized in hub files
- **Cross-surface sync** — desktop, mobile, Code, Cowork all read the same repo
- **Disaster recovery** — full memory restoration from repo alone
- **Behavioral rules** that persist via memory edits
- **Custom skills** — repeatable procedures Claude can execute
- **Graduated context loading** — minimal tokens at startup, everything else on-demand
- **Quality loop** (Full mode) — automated health checks, session logging, TODO generation

## Architecture

```
Your Private Repo (source of truth)
├── STATUS_SNAPSHOT.md      # Cross-domain status (~50 lines, read first)
├── CLAUDE.md               # Routing table + key rules
├── BOOTSTRAP.md            # Disaster recovery — full restore from zero
├── RULES.md                # Behavioral patterns, failure modes
├── hubs/                   # Domain knowledge files (on-demand)
├── skills/                 # Repeatable procedures (on-demand)
├── config/                 # Projects, connectors, sync protocol
│   └── mcp-worker/         # Cloudflare Worker source (Full mode)
├── memory/                 # Memory edits + preferences snapshots
├── references/             # Deep research artifacts
└── archive/                # Chat history backups
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for design rationale.

## How it works

1. Claude clones/pulls your private repo at conversation start
2. Reads `STATUS_SNAPSHOT.md` for quick routing (~3K tokens)
3. Loads specific hub files on-demand based on topic
4. Uses behavioral rules from `RULES.md` and memory edits
5. After significant changes, commits and pushes back to the repo
6. Next conversation (any surface) picks up where the last left off

In **Full mode**, Claude.ai connects to the MCP server directly — no git commands needed. The `wake_up` tool loads everything in one call.

## Quick start

1. **Fork this repo** as your private memory repo
2. **Follow [QUICKSTART.md](QUICKSTART.md)** (Lite) or [SETUP_MCP.md](SETUP_MCP.md) (Full)
3. **Customize** hub files, skills, and rules for your domains
4. Start a conversation — Claude will use your memory

## MCP Tools (Full mode — 22 tools)

Core: `wake_up`, `get_snapshot`, `get_hub`, `get_rules`, `get_taxonomy`
Files: `list_files`, `read_file`, `search`, `search_in_hub`, `update_file`
D1 Facts: `store_fact`, `query_facts`
Sessions: `log_session`, `auto_log`, `recent_sessions`
Errors: `log_error`, `error_report`
Knowledge Graph: `kg_add`, `kg_query`
Quality: `health_check`, `todo_add`
Utility: `flush_cache`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes.

## License

MIT — use, modify, share freely.
