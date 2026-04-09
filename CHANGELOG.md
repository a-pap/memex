# Changelog

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
