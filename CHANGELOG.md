# Changelog

All notable changes to the Memex blueprint.

## 2026-06-28 — v2.8: the lint primitive (compile, don't re-retrieve)

### Added

- **`ARCHITECTURE.md` pattern 7 — "Compile once; lint the links that bind it."**
  Documents the third operational primitive of a self-maintaining knowledge base
  (ingest / query / **lint**): synthesize each source once and merge-reconcile it
  into the store rather than re-deriving on every query, then run a periodic link
  lint so textual cross-references (`page NN`, `§N`, file paths) can't dangle
  silently after a rename or move. Convergent with the widely-shared
  compile-don't-retrieve knowledge-base pattern; the reference implementation
  adds a `memory-lint` cross-reference checker wired into its repo-health
  aggregator as a non-blocking warning.

## 2026-06-25 — v2.7: pre-distribution hardening (security, honesty, dogfooding, tests)

A full audit before sharing the project publicly — four parallel reviews (security,
fresh-install correctness, competitive value, dogfooding), then fixes.

### Fixed (security)

- **MCP worker auth.** The bare `/mcp` path served every tool (including writes) with
  no authentication, while the docs promised "Bearer header" auth. The worker now
  **requires the secret token in the URL path** (`/mcp/<token>`) and rejects bare
  `/mcp` with 401. Docs (`SECURITY.md`, `SETUP_MCP.md`, `config/mcp-worker/README.md`,
  `setup-d1.sh`) corrected to the honest token-in-path model.
- PAT-scope guidance aligned to fine-grained **Contents: read/write** (was classic "repo" scope).
- Git history re-verified clean of secrets; no personal-data leak. (The worker is
  opt-in; the default git-only path was already clean.)

### Changed (honesty / accuracy)

- `GIT_AS_RAG.md` §8 now cites the closest neighbors to its thesis — DiffMem and the
  Git Context Controller (arXiv:2508.00031) — and sharpens the novelty claim to the
  *curated routing + cost-graduated loading, personal multi-surface* convention.
- README no longer calls Claude's built-in memory "opaque and lags by days" (it has
  improved); it keeps the real differentiators (own / edit / roll back / portable).
- `ARCHITECTURE.md` token economics reframed as a *floor*, not a fixed measurement (a
  mature install starts ~10K, not ~2.5K); softened the "dump-everything" strawman.

### Fixed (out-of-box correctness)

- Install now seeds `memory/` so `BOOTSTRAP.md`'s references resolve.
- Removed a broken `docs/LITE_VS_FULL.md` link and a dead `setup-d1.sql` command.
- `SKILL_CATALOG.md` documents both skill locations (project `.claude/skills/` and
  global `~/.claude/skills/`).

### Added (verification)

- `tests/test-install-sim.sh` — a fresh-fork install simulation (seeds templates,
  checks structure, asserts zero tokens / sandbox paths, link integrity) wired into CI
  as a gate, so every change is verified before it ships.

## 2026-06-24 — v2.6: read your memory in Claude chat & Projects (token-free)

Documented the native **GitHub connector** path so the memory repo works in claude.ai
chat and Projects, not just Claude Code — with no MCP worker and no token. Connect the
repo under Settings → Connectors → GitHub (OAuth), then attach `STATUS_SNAPSHOT.md` +
the relevant hub in a chat, or sync the repo into a Project. This path is **read-only**
(verified against Anthropic's docs); writes (commits/branches/PRs) still go through
Claude Code or the optional worker. Net model: **read anywhere, write in Code.**

### Changed
- README, QUICKSTART, START_HERE, ARCHITECTURE, `templates/CLAUDE.md`, BOOTSTRAP —
  added the chat/Projects read path; corrected the cross-surface example (read in chat
  / write in Code) and the architecture-diagram edges; updated the file tree to
  `.claude/skills/`.
- `SETUP_MCP.md` — repositioned the worker as **write-automation only** (reads are now
  native via the connector), with a "do you need this?" callout up top.

## 2026-06-24 — v2.5: git-only out-of-the-box for Claude Code

Audited and fixed the entire setup, template, and skill layer so a fork works in
Claude Code with **zero dependencies beyond a free GitHub account** — no Cloudflare,
no MCP worker, no access token in any file, no paid tier. The optional MCP worker is
now cleanly separated as an advanced, later step.

### Fixed (security)

- **Removed the "put your PAT in a committed file" pattern** everywhere it appeared
  (QUICKSTART, SETUP, START_HERE, ONBOARDING, FIRST_TIME_PROMPT, `templates/CLAUDE.md`,
  `templates/memory/MEMORY_EDITS.md`, `templates/RULES.md`, examples). For Claude Code,
  local git auth handles pushes — no token belongs in the repo, and git history is
  permanent. Any token is now confined to the optional claude.ai path, where it lives
  in claude.ai settings, never in a tracked file.
- Genericized a personal-data reference in the maintainer guide.

### Fixed (out-of-the-box correctness)

- **Skills now install where Claude Code finds them** — `.claude/skills/`, not a bare
  `skills/` directory (which is never auto-discovered). Updated every setup doc and
  `SKILL_CATALOG.md`.
- **Removed claude.ai sandbox paths** (`/home/claude/...`) from the Claude Code path in
  templates, skills, and configs — the repo is the working directory.
- **Fenced claude.ai-only tools** (`conversation_search`, `memory_user_edits`,
  `recent_chats`, `event_search_v0`, `reminder_search_v0`) behind clear "(claude.ai
  only)" labels with git-native alternatives, so a Claude Code session never reaches
  for a tool it doesn't have.
- **Fixed the routing table → missing hubs problem** — the table is now a clearly
  marked CUSTOMIZE placeholder that references the one hub the blueprint ships.
- **BOOTSTRAP restores git-only** — read `CLAUDE.md` → `STATUS_SNAPSHOT.md` → `RULES.md`,
  with the chat-only memory-edit replay fenced as optional.
- Corrected the Claude Code link and the optional worker's tool count (26).

### Verified

Replicated the CI gates and ran a fresh simulated install (copy templates → skills to
`.claude/skills/` → inspect): root files present, skills auto-discoverable, no token or
sandbox path anywhere, links resolve, no personal identifiers.

## 2026-06-24 — v2.4: the memory architecture, distilled

The first big content update since the public release. Repositions Memex around the
*memory device itself* — curated retrieval over a git repo — and sets the optional
MCP worker aside as an advanced, later step. Adds a flagship essay making the design
argument, fact-checked against primary sources and pressure-tested through several
expert review lenses (retrieval/IR, agent-memory, security, and editorial).

### Added

- **`GIT_AS_RAG.md`** — flagship essay: *"Git as RAG — Curated Retrieval as Long-Term
  Memory for AI Agents."* The case for a curated git repo over a vector database for
  personal/agent memory — routing table + graduated loading + write-side discipline —
  with honest trade-offs and prior-art positioning (MemGPT/Letta, Generative Agents,
  Zep/Graphiti, A-MEM, mem0, LangMem, Basic Memory). Every external claim is cited to
  a primary source.

### Changed

- **README** — repositioned around the git-only memory architecture as the default
  path. The optional Cloudflare/MCP worker is now a clearly-marked "advanced, later"
  section instead of the lead. Removed a duplicated "What it looks like" block,
  reframed the comparison table around curated-vs-vector retrieval, and added a
  "what not to store" pointer before first use.

### Fixed

- **Removed an unverified claim** that Claude's memory edits are "limited to 14 items,
  ~500 chars each" — no such limit appears in any Anthropic documentation (the official
  support page states no numeric limits). Replaced with the documented behavior.
- **Corrected the "context rot" citation** in `ARCHITECTURE.md` from an unrelated
  Anthropic prompt-caching page to the actual sources (Chroma, *Context Rot*, 2025;
  Liu et al., *Lost in the Middle*, 2023).
- **Reconciled the MCP tool count** — the README no longer disagrees with itself
  (26 vs. 22) about the worker's tool surface.

## 2026-04-10 — v2.3: quality loop + annotations + hooks + security scrub

Four new MCP tools, annotation metadata on every tool, a Claude Code SessionEnd
hook, and a hard security reset — see `SECURITY.md` for the incident record.

### Added

- **Worker v2.3.0 (`config/mcp-worker/src/index.ts`, 26 tools total, +4 since v2.2)**
  - `auto_log` — low-friction one-line session logger (surface auto-detect)
  - `health_check` — structured system health report (errors / sessions / KG / freshness)
  - `todo_add` — programmatic TODO.md append for automated quality loops
  - `memex_diff` — compare this worker's key files against a public fork
  - `diary_write` / `diary_read` — per-domain chronological diary logs (GitHub-backed)
  - `get_tunnels` — find entities that appear in multiple hubs
- **MCP `ToolAnnotations` on every tool** — `title`, `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint` per MCP SDK spec. Split: 17 read-only, 8 write,
  1 stateless signal.
- **Claude Code SessionEnd hook** — `config/hooks/auto-log-session.sh` + example
  install config (`config/hooks/claude-code-hooks-example.json`). Auto-logs every
  Claude Code session close via the `auto_log` tool. Best-effort, never blocks exit.
- **Worker `config/mcp-worker/README.md`** — full tool catalogue, deploy steps,
  D1 schema, Claude.ai connector wiring, version history.
- **Lint hardening** — `.github/workflows/lint-templates.yml` now scans
  `config/`, `.github/`, and top-level scripts (not just `templates/` / `examples/`),
  with explicit token prefix patterns (`cfut_`, `ghp_`, `grn_`, hex bearers).

### Changed

- **Worker `name/version`** → 2.3.0 (was 2.2.0)
- **User-Agent** → `claude-memory-mcp/2.3` (was 2.2)
- **`setup-d1.sh`** — rewritten to require three env vars (`CLOUDFLARE_API_TOKEN`,
  `MCP_AUTH_TOKEN`, `GITHUB_PAT`), seed KG with a generic example only, and
  auto-detect the worker URL for verification. **No secrets in source.**
- **Worker `HUB_MAP`** — documented as the single customization point; sample
  domains renamed to generic `work / projects / health / finance / learning / blog`.
- **Contradiction check index** — `idx_facts_key` is now `UNIQUE` to enable
  `ON CONFLICT DO UPDATE` upsert semantics used by `store_fact`.

### Security

- **Removed** committed `cfut_*` Cloudflare API token, `1be0cca6...` legacy MCP
  Bearer, and a knowledge-graph SQL seed containing real personal data. All
  past occurrences were stripped from git history via `git filter-repo` and the
  branch was force-pushed. **Token rotation is a separate step performed by the
  repo owner on the Cloudflare dashboard.** See `SECURITY.md` for the full
  incident record and the patched lint workflow that prevents regression.

---

## 2026-04-09 — Public blueprint release

Extracted from private `claude-memory` repo into a reusable, anonymized blueprint.

### Added
- **MCP Worker source** (`config/mcp-worker/`) — 22 tools, v2.2
- **CI/CD workflow** (`.github/workflows/deploy-mcp.yml`) — auto-deploy on push to main
- **D1 setup script** (`setup-d1.sh`) — bootstrap tables and indexes
- **QUICKSTART.md** — Lite mode setup (repo only, 10 min)
- **SETUP_MCP.md** — Full mode setup (Cloudflare MCP, 15 min)
- **Examples directory** — filled-in demos for STATUS_SNAPSHOT, hubs, memory edits
- **ARCHITECTURE.md** — design rationale, token economics, graduated loading

### Changed
- **README.md** — architecture diagram, differentiation table, live examples

---

## 2026-03 — D1 database & knowledge graph (v2.0)

Session logging, structured fact storage, and knowledge graph triples.

### Added
- D1 database on Cloudflare (facts, sessions, errors, knowledge_graph tables)
- `store_fact` / `query_facts` — persist and retrieve structured facts
- `log_session` / `recent_sessions` — automatic session history
- `kg_add` / `kg_query` — subject-predicate-object knowledge graph
- `log_error` / `error_report` — error tracking for self-improvement
- Tool count: 9 → 16

---

## 2026-02 — Community-driven improvements

Freshness tracking, compaction survival, behavioral rule refinements.

### Added
- Freshness timestamps on all hub sections
- STATUS_SNAPSHOT compaction (kept under 60 lines)
- MEMORY_EDITS.md — cross-surface drift detection between live edits and repo
- Misinference check framework (adapted from Edmans)
- Behavioral nudging rules (Clear + Fogg)

### Changed
- CLAUDE.md — added pre-flight check as MANDATORY
- RULES.md — expanded failure patterns from 3 to 6

---

## 2026-01 — First MCP Worker (v1.0)

Cloudflare Worker to expose the Git repo as MCP tools for Claude.ai Chat and Mobile.

### Added
- MCP Worker on Cloudflare Workers — 9 initial tools
- `wake_up` — one-call context loading for Chat surface
- `get_snapshot`, `get_hub`, `get_rules` — file access tools
- `search` — code search across repo via GitHub API
- Bearer token authentication
- UTF-8 handling for non-Latin content

### Why
Claude.ai Chat and Mobile can't run `git clone`. The MCP Worker bridges the gap — same repo, accessible from any Claude surface.

---

## 2025-12 — Migration to Git

Moved from Google Drive to GitHub as the primary source of truth.

### Changed
- **Storage**: Google Drive documents → Git repository with structured markdown
- **Access**: Drive API → `git clone/pull` (Chat) / local fs (Code)
- **Versioning**: manual snapshots → full git history with rollback

### Why
Google Drive had no versioning, no structured format, and required Drive API access. Git gives us versioned, auditable, human-readable storage that works with all Claude surfaces.

---

## 2025-10 — Initial concept

Hub-based memory files stored in Google Drive, accessed via Drive API.

### Added
- First hub files: personal profile, work status, side project
- STATUS_SNAPSHOT concept — single file for cross-domain routing
- Claude reads Google Drive at conversation start for persistent context
- Behavioral rules via memory edits

### Why
Claude's built-in `userMemories` is auto-generated, unstructured, and lags by days. Manual memory edits are limited to 14 items of ~500 chars each. Neither is sufficient for structured, multi-domain context. The idea: give Claude a file system it can read and write to.
