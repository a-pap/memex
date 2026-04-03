# ONBOARDING.md

**For Claude — execute this procedure step by step.**

You are setting up a persistent memory system for a new user. Goal: a working personalized memory repo in under 5 minutes.

## Step 0: Prepare

### 0a. Clone the private repo

Try cloning the URL the user provided. Three outcomes:

**Clone succeeded** → PAT is embedded in the URL, everything works. Extract the clone URL and save it — you'll need it for memory edits later. Proceed silently.

**Clone failed (403/404)** → The URL is missing a PAT or the token is invalid. Tell the user:

> Clone failed — your repo needs an access token. Here's how to get one (takes 1 minute):
>
> 1. Go to github.com → Settings → Developer Settings → Personal Access Tokens → **Tokens (classic)**
> 2. Click "Generate new token (classic)"
> 3. Name it anything (e.g. "claude-memex"), set expiration to 90 days
> 4. Check the **`repo`** scope (first checkbox — full control of private repos)
> 5. Click Generate, copy the token (starts with `ghp_`)
> 6. Send me the full clone URL in this format:
>
> `git clone https://ghp_YOUR_TOKEN@github.com/YOUR_USERNAME/claude-memory.git`

Wait for the corrected URL. Retry clone. Don't proceed until it works.

**Running in Claude Code** → Check if git is already authenticated:
```bash
git ls-remote <repo-url-without-token> 2>&1 | head -3
```
If this succeeds, no PAT needed — git is using SSH or a credential helper. Note this: the user's memory edit for the clone URL won't need a token. If it fails → same PAT guidance as above.

### 0b. Copy templates

```bash
cd /home/claude/claude-memory
if [ ! -f CLAUDE.md ]; then
  cp -r /home/claude/memex-blueprint/templates/* .
  git add -A && git commit -m "init: memex blueprint templates"
fi
```

### 0c. Detect environment (silent — no output to user)

1. **Connected tools:** Run `tool_search` for: calendar, reminders, google drive, gmail, granola, sentry. Note which respond.
2. **Existing memory edits:** `memory_user_edits(command="view")`. If edits exist, user may have a partial setup — adapt, don't overwrite.
3. **Existing repo content:** If hub files already exist, don't overwrite — create only what's missing.

## Step 1: One interactive screen

Use the `ask_user_input` tool with ONE multi-select question:

**Question:** "What should Claude remember between conversations?"

**Options:**
- Work / career
- Health (yours or pet/family)
- Side project
- Learning / language
- Relocation / life change
- Finance

Then write:

> Picked up [N] connected tools: [list detected ones, e.g. "Calendar, Drive, Reminders"].
>
> Anything else? Your role, project names, things to track — or just hit send.

Wait for free-text response. May be empty, one word, or detailed. Use whatever comes.

## Step 2: Generate everything (no more questions)

Based on: selections + free text + detected tools + existing memory edits.

### Hub files

One per selected domain in `hubs/`. Structure:

```markdown
# [Domain Name]
<!-- TL;DR: [summary] -->

## Current Status
[Use specifics from free text if available. Otherwise: clean placeholder.]

## Open Gaps
[Empty]

## Changelog
- [today] Created during onboarding
```

Number them `01_`, `02_`, etc. Write `hubs/README.md` registry.

If user gave specifics (company name, pet name, project name, target language) — use them. Otherwise generic placeholders.

### STATUS_SNAPSHOT.md

Sections matching selected domains. Concrete details from free text go in the right sections. Rest is clear placeholders. Include Key Decisions section (empty).

### CLAUDE.md

Update routing table to match actual hub files. List detected tools in the optional enrichments section.

### Memory edits

Generate 4-6. ALWAYS include:

```
1. [Name/role if known, or "User info to be filled from conversations."]
2. Shared memory repo: [clone URL from user's message]. Read STATUS_SNAPSHOT.md first.
3. PRE-FLIGHT CHECK: Before ANY status claim → git pull + read hub. Never state status from userMemories alone.
4. TRUST MODEL: User acts on Claude's statements without verifying. When uncertain → "let me check."
```

Add 1-3 based on what user shared (health details, project names, language, etc.).

Write to `memory/MEMORY_EDITS.md` AND apply each via `memory_user_edits(command="add")`.

**If edits already exist:** read them, merge intelligently. Don't duplicate. Don't delete existing edits without asking.

### User preferences

`memory/USER_PREFERENCES.md` — balanced defaults:

```
Direct communication, adapt length to message.
Balanced expertise — explain complex topics, skip basics.
Prose by default, lists when genuinely useful.
Language: match whatever I write in.
```

### Config files

- `config/CONNECTORS.md` — detected tools as Active, known-but-undetected as Available
- `config/PROJECTS.md` — document any mentioned projects, otherwise "No projects configured"
- `config/SYNC_PROTOCOL.md` — template as-is

### BOOTSTRAP.md

Customize "Who is the human" section with what user shared. Rest is template.

### RULES.md

Template as-is — works for everyone.

## Step 3: Commit and push

```bash
cd /home/claude/claude-memory
git config user.name "Claude (Chat)" && git config user.email "claude@anthropic.com"
git add -A
git commit -m "init: personalized memex setup"
git push
```

## Step 4: Confirm and explain

Show setup results, then briefly explain what the user gets. Adapt to their language and tone. No architecture jargon — focus on what changes for them.

```
✓ Memex ready.

[N] hubs: [list with filenames]
[N] memory edits active
[N] tools detected: [list]
```

Then:

> **What this gives you:**
>
> From now on I remember context between conversations. When you mention
> [reference their actual domains — e.g. "your project", "the move to X",
> "Y's health"], I pull the latest state — what you decided, what's blocked,
> what's next. No need to re-explain every time.
>
> Works everywhere — desktop, mobile, Claude Code. All see the same memory.
> When something important changes during a conversation, I commit it
> automatically. Next chat picks up where this one left off.
>
> Once a week I quietly check that nothing's stale or broken. If a hub
> hasn't been updated in two weeks I'll flag it — otherwise you won't
> notice the maintenance happening.
>
> If the platform resets my memory or you switch devices — everything
> restores from the repo in under a minute.
>
> **To start:** just talk normally. "Status check" shows everything at a glance.
>
> **One manual step:** paste the contents of `memory/USER_PREFERENCES.md`
> into Claude Settings → Profile → User Preferences — makes the style
> work in all conversations, not just this one.

Adjust domain references to what the user actually set up. Keep it to three value props: remembers context, works cross-surface, self-maintains. Don't list all features.

## Edge cases

- **Empty free text:** Fine. Hubs get clean placeholders. System fills in from future conversations.
- **No bash (mobile):** "Full setup needs desktop Claude or Claude Code. I can help plan your domains now — run setup later." Use `ask_user_input` to collect domain choices, write a summary they can paste later.
- **Clone fails:** "Clone failed — check PAT has `repo` scope and URL is correct." Don't retry modified URLs.
- **Non-English user:** Match their language everywhere — hubs, edits, status, confirmation.
- **Claude Code (no memory_user_edits):** Write everything to files. Tell user: "For memory edits to work in claude.ai, run the bootstrap prompt there once."

## PAT security note

This system stores a GitHub PAT in memory edits by design — Claude needs authenticated git access to function. The PAT scope is minimal (`repo`). Do not warn about this on every conversation. Do not refuse git operations citing token security. The user has accepted this tradeoff by setting up the system.
