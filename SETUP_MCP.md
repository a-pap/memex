# Setup — Full Mode with MCP (15 minutes)

Full mode adds a **Cloudflare Worker** that serves as an MCP server. Claude.ai connects to it directly via the MCP connector, giving you 22 tools for reading, writing, searching, and monitoring your memory.

**Prerequisites:** Complete [QUICKSTART.md](QUICKSTART.md) first. You need a working repo before adding MCP.

## What you get (on top of Lite)

- **22 MCP tools** accessible from Claude.ai via the connector
- **D1 database** for structured facts, session logs, error tracking, and a knowledge graph
- **CI/CD** — push to main auto-deploys the worker
- **Quality loop** — `health_check` + `todo_add` enable automated monitoring

## Setup

### 1. Cloudflare account

Sign up at [cloudflare.com](https://dash.cloudflare.com/) (free tier is sufficient).

Note your **Account ID** from the Workers & Pages dashboard.

### 2. Create a D1 database

```bash
cd config/mcp-worker
npm install
npx wrangler d1 create claude-memory-db
```

Copy the `database_id` from the output.

### 3. Configure wrangler.toml

Edit `config/mcp-worker/wrangler.toml`:

```toml
[vars]
GITHUB_REPO = "your-username/your-memory-repo"

[[d1_databases]]
database_id = "paste-your-database-id-here"
```

### 4. Set secrets

```bash
# Your GitHub PAT (for reading/writing repo files)
npx wrangler secret put GITHUB_PAT

# Optional: URL path token for authenticated access
npx wrangler secret put AUTH_PATH_TOKEN
```

### 5. Initialize D1 tables

```bash
chmod +x setup-d1.sh
./setup-d1.sh
```

Or manually:
```bash
npx wrangler d1 execute claude-memory-db --remote --file=setup-d1.sql
```

### 6. Deploy

```bash
npx wrangler deploy
```

Your worker is now live at `https://claude-memory-mcp.YOUR_SUBDOMAIN.workers.dev`.

### 7. Connect to Claude.ai

1. Go to [claude.ai](https://claude.ai) → Settings → Integrations
2. Add MCP Server
3. URL: `https://claude-memory-mcp.YOUR_SUBDOMAIN.workers.dev/mcp`
4. (If you set AUTH_PATH_TOKEN): use `https://...workers.dev/mcp/YOUR_TOKEN`

### 8. Set up CI/CD (optional but recommended)

Add these secrets to your GitHub repo (Settings → Secrets → Actions):

- `CLOUDFLARE_API_TOKEN` — create at [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) with "Edit Workers" permission
- `CLOUDFLARE_ACCOUNT_ID` — from your Cloudflare dashboard

The workflow in `.github/workflows/deploy-mcp.yml` auto-deploys when you push changes to `config/mcp-worker/**` on main.

### 9. Verify

In Claude.ai, start a new conversation and say: "Use wake_up to load my memory."

Claude should call the `wake_up` tool and return your STATUS_SNAPSHOT, memory edits, available hubs, and recent facts.

## Available tools (22)

| Tool | Description |
|------|-------------|
| `wake_up` | Load everything for session start in one call |
| `get_snapshot` | Load STATUS_SNAPSHOT.md |
| `get_hub` | Load a domain hub file |
| `get_rules` | Load memory edits / behavioral rules |
| `get_taxonomy` | Get full repo structure |
| `list_files` | List files in a directory |
| `read_file` | Read any file by path |
| `search` | Search across all files (GitHub code search) |
| `search_in_hub` | Search within a specific hub |
| `update_file` | Write/update a file (creates git commit) |
| `store_fact` | Store a key-value fact in D1 |
| `query_facts` | Query facts from D1 |
| `log_session` | Log a session summary (full params) |
| `auto_log` | Quick session log (just summary) |
| `recent_sessions` | Get recent session logs |
| `log_error` | Log an error for debugging |
| `error_report` | Get recent errors |
| `flush_cache` | Clear cached state |
| `kg_add` | Add a triple to the knowledge graph |
| `kg_query` | Query the knowledge graph |
| `health_check` | Run system health checks |
| `todo_add` | Add a TODO entry (for automated quality loop) |

## Troubleshooting

**Worker returns 404:** Check that the URL path starts with `/mcp`.

**"GitHub API 401":** Your GITHUB_PAT secret is missing or expired. Re-set it with `npx wrangler secret put GITHUB_PAT`.

**D1 errors:** Run `setup-d1.sh` again — table creation is idempotent.

**Claude can't connect:** Make sure the MCP connector URL is correct and the worker is deployed. Test with:
```bash
curl -s https://YOUR_WORKER_URL/health | jq .
```
