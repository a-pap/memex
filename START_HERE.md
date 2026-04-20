# START_HERE — Zero to Memex in 15 minutes

**If you're Claude reading this:** the user just pointed you at this repo and asked for help setting up persistent memory. They probably have nothing configured yet. Follow the steps below top-to-bottom.

**If you're the user:** you don't need to read this. Paste this into [Claude Code](https://claude.ai/code) (recommended) or [claude.ai](https://claude.ai):

> Help me set up Memex from scratch. Read https://github.com/a-pap/memex/blob/main/START_HERE.md and walk me through it step-by-step. I'm starting with nothing.

Your Claude will take it from here.

---

## For Claude — execute top to bottom

### Step 0. Detect your surface (silent, don't tell the user)

- **Claude Code / CLI** → you can run `bash`, `git`, `gh`, `curl`, `npx`. Execute commands directly after each confirmation.
- **claude.ai Chat** → no shell. Emit commands as code blocks for the user to run in their own terminal. Wait for their confirmation + any output.
- **Mobile** → no shell, no local files. Do Lite mode only (Step 2); stop before Step 3.

### Step 1. One batched question

Ask in ONE message, wait for the reply:

> Three quick questions before we start:
>
> 1. **GitHub username?** (I'll need this for the fork URL.)
> 2. **Lite or Full?**
>    - **Lite** — just a private GitHub repo. Claude reads and commits your memory via git. ~10 min, no other services.
>    - **Full** — Lite + a Cloudflare Worker that gives Claude 22 direct tools (`wake_up`, `search`, `store_fact`, etc.). ~15 min, needs a free Cloudflare account (OAuth with GitHub, no card).
> 3. **Language?** I'll write hubs and memory edits in whatever you pick.

Store the answers. Branch: Step 2 always; Step 3 only if Full.

### Step 2. Common setup

#### 2a. Fork the repo

> 1. Open https://github.com/a-pap/memex
> 2. Click **Fork** (top-right)
> 3. **Private: ✅ yes** (your memory will contain personal data — never make it public)
> 4. Leave other defaults
> 5. **Create fork**
> 6. Paste the URL of your fork here — e.g. `https://github.com/you/memex`

Verify: `curl -fsI https://github.com/{user}/{repo}` returns 200. If 404, the repo is still private and un-authenticated — that's expected; skip this check and trust the user.

#### 2b. Create a GitHub PAT

> Now a token so Claude can read and write your repo:
>
> 1. Open https://github.com/settings/tokens?type=classic
> 2. **Generate new token (classic)**
> 3. Note: `memex-claude`. Expiration: `90 days` (set a reminder to rotate).
> 4. Scopes to tick:
>    - ☑ **`repo`** — required
>    - ☑ **`workflow`** — required if you picked Full (lets CI/CD deploy the worker)
> 5. **Generate token**, copy it (starts with `ghp_`), paste it in this chat.

Validate: `curl -fsH "Authorization: Bearer $TOKEN" https://api.github.com/user` → JSON with the user's login. If 401, ask them to regenerate with the right scopes.

Build the authenticated clone URL: `https://{TOKEN}@github.com/{user}/{repo}.git`. You'll need it twice (clone now, memory edit #2 later).

#### 2c. Clone and seed templates

Claude Code — run:

```bash
git clone https://<TOKEN>@github.com/<user>/<repo>.git ~/memex
cd ~/memex
cp -r templates/* .
cp -r templates/.* . 2>/dev/null || true
# Keep a reference copy of the blueprint but scrub it from tracked content
rm -rf templates examples SKILL_CATALOG.md FIRST_TIME_PROMPT.md
git add -A
git commit -m "init: personal memex from blueprint"
git push
```

Chat — emit the block as a single copy-paste for the user's terminal. Ask them to paste any error.

#### 2d. Personalize hubs

Ask:

> Which life domains should Claude remember? Pick any:
> - Work / career
> - Health (yours or pet/family)
> - Side project
> - Learning (language, new skill)
> - Relocation / big life change
> - Finance
> - Relationships / family
> - Other — describe in one line

For each picked domain, create `hubs/0N_{slug}.md` from the hub template. Number sequentially. Leave `Current Status` minimal — the system fills in over time.

Update `hubs/README.md` registry to match the created files.

#### 2e. Fill STATUS_SNAPSHOT.md

Ask once: "One-line status per domain? Or just 'placeholder' — I'll fill in over the first week."

Write `STATUS_SNAPSHOT.md` with the picked domains as sections. Include an empty `## Key decisions (SETTLED)` block — it'll fill up over time.

#### 2f. Memory edits (for claude.ai users)

Generate exactly 4 edits. Always include these (replace `{...}` with actual values):

```
1. User: {name}. Role: {role}. Language: {lang}.
2. Memory repo: https://{TOKEN}@github.com/{user}/{repo}.git — use this exact clone URL for git operations.
3. PRE-FLIGHT: before asserting status on {user}'s ongoing topics, git pull and read STATUS_SNAPSHOT.md + the relevant hub. Never state status from memory alone.
4. TRUST: the user acts on your words without verifying. When unsure → "let me check" and pull the repo. Never fill gaps with guesses.
```

Tell the user:

> Open https://claude.ai → **Settings → Profile → Memory** (or "Memory edits") and paste these four in order. That's what gives me behavior continuity across conversations.

Write the same 4 to `memory/MEMORY_EDITS.md` and commit.

#### 2g. Commit and push

```bash
cd ~/memex
git add -A
git commit -m "personalize: hubs, status, memory edits"
git push
```

**If the user picked Lite — skip to Step 4.**

### Step 3. Full mode — deploy the MCP worker

#### 3a. Cloudflare account

> Sign up at https://dash.cloudflare.com/sign-up — use **Sign up with GitHub** (OAuth, ~30 seconds, no credit card). Reply "done" when logged in.

Wait for "done". If the user signed up with email instead, that's fine — Cloudflare works either way.

#### 3b. Wrangler + D1

Claude Code — run:

```bash
cd ~/memex/config/mcp-worker
npm install
npx wrangler login      # opens browser, OAuth with Cloudflare — user clicks Allow
npx wrangler d1 create claude-memory-db
```

Capture the `database_id` from the `d1 create` output. It looks like a UUID: `8b2379bf-7664-477e-9d0f-ccd7f93db744`.

Edit `config/mcp-worker/wrangler.toml`:

- Replace the `database_id` placeholder with the UUID from above.
- Set `[vars] GITHUB_REPO = "{user}/{repo}"`.

Store the GitHub PAT as a secret:

```bash
npx wrangler secret put GITHUB_PAT
# paste the PAT (same one as 2b) when prompted
```

Initialize D1 tables:

```bash
chmod +x setup-d1.sh
./setup-d1.sh
```

Deploy:

```bash
npx wrangler deploy
```

Capture the worker URL from the output, e.g. `https://claude-memory-mcp.{user}.workers.dev`.

Quick health check:

```bash
curl -fsS https://claude-memory-mcp.{user}.workers.dev/health
# expect: {"status":"ok","tools":22,...}
```

#### 3c. Add the MCP connector to Claude.ai

> 1. Open https://claude.ai
> 2. **Settings → Connectors** (sometimes labeled "Integrations" or "MCP servers")
> 3. Click **Add custom connector** (or similar)
> 4. URL: paste the worker URL with `/mcp` appended — `https://claude-memory-mcp.{user}.workers.dev/mcp`
> 5. No auth needed (open endpoint; HTTPS-only, your repo still private)
> 6. Save

#### 3d. CI/CD (optional, recommended)

Lets pushes to `main` auto-deploy the worker. Add two GitHub secrets to the user's fork:

> Open https://github.com/{user}/{repo}/settings/secrets/actions → **New repository secret**:
>
> 1. `CLOUDFLARE_API_TOKEN` — create at https://dash.cloudflare.com/profile/api-tokens → **Create Token** → template "Edit Cloudflare Workers" → Create → copy.
> 2. `CLOUDFLARE_ACCOUNT_ID` — in the Cloudflare dashboard, right sidebar on any page. 32-char hex.
>
> Also add `GITHUB_PAT` as a secret (same value as 2b) so the worker build can read the repo during CI.

Push a no-op commit to trigger the workflow:

```bash
cd ~/memex
git commit --allow-empty -m "ci: trigger first deploy"
git push
```

Confirm green on https://github.com/{user}/{repo}/actions.

#### 3e. Verify the connector works

Open a fresh claude.ai conversation and say:

> Use the `wake_up` tool to load my memory.

Expected response: STATUS_SNAPSHOT content, 4 memory edits listed, hub files enumerated, ~22 tools available.

If the tool isn't visible: re-check the connector URL ends in `/mcp`, and that the health endpoint returns 200.

### Step 4. Wrap up

Show the user:

```
✓ Private repo: https://github.com/{user}/{repo}
✓ {N} hubs: {list}
✓ 4 memory edits (paste into claude.ai → Settings → Memory)
✓ MCP worker: {url} (Full mode)
✓ CI/CD: active (Full mode, if set up)
```

Then briefly (3-4 lines) explain what they get:

> **What this gives you.** From now on I remember context across conversations — your domains, decisions, deadlines. Next chat, just say "status" for a cross-domain check. When important things change, I commit them automatically. Works the same in Chat, Code, and on mobile — all read the same repo. Once a week I audit quietly and flag anything stale.

### Edge cases

- **Clone returns 403/404.** PAT is missing `repo` scope or the URL has a typo. Regenerate.
- **`wrangler login` stuck.** User closed the browser. Retry; it opens a new device-auth page.
- **`d1 create` says "already exists".** Rename to `claude-memory-db-v2` or pick the existing one and note its id.
- **Claude.ai connector dialog has no "Add MCP" button.** User's Claude plan doesn't support custom MCP connectors yet. Fall back to Lite — the repo alone still works via git.
- **`setup-d1.sh` fails midway.** It's idempotent (CREATE TABLE IF NOT EXISTS). Just re-run.
- **Friend refuses Cloudflare entirely.** Stay Lite-only (stop after Step 2). A no-Cloudflare Full mode (Node/Docker adapter) is planned — not shipped.
- **Mobile-only user.** Lite only. Full requires a desktop with `wrangler` CLI. Tell them to finish Step 3 when they get to a laptop.
- **User is on free claude.ai tier.** Claude Code requires Pro/Max/Team/Enterprise or a Console API key. If the user is on free tier and wants Full mode, they either upgrade to Pro or run Step 3's `wrangler` commands manually in a terminal you can't see — paste command blocks they copy. Lite mode works fine on free tier since Chat can still pull via artifact-generated clone commands.
- **Claude Code not installed.** Install: `curl -fsSL https://claude.ai/install.sh | bash` (macOS/Linux/WSL), `brew install --cask claude-code` (macOS), or `winget install Anthropic.ClaudeCode` (Windows). Then `claude` in any terminal. Full install docs: https://code.claude.com/docs/en/setup.
- **Multiple Claudes (Code + Chat + iPad).** They all share the same repo + MCP worker. No per-surface setup needed beyond pasting the 4 memory edits once on claude.ai.

### Security notes

- The GitHub PAT lives in **memory edits** (claude.ai) and as a **Wrangler secret** (Cloudflare). That's by design — Claude needs authenticated git access and the worker needs to read/write the repo. Don't warn about this on every session.
- Scope is minimal: `repo` + `workflow`. Nothing else.
- If the user ever wants to rotate: regenerate PAT on GitHub, update memory edit #2, run `npx wrangler secret put GITHUB_PAT` with the new value, and update the GitHub secret if CI/CD is set up.
- `memex` (this public blueprint) contains no personal data. The user's private fork is where memory lives. Never push personal data back upstream — if they want to contribute a fix to `a-pap/memex`, open a clean PR from a fork with ONLY the generic change.

### When you (Claude) are done

- Commit `memory/MEMORY_EDITS.md`, `hubs/*.md`, `STATUS_SNAPSHOT.md`, `wrangler.toml` (Full) with a single message: `init: personal memex — {N} hubs, MCP worker live` (or without the worker clause for Lite).
- Confirm the user saw the wrap-up.
- Don't offer to do more. The system is designed to improve itself from the next conversation onward.
