# Setup Guide

Total time: ~30 minutes. You'll create a private repo, customize templates, and give Claude access.

## Step 1: Create Your Private Repo (5 min)

1. Create a new **private** repo on GitHub (e.g., `your-username/claude-memory`)
2. Generate a Personal Access Token:
   - GitHub → Settings → Developer Settings → Personal Access Tokens → Tokens (classic)
   - Scope: `repo` (full control of private repositories)
   - Expiration: set a reminder to rotate it
3. Note your clone URL: `https://<YOUR_TOKEN>@github.com/<your-username>/claude-memory.git`

## Step 2: Copy Template Files (10 min)

Copy the contents of `templates/` into your new repo. The structure:

```
├── STATUS_SNAPSHOT.md      ← Your cross-domain status (edit this regularly)
├── CLAUDE.md               ← Routing table (customize hub names/topics)
├── BOOTSTRAP.md            ← Disaster recovery (customize with your info)
├── RULES.md                ← Behavioral patterns (start with defaults, add yours)
├── hubs/
│   ├── README.md           ← Hub registry
│   └── 01_example_hub.md   ← Template — create one per life domain
├── skills/
│   └── git-memory/
│       └── SKILL.md        ← Core skill (customize clone URL only)
├── config/
│   ├── PROJECTS.md         ← Your Claude Projects setup
│   ├── CONNECTORS.md       ← Your MCP connectors
│   └── SYNC_PROTOCOL.md    ← Sync mechanics (works as-is)
├── memory/
│   ├── MEMORY_EDITS.md     ← Your memory edits (behavioral instructions)
│   ├── USER_MEMORIES.md    ← Snapshot of auto-generated memories
│   └── USER_PREFERENCES.md ← Your preferences for Claude
├── references/             ← Deep research artifacts (optional)
└── archive/                ← Chat history backups (auto-populated)
```

## Step 3: Create Your Hub Files (10 min)

Think about the domains of your life that Claude should remember. Common examples:

| Domain | Hub file |
|--------|----------|
| Work / career | `hubs/01_work.md` |
| Health | `hubs/02_health.md` |
| Side project | `hubs/03_side_project.md` |
| Relocation / major life event | `hubs/04_relocation.md` |
| Learning (language, skill) | `hubs/05_learning.md` |
| Personal profile | `hubs/06_personal.md` |

For each hub, follow the template structure:

```markdown
# [Hub Name]
<!-- TL;DR: one-line summary for quick scan -->

## Current Status
[3-8 lines: what's happening NOW. This is what Claude reads first.]

## Open Gaps
[Structured unknowns: Status / Question / Tried / Closes when]

## [Detail Sections]
[As needed for your domain]

## Changelog
[Bottom of file, append-only]
```

Start small — 2-3 hubs is plenty. You can always add more.

## Step 4: Write Your Memory Edits (5 min)

Memory edits are behavioral instructions that Claude follows across all conversations. They persist via Claude's `memory_user_edits` tool and are mirrored in `memory/MEMORY_EDITS.md`.

Open `memory/MEMORY_EDITS.md` and write 5-10 instructions. Examples:

```
1. User's name is [Name]. Role: [Role] at [Company].
2. Shared memory repo: github.com/[user]/claude-memory (private). Clone: git clone https://[TOKEN]@github.com/[user]/claude-memory.git — use EXACT command.
3. PRE-FLIGHT CHECK: Before ANY status claim → (1) bash available? git pull, read hub; (2) no bash? conversation_search. Never state status from userMemories alone.
4. TRUST MODEL: User acts on Claude's statements without verifying. Confident wrong answer = real cost. When uncertain → "let me check." Never fill gaps with guesses.
5. [Your domain-specific instruction]
```

**Critical:** Memory edit #2 must contain the full clone URL with token. This is how Claude accesses your repo.

## Step 5: Set Up User Preferences (3 min)

Go to Claude Settings → Profile → User Preferences. Paste your preferences — they govern Claude's communication style across all conversations. See `memory/USER_PREFERENCES.md` template for a starting point.

## Step 6: Bootstrap Claude (2 min)

Start a new conversation in claude.ai and send:

```
Clone this repo and read BOOTSTRAP.md:
git clone https://<YOUR_TOKEN>@github.com/<your-username>/claude-memory.git
```

Claude will:
1. Clone the repo
2. Read BOOTSTRAP.md
3. Restore memory edits via `memory_user_edits` tool
4. Read CLAUDE.md and STATUS_SNAPSHOT.md
5. Confirm everything is loaded

## Step 7: Verify

Ask Claude:
- "What do you know about me?" — should reference hub content
- "Status check" — should read STATUS_SNAPSHOT
- "What are my memory edits?" — should list them

## Ongoing Maintenance

The system is largely self-maintaining. Claude updates the repo during conversations when significant things change. You should:

- **Weekly:** Glance at STATUS_SNAPSHOT.md — is it current?
- **Monthly:** Review hub files — anything outdated?
- **On token expiry:** Rotate PAT and update memory edit #2
- **On new domain:** Create a new hub file, add to CLAUDE.md routing table

## Claude Projects (Optional)

If you use Claude Projects for different work contexts:
1. Create projects in claude.ai
2. Document them in `config/PROJECTS.md`
3. Each project can have its own knowledge files and instructions
4. Root context handles everything not in a project

## MCP Connectors (Optional)

If you have MCP connectors (Google Drive, Granola, Calendar, etc.):
1. Document them in `config/CONNECTORS.md`
2. Claude will use them as enrichment when available
3. The system works fully without them — repo is sufficient
