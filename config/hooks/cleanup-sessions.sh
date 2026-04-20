#!/usr/bin/env bash
# cleanup-sessions.sh — Remove stale Claude Code JSONL session files
# Run manually or via scheduled task. Safe to run repeatedly.
#
# Targets: ~/.claude/projects/*/sessions/*.jsonl
# Default: delete files older than 30 days
# Dry-run mode: pass --dry-run to preview without deleting

set -euo pipefail

DAYS="${CLEANUP_DAYS:-30}"
DRY_RUN=false
TOTAL_FREED=0
FILES_DELETED=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --days=*) DAYS="${arg#*=}" ;;
  esac
done

CLAUDE_DIR="${HOME}/.claude/projects"

if [ ! -d "$CLAUDE_DIR" ]; then
  echo "No Claude projects dir found at $CLAUDE_DIR"
  exit 0
fi

echo "Scanning $CLAUDE_DIR for JSONL files older than ${DAYS} days..."

while IFS= read -r -d '' file; do
  size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo 0)
  size_kb=$((size / 1024))

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would delete: $file (${size_kb}KB)"
  else
    rm -f "$file"
    echo "Deleted: $file (${size_kb}KB)"
  fi

  TOTAL_FREED=$((TOTAL_FREED + size))
  FILES_DELETED=$((FILES_DELETED + 1))
done < <(find "$CLAUDE_DIR" -name "*.jsonl" -type f -mtime "+${DAYS}" -print0 2>/dev/null)

FREED_MB=$((TOTAL_FREED / 1024 / 1024))

if [ "$FILES_DELETED" -eq 0 ]; then
  echo "No stale JSONL files found (threshold: ${DAYS} days)."
else
  if [ "$DRY_RUN" = true ]; then
    echo "Would free: ${FILES_DELETED} files, ~${FREED_MB}MB"
  else
    echo "Cleaned: ${FILES_DELETED} files, ~${FREED_MB}MB freed"
  fi
fi
