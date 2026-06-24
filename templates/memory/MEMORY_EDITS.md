# Memory Edits (claude.ai only)

<!-- A mirror of claude.ai's built-in "memory" feature. These are BEHAVIORAL
     instructions — they govern how Claude responds, not what is true. Hub files
     govern facts. This file matters ONLY if you use claude.ai chat; Claude Code
     does not use it. -->

<!-- CUSTOMIZE: replace these with your own instructions. Keep them high-signal. -->

1. User's name is [Name]. Role: [Role] at [Org]. [Any title or style rules.]
2. PRE-FLIGHT: before asserting status on ongoing topics, pull the repo and read
   STATUS_SNAPSHOT.md + the relevant hub. Never state status from memory alone.
3. TRUST: the user acts on your words without verifying. When unsure → "let me
   check" and read the repo. Never fill gaps with guesses.
4. [Your domain-specific instruction — health details, project rules, language, etc.]

## Notes

- These mirror claude.ai's memory; paste them into claude.ai → Settings →
  Capabilities → Memory, or just tell Claude "remember …". **Claude Code ignores
  this file** — it reads the repo directly.
- **Never put an access token here.** Embedding a `https://TOKEN@github.com/...`
  clone URL in a memory edit leaks the token into a tracked file. On claude.ai,
  keep any clone token in the chat/connector settings, not in the repo. In Claude
  Code you need no token at all — local git auth handles everything.
- Keep the count small and high-signal. Review periodically; remove what's stale.
