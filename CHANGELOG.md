# Changelog

## 2026-04-09 — v3.0 Karpathy wiki features

### Added
- **wiki_lint** tool — audits KB for orphan knowledge, stale facts, low confidence, stale hubs
- **memory_stats** tool — aggregate KB statistics (facts, KG, sessions, confidence distribution)
- **audit_trail** tool — read-only view of all write operations via audit_log D1 table
- **KG supersession** — `kg_add` now auto-expires old triples when value changes, preserves history
- **Confidence scoring** — facts get 0.0–1.0 confidence, reinforced on matching upsert, sorted by confidence
- **LOG.md** — append-only activity log from update_file, store_fact, kg_add, diary_write
- **Input sanitization** — strips prompt injection tags, enforces 50KB write limit
- **Audit log** D1 table — tracks all write operations with timestamps
- **Ingest Protocol** — documented workflow in MEMORY_EDITS for compiling new information across hubs
- **Writeback Convention** — documented rule for filing synthesis back into hubs

### Changed
- MCP Worker upgraded to **v3.0**, 29 tools total
- `store_fact` now tracks confidence and last_accessed_at
- `query_facts` now sorts by confidence descending, touches last_accessed_at on read
- `kg_add` detects matching subject+predicate and either reinforces or supersedes

---

## 2026-04-09 — Initial MCP sync

First sync from private claude-memory repo.

### Added
- **MCP Worker source** (`config/mcp-worker/`) — 22 tools, v2.2.0
  - Core: wake_up, get_snapshot, get_hub, get_rules, get_taxonomy
  - Files: list_files, read_file, search, search_in_hub, update_file
  - D1: store_fact, query_facts, log_session, auto_log, recent_sessions
  - Errors: log_error, error_report
  - Knowledge Graph: kg_add, kg_query
  - Quality: health_check, todo_add
  - Utility: flush_cache
- **CI/CD workflow** (`.github/workflows/deploy-mcp.yml`) — auto-deploy on push to main
- **D1 setup script** (`setup-d1.sh`) — bootstrap tables and indexes
- **QUICKSTART.md** — Lite mode setup (repo only, 10 min)
- **SETUP_MCP.md** — Full mode setup (Cloudflare MCP, 15 min)
- **CHANGELOG.md** — this file

### Changed
- **README.md** — updated with two-level architecture (Lite vs Full), tool list
