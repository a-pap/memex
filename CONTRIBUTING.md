# Contributing

## For users: fork and customize

The main use case is **forking this repo and making it your own**. Your private fork contains your personal data — hubs, memory edits, status. The blueprint repo contains generic templates.

1. Fork → make it private
2. Follow [QUICKSTART.md](QUICKSTART.md) or [SETUP_MCP.md](SETUP_MCP.md)
3. Customize everything for your domains

## For contributors: improve the blueprint

If you've discovered a pattern, skill, or improvement that would help everyone:

1. Fork the blueprint repo
2. Make your change (template, doc, or pattern)
3. Submit a PR with a clear description

**Good contributions:**
- New skill templates (e.g., `weekly-review`, `health-tracker`)
- Behavioral rules from real failure modes
- Token optimization strategies with measured impact
- Hub structure conventions that solve a common problem
- MCP Worker improvements

**Don't include:**
- Personal data or domain-specific content
- Speculative improvements without real-world evidence
- Changes to `examples/` that don't follow the anonymization pattern

## Code style (MCP Worker)

- TypeScript, single-file architecture (`config/mcp-worker/src/index.ts`)
- Zod for input validation
- GitHub API for repo access, D1 for structured data
- Keep tool handlers focused — one tool, one job

## Claude-assisted contributions

If Claude notices a systemic improvement during a conversation (a pattern that would benefit all users), it should flag it to you. If you agree, submit it as a PR.
