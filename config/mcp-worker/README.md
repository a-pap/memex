# MCP Worker — Cloudflare Worker for Memex

A Cloudflare Worker that exposes your Git-based memory repo as **26 MCP tools** (v2.3.0). This is the **Full mode** access path — Claude.ai Chat and Mobile can't run `git clone`, so the MCP Worker bridges the gap.

## Architecture

```
Claude.ai / Mobile / Cowork
    ↓ MCP protocol (optional Bearer or URL-path auth)
Cloudflare Worker (src/index.ts)
    ├── GitHub API → repo files (read/write/search)
    └── D1 Database → structured data (facts, sessions, errors, KG)
```

- **Runtime:** Cloudflare Workers (edge, ~50ms cold start)
- **Repo access:** GitHub REST API with a fine-grained PAT (Contents read/write)
- **Database:** Cloudflare D1 (SQLite at edge) — default region WEUR (Paris)
- **Auth:** Bearer token (header) OR URL-path token (`/mcp/<token>`), both optional
- **Type-safety:** `zod` schemas + MCP `ToolAnnotations` on every tool

## Tools (26)

All tools ship with `ToolAnnotations` (`title` + `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) so Claude and other MCP clients can reason about their safety class.

| Tool | Description | When used |
|------|-------------|-----------|
| **Memory loaders** | | |
| `wake_up` | Load snapshot + rules + hubs + recent facts in one call | Every conversation start |
| `get_snapshot` | Read STATUS_SNAPSHOT.md | Quick status check |
| `get_hub` | Read a specific hub file by name or path | Topic-specific questions |
| `get_rules` | Read RULES.md | Behavioral calibration |
| `get_taxonomy` | List all hubs, skills, config files | Navigation / routing |
| **Files** | | |
| `list_files` | List directory contents from repo | Browsing repo structure |
| `read_file` | Read any file from repo | On-demand loading |
| `search` | Full-text search across repo (GitHub API) | Finding specific info |
| `search_in_hub` | Scoped keyword search inside one hub file | Targeted lookup |
| `update_file` | Write/update a file (auto-commits to git) | Persisting changes |
| **Facts (D1)** | | |
| `store_fact` | Upsert a structured fact (domain/key/value) | After learning something new |
| `query_facts` | Query facts by domain or keyword | Answering questions |
| **Sessions (D1)** | | |
| `log_session` | Log a conversation summary (explicit fields) | End of conversation |
| `auto_log` | Low-friction one-line session logger | End of conversation (lazy) |
| `recent_sessions` | Retrieve recent session logs | Context continuity |
| **Errors (D1)** | | |
| `log_error` | Log an error for tracking | When a tool or action fails |
| `error_report` | Get error trends and counts | Self-improvement cycles |
| **Knowledge graph (D1)** | | |
| `kg_add` | Add/upsert a subject-predicate-object temporal triple | Building relationships |
| `kg_query` | Query the knowledge graph by subject or predicate | Complex questions |
| **Diaries (GitHub)** | | |
| `diary_write` | Append a timestamped entry to a domain diary log | Per-domain chronology |
| `diary_read` | Read recent entries from a domain diary | Chronological review |
| **Cross-hub tunnels** | | |
| `get_tunnels` | Find entities that appear in multiple hubs | Cross-domain discovery |
| **Quality loop** | | |
| `health_check` | Structured system health report (errors, sessions, KG, freshness) | Conversation start (Chat) |
| `todo_add` | Append a TODO entry to TODO.md | Auto-quality loop |
| `memex_diff` | Compare this worker's key files against a public fork | Drift detection |
| **Self-maintenance** | | |
| `flush_cache` | Best-effort cache flush signal | After manual repo changes |

## Deployment

### Prerequisites

- Cloudflare account (free tier works) with Workers + D1 enabled
- GitHub PAT (fine-grained: Contents read/write on your memory repo)
- Node.js 18+ and `wrangler` CLI

### Deploy

```bash
cd config/mcp-worker

# Required env vars (NEVER hardcode — export in your shell)
export CLOUDFLARE_API_TOKEN=...        # Cloudflare API token (Workers + D1 perms)
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)   # random 64-char hex for URL-path auth
export GITHUB_PAT=...                  # GitHub PAT with Contents read/write

# Option A: one-shot script
bash setup-d1.sh

# Option B: manual
npm install
npx wrangler d1 create claude-memory-db --location=weur  # copy the ID into wrangler.toml
npx wrangler deploy
echo "$MCP_AUTH_TOKEN" | npx wrangler secret put AUTH_PATH_TOKEN
echo "$GITHUB_PAT"     | npx wrangler secret put GITHUB_PAT
```

Or use GitHub Actions — push to `main` and the CI/CD workflow handles it (`.github/workflows/deploy-mcp.yml`). Store `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `GH_PAT` as repo secrets.

### Secrets

Set via `wrangler secret put` or GitHub Actions:

| Secret | Purpose |
|--------|---------|
| `GITHUB_PAT` | GitHub Personal Access Token (Contents read/write) |
| `AUTH_PATH_TOKEN` | Optional token checked in the `/mcp/<token>` URL path |

`GITHUB_REPO` is a *var*, not a secret — set it in `wrangler.toml` under `[vars]` to `owner/repo`.

### D1 Schema

Tables are auto-created on first D1 write (`ensureTables` in `src/index.ts`), so you don't strictly need an upfront migration — but `setup-d1.sh` also has an optional seed step.

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `facts` | Upsert key/value store for structured facts | `key` (unique), `value`, `domain` |
| `sessions` | Conversation history | `surface`, `summary`, `created_at` |
| `errors` | Error tracking and trend analysis | `tool`, `message`, `created_at` |
| `knowledge_graph` | Temporal SPO triples | `subject`, `predicate`, `object`, `valid_from`, `valid_until` |

## Connecting Claude.ai

1. Go to claude.ai → Settings → Connectors → Add custom MCP
2. Fill in:
   - **URL:** `https://<your-worker>.workers.dev/mcp` (Bearer auth via client)
   - **OR:** `https://<your-worker>.workers.dev/mcp/<MCP_AUTH_TOKEN>` (URL-path auth, no Bearer header needed)
3. Call `wake_up` in a new chat to confirm all 26 tools are wired.

## Development

```bash
cd config/mcp-worker
npm install
npx wrangler dev    # local dev server, D1 preview
npx tsc --noEmit    # type-check without deploying
```

See [../../SETUP_MCP.md](../../SETUP_MCP.md) for the full end-to-end setup guide, and [../../docs/LITE_VS_FULL.md](../../docs/LITE_VS_FULL.md) to decide between the Lite (repo only, no MCP) and Full (MCP Worker) modes.

## Version history

| Version | Highlights |
|---------|-----------|
| **2.3.0** | `ToolAnnotations` on all 26 tools; `memex_diff`, `diary_*`, `get_tunnels`, `todo_add`, `health_check`, `auto_log` added |
| 2.2.0 | D1 contradiction checks, upsert semantics, URL-path auth |
| 2.1.0 | Temporal knowledge graph, scoped hub search, compact wake_up |
| 2.0.0 | D1 integration (facts, sessions, errors, KG) — 16 tools |
| 1.0.0 | Initial worker — 9 read-only tools |
