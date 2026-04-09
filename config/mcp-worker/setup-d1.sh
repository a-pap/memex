#!/bin/bash
# Setup D1 database for claude-memory-mcp worker
# Run this locally (not in sandbox) — requires Cloudflare API access
#
# Usage: cd config/mcp-worker && bash setup-d1.sh

set -euo pipefail

export CLOUDFLARE_API_TOKEN="cfut_X3RTVnn6E0cQ4jRexJKiLpXJAU0CiNto2fz42FgUd3a17611"
AUTH_TOKEN="1be0cca6fdd39c9905d9827b42c2334aa6a22cb1e8e451f4c8c3f703c22653ca"

echo "=== Step 1: Install dependencies ==="
npm install

echo ""
echo "=== Step 2: Get D1 database ID ==="
DB_ID=$(npx wrangler d1 list 2>/dev/null | grep "claude-memory-db" | awk '{print $1}')
if [ -z "$DB_ID" ]; then
  echo "ERROR: claude-memory-db not found. Create it first:"
  echo "  npx wrangler d1 create claude-memory-db --location=weur"
  exit 1
fi
echo "Found database ID: $DB_ID"

echo ""
echo "=== Step 3: Update wrangler.toml with database ID ==="
sed -i.bak "s/REPLACE_WITH_REAL_ID/$DB_ID/" wrangler.toml
rm -f wrangler.toml.bak
echo "Updated wrangler.toml"
cat wrangler.toml

echo ""
echo "=== Step 4: Deploy worker ==="
npx wrangler deploy

echo ""
echo "=== Step 5: Set AUTH_PATH_TOKEN secret ==="
echo "$AUTH_TOKEN" | npx wrangler secret put AUTH_PATH_TOKEN

echo ""
echo "=== Step 6: Seed knowledge graph ==="
npx wrangler d1 execute claude-memory-db --command "INSERT OR REPLACE INTO knowledge_graph (subject, predicate, object, valid_from, source) VALUES ('jay', 'diet', 'Royal Canin Renal', '2026-02-01', 'hub08'), ('jay', 'diet_planned', 'RC Urinary U/C Low Purine', '2026-04-15', 'hub08'), ('jay', 'condition', 'Cystinuria III', '2020-01-01', 'hub08'), ('jay', 'condition', 'Epilepsy (2 GTC seizures)', '2025-12-01', 'hub08'), ('jay', 'last_seizure', '2026-03-31', '2026-03-31', 'hub08'), ('jay', 'mobility_restriction', 'ended', '2026-04-08', 'hub08'), ('artem', 'location', 'Belgrade', '2025-09-01', 'hub06'), ('artem', 'location_planned', 'Barcelona (Poblenou)', '2026-06-01', 'hub06');"

echo ""
echo "=== Step 7: Verify deployment ==="
echo "Testing health endpoint..."
curl -s "https://claude-memory-mcp.a-papilov.workers.dev/" | python3 -m json.tool 2>/dev/null || echo "(python not available for formatting)"

echo ""
echo "Testing MCP tools/list..."
curl -s -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" -X POST \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}' \
  "https://claude-memory-mcp.a-papilov.workers.dev/mcp/$AUTH_TOKEN"

echo ""
echo ""
echo "=== DONE ==="
echo "Database ID: $DB_ID"
echo "Worker URL: https://claude-memory-mcp.a-papilov.workers.dev/mcp/$AUTH_TOKEN"
echo ""
echo "Next: Update claude.ai connector URL to the worker URL above."
