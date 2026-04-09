# Changelog

All notable changes to the Memex blueprint.

## 2026-04-09 — Public blueprint release

Extracted from private `claude-memory` repo into a reusable, anonymized blueprint.

### Added
- **MCP Worker source** (`config/mcp-worker/`) — 22 tools, v2.2
- **CI/CD workflow** (`.github/workflows/deploy-mcp.yml`) — auto-deploy on push to main
- **D1 setup script** (`setup-d1.sh`) — bootstrap tables and indexes
- **QUICKSTART.md** — Lite mode setup (repo only, 10 min)
- **SETUP_MCP.md** — Full mode setup (Cloudflare MCP, 15 min)
- **Examples directory** — filled-in demos for STATUS_SNAPSHOT, hubs, memory edits
- **ARCHITECTURE.md** — design rationale, token economics, graduated loading

### Changed
- **README.md** — architecture diagram, differentiation table, live examples

---

## 2026-03 — D1 database & knowledge graph (v2.0)

Session logging, structured fact storage, and knowledge graph triples.

### Added
- D1 database on Cloudflare (facts, sessions, errors, knowledge_graph tables)
- `store_fact` / `query_facts` — persist and retrieve structured facts
- `log_session` / `recent_sessions` — automatic session history
- `kg_add` / `kg_query` — subject-predicate-object knowledge graph
- `log_error` / `error_report` — error tracking for self-improvement
- Tool count: 9 → 16

---

## 2026-02 — Community-driven improvements

Freshness tracking, compaction survival, behavioral rule refinements.

### Added
- Freshness timestamps on all hub sections
- STATUS_SNAPSHOT compaction (kept under 60 lines)
- MEMORY_EDITS.md — cross-surface drift detection between live edits and repo
- Misinference check framework (adapted from Edmans)
- Behavioral nudging rules (Clear + Fogg)

### Changed
- CLAUDE.md — added pre-flight check as MANDATORY
- RULES.md — expanded failure patterns from 3 to 6

---

## 2026-01 — First MCP Worker (v1.0)

Cloudflare Worker to expose the Git repo as MCP tools for Claude.ai Chat and Mobile.

### Added
- MCP Worker on Cloudflare Workers — 9 initial tools
- `wake_up` — one-call context loading for Chat surface
- `get_snapshot`, `get_hub`, `get_rules` — file access tools
- `search` — code search across repo via GitHub API
- Bearer token authentication
- UTF-8 handling for non-Latin content

### Why
Claude.ai Chat and Mobile can't run `git clone`. The MCP Worker bridges the gap — same repo, accessible from any Claude surface.

---

## 2025-12 — Migration to Git

Moved from Google Drive to GitHub as the primary source of truth.

### Changed
- **Storage**: Google Drive documents → Git repository with structured markdown
- **Access**: Drive API → `git clone/pull` (Chat) / local fs (Code)
- **Versioning**: manual snapshots → full git history with rollback

### Why
Google Drive had no versioning, no structured format, and required Drive API access. Git gives us versioned, auditable, human-readable storage that works with all Claude surfaces.

---

## 2025-10 — Initial concept

Hub-based memory files stored in Google Drive, accessed via Drive API.

### Added
- First hub files: personal profile, work status, side project
- STATUS_SNAPSHOT concept — single file for cross-domain routing
- Claude reads Google Drive at conversation start for persistent context
- Behavioral rules via memory edits

### Why
Claude's built-in `userMemories` is auto-generated, unstructured, and lags by days. Manual memory edits are limited to 14 items of ~500 chars each. Neither is sufficient for structured, multi-domain context. The idea: give Claude a file system it can read and write to.
