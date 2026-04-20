#!/bin/bash
# Claude Code SessionEnd hook — calls auto_log MCP tool on session close.
#
# Purpose: Every Claude Code session produces a structured log entry in D1
# (sessions table) without requiring manual intervention. Addresses P0-C
# original problem: 98% conversations ended without logging.
#
# Install: Reference this script from a SessionEnd hook in ~/.claude/settings.json
# or .claude/settings.local.json. See config/claude-code-hooks-example.json.
#
# Hook event payload is passed via stdin as JSON. We don't need it for the minimal
# version — just log "session ended" with timestamp and surface=code.
#
# Environment contract:
#   MCP_URL            — defaults to claude-memory-mcp production URL
#   MCP_SURFACE        — defaults to "code"
#   MCP_SESSION_SUMMARY (optional) — custom summary; otherwise auto-generated

set -euo pipefail

MCP_URL="${MCP_URL:-https://claude-memory-mcp.OWNER.workers.dev/mcp}"
SURFACE="${MCP_SURFACE:-code}"

# Read stdin (Claude Code passes event JSON) — we ignore it for the minimal impl
# but slurp it to avoid broken pipe errors.
read -r _STDIN_JSON < /dev/stdin 2>/dev/null || true

# Construct a generic summary if none provided
if [ -z "${MCP_SESSION_SUMMARY:-}" ]; then
  CWD="$(basename "$(pwd)")"
  TS="$(date +%Y-%m-%dT%H:%M)"
  SUMMARY="Claude Code session ended in ${CWD} at ${TS}"
else
  SUMMARY="$MCP_SESSION_SUMMARY"
fi

# Escape summary for JSON (minimal — assumes no embedded backslashes)
SUMMARY_ESCAPED="${SUMMARY//\"/\\\"}"

PAYLOAD=$(cat <<EOF
{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"auto_log","arguments":{"summary":"${SUMMARY_ESCAPED}","surface":"${SURFACE}"}}}
EOF
)

# Best-effort POST — don't block session exit on MCP errors
curl -s --max-time 5 \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -X POST \
  -d "$PAYLOAD" \
  "$MCP_URL" > /dev/null 2>&1 || true

# Always exit 0 — hooks should not fail the session
exit 0
