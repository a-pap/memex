# Memory Edits — Cross-Surface Reference
<!--
Purpose: Mirror of live claude.ai memory edits for cross-surface drift detection.
Update procedure: After modifying live edits, update this file in same commit.
Last verified: 2026-04-08 — 12 edits, matches live system.
-->

## Live edits (12 total)

1. User's role: Product Manager at TechCorp (Ad Platform team). Use "PM" in casual conversation.
2. Max's health: Cystinuria III, diet transition mid-April. Epilepsy: 2 seizures (Dec'25, Mar'26). Brain MRI needed Jun-Aug.
3. Shared memory repo: `git clone https://ghp_EXAMPLE_TOKEN@github.com/username/claude-memory.git`
4. Berlin relocation: early June 2026. Kreuzberg/Friedrichshain. Budget €1,500/mo.
5. Learning German: B1 target Aug 2026. Teacher mode when writing in German.
6. Claude Projects: 4 + root. (1) TechCorp (2) Max health (3) SideProject (4) Blog.
7. PRE-FLIGHT CHECK: Before status claims → MCP wake_up, or git pull, or conversation_search.
8. TRUST MODEL: User acts on statements without verifying. When uncertain → "let me check."
9. Meeting transcripts: Granola only.
10. MISINFERENCE CHECK (Edmans): Apply Ladder before relaying claims.
11. MCP INFRASTRUCTURE: v2.1, 19 tools, D1. URL: memex-mcp.my-domain.workers.dev/mcp. Auth: Bearer token.
12. SESSION END PROTOCOL: Offer "update memory?" when significant new facts discussed.

## Pattern guide

The edits above follow a deliberate structure:

- **Edits 1-6: Factual shortcuts** — key facts Claude needs immediately, without loading hubs. These are _pointers_, not sources of truth. The hubs hold the full picture.
- **Edit 3: Repo access** — the PAT-embedded clone URL. This is the ONE credential stored in memory edits (necessary for private repo access).
- **Edits 7-8: Safety rules** — prevent Claude's most dangerous failure modes (asserting stale info, guessing instead of checking).
- **Edits 9-10: Behavioral calibration** — how Claude should process information.
- **Edit 11: Infrastructure** — MCP connection details for Chat/Mobile surfaces.
- **Edit 12: Session hygiene** — ensure important facts get persisted.

## Why mirror edits in the repo?

Memory edits live in Claude's system — they're not in the git repo by default. This file mirrors them for:

1. **Cross-surface drift detection** — if Chat adds an edit, Code can detect the mismatch
2. **Disaster recovery** — if all edits are wiped, BOOTSTRAP.md restores them from this file
3. **Audit trail** — git log shows when edits changed and why
