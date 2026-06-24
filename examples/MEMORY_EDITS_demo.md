# Memory Edits — example (claude.ai only)

<!--
A demo of what claude.ai's behavioral "memory" looks like for a mature install.
These mirror claude.ai's memory feature; they are NOT used by Claude Code, which
reads the repo directly. No access token ever belongs here.
Last verified: 2026-04-08.
-->

## Example edits

1. User's role: Product Manager at TechCorp (Ad Platform team). Use "PM" in casual conversation.
2. Max's health: CKD Stage 2, diet transition mid-April. Epilepsy: 2 seizures (Dec'25, Mar'26). Brain MRI Jun–Aug.
3. Memory repo: github.com/username/your-memory (private). Pull and read STATUS_SNAPSHOT.md first for routing. (No token here — see note below.)
4. Berlin relocation: early June 2026. Kreuzberg/Friedrichshain. Budget €1,500/mo.
5. Learning German: B1 target Aug 2026. Teacher mode when writing in German.
6. PRE-FLIGHT: before status claims → pull the repo and read the relevant hub. Never assert from memory alone.
7. TRUST: the user acts on statements without verifying. When uncertain → "let me check."
8. Meeting transcripts: keep conclusions in hubs, not raw transcripts (those live in the source tool).
9. SESSION END: offer "update memory?" when significant new facts come up.

## Notes

- These are behavioral pointers, not facts — the hubs hold the full, authoritative picture.
- **No credential lives here.** Claude Code uses your local git auth; claude.ai chat
  keeps any clone token in its own settings, never in a tracked file. The old
  "embed a `TOKEN@github.com` clone URL in edit #3" pattern is gone — it leaked the
  token into the repo.
- Mirroring edits in the repo lets a second surface detect drift and lets
  BOOTSTRAP restore them after a wipe.
