# Claude Persistent Memory System

A blueprint for building persistent, cross-surface memory for Claude using a private GitHub repo as the single source of truth.

**What this solves:** Claude has no persistent memory between conversations. Each new chat starts from zero. This system gives Claude a structured external memory that works across all surfaces (claude.ai chat, mobile, Claude Code, Cowork) — requiring only a GitHub repo and a Personal Access Token.

**What you get:**
- Persistent context that survives conversation resets and platform changes
- Structured domain knowledge organized in hub files
- Cross-surface sync (desktop, mobile, Code, Cowork all read the same repo)
- Disaster recovery (full memory restoration from repo alone)
- Behavioral rules that persist via memory edits
- Custom skills (repeatable procedures Claude can execute)
- Graduated context loading (minimal tokens, maximum signal)

**Requirements:**
- A GitHub account with a private repo
- A Personal Access Token (classic, `repo` scope)
- Claude Pro/Team/Enterprise (needs computer use for git operations)
- ~30 minutes for initial setup

## Quick Start

1. **Fork or clone this repo** as your private memory repo
2. **Follow [SETUP.md](SETUP.md)** — step-by-step guide
3. **Customize** hub files, skills, and rules for your domains
4. **Paste the bootstrap prompt** into a new Claude conversation

That's it. Claude will clone your repo and start using it.

## Architecture Overview

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design rationale.

```
Your Private Repo (source of truth)
├── STATUS_SNAPSHOT.md      # Cross-domain status (~50 lines, read first)
├── CLAUDE.md               # Routing table + key rules
├── BOOTSTRAP.md            # Disaster recovery — full restore from zero
├── RULES.md                # Behavioral patterns, failure modes
├── hubs/                   # Domain knowledge files (on-demand)
├── skills/                 # Repeatable procedures (on-demand)
├── config/                 # Projects, connectors, sync protocol
├── memory/                 # Memory edits + preferences snapshots
├── references/             # Deep research artifacts
└── archive/                # Chat history backups
```

## How It Works

1. Claude clones/pulls your private repo at conversation start
2. Reads `STATUS_SNAPSHOT.md` for quick routing (~3K tokens)
3. Loads specific hub files on-demand based on topic
4. Uses behavioral rules from `RULES.md` and memory edits
5. After significant changes, commits and pushes back to the repo
6. Next conversation (any surface) picks up where the last left off

## Contributing

This is a living system. If your Claude instance discovers improvements to the core architecture, see [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes to this blueprint.

## License

MIT — use, modify, share freely.
