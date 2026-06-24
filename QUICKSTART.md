# Quickstart — git-only memory for Claude Code (10 minutes)

This is the minimum, default setup: persistent memory for Claude using **only a
private GitHub repo**. No Cloudflare, no MCP server, no access token in any file,
no paid service — just `git` and the Claude Code you already run.

> The optional MCP worker (for claude.ai chat, mobile, or scheduled automation) is
> a separate, later step — see [SETUP_MCP.md](SETUP_MCP.md). You do **not** need it
> for Claude Code.

## What you get

- `STATUS_SNAPSHOT.md` — your cross-domain status, read first every session
- `CLAUDE.md` — the routing table Claude Code reads automatically
- `hubs/` — one markdown file per life domain (work, health, projects…)
- `RULES.md`, `BOOTSTRAP.md` — behavioral rules and disaster recovery
- `.claude/skills/` — optional repeatable procedures Claude Code auto-discovers

Claude reads these files at the start of every session and updates them with
ordinary git commits.

## Setup

### 1. Fork this repo — make it private

On GitHub, click **Fork** on `memex` and set the fork to **Private** (it will hold
personal data). The web UI is enough — no CLI, no token.

### 2. Clone it the way you already clone repos

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git ~/memex
cd ~/memex
```

Use your normal GitHub auth — SSH, or HTTPS via the git credential helper /
`gh auth login`. **Do not put a token in any file.** Claude Code pushes with the
same local auth you just used to clone; none of your credentials go into the repo.

### 3. Seed your files from the templates

```bash
# Core files at the repo root
cp templates/STATUS_SNAPSHOT.md templates/CLAUDE.md templates/RULES.md templates/BOOTSTRAP.md .
cp -r templates/hubs .

# Skills go where Claude Code discovers them: .claude/skills/
mkdir -p .claude/skills
cp -r templates/skills/* .claude/skills/
```

### 4. Make it yours

1. **`CLAUDE.md`** — edit the *Route by topic* table: list the domains you care
   about and the hub file each maps to. Delete the rows you won't use.
2. **`STATUS_SNAPSHOT.md`** — a line or two of real status per domain, or leave the
   placeholders (it fills in over the first week).
3. **`hubs/`** — create one file per domain by copying `hubs/01_example_hub.md`.
   Name them `01_work.md`, `02_health.md`, … to match your routing table.

### 5. Commit

```bash
git add -A && git commit -m "init: personal memex" && git push
```

### 6. Use it in Claude Code

Open Claude Code with this repo as the working directory. Claude reads `CLAUDE.md`
automatically, follows it to `STATUS_SNAPSHOT.md` and the right hub, and commits
changes back as you work. Try:

> What's my current status?

Claude should read `STATUS_SNAPSHOT.md` and answer with your data. Tell it
something worth remembering and watch it update a hub and push the commit.

That's the whole system. Everything below is optional.

## Next steps (all optional)

- **claude.ai chat / mobile / automation** — deploy the MCP worker so non-Code
  surfaces read the same repo without git: [SETUP_MCP.md](SETUP_MCP.md). This is the
  only path that needs an access token, and even there the token lives in claude.ai
  settings or a Cloudflare secret — never in the repo.
- **How it works** — [ARCHITECTURE.md](ARCHITECTURE.md) and the design essay
  [GIT_AS_RAG.md](GIT_AS_RAG.md).
- **What not to store** — [SECURITY.md](SECURITY.md). Git history is permanent; keep
  secrets and other people's data out of it.
