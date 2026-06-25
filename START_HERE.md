# START_HERE — set up Memex in ~10 minutes

**If you're Claude reading this:** the user pointed you at this repo and wants
persistent memory. They probably have nothing set up. Follow the steps below.

**If you're the user:** you don't need to read this. Paste this into
[Claude Code](https://code.claude.com) (recommended) or [claude.ai](https://claude.ai):

> Help me set up Memex from scratch. Read
> https://github.com/a-pap/memex/blob/main/START_HERE.md and walk me through it
> step by step. I'm starting with nothing.

---

## For Claude — execute top to bottom

### Step 0. Detect your surface (silent)

- **Claude Code / CLI** → you can run `bash`/`git`. The repo is a local directory;
  pushes use the user's existing git auth. This is the default, git-only path.
  **Never write an access token into any file.**
- **claude.ai chat** → no persistent shell. Emit commands as code blocks for the
  user's terminal, or set up the optional MCP worker later. Wait for their output.
- **Mobile** → no shell. Help plan domains; the user finishes on a laptop.

### Step 1. One question

Ask, then wait:

> Two quick things before we start:
> 1. **GitHub username?** (for your fork URL)
> 2. **Which domains should I remember?** — e.g. work, health, a side project,
>    learning, a relocation, finance. Pick any.
>
> (I'll write everything in whatever language you reply in.)

The default is the git-only setup — no other accounts or services. Mention the
optional MCP worker (for claude.ai / mobile / automation) only at the end, if asked.

### Step 2. Set it up

#### 2a. Fork (web UI — no token)
> 1. Open https://github.com/a-pap/memex → **Fork** (top-right).
> 2. Set the fork **Private** (your memory holds personal data).
> 3. **Create fork**, then paste your fork's URL here.

#### 2b. Clone with the user's existing git auth
Claude Code — run (no token in the URL; the user's SSH or credential helper handles auth):
```bash
git clone https://github.com/<user>/<repo>.git ~/memex
cd ~/memex
```
If the clone asks for credentials, the user signs in with git as they normally do
(`gh auth login`, or an SSH key). **Do not embed a token in the URL or any file.**

#### 2c. Seed templates
```bash
cp templates/STATUS_SNAPSHOT.md templates/CLAUDE.md templates/RULES.md templates/BOOTSTRAP.md .
cp -r templates/hubs templates/memory .
mkdir -p .claude/skills && cp -r templates/skills/* .claude/skills/
```

#### 2d. Personalize hubs
For each domain the user picked, create `hubs/0N_<slug>.md` from
`hubs/01_example_hub.md` (number sequentially). Keep Current Status minimal — it
fills in over time. Update `hubs/README.md` to list them.

#### 2e. Routing table + status
Edit the *Route by topic* table in `CLAUDE.md` to match the hubs you created (delete
unused rows). Write `STATUS_SNAPSHOT.md` with one section per domain (placeholders
are fine) plus an empty `## Key decisions (SETTLED)` block.

#### 2f. Commit
```bash
git add -A
git commit -m "init: personal memex"
git push
```

**That's the whole git-only setup.** Skip to Step 4 unless the user explicitly wants
claude.ai chat or mobile to share this memory (Step 3).

### Step 3. Optional — use the memory in claude.ai chat & Projects

- **Read it in chat/Projects (token-free, recommended):** have the user connect
  **Settings → Connectors → GitHub** (OAuth, no token, private repos OK). Then in a
  chat they attach `STATUS_SNAPSHOT.md` + the relevant hub via ＋ → Add from GitHub, or
  sync the repo into a Project for always-on context. Read-only — writing memory back
  stays in Claude Code.
- **Behavioral memory (no infra):** generate 3–4 short behavioral notes (name,
  pre-flight, trust) for the user to paste into claude.ai → Settings → Memory. Mirror
  them as plain text in `memory/MEMORY_EDITS.md` — **no token, ever.**
- **MCP worker (write-automation, advanced):** only if they want chat/mobile to
  *commit* memory or run scheduled jobs — a free Cloudflare Worker. Follow `SETUP_MCP.md`.

### Step 4. Wrap up

Show:
```
✓ Private repo: github.com/<user>/<repo>
✓ <N> hubs: <list>
✓ Works in Claude Code now — no tokens, no other services
```
Then three lines: "I now remember context across sessions — your domains, decisions,
deadlines. Say 'status' any time for a cross-domain check. When things change I
commit them. It all lives in your repo, restorable from a clone."

### Edge cases
- **Clone asks for a password / fails:** the user's git isn't authenticated. Have
  them run `gh auth login` (or add an SSH key), then retry. No token in any file.
- **Claude Code not installed:** `curl -fsSL https://claude.ai/install.sh | bash`
  (macOS/Linux/WSL), `brew install --cask claude-code` (macOS), or
  `winget install Anthropic.ClaudeCode` (Windows). Docs: https://code.claude.com/docs/en/setup.
- **Mobile-only user:** plan domains now; finish on a laptop with Claude Code.

### Security
- The git-only path stores **no secret anywhere** — local git auth handles pushes.
- Only the optional claude.ai / MCP paths involve a token, and it lives in claude.ai
  settings or a Cloudflare secret — never in the repo. Git history is permanent.
- The user's fork is private; never push personal data to the public `a-pap/memex`.
