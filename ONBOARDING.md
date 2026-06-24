# ONBOARDING.md

The canonical setup procedure is **[START_HERE.md](START_HERE.md)** — follow it top
to bottom. This file lists the automation notes that matter when Claude runs the
setup directly.

## Notes for Claude running the setup

- **Default is git-only and token-free.** In Claude Code the repo is the working
  directory; pushes use the user's local git auth. **Never write an access token
  into any file** — not `CLAUDE.md`, not `memory/MEMORY_EDITS.md`, not anywhere. Git
  history is permanent.
- **Silent surface detect.** Code = run bash directly. claude.ai chat = emit command
  blocks for the user's terminal, or offer the optional MCP worker. Mobile = plan
  domains, finish on a laptop.
- **Skills go in `.claude/skills/`** — that's where Claude Code discovers them. A
  bare `skills/` at the repo root is not auto-loaded.
- **Seed → personalize → commit:** copy templates to root (and skills to
  `.claude/skills/`) → create one hub per chosen domain from
  `hubs/01_example_hub.md` → edit the CLAUDE.md routing table and STATUS_SNAPSHOT →
  `git add -A && git commit && git push`.
- **Generate, then confirm.** Ask once for domains (and language); generate hubs and
  status with the user's specifics, or clean placeholders; show a short wrap-up.
- **claude.ai memory edits are optional and token-free** — short behavioral notes the
  user pastes into claude.ai settings, mirrored as plain text in
  `memory/MEMORY_EDITS.md`. They do not apply to Claude Code.
- **No secret by design.** The git-only path stores nothing sensitive. Only the
  optional claude.ai / MCP paths use a token, and it lives in claude.ai settings or a
  Cloudflare secret — never in the repo.
