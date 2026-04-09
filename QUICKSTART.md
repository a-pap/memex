# Quickstart — Lite Mode (10 minutes)

Lite mode gives you persistent memory across Claude conversations using **only a GitHub repo**. No Cloudflare, no MCP server, no external services.

## What you get

- `STATUS_SNAPSHOT.md` — your cross-domain status dashboard
- `hubs/` — domain-specific knowledge files (work, health, projects, etc.)
- `CLAUDE.md` — instructions Claude reads at session start
- `RULES.md` — behavioral rules and failure patterns
- Skills, references, and templates

Claude reads these files via CLAUDE.md project instructions and updates them via git commits.

## Setup

### 1. Fork this repo

Fork `memex` to your GitHub account. Make it **private** (it will contain personal data).

### 2. Create a GitHub PAT

Go to [GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/personal-access-tokens).

Create a token with:
- **Repository access:** Only select your forked repo
- **Permissions:** Contents (Read and write)

Save the token — you'll need it for CLAUDE.md.

### 3. Customize your files

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
```

1. **Copy templates to root:**
   ```bash
   cp templates/STATUS_SNAPSHOT.md .
   cp templates/CLAUDE.md .
   cp templates/RULES.md .
   cp -r templates/hubs .
   cp -r templates/skills .
   ```

2. **Edit `CLAUDE.md`** — replace placeholders with your repo URL and PAT.

3. **Edit `STATUS_SNAPSHOT.md`** — fill in your current status across domains.

4. **Create hub files** — one per domain you want to track. See `hubs/01_example_hub.md` for format.

5. **Commit and push:**
   ```bash
   git add -A && git commit -m "initial setup" && git push
   ```

### 4. Add to Claude

**Claude.ai (Projects):**
- Create a new Project
- Add your repo's `CLAUDE.md` content as Project Instructions
- Claude will read/write files via git commands in artifacts

**Claude Code (CLI):**
- Clone the repo locally
- Claude Code reads `CLAUDE.md` automatically from the project root
- Updates happen via local git commits + push

### 5. Verify

Start a conversation and ask: "What's my current status?" Claude should read `STATUS_SNAPSHOT.md` and respond with your data.

## Next steps

- **Want MCP tools?** See [SETUP_MCP.md](SETUP_MCP.md) for the Full setup with Cloudflare Workers.
- **Want CI/CD?** The `.github/workflows/deploy-mcp.yml` template auto-deploys on push.
- **Questions?** See [ARCHITECTURE.md](ARCHITECTURE.md) for how the system works.
