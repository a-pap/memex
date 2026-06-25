# BOOTSTRAP.md — Full Memory Restoration

**Purpose:** if Claude's memory is wiped (platform reset, new account, new device),
this repo restores the full working context. A fresh Claude with access to the repo
can reconstruct everything that matters — because every fact lives in the files.

## Claude Code (git-only) — the default path

The repo IS the memory. There is nothing external to restore.

1. Clone the repo with your normal git auth and open it in Claude Code.
2. Read in order: `CLAUDE.md` → `STATUS_SNAPSHOT.md` → `RULES.md`.
3. Read the relevant `hubs/` file when a topic comes up.

Then confirm to the user: the STATUS_SNAPSHOT date and any overdue items. Done —
no tokens, no tools, no external services.

## Claude.ai chat & Projects (optional)

To read your restored memory in claude.ai, connect the repo via the GitHub connector
(Settings → Connectors → GitHub) — attach files in a chat, or sync it into a Project.
No token needed; writes still go through Code.

claude.ai also has a behavioral "memory" separate from the repo. To restore that:

1. Paste `memory/USER_PREFERENCES.md` into Settings → Profile → User Preferences.
2. Paste the items from `memory/MEMORY_EDITS.md` into claude.ai's memory, or tell
   Claude to remember them.

These steps do **not** apply to Claude Code, which reads the files directly.

## What CAN'T be auto-restored

- **Built-in platform memory** — auto-generated; rebuilds over 1–2 weeks.
- **Conversation history** — gone from the platform. Archive files may hold summaries.
- **Local device tool state** (Notes, Reminders) — local to each device.

## Style template

<!-- CUSTOMIZE: your preferred Claude communication style -->

Name: **Direct**

```
Tone: Direct, analytical, no filler. Conclusions first.
Format: Prose by default. No bullets unless asked.
Language: Respond in whichever language I write in.
Avoid: Buzzwords, jargon, motivational fluff, emoji.
```

## Who is the human (context for a fresh Claude)

<!-- CUSTOMIZE: a brief description of yourself for a fresh Claude instance -->

[Name]. [Role/background]. [Key interests]. [Communication style].
Based in [Location]. [Any major life context Claude should know].

**The relationship:** [how you use Claude — working partner, research assistant, etc.]
