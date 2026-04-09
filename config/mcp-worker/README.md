# MCP Worker — Cloudflare Worker for Memex

A Cloudflare Worker that exposes your Git-based memory repo as 22 MCP tools. This is the **Full mode** access path — Claude.ai Chat and Mobile can't run `git clone`, so the MCP Worker bridges the gap.

## Architecture

```
Claude.ai / Mobile
    ↓ MCP protocol (Bearer auth)
Cloudflare Worker (index.ts)
    ├── GitHub API → repo files (read/write/search)
    └── D1 Database → structured data (facts, sessions, KG)
```

- **Runtime:** Cloudflare Workers (edge, ~50ms cold start)
- **Repo access:** GitHub REST API with PAT (fine-grained, Contents read/write)
- **Database:** Cloudflare D1 (SQLite at edge) — Paris region (WEUR)
- **Auth:** Bearer token in MCP connector settings

## Tools (22)

| Tool | Description | When used |
|------|-------------|-----------|
| **Core** | | |
| `wake_up` | Load snapshot + rules + hubs + recent facts in one call | Every conversation start |
| `get_snapshot` | Read STATUS_SNAPSHOT.md | Quick status check |
| `get_hub` | Read a specific hub file by name/number | Topic-specific questions |
| `get_rules` | Read RULES.md | Behavioral calibration |
| `get_taxonomy` | List all hubs, skills, config files | Navigation / routing |
| **Files** | | |
| `list_files` | List directory contents | Browsing repo structure |
| `read_file` | Read any file from repo | On-demand loading |
| `search` | Full-text search across repo (GitHub API) | Finding specific info |
| `search_in_hub` | Search within a specific hub file | Targeted lookup |
| `update_file` | Write/update a file (auto-commits to git) | Persisting changes |
| **D1 Facts** | | |
| `store_fact` | Save a structured fact (domain, key, value) | After learning something new |
| `query_facts` | Query facts by domain or keyword | Answering questions |
| **Sessions** | | |
| `log_session` | Log a conversation summary | End of conversation |
| `auto_log` | Automatically log session with extracted facts | End of conversation (lazy) |
| `recent_sessions` | Retrieve recent session logs | Context continuity |
| **Errors** | | |
| `log_error` | Log an error for tracking | When something fails |
| `error_report` | Get error trends and patterns | Self-improvement |
| **Knowledge Graph** | | |
| `kg_add` | Add a subject-predicate-object triple | Building relationships |
| `kg_query` | Query the knowledge graph | Complex questions |
| **Quality** | | |
| `health_check` | Run system health diagnostics | Periodic check (Cowork) |
| `todo_add` | Add a task to TODO.md | Task tracking |
| `flush_cache` | Clear cached data | After manual repo changes |

## Deployment

### Prerequisites

- Cloudflare account (free tier works)
- GitHub PAT (fine-grained: Contents read/write on your memory repo)
- Node.js 18+

### Deploy

```bash
cd config/mcp-worker
npm install
CLOUDFLARE_API_TOKEN=your_token npx wrangler deploy
```

Or use GitHub Actions — push to `main` and the CI/CD workflow handles it (see `.github/workflows/deploy-mcp.yml`).

### Secrets

Set these in the Cloudflare dashboard or via `wrangler secret put`:

| Secret | Purpose |
|--------|---------|
| `GITHUB_PAT` | GitHub Personal Access Token (Contents read/write) |
| `GITHUB_REPO` | Your repo in `owner/repo` format |
| `AUTH_PATH_TOKEN` | Optional Bearer token for MCP auth |

### D1 Database Setup

```bash
# Create the database
wrangler d1 create memex-db

# Run migrations
wrangler d1 execute memex-db --remote --file=schema.sql
# Or use the setup script:
bash setup-d1.sh
```

### D1 Schema

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `facts` | Structured facts | domain, key, value, updated_at |
| `sessions` | Conversation logs | summary, facts_extracted, created_at |
| `errors` | Error tracking | tool, message, created_at |
| `knowledge_graph` | SPO triples | subject, predicate, object |

## Connecting Claude.ai

1. Go to Claude.ai Settings → MCP Servers
2. Add a new server:
   - **URL:** `https://your-worker.your-subdomain.workers.dev/mcp`
   - **Auth:** Bearer token (your `AUTH_PATH_TOKEN`)
3. Claude will now have access to all 22 tools

## Development

```bash
cd config/mcp-worker
npm install
wrangler dev  # Local development server
```

See [SETUP_MCP.md](../../SETUP_MCP.md) for the full setup guide.
