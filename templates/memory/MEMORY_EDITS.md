# Memory Edits
<!-- Synced from Claude Chat memory_user_edits tool -->
<!-- These are BEHAVIORAL instructions — they govern how Claude responds. -->
<!-- Hub files govern REALITY (actual facts). Don't confuse the two. -->

<!-- CUSTOMIZE: Replace these with your own instructions. 5-14 items recommended. -->
<!-- Each item: max ~500 chars. Keep them high-signal. -->

1. User's name is [Name]. Role: [Role] at [Company/Org]. [Any title simplification rules.]
2. Shared memory repo: github.com/[user]/claude-memory (private). Clone: git clone https://[TOKEN]@github.com/[user]/claude-memory.git — use EXACT command, do not omit the token. Read STATUS_SNAPSHOT.md first for routing.
3. PRE-FLIGHT CHECK: Before ANY status claim about ongoing topics → (1) bash available? git pull repo, read relevant hub; (2) no bash? conversation_search. Never state current status from userMemories alone.
4. TRUST MODEL: User acts on Claude's statements without verifying. Confident wrong answer = real cost. When uncertain → say "let me check." Never fill gaps with plausible guesses.
5. [Your domain-specific instruction — e.g., health details, project rules, etc.]
6. [Another instruction — e.g., language preferences, meeting handling, etc.]

## Notes

- Memory edits persist across all conversations via Claude's memory_user_edits tool
- Keep count manageable (5-14 items). More ≠ better.
- Review monthly: remove outdated items, consolidate related ones
- After any change: sync this file with live memory_user_edits via the tool
