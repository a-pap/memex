#!/bin/bash
# Bootstrap script for the memex MCP Worker on Cloudflare.
#
# What it does:
#   1. Installs worker dependencies
#   2. Creates the D1 database (if it doesn't exist)
#   3. Patches wrangler.toml with the real database_id
#   4. Deploys the worker
#   5. Sets the AUTH_PATH_TOKEN secret
#   6. (Optional) Seeds the knowledge graph with your own facts
#   7. Verifies the deployment
#
# Prerequisites:
#   - brew install wrangler  (or npm i -g wrangler)
#   - A Cloudflare account with Workers + D1 enabled
#   - A GitHub Personal Access Token with repo scope (for the worker to read your memory repo)
#
# Required environment variables (NEVER hardcode these — export them in your shell):
#   CLOUDFLARE_API_TOKEN   — Cloudflare API token with "Workers Scripts:Edit" + "D1:Edit" perms
#   MCP_AUTH_TOKEN         — a random 64-character hex string (generate with: openssl rand -hex 32)
#   GITHUB_PAT             — GitHub PAT with repo scope for your memory repo
#
# Optional:
#   KG_SEED_FILE           — path to a .sql file with your own INSERT statements for knowledge_graph
#   WORKER_URL             — override worker URL for verification (default: auto-detect from wrangler)
#
# Usage:
#   cd config/mcp-worker
#   export CLOUDFLARE_API_TOKEN=...
#   export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
#   export GITHUB_PAT=...
#   bash setup-d1.sh

set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Need CLOUDFLARE_API_TOKEN env var — never hardcode}"
: "${MCP_AUTH_TOKEN:?Need MCP_AUTH_TOKEN env var — never hardcode}"
: "${GITHUB_PAT:?Need GITHUB_PAT env var — never hardcode}"

AUTH_TOKEN="$MCP_AUTH_TOKEN"
DB_NAME="claude-memory-db"

echo "=== Step 1: Install dependencies ==="
npm install

echo ""
echo "=== Step 2: Ensure D1 database exists ==="
DB_ID=$(npx wrangler d1 list 2>/dev/null | grep "$DB_NAME" | awk '{print $1}' || true)
if [ -z "${DB_ID:-}" ]; then
  echo "Creating new D1 database: $DB_NAME"
  npx wrangler d1 create "$DB_NAME" --location=weur
  DB_ID=$(npx wrangler d1 list 2>/dev/null | grep "$DB_NAME" | awk '{print $1}')
fi
echo "Database ID: $DB_ID"

echo ""
echo "=== Step 3: Update wrangler.toml with database ID ==="
sed -i.bak "s/YOUR_D1_DATABASE_ID/$DB_ID/" wrangler.toml
rm -f wrangler.toml.bak
echo "Updated wrangler.toml:"
grep database_id wrangler.toml

echo ""
echo "=== Step 4: Deploy worker ==="
npx wrangler deploy

echo ""
echo "=== Step 5: Set secrets ==="
echo "$AUTH_TOKEN" | npx wrangler secret put AUTH_PATH_TOKEN
echo "$GITHUB_PAT" | npx wrangler secret put GITHUB_PAT

echo ""
echo "=== Step 6: (Optional) Seed knowledge graph ==="
# The worker auto-creates tables on first D1 use. This step lets you
# preload your own facts/triples so the memory system starts useful.
#
# To seed, set KG_SEED_FILE=/path/to/your-seed.sql and re-run, OR
# customize the inline example below.
if [ -n "${KG_SEED_FILE:-}" ] && [ -f "$KG_SEED_FILE" ]; then
  echo "Seeding from $KG_SEED_FILE"
  npx wrangler d1 execute "$DB_NAME" --remote --file "$KG_SEED_FILE"
else
  echo "No KG_SEED_FILE provided — seeding with a generic example."
  echo "(Edit setup-d1.sh or pass KG_SEED_FILE to customize.)"
  npx wrangler d1 execute "$DB_NAME" --remote --command "INSERT OR IGNORE INTO knowledge_graph (subject, predicate, object, valid_from, source) VALUES ('user', 'location', 'Berlin', '2026-01-01', 'manual'), ('project', 'status', 'active', '2026-01-01', 'manual');" 2>/dev/null || echo "(tables not created yet — they auto-create on first worker call; re-run seeding after first health check if needed)"
fi

echo ""
echo "=== Step 7: Verify deployment ==="
WORKER_URL="${WORKER_URL:-$(npx wrangler deployments list 2>/dev/null | grep -oE 'https://[^ ]+\.workers\.dev' | head -1 || echo '')}"
if [ -z "$WORKER_URL" ]; then
  echo "Could not auto-detect worker URL. Set WORKER_URL env var and re-run verify step manually."
  exit 0
fi

echo "Worker URL: $WORKER_URL"
echo "Testing health endpoint..."
curl -s "$WORKER_URL/" | python3 -m json.tool 2>/dev/null || curl -s "$WORKER_URL/"

echo ""
echo "Testing MCP tools/list..."
curl -s -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" -X POST \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}' \
  "$WORKER_URL/mcp/$AUTH_TOKEN"

echo ""
echo ""
echo "=== DONE ==="
echo "Database:   $DB_NAME ($DB_ID)"
echo "Worker URL: $WORKER_URL"
echo ""
echo "Next steps:"
echo "  1. Add the MCP connector to claude.ai:"
echo "       Settings → Connectors → Add custom MCP"
echo "       URL:  $WORKER_URL/mcp"
echo "       Auth: Bearer \$MCP_AUTH_TOKEN  (or use $WORKER_URL/mcp/\$MCP_AUTH_TOKEN)"
echo "  2. Edit CLAUDE.md and hubs/ in your memory repo to match your own context."
echo "  3. Call wake_up from claude.ai to confirm end-to-end flow."
