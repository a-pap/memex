#!/bin/bash
# Claude Code SessionEnd hook — calls the auto_log MCP tool on session close.
#
# Purpose
#   Every Claude Code session produces a structured log entry in D1 (sessions
#   table) without manual intervention. Addresses the common failure mode where
#   98%+ of conversations end without being logged, leaving future sessions blind.
#
# Install
#   1. Copy this directory into your memory repo (or keep it where it is).
#   2. Export MCP_URL for your deployed worker:
#        export MCP_URL="https://<your-worker>.workers.dev/mcp"
#      or for authed path form:
#        export MCP_URL="https://<your-worker>.workers.dev/mcp/$MCP_AUTH_TOKEN"
#   3. Merge the hooks block from config/hooks/claude-code-hooks-example.json
#      into ~/.claude/settings.json (or .claude/settings.local.json for per-repo).
#   4. Update the `command` path in that JSON to point at THIS script.
#
# Environment contract
#   MCP_URL             — full MCP endpoint. Required.
#   MCP_SURFACE         — surface label (default: "code")
#   MCP_SESSION_SUMMARY — custom summary (default: auto-generated from cwd + time)
#
# Hook payload
#   Claude Code writes the SessionEnd event JSON to stdin. We currently ignore
#   it — only need the timestamp and cwd. Feel free to parse it if you want
#   richer summaries (see https://docs.claude.com/ for the payload shape).

set -euo pipefail

MCP_URL="${MCP_URL:-}"
SURFACE="${MCP_SURFACE:-code}"

if [ -z "$MCP_URL" ]; then
  # Hook runs silently by design — don't spam the user at session close.
  exit 0
fi

# Slurp stdin to avoid broken-pipe errors from Claude Code's writer
read -r _STDIN_JSON < /dev/stdin 2>/dev/null || true

# Build a generic summary unless caller provided one
if [ -z "${MCP_SESSION_SUMMARY:-}" ]; then
  CWD="$(basename "$(pwd)")"
  TS="$(date +%Y-%m-%dT%H:%M)"
  SUMMARY="Claude Code session ended in ${CWD} at ${TS}"
else
  SUMMARY="$MCP_SESSION_SUMMARY"
fi

# Minimal JSON escape (handles embedded quotes; assumes no raw backslashes)
SUMMARY_ESCAPED="${SUMMARY//\"/\\\"}"

PAYLOAD=$(cat <<EOF
{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"auto_log","arguments":{"summary":"${SUMMARY_ESCAPED}","surface":"${SURFACE}"}}}
EOF
)

# Best-effort POST — never block session exit on network errors
curl -s --max-time 5 \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -X POST \
  -d "$PAYLOAD" \
  "$MCP_URL" > /dev/null 2>&1 || true

exit 0
