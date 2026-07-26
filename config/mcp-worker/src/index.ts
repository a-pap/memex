import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  chunkMarkdown,
  upsertChunks,
  deleteByFilePath,
  searchSemantic,
  searchHybrid,
  type SearchResult,
} from "./indexer";
import { correctGranolaText } from "./granola-corrections";

// Single source of truth for the worker version. Drives the `version` /
// `worker_version` response fields AND the outbound User-Agent, so bumping the
// version is a one-line change (was: 3 drifted UA literals 2.10/2.11/2.12 +
// "2.13.0" hardcoded in 4 places). Keep in sync with package.json + CLAUDE.md.
const WORKER_VERSION = "2.13.0";
const WORKER_UA = `claude-memory-mcp/${WORKER_VERSION}`;

interface Env {
  GITHUB_PAT: string;
  GITHUB_REPO: string;
  AUTH_PATH_TOKEN?: string;
  GRANOLA_API?: string;
  DB: D1Database;
  STORE?: R2Bucket;
  // user-artifacts bucket (a.user-site.example/<hash> host). Optional so the
  // worker boots cleanly on environments where the binding isn't configured —
  // r2_upload(bucket="artifacts") returns a friendly error in that case.
  ARTIFACTS_STORE?: R2Bucket;
  // TZ 1 (2026-05-01): Vectorize index + Workers AI for semantic search over
  // hubs/references/root .md. Optional — if missing, the three new tools
  // (semantic_search/hybrid_search) and /index/* endpoints return a friendly
  // 503-equivalent error instead of crashing the worker boot.
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  // TZ 2 (2026-05-01): account-scoped credentials needed by `gateway_logs`
  // tool to call the AI Gateway REST API. Set as Worker secrets via
  // `wrangler secret put`.
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  // Nightly deep analysis cron (2026-06-12, migrated from GHA). Optional —
  // when absent the Mon/Wed/Fri cron logs a high-severity `errors` row and
  // exits instead of crashing. Set via `wrangler secret put ANTHROPIC_API_KEY`.
  ANTHROPIC_API_KEY?: string;
  // Outbound Telegram via `tg_send` (2026-06-13) — gives mobile/web Claude Code
  // parity with the Mac-only scripts/tg-send.sh. Bot token is a Worker secret
  // (pushed by deploy-mcp.yml from the TELEGRAM_BOT_TOKEN GitHub secret, the
  // same one the telegram-bot worker uses). Optional: when absent, tg_send
  // returns a friendly setup message instead of crashing.
  TELEGRAM_BOT_TOKEN?: string;
  // Default outbound target for tg_send (User's chat). Plain var, not secret —
  // a chat id is not sensitive (it's already in telegram-bot ALLOWED_CHAT_IDS).
  TG_DEFAULT_CHAT_ID?: string;
}

const GITHUB_API = "https://api.github.com";

// Public URL of this worker — used as the base for the server icon advertised
// to MCP clients. If the worker is ever reachable at a different hostname,
// update this constant (or read from env); icon URLs must be absolute per spec.
const WORKER_PUBLIC_URL = "https://claude-memory-mcp.OWNER.workers.dev";

// Knowledge-graph motif: four peripheral nodes connected to a central hub —
// mirrors the memory model (hubs + facts + KG enrichment). Served at /icon.svg
// and referenced from the `icons` field in the MCP server info so Claude
// clients render this instead of the default placeholder.
const SERVER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" fill="none"><defs><linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse"><stop stop-color="#6366F1"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><g stroke="#ffffff" stroke-width="2.2" stroke-opacity="0.9" stroke-linecap="round"><line x1="20" y1="20" x2="32" y2="32"/><line x1="44" y1="20" x2="32" y2="32"/><line x1="20" y1="44" x2="32" y2="32"/><line x1="44" y1="44" x2="32" y2="32"/></g><g fill="#ffffff"><circle cx="20" cy="20" r="4"/><circle cx="44" cy="20" r="4"/><circle cx="20" cy="44" r="4"/><circle cx="44" cy="44" r="4"/></g><circle cx="32" cy="32" r="6" fill="#FBBF24"/></svg>`;

// ── GitHub helpers ──────────────────────────────────────────

async function githubFetch(env: Env, path: string): Promise<Response> {
  return fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": WORKER_UA,
    },
  });
}

function base64ToUtf8(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

// D1 file-cache freshness window. The cache is a warm-path optimization, not a
// source of truth: hub / STATUS / RULES edits land out-of-band (dreaming cron,
// Code `git push`, GitHub UI) and MUST be visible the same session. A cache-first
// read with no expiry served a STALE hub06 to a chat on 2026-06-22 — the "Martí
// 127" apartment edit (pushed 16:45 UTC) was invisible for hours because the only
// invalidation was the once-a-day 07:00 UTC cacheHygiene cron, so the chat said
// "no apartment in the hub" and looked confused. A short TTL bounds staleness to
// seconds while still collapsing the read-burst at session start (wake_up reads
// snapshot + several hubs within the window). On a GitHub refetch failure we fall
// back to the stale copy, so freshness never costs availability.
const CACHE_TTL_SECONDS = 60;

async function readFile(env: Env, path: string, fresh = false): Promise<string | null> {
  // 1. D1 cache first, but only within the TTL. fresh=true bypasses the READ.
  //    A present-but-stale entry is retained as `stale` and used as a fallback
  //    if the GitHub refetch below fails (don't trade availability for freshness).
  await ensureCacheTable(env.DB);
  let stale: string | null = null;
  if (!fresh) {
    const hit = await cacheGetWithAge(env.DB, path);
    if (hit.content !== null) {
      if (hit.ageSeconds !== null && hit.ageSeconds <= CACHE_TTL_SECONDS) return hit.content;
      stale = hit.content; // present but past TTL — refetch, keep as fallback
    }
  }

  // 2. Cache miss / stale / fresh — fetch from GitHub, populate cache, return.
  //    GitHub failure → serve the stale copy if we have one (else null).
  const res = await githubFetch(env, path);
  if (!res.ok) return stale;
  const data = (await res.json()) as { content?: string; encoding?: string; sha?: string };
  if (data.content && data.encoding === "base64") {
    const content = base64ToUtf8(data.content);
    await cachePut(env.DB, path, content, data.sha ?? null, 0);
    return content;
  }
  return stale;
}

async function readFileFromRepo(env: Env, repo: string, path: string): Promise<string | null> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": WORKER_UA,
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (data.content && data.encoding === "base64") {
    return base64ToUtf8(data.content);
  }
  return null;
}

async function listDir(env: Env, path: string): Promise<string[]> {
  const res = await githubFetch(env, path);
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{ name: string; type: string }>;
  if (!Array.isArray(data)) return [];
  return data.map((f) => `${f.type === "dir" ? "\u{1F4C1}" : "\u{1F4C4}"} ${f.name}`);
}

// ─── Indexer scope (TZ 1, 2026-05-01) ──────────────────────────────────────
//
// Defines which markdown paths flow into the Vectorize index. The shape:
//   - everything under `hubs/` and `references/` (deep, semantic-rich)
//   - a curated whitelist of root-level .md files (cross-cutting docs)
//   - explicit blacklist for noisy/build/log directories
// `isIndexable(path)` is the single decision point — used by both the bootstrap
// and the incremental endpoints below, and by the GitHub Action that fires on
// push to `main` for any of these paths.

const INDEXER_INCLUDE_PREFIXES = ["hubs/", "references/"];

const INDEXER_INCLUDE_ROOT_FILES = new Set<string>([
  "STATUS_SNAPSHOT.md",
  "CLAUDE.md",
  "MEMEX_GUIDE.md",
  "BOOTSTRAP.md",
  "BACKLOG.md",
  "TODO.md",
  "RULES.md",
  "MEMORY_EDITS.md",
  "SECURITY.md",
  "MIGRATION_AUDIT.md",
  "VERIFICATION_CHECKLIST.md",
  "README.md",
  "PREFERENCES.md",
]);

const INDEXER_EXCLUDE_PREFIXES = [
  "logs/",
  "dreams/",
  "inbox/",
  "archive/",
  ".github/",
  ".planning/",
  "config/",
  "scripts/",
  "[employer-ad-network]_scripts/",
  "user-artifacts-worker/",
  "tests/",
  "skills/",
  "tasks/",
  "memory/",
  "deliverables/",
  "artifacts/",
  "docs/",
];

function isIndexable(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  for (const ex of INDEXER_EXCLUDE_PREFIXES) {
    if (path.startsWith(ex)) return false;
  }
  for (const inc of INDEXER_INCLUDE_PREFIXES) {
    if (path.startsWith(inc)) return true;
  }
  if (!path.includes("/") && INDEXER_INCLUDE_ROOT_FILES.has(path)) return true;
  return false;
}

// List every indexable path on the current main of GITHUB_REPO. One git-tree
// API call (recursive=1) returns all blobs; we filter via isIndexable.
async function listIndexablePaths(env: Env): Promise<string[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_REPO}/git/trees/main?recursive=1`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": WORKER_UA,
      },
    }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    truncated?: boolean;
    tree?: Array<{ path: string; type: string }>;
  };
  if (data.truncated) {
    console.warn("listIndexablePaths: git tree truncated — bootstrap may miss files");
  }
  return (data.tree ?? [])
    .filter((n) => n.type === "blob" && isIndexable(n.path))
    .map((n) => n.path);
}

// Compact markdown formatter for top-K SearchResult arrays surfaced via
// semantic_search / hybrid_search MCP tools. Keeps each result under ~300 chars
// to leave headroom for the LLM context.
function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No semantic matches for "${query}".`;
  }
  const lines: string[] = [`# Top ${results.length} for "${query}"`, ""];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const preview = r.chunk_text.length > 280 ? r.chunk_text.slice(0, 277) + "..." : r.chunk_text;
    lines.push(
      `## ${i + 1}. ${r.section_title} — ${r.file_path} (score ${r.score.toFixed(3)})`
    );
    lines.push(preview);
    lines.push("");
  }
  return lines.join("\n");
}

// Allow-list of repos that update_file may write to. We don't want a
// malicious caller writing arbitrary files in unrelated repos with the
// claude-memory PAT — only User's known repos that we ship to.
//
// 2026-05-01: memex added so Mobile Claude can edit the public blueprint
// repo (templates, examples, docs). Pre-commit secret scan + scan-private-
// refs hooks remain the leak guards — same defense as the other repos.
// [side-project] is INTENTIONALLY excluded — it's Collaborator's repo, read-only.
const ALLOWED_WRITE_REPOS: ReadonlySet<string> = new Set([
  "OWNER/REPO",
  "OWNER/spanish-portal",
  "OWNER/user-site.example",
  "OWNER/memex",
]);

async function writeFile(
  env: Env,
  path: string,
  content: string,
  message: string,
  repoOverride?: string
): Promise<{ success: boolean; error?: string }> {
  const repo = repoOverride && repoOverride !== "" ? repoOverride : env.GITHUB_REPO;
  if (!ALLOWED_WRITE_REPOS.has(repo)) {
    return { success: false, error: `repo '${repo}' not in allow-list (${[...ALLOWED_WRITE_REPOS].join(", ")})` };
  }

  // Write-through cache: only the source-of-truth memory repo (claude-memory)
  // is cached. Cross-repo writes (spanish-portal, user-site.example) go straight to
  // GitHub without any D1 mirror — those repos have their own ground truth.
  const writingToMemory = repo === env.GITHUB_REPO;

  // 1. Optimistic write to D1 cache marked dirty=1. If the GitHub commit
  //    fails, the row stays dirty and surfaces via self-diagnostic / cache
  //    hygiene cron.
  if (writingToMemory) {
    await ensureCacheTable(env.DB);
    await cachePut(env.DB, path, content, null, 1);
  }

  // For non-default repo we still re-use the same PAT — it's a fine-grained
  // PAT scoped to the user's repos, so writes to spanish-portal succeed
  // identically to claude-memory.
  const existing = await fetch(
    `${GITHUB_API}/repos/${repo}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": WORKER_UA,
      },
    }
  );
  let sha: string | undefined;
  if (existing.ok) {
    const data = (await existing.json()) as { sha?: string };
    sha = data.sha;
  }

  const body: Record<string, string> = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
  };
  if (sha) body.sha = sha;

  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": WORKER_UA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    if (writingToMemory) {
      // Surface the failure: the row stays dirty=1 (already set above) and
      // log so the cron sweep can find it.
      try {
        await env.DB
          .prepare("INSERT INTO errors (error_type, description, severity) VALUES ('write_through', ?, 'high')")
          .bind(`writeFile failed for ${path}: GitHub API ${res.status}: ${err}`)
          .run();
      } catch {}
    }
    return { success: false, error: `GitHub API ${res.status}: ${err}` };
  }

  // 2. On success, mark the cache row clean and capture the new git blob SHA.
  if (writingToMemory) {
    try {
      const data = (await res.json()) as { content?: { sha?: string } };
      const newSha = data.content?.sha ?? null;
      if (newSha) {
        await cacheMarkClean(env.DB, path, newSha);
      } else {
        // No SHA in response (shouldn't happen for PUT contents) — clear dirty
        // anyway because the commit succeeded.
        await env.DB
          .prepare("UPDATE memory_files_cache SET dirty = 0 WHERE path = ?")
          .bind(path)
          .run()
          .catch(() => {});
      }
    } catch {
      // Response parse failure — non-fatal, the commit itself succeeded.
    }
  }

  return { success: true };
}

// ── Memory file cache (D1) ──────────────────────────────────
//
// Phase 1 of the 2026-05-01 migration: claude-memory stays the source of
// truth (private GitHub repo, durable, free, perfect audit log). D1 holds
// a content cache that read tools hit first (sub-50ms) and that the write
// tool populates write-through on every commit. GitHub Pat is still used —
// it is required for the durability half of write-through.
//
// Drift is solved at protocol level (Claude reads only via this MCP, never
// `git pull` for memory) — the cache exists for speed and resilience to
// GitHub API rate limits, NOT to make D1 the owner of the data.
//
// Schema is created idempotently on first use via ensureCacheTable() and
// also baked into ensureTables() for new D1 instances.

let _cacheTableEnsured = false;

async function ensureCacheTable(db: D1Database): Promise<void> {
  if (_cacheTableEnsured) return;
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS memory_files_cache (
           path           TEXT PRIMARY KEY,
           content        TEXT NOT NULL,
           size_bytes     INTEGER NOT NULL,
           content_hash   TEXT NOT NULL,
           cached_at      TEXT NOT NULL,
           last_seen_sha  TEXT,
           dirty          INTEGER NOT NULL DEFAULT 0
         )`
      )
      .run();
    // Partial index on dirty rows — small, useful for the cron sweep that
    // reconciles write-through failures.
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_cache_dirty ON memory_files_cache(dirty) WHERE dirty = 1`
      )
      .run();
    _cacheTableEnsured = true;
  } catch (e) {
    // Don't poison _cacheTableEnsured on transient error — try again next
    // request. cacheGet/cachePut both swallow their own errors so a missing
    // table just falls through to the GitHub path.
    console.warn("ensureCacheTable failed:", (e as Error)?.message ?? e);
  }
}

async function sha256Hex(content: string): Promise<string> {
  const buf = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function cacheGetWithAge(
  db: D1Database,
  path: string
): Promise<{ content: string | null; ageSeconds: number | null }> {
  try {
    const row = await db
      .prepare(
        // age in seconds derived from the stored UTC `cached_at` (datetime('now')
        // text). Both julianday() args are UTC so the diff is timezone-safe.
        "SELECT content, (julianday('now') - julianday(cached_at)) * 86400.0 AS age_seconds " +
          "FROM memory_files_cache WHERE path = ?"
      )
      .bind(path)
      .first<{ content: string; age_seconds: number | null }>();
    if (!row) return { content: null, ageSeconds: null };
    return { content: row.content, ageSeconds: row.age_seconds };
  } catch {
    return { content: null, ageSeconds: null }; // table missing / transient → miss
  }
}

async function cachePut(
  db: D1Database,
  path: string,
  content: string,
  gitSha: string | null,
  dirty: 0 | 1
): Promise<void> {
  let hash: string;
  try {
    hash = await sha256Hex(content);
  } catch {
    hash = "unknown";
  }
  try {
    await db
      .prepare(
        `INSERT INTO memory_files_cache (path, content, size_bytes, content_hash, cached_at, last_seen_sha, dirty)
         VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           content = excluded.content,
           size_bytes = excluded.size_bytes,
           content_hash = excluded.content_hash,
           cached_at = excluded.cached_at,
           last_seen_sha = COALESCE(excluded.last_seen_sha, memory_files_cache.last_seen_sha),
           dirty = excluded.dirty`
      )
      .bind(path, content, content.length, hash, gitSha, dirty)
      .run();
  } catch (e) {
    console.warn(`cachePut failed for ${path}:`, (e as Error)?.message ?? e);
  }
}

async function cacheMarkClean(db: D1Database, path: string, gitSha: string): Promise<void> {
  try {
    await db
      .prepare("UPDATE memory_files_cache SET dirty = 0, last_seen_sha = ? WHERE path = ?")
      .bind(gitSha, path)
      .run();
  } catch {}
}

async function searchRepo(
  env: Env,
  query: string
): Promise<Array<{ path: string; snippet: string }>> {
  const res = await fetch(
    `${GITHUB_API}/search/code?q=${encodeURIComponent(query)}+repo:${env.GITHUB_REPO}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: "application/vnd.github.v3.text-match+json",
        "User-Agent": WORKER_UA,
      },
    }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    items?: Array<{
      path: string;
      text_matches?: Array<{ fragment: string }>;
    }>;
  };
  if (!data.items) return [];
  return data.items.slice(0, 10).map((item) => ({
    path: item.path,
    snippet:
      item.text_matches?.map((m) => m.fragment).join("\n---\n") ||
      "(no snippet)",
  }));
}

// ── D1 helpers ──────────────────────────────────────────────

async function ensureTables(db: D1Database): Promise<void> {
  // NOTE: Schema matches the LIVE D1 database (verified 2026-04-11 against
  // database id 8b2379bf-7664-477e-9d0f-ccd7f93db744). Earlier worker
  // versions shipped a different schema (`facts.key/value`, `errors.tool/
  // message/context`) that silently did not match the live tables. All
  // store_fact / query_facts / log_error / error_report / wake_up-recent-
  // facts queries failed with "no such column" at runtime and were
  // swallowed by try/catch. Fixed in v2.4.1.
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      entity TEXT NOT NULL,
      attribute TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT,
      confidence TEXT DEFAULT 'high',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface TEXT NOT NULL,
      summary TEXT NOT NULL,
      topics TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error_type TEXT NOT NULL,
      description TEXT NOT NULL,
      domain TEXT,
      severity TEXT DEFAULT 'medium',
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS knowledge_graph (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS granola_meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      participants TEXT,
      summary TEXT,
      transcript TEXT,
      action_items TEXT,
      decisions TEXT,
      domain TEXT DEFAULT 'general',
      synced_at TEXT DEFAULT (datetime('now'))
    )`),
    // Memory file content cache (Phase 1 of 2026-05-01 migration). Lazy-
    // populated on read miss (cacheGet/readFile), updated write-through on
    // every update_file. Source of truth remains the claude-memory git repo;
    // this is a speed + resilience layer.
    db.prepare(`CREATE TABLE IF NOT EXISTS memory_files_cache (
      path           TEXT PRIMARY KEY,
      content        TEXT NOT NULL,
      size_bytes     INTEGER NOT NULL,
      content_hash   TEXT NOT NULL,
      cached_at      TEXT NOT NULL,
      last_seen_sha  TEXT,
      dirty          INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_cache_dirty ON memory_files_cache(dirty) WHERE dirty = 1`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_granola_date ON granola_meetings(date DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_granola_domain ON granola_meetings(domain)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_entity_attr ON facts(entity, attribute)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_facts_domain ON facts(domain)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_surface ON sessions(surface)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_kg_subject ON knowledge_graph(subject)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_kg_predicate ON knowledge_graph(predicate)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_kg_subject_pred ON knowledge_graph(subject, predicate)`),
    // Spanish portal telemetry (s.user-site.example). Events are POSTed by the portal
    // browser, read by Claude via `recent_sessions(source="portal")` so future
    // drills can adapt to what User actually clicks/struggles with.
    db.prepare(`CREATE TABLE IF NOT EXISTS portal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      sid TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_portal_ts ON portal_events(ts DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_portal_kind ON portal_events(kind)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_portal_sid ON portal_events(sid)`),
    // FTS5 for granola meetings — fixes RU-morphology gaps in LIKE-based
    // granola_context (BACKLOG P2 2026-04-22: 8 Russian queries returned 0
    // hits despite hits existing). unicode61 handles Cyrillic; we use
    // prefix search (`tok*`) at query-build time for naive stemming.
    //
    // External-content mode is avoided to keep write path simple: granola_sync
    // explicitly upserts into granola_fts on every INSERT OR REPLACE of
    // granola_meetings. Backfill runs idempotently below.
    db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS granola_fts USING fts5(
      id UNINDEXED,
      searchable,
      tokenize = 'unicode61 remove_diacritics 2'
    )`),
    // tool_calls: per-tool usage telemetry (2026-06-13). Bumped via the
    // server.tool wrapper; surfaced by health_check. See bumpToolCall.
    db.prepare(`CREATE TABLE IF NOT EXISTS tool_calls (
      tool TEXT PRIMARY KEY,
      calls INTEGER NOT NULL DEFAULT 0,
      last_called TEXT
    )`),
  ]);

  // Backfill FTS for existing granola rows that aren't indexed yet.
  // NOT EXISTS clause makes this a one-time copy per row; idempotent on
  // subsequent calls. Kept outside the batch() because it depends on the
  // virtual table existing.
  try {
    await db.prepare(
      `INSERT INTO granola_fts(rowid, id, searchable)
       SELECT gm.rowid, gm.id,
              COALESCE(gm.title,'')||' '||COALESCE(gm.summary,'')||' '||COALESCE(gm.participants,'')||' '||COALESCE(gm.action_items,'')||' '||COALESCE(gm.decisions,'')||' '||COALESCE(gm.transcript,'')
       FROM granola_meetings gm
       WHERE NOT EXISTS (SELECT 1 FROM granola_fts WHERE granola_fts.id = gm.id)`
    ).run();
  } catch (e) {
    // Non-fatal: if FTS5 isn't supported on this D1 tier the granola_context
    // fallback path to LIKE still works. Log once so the symptom isn't silent.
    console.warn("ensureTables: granola_fts backfill failed", (e as Error)?.message ?? e);
  }
}

// Build an FTS5 MATCH query from a free-form user string with naive
// Russian-morphology handling. Rules:
//   - Split on whitespace and common punctuation.
//   - Strip FTS-syntax characters ("()*+-:") from each token.
//   - Drop tokens <2 chars (FTS5 refuses single-char terms anyway).
//   - Cap per-token length at 15 chars — FTS5 prefix queries compile into
//     GLOB-style matches internally; long Cyrillic (UTF-8 multi-byte) prefix
//     terms combined with 3+ others trip SQLite's "LIKE or GLOB pattern too
//     complex" limit.
//   - Tokens ≥4 chars get a prefix suffix `tok*` so "разреклам" matches
//     "разрекламировал", "разрекламировать", etc.
//   - Cap at 2 tokens (not 4) — same complexity issue. Two significant terms
//     give enough selectivity; third term usually pushes the compiled GLOB
//     past the threshold on Cyrillic inputs.
//   - Tightened 2026-04-23 (BACKLOG claude-mcp granola LIKE/GLOB error branch —
//     "Свинцицкий партнёрские кабинеты" reproduced the error on v2.8.0).
//   - Join with spaces (implicit AND in FTS5).
// Returns null if no usable tokens remain → caller falls back to LIKE.
function buildFtsQuery(raw: string): string | null {
  const stripped = raw.replace(/[()*+\-:"'`]/g, " ").trim();
  if (!stripped) return null;
  const tokens = stripped
    .split(/[\s.,;!?—–\u00A0]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2)
    .map((t) => t.slice(0, 15))
    .slice(0, 2);
  if (tokens.length === 0) return null;
  return tokens.map((t) => (t.length >= 4 ? `${t}*` : t)).join(" ");
}

// Hub domain-to-path mapping
const HUB_MAP: Record<string, string> = {
  [employer-ad-network]: "hubs/04_[employer-ad-network]_WORK.md",
  work: "hubs/04_[employer-ad-network]_WORK.md",
  experiments: "hubs/04_[employer-ad-network]_WORK.md",
  meetings: "hubs/05_MEETINGS.md",
  relocation: "hubs/06_RELOCATION.md",
  barcelona: "hubs/06_RELOCATION.md",
  [side-project]: "hubs/07_[side-project].md",
  [pet]: "hubs/08_JAY.md",
  spanish: "hubs/09_SPANISH.md",
  blog: "hubs/10_BLOG.md",
  user: "hubs/10_BLOG.md",
  finance: "hubs/02_FINANCE.md",
  creative: "hubs/03_CREATIVE.md",
};

function resolveHubPath(domain: string): string | null {
  const key = domain.toLowerCase().trim();
  return HUB_MAP[key] || null;
}

// ── Granola REST API helpers ────────────────────────────────

const GRANOLA_API_BASE = "https://public-api.granola.ai/v1";

interface GranolaNoteListItem {
  id: string;
  title: string;
  created_at: string;
  people?: Array<{ name?: string; email?: string }>;
}

interface GranolaNoteDetail {
  id: string;
  title: string;
  created_at: string;
  attendees?: Array<{ name?: string; email?: string }>;
  summary_markdown?: string;
  summary_text?: string;
  transcript?: Array<{ speaker?: { source?: string }; text?: string }>;
}

async function granolaFetch(env: Env, path: string): Promise<Response> {
  if (!env.GRANOLA_API) throw new Error("GRANOLA_API secret not configured");
  return fetch(`${GRANOLA_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${env.GRANOLA_API}`,
      Accept: "application/json",
      "User-Agent": WORKER_UA,
    },
  });
}

async function granolaListNotes(env: Env, createdAfter?: string): Promise<GranolaNoteListItem[]> {
  const notes: GranolaNoteListItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = 5; // Safety limit

  do {
    const params = new URLSearchParams();
    if (createdAfter) params.set("created_after", createdAfter);
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    const res = await granolaFetch(env, `/notes${qs ? `?${qs}` : ""}`);
    if (!res.ok) break;
    const data = (await res.json()) as {
      notes?: GranolaNoteListItem[];
      hasMore?: boolean;
      cursor?: string;
    };
    if (data.notes) notes.push(...data.notes);
    cursor = data.hasMore ? data.cursor : undefined;
    pages++;
  } while (cursor && pages < maxPages);

  return notes;
}

async function granolaGetNote(env: Env, noteId: string, includeTranscript = true): Promise<GranolaNoteDetail | null> {
  const qs = includeTranscript ? "?include=transcript" : "";
  const res = await granolaFetch(env, `/notes/${noteId}${qs}`);
  if (!res.ok) return null;
  return (await res.json()) as GranolaNoteDetail;
}

function formatTranscript(transcript?: GranolaNoteDetail["transcript"]): string {
  if (!transcript || transcript.length === 0) return "";
  return transcript
    .map((t) => {
      const speaker = t.speaker?.source === "microphone" ? "Me" : "Them";
      // Active correction layer: fix confirmed ASR garbles ([employer-ad-network] terms / product
      // names) once at sync time → persisted to D1 → every reader gets clean text.
      return `${speaker}: ${correctGranolaText((t.text || "").trim())}`;
    })
    .filter((l) => l.length > 5) // Skip empty lines
    .join("\n");
}

function extractSummary(note: GranolaNoteDetail): string {
  // Granola REST API returns summary_markdown (preferred) or summary_text.
  // Run both through the ASR correction layer (see granola-corrections.ts).
  if (note.summary_markdown) return correctGranolaText(note.summary_markdown);
  if (note.summary_text) return correctGranolaText(note.summary_text);
  return "";
}

function autoDetectDomain(title: string, summary: string): string {
  const text = `${title} ${summary}`.toLowerCase();
  if (/\b(рся|[employer-ad-network]|эксперимент|баннер|нейродизайн|аукцион|sdk|ssp|cpm|overlay|формат|блок|монетиз|партнёр|дизайн id|автораст|флаг)/i.test(text)) return "[employer-ad-network]";
  if (/\b(spanish|español|práctica|clase|lección|judit)/i.test(text)) return "spanish";
  if (/\b([pet]|basenji|vet|renal|epilep|собак)/i.test(text)) return "[pet]";
  if (/\b([side-project]|stripe|restaurant|nfc|qr)/i.test(text)) return "[side-project]";
  if (/\b(barcelona|bcn|relocation|visa|аренда)/i.test(text)) return "relocation";
  return "general";
}

function extractActionItems(summary: string): string[] {
  const items: string[] = [];
  const lines = summary.split("\n");
  let inActionSection = false;
  for (const line of lines) {
    if (/^###?\s*(действия|action|next|следующ|задач|todo)/i.test(line)) {
      inActionSection = true;
      continue;
    }
    if (/^###?\s/.test(line) && inActionSection) break; // Next section
    if (inActionSection && /^\s*[-*]\s+/.test(line)) {
      items.push(line.replace(/^\s*[-*]\s+/, "").trim());
    }
  }
  return items;
}

function extractDecisions(summary: string): string[] {
  const items: string[] = [];
  const lines = summary.split("\n");
  for (const line of lines) {
    // Lines with decision keywords
    if (/\b(решен|decision|agreed|договорились|закрыли вопрос|выбран|решили)\b/i.test(line) && /^\s*[-*]\s+/.test(line)) {
      items.push(line.replace(/^\s*[-*]\s+/, "").trim());
    }
  }
  return items;
}

// ── KG contradiction check ──────────────────────────────────

async function checkContradictions(db: D1Database, content: string): Promise<string[]> {
  const entityCandidates = [...new Set(
    content.match(/[A-ZА-ЯЁ][a-zа-яё]{2,}/g) || []
  )];
  if (entityCandidates.length === 0) return [];

  const warnings: string[] = [];
  for (const entity of entityCandidates.slice(0, 10)) {
    try {
      const rows = await db
        .prepare("SELECT subject, predicate, object FROM knowledge_graph WHERE subject LIKE ? OR object LIKE ? LIMIT 5")
        .bind(`%${entity}%`, `%${entity}%`)
        .all();
      for (const row of rows.results as Array<{ subject: string; predicate: string; object: string }>) {
        warnings.push(`KG: ${row.subject} → ${row.predicate} → ${row.object}`);
      }
    } catch { /* skip */ }
  }
  return [...new Set(warnings)];
}

// ── KG auto-enrichment from hub headers ────────────────────

interface ExtractedTriple {
  subject: string;
  predicate: string;
  object: string;
}

function extractTriplesFromHubContent(hubDomain: string, content: string): ExtractedTriple[] {
  const triples: ExtractedTriple[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern: "## Status: <value>" or "## Статус: <value>"
    const statusMatch = line.match(/^##\s*(Status|Статус)\s*[:\-—]\s*(.+)/i);
    if (statusMatch) {
      triples.push({ subject: hubDomain, predicate: "status", object: statusMatch[2].trim() });
      continue;
    }

    // Pattern: "- **Person** — role/action" (common in hub files)
    const personRoleMatch = line.match(/^\s*[-*]\s*\*\*([А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+)?)\*\*\s*[—–:]\s*(.+)/);
    if (personRoleMatch) {
      const person = personRoleMatch[1].toLowerCase();
      const role = personRoleMatch[2].trim().slice(0, 100);
      triples.push({ subject: person, predicate: `role_in_${hubDomain}`, object: role });
      continue;
    }

    // Pattern: "Deadline: <date>" or "Дедлайн: <date>"
    const deadlineMatch = line.match(/\b(Deadline|Дедлайн|DDL|due)\s*[:\-—]\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|янв|фев|мар|апр|мая?|июн|июл|авг|сен|окт|ноя|дек)\w*\s+\d{4})/i);
    if (deadlineMatch) {
      triples.push({ subject: hubDomain, predicate: "deadline", object: deadlineMatch[2].trim() });
      continue;
    }

    // Pattern (added 2026-04-23, BACKLOG claude-mcp KG-flat fix): portfolio
    // table rows in hubs/04. Format:
    //   "| N | [Name](url) | project_id | 🟢 status_text | progress | ..."
    // Captures project → status, project → name, project → domain triples.
    // Catches the bulk of [employer-ad-network] hub mutations that the legacy patterns missed.
    const portfolioMatch = line.match(/^\|\s*\d+\s*\|\s*\[([^\]]+)\][^|]*\|\s*(\d{5,7})\s*\|\s*(🟢|🟡|🔴|⚪)\s*([^|]+?)\s*\|/u);
    if (portfolioMatch) {
      const projectName = portfolioMatch[1].trim().slice(0, 80);
      const projectId = portfolioMatch[2].trim();
      const statusText = portfolioMatch[4].trim().slice(0, 50);
      triples.push({ subject: `project:${projectId}`, predicate: "name", object: projectName });
      triples.push({ subject: `project:${projectId}`, predicate: "status", object: statusText });
      triples.push({ subject: `project:${projectId}`, predicate: "hub", object: hubDomain });
      continue;
    }

    // Pattern (2026-04-23): "### Gap: <name>" + look-ahead for "- **Status:** <value>"
    // within the next 4 lines. Captures open questions in hubs/04 et al.
    const gapMatch = line.match(/^###\s+Gap:\s*(.+?)\s*$/);
    if (gapMatch) {
      const gapName = gapMatch[1].trim().slice(0, 80);
      triples.push({ subject: `gap:${gapName}`, predicate: "type", object: `gap_in_${hubDomain}` });
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const gapStatus = lines[j].match(/^-\s+\*\*Status:\*\*\s+(.+?)\s*$/);
        if (gapStatus) {
          triples.push({ subject: `gap:${gapName}`, predicate: "status", object: gapStatus[1].trim().slice(0, 50) });
          break;
        }
      }
      continue;
    }

    // Pattern (2026-04-23): ticket reference "- **TICKET-12345 Name** — note"
    // or "- **542026 Overlay β** — note". Numeric-only ids (5-7 digits) and
    // "PREFIX-N" ids both match.
    const ticketMatch = line.match(/^\s*[-*]\s*\*\*((?:[A-Z]+-)?\d{4,7})\s+([^*]+)\*\*\s*[—–:]\s*(.+)$/);
    if (ticketMatch) {
      const ticketId = ticketMatch[1].trim();
      const ticketName = ticketMatch[2].trim().slice(0, 80);
      triples.push({ subject: `ticket:${ticketId}`, predicate: "name", object: ticketName });
      triples.push({ subject: `ticket:${ticketId}`, predicate: "hub", object: hubDomain });
      continue;
    }
  }

  return triples;
}

async function autoEnrichKG(db: D1Database, path: string, content: string): Promise<number> {
  // Only enrich from hub files
  if (!path.startsWith("hubs/")) return 0;

  const hubDomain = Object.entries(HUB_MAP).find(([_, p]) => p === path)?.[0] || path.replace("hubs/", "").replace(/\.md$/, "").replace(/^\d+_/, "");
  const triples = extractTriplesFromHubContent(hubDomain, content);
  let added = 0;

  for (const t of triples.slice(0, 40)) {
    try {
      const existing = await db
        .prepare("SELECT id FROM knowledge_graph WHERE subject = ? AND predicate = ?")
        .bind(t.subject, t.predicate)
        .first();

      if (existing) {
        await db
          .prepare("UPDATE knowledge_graph SET object = ?, valid_from = datetime('now'), source = ? WHERE subject = ? AND predicate = ?")
          .bind(t.object, `auto:${path}`, t.subject, t.predicate)
          .run();
      } else {
        await db
          .prepare("INSERT INTO knowledge_graph (subject, predicate, object, valid_from, source) VALUES (?, ?, ?, datetime('now'), ?)")
          .bind(t.subject, t.predicate, t.object, `auto:${path}`)
          .run();
      }
      added++;
    } catch (e) {
      // A single bad triple should not abort the whole hub enrichment, but it
      // MUST be logged — silent swallowing here masked 2026-04-18 regressions
      // where unique-constraint drift made every insert error and KG counts
      // silently went to zero. Safe to log: no secret content, only subject /
      // predicate / object from hub markdown (already committed to git).
      console.warn(
        `autoEnrichKG: triple insert failed (path=${path}, subject=${t.subject.slice(0, 40)}, predicate=${t.predicate}):`,
        (e as Error)?.message ?? e
      );
    }
  }

  return added;
}

// ── Tool-call telemetry (2026-06-13) ───────────────────────────────────────
// Before today there was NO per-tool usage signal anywhere (a usage audit could
// only INFER active/dormant from callers). This bumps a D1 counter from a single
// wrapper around server.tool — a table is not a tool, so the RULES §14 surface-
// freeze (48) is untouched. Best-effort + waitUntil: telemetry must NEVER block
// or break a real tool call.
async function ensureToolCallsTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS tool_calls (
         tool TEXT PRIMARY KEY,
         calls INTEGER NOT NULL DEFAULT 0,
         last_called TEXT
       )`
    )
    .run();
}

async function bumpToolCall(env: Env, tool: string): Promise<void> {
  try {
    await ensureToolCallsTable(env.DB);
    await env.DB
      .prepare(
        `INSERT INTO tool_calls (tool, calls, last_called)
         VALUES (?, 1, datetime('now'))
         ON CONFLICT(tool) DO UPDATE SET calls = calls + 1, last_called = datetime('now')`
      )
      .bind(tool)
      .run();
  } catch {
    // telemetry is best-effort — never surface to the caller
  }
}

// ── Server factory ──────────────────────────────────────────

function createServer(env: Env, ctx?: ExecutionContext) {
  const server = new McpServer({
    name: "claude-memory",
    title: "Claude Memory",
    version: WORKER_VERSION,
    websiteUrl: "https://github.com/OWNER/REPO",
    icons: [
      {
        src: `${WORKER_PUBLIC_URL}/icon.svg`,
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
    ],
  }, {
    // Server-level instructions delivered in the MCP initialize response.
    // claude.ai (mobile + desktop) inject these into the session system prompt
    // automatically on connector load — so User doesn't have to type any
    // bootstrap command. Keep concise (<2KB), directive, and surface-agnostic.
    instructions: [
      "You are connected to User's personal memory (private GitHub repo OWNER/REPO, Cloudflare Worker).",
      "",
      "**Active model:** **Fable 5** (`claude-fable-5`, 1M) — returned 2026-07-01 after the 06-12 US-suspension; Opus 4.8 = fallback + classifier-redirect target. Do NOT hard-assume a model from memory — the single canonical home is `read_file({path:'CLAUDE.md'})` § Model landscape (read it if the model matters). Whatever is active: flag uncertainty plainly, prefer a tool call ('дай проверю') over an unsupported claim.",
      "",
      "**Before any answer about ongoing topics ([employer-ad-network], [pet], Barcelona relocation, [side-project], Spanish, user-site.example, artifacts, plugins, mobile workflows):**",
      "1. Call `get_snapshot` (or `wake_up` prompt) once — STATUS_SNAPSHOT.md + MEMORY_EDITS.md.",
      "2. If on iPhone/iPad/web-mobile: also call `get_hub({domain:'00_mobile_kickoff'})` AND `get_hub({domain:'18_mobile_skills_catalog'})` once. They tell you (a) what to load when, (b) which Mac-only skills have mobile equivalents and the exact prompts to orchestrate them via corp MCP (tracker, wiki, calendar, staff, yql, yt, intrasearch, deepagent, granola).",
      "3. Topic-detect from user's first message → `get_hub` for the matched hub per the routing table in CLAUDE.md (read via `read_file({path:'CLAUDE.md'})` if unsure).",
      "4. Optional: `r2_download({key:'work_snapshot/latest.md'})` for fresh corp context (≤90 min old, daily LaunchAgent on Mac); fall back silently if 404.",
      "5. Only then answer.",
      "",
      "**Write protocol:** mobile sessions DO NOT auto-archive. Any decision, hub edit, plan, or fact worth keeping → `update_file` immediately. End every session with `auto_log({surface:'mobile', summary:'<3-7 words>'})` so the desktop audit hook picks it up.",
      "",
      "**Trust ladder:** current conversation > committed hubs (PRIMARY for facts) > Granola/Drive (enrichment) > claude.ai auto-memory (Memory files mode since 2026-07-08; auto-generated, may lag — see root MEMORY_EDITS.md). When unsure say 'let me check' and call a tool; never guess on ongoing-topic facts.",
      "",
      "**Behavioral rules:** ru/en NEVER mixed in one reply; conclusions-first; absolute dates only (`2026-05-13`, not `today`); SETTLED decisions (see STATUS_SNAPSHOT 'Key decisions') don't get re-opened; personal data never ships to public surfaces (RULES.md §10). Full cross-surface behavioral canon (modes STRATEGY/EXECUTION/STUCK/PERSONAL, the Don'ts, verification-before-'done', autonomy levels) → `read_file({path:'PREFERENCES.md'})` once at session start. NOTE: the Mac mechanical guard-hooks (language-mix, secret-scan, TZ-fix, destructive-ops) do NOT run on this surface — self-verify manually.",
      "",
      "**Telegram to User (`tg_send` / Mac `tg-send.sh`) — HARD rule:** write EVERY message in plain human Russian — what happened and why it matters to User, the way you'd tell a busy friend. NO internal jargon: no PR/CI/FAIL/test names, no file paths (STATUS_SNAPSHOT / BACKLOG / commit SHAs), no `BACKLOG L37`-style refs, no routine internals. Internal tech-hiccups (CI fails, PR blocks, status-file oversize, auto-merge waits) are handled silently or by retry — do NOT notify User about them at all unless he must personally act; if he must, 1-3 plain lines, zero codes. He reads these on his phone — if it isn't readable by a non-engineer, it failed. First line = the outcome (it doubles as the push preview); last line = «Нужно от тебя: …» or «Действий не нужно»; ≥3 parallel results → ONE digest, not a ping series; say «готово» only after actually verifying the artifact (otherwise «сделал, но не проверил»); for long tasks promise WHEN the next update comes and keep that promise; don't re-report the same error within ~4h. tg_send now enforces a kitchen-lint (rejects PR#/commit hashes/CI/FAIL/repo paths) — if rejected, REWRITE in plain Russian; skip_lint only when User explicitly asked for a technical dump. **Аббревиатуру [employer-ad-network] всегда писать кириллицей «[employer-ad-network]», никогда латиницей ([employer-ad-network]/[employer-ad-network]) — исключение только реальные ключи трекера TRACKERQUEUE-NNN.**",
      "",
      "**Artifacts (ANY surface, ANY format) — canon v3.1 «одна система, три режима»:** live guide https://a.user-site.example/6ae26ebfe440 + `read_file({path:'skills/html-artifact-master/SKILL.md'})`. HTML: system+Inter only (serif = blog-only), body 18px, text 84ch / page 1080px, bg #FAF9F7 (personal) | #FCFDFF (corp), blue links #1C5FB8, exactly TWO block shapes (neutral rounded container / semantic left-edge tint — никаких цветных верхних кромок), every tracker key = inline link, copy-payloads = plain text (clipboard.writeText, не rich-selection). PPTX/PDF: [employer-ad-network] brand guide + те же принципы. Новый дизайн-паттерн/фидбэк → сначала обнови гайд (тот же hash) + SKILL, потом применяй.",
      "",
      "**Hub map (route by topic):** 02 personal · 03/04 [employer-ad-network] work · 05 [employer-ad-network] meeting index · 06 Barcelona · 07 [side-project] · 08 [pet] health · 09 Spanish · 10 user-site.example · 11 a.user-site.example artifacts · 12 [employer-ad-network] data infra · 13 corp landscape · 14 corp gaps · 15 TG/Arcadia/SO · 16 prompt library · 17 plugins state (Mac) · 18 mobile skills catalog.",
      "",
      "**Tool gating by topic (cross-surface policy, 2026-05-27):** при старте КАЖДОЙ новой conversation, после `get_snapshot`, классифицируй topic ПЕРВЫМ user message и применяй gate:",
      "1. **Clearly work** ([employer-ad-network] / PCODE-* / BSSERVER-* / [employer] meeting / явный запрос про tracker/wiki/yql/yt) — используй corp tools (tracker_mcp, wiki, intrasearch, yql, yt, devtools, ab_experiments, mail_corp, monium_mcp, staff_api_mcp, docs, deepagent, proai) свободно, без вопроса.",
      "2. **Personal / Entertainment** ([pet], [side-project], Spanish, Barcelona relocation, user-site.example, фильмы/сериалы/recap, любая non-work тема) — **НЕ трогай corp tools** даже если доступны. Skip tracker/wiki/yql/yt/intrasearch/mail_corp/monium/staff_api. claude-memory tools OK (snapshot, get_hub, read_file, semantic_search, granola_recent, r2_download, update_file, remember) — это shared substrate.",
      "3. **Ambiguous** (мог бы быть и работа, и личное — например «найди контакт Х», «расскажи про Y») — **СПРОСИ User явно**: «Это про работу или личное? Если работа — могу через tracker/wiki/staff. Если личное — обойдусь claude-memory.» Не угадывай молча.",
      "4. **Corp tool failure** (timeout / no-auth / endpoint down) — НЕ retry молча. Скажи: «corp endpoint <name> недоступен сейчас; альтернатива X, или подождать пока поднимется?». User решит.",
      "   ⚠ **`tracker_mcp` известно нестабилен (2026-06-01):** его `ya`-stdio транспорт виснет (особенно в суб-агентах/workflow, без таймаута). На Code есть REST-обход `scripts/tracker_rest.py` (`$STARTREK_TOKEN`, Startrek API). В Chat локального обхода нет — статусы тикетов бери из committed hubs (03/04/13/14), а свежий live-pull трекера делегируй Code-сессии.",
      "",
      "Цель: уменьшить tool-noise в personal/entertainment chats без переключения profiles на surface-уровне. RULES §10 — personal data не должна засасывать workflow leak через corp tools.",
    ].join("\n"),
  });

  // Wrap server.tool so every registered handler bumps the tool_calls counter
  // (best-effort, via waitUntil). One wrapper, zero per-tool edits, no new tool
  // registration — RULES §14 untouched. See ensureToolCallsTable above.
  const _origTool = server.tool.bind(server);
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const name = typeof args[0] === "string" ? (args[0] as string) : "unknown";
    const handler = args[args.length - 1];
    if (typeof handler === "function") {
      const orig = handler as (...h: unknown[]) => unknown;
      args[args.length - 1] = (...h: unknown[]) => {
        try {
          if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(bumpToolCall(env, name));
        } catch {
          // never let telemetry break dispatch
        }
        return orig(...h);
      };
    }
    return (_origTool as (...a: unknown[]) => unknown)(...args);
  };

  // ── get_snapshot ──────────────────────────────────────────
  server.tool(
    "get_snapshot",
    "Load STATUS_SNAPSHOT.md — the main routing file with current status across all domains. Call this FIRST in any session before answering about ongoing topics. On mobile (iPhone/iPad/web-mobile/native app): follow up with `get_hub({domain:'00_mobile_kickoff'})` + `get_hub({domain:'18_mobile_skills_catalog'})` for the portable-workflows map.",
    {},
    { title: "Read STATUS_SNAPSHOT", readOnlyHint: true, openWorldHint: true },
    async () => {
      const content = await readFile(env, "STATUS_SNAPSHOT.md");
      return {
        content: [
          { type: "text" as const, text: content || "STATUS_SNAPSHOT.md not found" },
        ],
      };
    }
  );

  // ── get_hub ───────────────────────────────────────────────
  server.tool(
    "get_hub",
    "Load a domain hub file. Domains: [pet] (08), [employer-ad-network] (03,04,05,12,13,14,15), [side-project] (07), relocation (06), spanish (09), user_site (10), artifacts (11), personal (02), prompt_library (16), plugins_state (17, Mac-only), mobile_kickoff (00), mobile_skills_catalog (18). On mobile sessions: always load 00 + 18 first (they describe how to route Mac-only skills through MCP tools).",
    { domain: z.string().describe("Domain name, e.g. '[pet]', '[employer-ad-network]', 'relocation'") },
    { title: "Read a Hub File", readOnlyHint: true, openWorldHint: true },
    async ({ domain }) => {
      const direct = resolveHubPath(domain);
      const paths = direct
        ? [direct]
        : [
            `hubs/${domain}.md`,
            `hubs/HUB_${domain.toUpperCase()}.md`,
            `HUB_${domain.toUpperCase()}.md`,
          ];
      for (const p of paths) {
        const content = await readFile(env, p);
        if (content) {
          return { content: [{ type: "text" as const, text: content }] };
        }
      }
      const files = await listDir(env, "hubs");
      return {
        content: [
          {
            type: "text" as const,
            text: `Hub "${domain}" not found. Available:\n${files.join("\n")}`,
          },
        ],
      };
    }
  );

  // ── get_rules ─────────────────────────────────────────────
  server.tool(
    "get_rules",
    "Load MEMORY_EDITS.md — behavioral rules and memory edit directives.",
    {},
    { title: "Read Behavior Rules", readOnlyHint: true, openWorldHint: true },
    async () => {
      const content = await readFile(env, "MEMORY_EDITS.md");
      return {
        content: [
          { type: "text" as const, text: content || "MEMORY_EDITS.md not found" },
        ],
      };
    }
  );

  // ── list_files ────────────────────────────────────────────
  server.tool(
    "list_files",
    "List files and folders in a directory of the memory repo.",
    {
      path: z.string().default("").describe("Directory path relative to repo root"),
    },
    { title: "List Files in a Directory", readOnlyHint: true, openWorldHint: true },
    async ({ path }) => {
      const files = await listDir(env, path || "");
      return {
        content: [
          {
            type: "text" as const,
            text: files.length > 0 ? files.join("\n") : `No files at "${path}"`,
          },
        ],
      };
    }
  );

  // ── read_file ─────────────────────────────────────────────
  server.tool(
    "read_file",
    "Read any file from the memory repo by path. Pass fresh=true to bypass the D1 cache and read straight from GitHub main (use for correctness-critical reads that must reflect an out-of-band push).",
    {
      path: z.string().describe("File path relative to repo root"),
      fresh: z.boolean().default(false).describe("Bypass the D1 cache; read straight from GitHub main and refresh the cache. Default false (cache-first)."),
    },
    { title: "Read a Memory File", readOnlyHint: true, openWorldHint: true },
    async ({ path, fresh }) => {
      const content = await readFile(env, path, fresh);
      return {
        content: [
          { type: "text" as const, text: content || `File not found: ${path}` },
        ],
      };
    }
  );

  // ── search ────────────────────────────────────────────────
  server.tool(
    "search",
    "Search across all files in the memory repo using GitHub code search.",
    { query: z.string().describe("Search query — keywords, names, topics") },
    { title: "Search All Memory Files", readOnlyHint: true, openWorldHint: true },
    async ({ query }) => {
      const results = await searchRepo(env, query);
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No results for "${query}"` }],
        };
      }
      const text = results
        .map((r) => `## ${r.path}\n${r.snippet}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── update_file ───────────────────────────────────────────
  server.tool(
    "update_file",
    "Write or update a file. Default repo = claude-memory; pass repo='OWNER/spanish-portal' to update Spanish portal data files (errors.json, plan.json, vocab.json, etc.) — the portal will rebuild + redeploy automatically. Allowed repos: claude-memory, spanish-portal, user-site.example. Set async_mode=true to return immediately.",
    {
      path: z.string().describe("File path relative to repo root"),
      content: z.string().describe("Full file content to write"),
      commit_message: z.string().default("update via claude-memory-mcp").describe("Git commit message"),
      async_mode: z.boolean().default(false).describe("Fire-and-forget mode — returns immediately and commits via ctx.waitUntil. Contradiction check is skipped. Useful for bulk updates."),
      repo: z.string().optional().describe("Override target repo (e.g. 'OWNER/spanish-portal'). Default: claude-memory."),
    },
    { title: "Write or Update a Memory File", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async ({ path, content, commit_message, async_mode, repo }) => {
      if (async_mode && ctx) {
        // Fire-and-forget: schedule the write on the worker's background
        // queue and return immediately. No contradiction check — async mode
        // is for bulk updates where latency matters more than warnings.
        //
        // IMPORTANT: KG enrichment MUST run in the same background task when
        // the write targets a hub. Prior implementation (pre-2026-04-19) only
        // ran enrichment in the sync path — async bulk-updates silently
        // skipped KG enrichment, so the graph grew stale for any hub touched
        // via async_mode (P3-L Phase 4 kg_enrichment_hook test covers the
        // source-level invariant; this closes the runtime gap).
        ctx.waitUntil(
          (async () => {
            const result = await writeFile(env, path, content, commit_message, repo);
            if (!result.success) {
              console.warn(`update_file async: writeFile failed (${path}):`, result.error);
              return;
            }
            if (path.startsWith("hubs/")) {
              try {
                await autoEnrichKG(env.DB, path, content);
              } catch (e) {
                console.warn(`update_file async: autoEnrichKG failed (${path}):`, (e as Error)?.message ?? e);
              }
            }
          })()
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Queued async write: ${path} (commit + KG enrichment via ctx.waitUntil)`,
            },
          ],
        };
      }
      if (async_mode && !ctx) {
        // Caller asked for async, but the handler wasn't given an
        // ExecutionContext (shouldn't happen — MCP SDK always passes ctx).
        // Fail loud rather than silently fall through to sync path, which
        // would break the caller's latency expectations.
        return {
          content: [
            {
              type: "text" as const,
              text: "async_mode=true requires ExecutionContext — falling through would change latency semantics silently. Call again without async_mode or investigate.",
            },
          ],
        };
      }
      const result = await writeFile(env, path, content, commit_message, repo);
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }] };
      }
      // Skip claude-memory-specific enrichment when writing to a different
      // repo — contradiction check + KG enrichment only make sense for hub
      // content in the memory repo.
      const writingToMemory = !repo || repo === env.GITHUB_REPO;
      const [contradictions, kgAdded] = writingToMemory
        ? await Promise.all([
            checkContradictions(env.DB, content),
            autoEnrichKG(env.DB, path, content).catch(() => 0),
          ])
        : [[] as string[], 0];
      let response = repo && repo !== env.GITHUB_REPO
        ? `Committed to ${repo}: ${path}\nMessage: ${commit_message}`
        : `Committed: ${path}\nMessage: ${commit_message}`;
      if (kgAdded > 0) {
        response += `\n📊 KG auto-enriched: ${kgAdded} triple(s) extracted from hub content.`;
      }
      if (contradictions.length > 0) {
        response += `\n\n⚠️ KG cross-check (review, not blocking):\n${contradictions.join("\n")}`;
      }
      return { content: [{ type: "text" as const, text: response }] };
    }
  );

  // ── wake_up ───────────────────────────────────────────────
  server.tool(
    "wake_up",
    "Load everything for session start in ONE call. Use compact=true for a ~200 token compressed version (good for iPad/slow connections).",
    {
      compact: z.boolean().default(false).describe("If true, return compressed ~200 token snapshot instead of full"),
      surface: z.string().default("unknown").describe("Calling surface: chat, code, cowork, mobile, ipad"),
    },
    { title: "Load Memory at Session Start", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ compact, surface }) => {
      if (compact) {
        const compressed = await readFile(env, "STATUS_COMPRESSED.md");
        if (compressed) {
          return { content: [{ type: "text" as const, text: compressed }] };
        }
        // Fallback to full if compressed file doesn't exist
      }

      const [snapshot, rules, hubFiles, recentFacts, sessionCount, recentMeetings, recentTg, recentSessions, openBlockers] = await Promise.all([
        readFile(env, "STATUS_SNAPSHOT.md"),
        readFile(env, "MEMORY_EDITS.md"),
        listDir(env, "hubs"),
        env.DB
          .prepare("SELECT domain, entity, attribute, value FROM facts WHERE entity != 'meta' ORDER BY updated_at DESC LIMIT 10")
          .all()
          .then((r) => r.results as Array<{ domain: string; entity: string; attribute: string; value: string }>)
          .catch(() => [] as Array<{ domain: string; entity: string; attribute: string; value: string }>),
        env.DB
          .prepare("SELECT COUNT(*) as cnt FROM sessions WHERE created_at > datetime('now', '-7 days')")
          .first()
          .then((r) => (r as { cnt: number } | null)?.cnt ?? 0)
          .catch(() => 0),
        env.DB
          .prepare("SELECT id, title, date, domain, action_items, decisions FROM granola_meetings ORDER BY date DESC LIMIT 5")
          .all()
          .then((r) => r.results as Array<{ id: string; title: string; date: string; domain: string; action_items: string; decisions: string }>)
          .catch(() => [] as Array<{ id: string; title: string; date: string; domain: string; action_items: string; decisions: string }>),
        // Recent Telegram bot messages — written by the claude-telegram-bot
        // worker into the same D1. Catch errors if the table doesn't exist
        // yet (bot hasn't received any messages). No-op on empty.
        env.DB
          .prepare("SELECT update_id, date, kind, text, forward_label, claude_reply FROM telegram_messages ORDER BY date DESC LIMIT 5")
          .all()
          .then((r) => r.results as Array<{ update_id: number; date: number; kind: string; text: string | null; forward_label: string | null; claude_reply: string | null }>)
          .catch(() => [] as Array<{ update_id: number; date: number; kind: string; text: string | null; forward_label: string | null; claude_reply: string | null }>),
        // Last 3 cross-surface sessions — gives Chat/TG/Cowork/mobile
        // visibility into what the other surfaces have been doing. Was just
        // a COUNT before (only a nudge to auto_log); now we actually show
        // surface + summary + date so a new session opens with the thread.
        env.DB
          .prepare("SELECT surface, summary, created_at FROM sessions ORDER BY created_at DESC LIMIT 3")
          .all()
          .then((r) => r.results as Array<{ surface: string; summary: string; created_at: string }>)
          .catch(() => [] as Array<{ surface: string; summary: string; created_at: string }>),
        // Open blockers across both durability surfaces: TG retry-exhausted
        // rows + unresolved high/critical errors. One round-trip via a
        // compound SELECT. Rendered only if either count is non-zero.
        env.DB
          .prepare(`
            SELECT
              (SELECT COUNT(*) FROM telegram_messages WHERE status='failed' AND retry_count>=3) as tg_failed,
              (SELECT COUNT(*) FROM errors WHERE resolved=0 AND severity IN ('high','critical')) as errors_open,
              (SELECT CAST(julianday('now') - julianday(MAX(created_at)) AS INTEGER) FROM telegram_messages) as tg_inbound_age
          `)
          .first()
          .then((r) => r as { tg_failed: number; errors_open: number; tg_inbound_age: number | null } | null)
          .catch(() => null),
      ]);

      const parts: string[] = [];
      parts.push("=== STATUS_SNAPSHOT ===");
      parts.push(snapshot || "(not found)");
      parts.push("\n=== MEMORY_EDITS ===");
      parts.push(rules || "(not found)");
      parts.push("\n=== AVAILABLE HUBS ===");
      parts.push(hubFiles.length > 0 ? hubFiles.join("\n") : "(none)");
      if (recentFacts.length > 0) {
        parts.push("\n=== RECENT FACTS (D1) ===");
        parts.push(
          recentFacts
            .map((f) => `- [${f.domain}/${f.entity}] ${f.attribute}: ${f.value}`)
            .join("\n")
        );
      }
      if (recentMeetings.length > 0) {
        parts.push("\n=== RECENT GRANOLA MEETINGS ===");
        for (const m of recentMeetings) {
          let line = `- **${m.title}** (${m.date.slice(0, 10)}, ${m.domain}) [id: \`${m.id}\`]`;
          try { const a = JSON.parse(m.action_items); if (a.length > 0) line += ` — Actions: ${a.slice(0, 2).join("; ")}`; } catch { /* skip */ }
          try { const d = JSON.parse(m.decisions); if (d.length > 0) line += ` | Decisions: ${d.slice(0, 2).join("; ")}`; } catch { /* skip */ }
          parts.push(line);
        }
        parts.push("\n_Pipe meeting_id into `granola_transcript` for full verbatim text._");
      }
      if (recentTg.length > 0) {
        parts.push("\n=== RECENT TELEGRAM (personal bot) ===");
        for (const t of recentTg) {
          const when = new Date(t.date * 1000).toISOString().slice(0, 16).replace("T", " ");
          const body = t.text ? t.text.slice(0, 200) : `[${t.kind}]`;
          const fwd = t.forward_label ? ` · fwd ${t.forward_label}` : "";
          const reply = t.claude_reply ? ` | bot→ ${t.claude_reply.slice(0, 120)}` : "";
          parts.push(`- [${when}] #${t.update_id} ${t.kind}${fwd}: ${body}${reply}`);
        }
        parts.push("  Use `tg_recent` / `tg_search` / `tg_get` for more.");
      }
      if (recentSessions.length > 0) {
        parts.push("\n=== RECENT SESSIONS (cross-surface) ===");
        for (const s of recentSessions) {
          const when = (s.created_at || "").slice(0, 16).replace("T", " ");
          const summary = (s.summary || "").slice(0, 160);
          parts.push(`- [${when}] ${s.surface}: ${summary}`);
        }
        parts.push("  Use `recent_sessions` for more.");
      }
      // Ingest-freshness guard (2026-07-07): the June'26 webhook freeze went
      // unnoticed for a month because DLQ stayed green while the ingest pipe
      // was dead (worker 404'ing every delivery). Surface staleness here so
      // ANY surface calling wake_up sees a dead pipe within days, not weeks.
      const tgIngestStale = (openBlockers?.tg_inbound_age ?? 0) >= 7;
      if (openBlockers && ((openBlockers.tg_failed ?? 0) > 0 || (openBlockers.errors_open ?? 0) > 0 || tgIngestStale)) {
        parts.push("\n=== OPEN BLOCKERS ===");
        if ((openBlockers.tg_failed ?? 0) > 0) {
          parts.push(`- ⚠️ ${openBlockers.tg_failed} Telegram messages stuck in retry limit (status='failed', retry_count>=3). Inspect via tg_search or D1.`);
        }
        if (tgIngestStale) {
          parts.push(`- ⚠️ TG inbound frozen? No message ingested for ${openBlockers.tg_inbound_age} days. Could be genuine silence, but the June'26 freeze looked exactly like this (webhook secret desync → worker 404s every delivery). Run tg_dlq_report — it probes getWebhookInfo live. Fix on Mac: config/telegram-bot/rotate-webhook-secret.sh.`);
        }
        if ((openBlockers.errors_open ?? 0) > 0) {
          parts.push(`- ⚠️ ${openBlockers.errors_open} unresolved high/critical errors. Call error_report(unresolved_only=true) for details.`);
        }
      }
      if (sessionCount < 3) {
        parts.push("\n⚠️ SESSION LOGGING: Only " + sessionCount + " session(s) in last 7 days. Call auto_log before ending this conversation.");
      }

      // Surface sync tracking — stores a per-surface heartbeat as
      // (entity='meta', attribute='last_sync_<surface>') upserted via
      // ON CONFLICT on the (entity, attribute) unique index.
      const syncAttr = `last_sync_${surface}`;
      const prevSync = await env.DB
        .prepare("SELECT value FROM facts WHERE entity = 'meta' AND attribute = ?")
        .bind(syncAttr)
        .first()
        .then((r) => (r as { value: string } | null)?.value)
        .catch(() => null);

      await env.DB
        .prepare("INSERT INTO facts (domain, entity, attribute, value, source) VALUES ('memory', 'meta', ?, datetime('now'), 'wake_up') ON CONFLICT(entity, attribute) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')")
        .bind(syncAttr)
        .run()
        .catch((e) => {
          // Best-effort timestamp — wake_up must still return snapshot even
          // if the write fails. But swallowing silently masked a 2026-04-11
          // class of bugs where the UNIQUE index was missing and every wake_up
          // thought it was the first one. Log with the attribute name.
          console.warn(`wake_up: meta-fact upsert failed (${syncAttr}):`, (e as Error)?.message ?? e);
        });

      if (prevSync) {
        const newSessions = await env.DB
          .prepare("SELECT COUNT(*) as cnt FROM sessions WHERE created_at > ?")
          .bind(prevSync)
          .first()
          .then((r) => (r as { cnt: number } | null)?.cnt ?? 0)
          .catch(() => 0);
        parts.push(`\n=== SURFACE SYNC ===\nSurface: ${surface}. Last sync: ${prevSync}. Sessions since: ${newSessions}.`);
      } else {
        parts.push(`\n=== SURFACE SYNC ===\nSurface: ${surface}. First sync.`);
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    }
  );

  // ── get_taxonomy ──────────────────────────────────────────
  server.tool(
    "get_taxonomy",
    "Get full repo structure: root files + hubs + references + skills.",
    {},
    { title: "List Repo Structure", readOnlyHint: true, openWorldHint: true },
    async () => {
      const [root, hubs, refs, skills, logs] = await Promise.all([
        listDir(env, ""),
        listDir(env, "hubs"),
        listDir(env, "references"),
        listDir(env, "skills"),
        listDir(env, "logs"),
      ]);
      const parts = [
        "=== ROOT ===",
        root.join("\n"),
        "\n=== HUBS ===",
        hubs.length > 0 ? hubs.join("\n") : "(empty)",
        "\n=== REFERENCES ===",
        refs.length > 0 ? refs.join("\n") : "(empty)",
        "\n=== SKILLS ===",
        skills.length > 0 ? skills.join("\n") : "(empty)",
        "\n=== LOGS ===",
        logs.length > 0 ? logs.join("\n") : "(empty)",
      ];
      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    }
  );

  // ── store_fact (D1 — EAV schema) ──────────────────────────
  // Live facts table uses (domain, entity, attribute, value) — a classic
  // entity-attribute-value triple model. This tool maps the legacy
  // (key, value, domain) API onto it: key → attribute, entity defaults
  // to 'general' unless explicitly provided. Upsert is keyed on
  // (entity, attribute) via idx_facts_entity_attr unique index.
  server.tool(
    "store_fact",
    "Store a fact in D1. Upserts on (entity, attribute). Pass just `key`+`value` for a simple store under entity='general', or specify `entity` to group related facts under one subject.",
    {
      key: z.string().describe("Fact key (maps to 'attribute' column), e.g. 'diet', 'location', 'status'"),
      value: z.string().describe("Fact value"),
      domain: z.string().optional().describe("Domain: [pet], [employer-ad-network], [side-project], relocation, meta, etc. Defaults to 'general'."),
      entity: z.string().optional().describe("Entity/subject (maps to 'entity' column), e.g. '[pet]', 'user', '[side-project]'. Defaults to 'general'."),
      source: z.string().optional().describe("Source of fact: hub08, conversation, etc."),
    },
    { title: "Save a Fact", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ key, value, domain, entity, source }) => {
      try {
        await ensureTables(env.DB);
        const finalEntity = (entity && entity.trim()) || "general";
        const finalDomain = (domain && domain.trim()) || "general";
        const existing = await env.DB
          .prepare("SELECT id FROM facts WHERE entity = ? AND attribute = ?")
          .bind(finalEntity, key)
          .first();
        if (existing) {
          await env.DB
            .prepare("UPDATE facts SET value = ?, domain = ?, source = ?, updated_at = datetime('now') WHERE entity = ? AND attribute = ?")
            .bind(value, finalDomain, source || null, finalEntity, key)
            .run();
          return { content: [{ type: "text" as const, text: `Updated fact: [${finalDomain}/${finalEntity}] ${key} = ${value}` }] };
        } else {
          await env.DB
            .prepare("INSERT INTO facts (domain, entity, attribute, value, source) VALUES (?, ?, ?, ?, ?)")
            .bind(finalDomain, finalEntity, key, value, source || null)
            .run();
          return { content: [{ type: "text" as const, text: `Stored fact: [${finalDomain}/${finalEntity}] ${key} = ${value}` }] };
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error storing fact: ${e}` }] };
      }
    }
  );

  // ── remember (D1 — EAV schema) — auto-extract fact ───────
  // Parses free-text into an (entity, attribute, value) triple using three
  // patterns. Falls back to a timestamped note_* attribute under entity='note'.
  server.tool(
    "remember",
    "Store a fact using free-text input. Auto-extracts the triple from patterns like 'entity.attr = value', 'attr: value', or 'entity is value'. Falls back to a timestamped note for unstructured input. Cheaper than store_fact when you just want to jot something down.",
    {
      text: z.string().describe("Free-text fact, e.g. '[pet].diet = renal LP', 'user is in Belgrade until June', 'experiment X shipped Q2'"),
      domain: z.string().optional().describe("Domain hint: [pet], [employer-ad-network], [side-project], relocation, spanish, finance, blog"),
    },
    { title: "Save a Fact (auto-detect from text)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ text, domain }) => {
      try {
        await ensureTables(env.DB);
        const trimmed = text.trim();
        let entity: string = "general";
        let attribute: string | null = null;
        let value: string = trimmed;

        // Pattern 0: "entity.attribute = value" or "entity.attribute: value"
        const eavMatch = trimmed.match(/^([a-zA-Zа-яА-Я0-9_-]{1,30})\.([a-zA-Zа-яА-Я0-9_ -]{1,40}?)\s*[=:]\s*(.+)$/);
        if (eavMatch) {
          entity = eavMatch[1].trim().toLowerCase();
          attribute = eavMatch[2].trim().toLowerCase().replace(/\s+/g, "_");
          value = eavMatch[3].trim();
        }

        // Pattern 1: "attribute = value" or "attribute: value" (entity stays 'general')
        if (!attribute) {
          const kvMatch = trimmed.match(/^([a-zA-Zа-яА-Я0-9_ -]{1,40}?)\s*[=:]\s*(.+)$/);
          if (kvMatch) {
            attribute = kvMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
            value = kvMatch[2].trim();
          }
        }

        // Pattern 2: "Entity is/are/was/were Y" — Entity becomes entity, attribute='is'
        if (!attribute) {
          const isMatch = trimmed.match(/^([A-ZА-Яa-zа-я][a-zа-яA-ZА-Я0-9_ -]{1,40}?)\s+(is|are|was|were|был|была|было|были|есть)\s+(.+)$/i);
          if (isMatch) {
            entity = isMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
            attribute = isMatch[2].toLowerCase();
            value = isMatch[3].trim();
          }
        }

        // Fallback: timestamped note — never overwrites existing data
        if (!attribute) {
          const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
          entity = "note";
          attribute = `note_${ts}`;
        }

        // Auto-detect domain from value if not provided
        const autoDomain = domain || (
          /\b([pet]|дог|pet|renal|urinary|vet|epilep)/i.test(trimmed) ? "[pet]" :
          /\b([employer-ad-network]|рся|experiment|эксперимент|автораст|нейро|overlay)/i.test(trimmed) ? "[employer-ad-network]" :
          /\b([side-project]|stripe|twilio|whatsapp|glovo)/i.test(trimmed) ? "[side-project]" :
          /\b(bcn|barcelona|relocation|visa|eurobelka|аренда)/i.test(trimmed) ? "relocation" :
          /\b(spanish|español|judit|dele|b1|b2)/i.test(trimmed) ? "spanish" :
          "general"
        );

        const existing = await env.DB
          .prepare("SELECT id FROM facts WHERE entity = ? AND attribute = ?")
          .bind(entity, attribute)
          .first();
        if (existing) {
          await env.DB
            .prepare("UPDATE facts SET value = ?, domain = ?, source = ?, updated_at = datetime('now') WHERE entity = ? AND attribute = ?")
            .bind(value, autoDomain, "remember", entity, attribute)
            .run();
          return { content: [{ type: "text" as const, text: `Updated: [${autoDomain}/${entity}] ${attribute} = ${value}` }] };
        } else {
          await env.DB
            .prepare("INSERT INTO facts (domain, entity, attribute, value, source) VALUES (?, ?, ?, ?, ?)")
            .bind(autoDomain, entity, attribute, value, "remember")
            .run();
          return { content: [{ type: "text" as const, text: `Remembered: [${autoDomain}/${entity}] ${attribute} = ${value}` }] };
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }] };
      }
    }
  );

  // ── forget_fact (D1 — EAV schema) — explicit deletion ────
  server.tool(
    "forget_fact",
    "Delete a fact from D1. Matches on (entity, attribute) — if `entity` is omitted, defaults to 'general'. Returns the count of rows deleted.",
    {
      key: z.string().describe("Fact attribute to delete, e.g. 'diet', 'location', 'note_20260411T1729'"),
      entity: z.string().optional().describe("Entity/subject (defaults to 'general'). Pass '*' to delete all facts with this attribute regardless of entity."),
    },
    { title: "Delete a Fact", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ key, entity }) => {
      try {
        await ensureTables(env.DB);
        let result;
        if (entity === "*") {
          result = await env.DB.prepare("DELETE FROM facts WHERE attribute = ?").bind(key).run();
        } else {
          const finalEntity = (entity && entity.trim()) || "general";
          result = await env.DB
            .prepare("DELETE FROM facts WHERE entity = ? AND attribute = ?")
            .bind(finalEntity, key)
            .run();
        }
        const deleted = result.meta?.changes ?? 0;
        if (deleted === 0) {
          return { content: [{ type: "text" as const, text: `No fact matching ${entity === "*" ? `*/${key}` : `${entity || "general"}/${key}`} — nothing to forget.` }] };
        }
        return { content: [{ type: "text" as const, text: `Forgot ${deleted} fact(s) matching ${entity === "*" ? `*/${key}` : `${entity || "general"}/${key}`}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error forgetting fact: ${e}` }] };
      }
    }
  );

  // ── query_facts (D1 — EAV schema) ────────────────────────
  server.tool(
    "query_facts",
    "Query facts from D1. Filter by attribute pattern (`key`), entity, or domain. Returns facts ordered by updated_at DESC.",
    {
      key: z.string().optional().describe("Attribute filter — exact or LIKE pattern (use % for wildcard), e.g. 'diet', 'last_sync_%'"),
      entity: z.string().optional().describe("Entity filter — exact match, e.g. '[pet]', 'user'"),
      domain: z.string().optional().describe("Domain filter — exact match, e.g. '[pet]', '[employer-ad-network]'"),
      limit: z.coerce.number().default(20).describe("Max results"),
    },
    { title: "Search Saved Facts", readOnlyHint: true, openWorldHint: false },
    async ({ key, entity, domain, limit }) => {
      try {
        await ensureTables(env.DB);
        const where: string[] = ["1=1"];
        const params: (string | number)[] = [];
        if (key) {
          if (key.includes("%")) {
            where.push("attribute LIKE ?");
          } else {
            where.push("attribute = ?");
          }
          params.push(key);
        }
        if (entity) {
          where.push("entity = ?");
          params.push(entity);
        }
        if (domain) {
          where.push("domain = ?");
          params.push(domain);
        }
        const sql = `SELECT domain, entity, attribute, value, source, updated_at FROM facts WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`;
        params.push(limit);

        const results = await env.DB.prepare(sql).bind(...params).all();
        const rows = results.results as Array<{
          domain: string;
          entity: string;
          attribute: string;
          value: string;
          source: string | null;
          updated_at: string;
        }>;

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: "No facts found matching query." }] };
        }

        const text = rows
          .map((r) => `[${r.domain}/${r.entity}] ${r.attribute}: ${r.value} (${r.updated_at}, src: ${r.source || "unknown"})`)
          .join("\n");
        return { content: [{ type: "text" as const, text: `${rows.length} fact(s):\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error querying facts: ${e}` }] };
      }
    }
  );

  // ── log_session (D1) ──────────────────────────────────────
  server.tool(
    "log_session",
    "Log a conversation session summary to D1. Call at session end.",
    {
      surface: z.string().describe("Surface: chat, code, cowork, mobile"),
      summary: z.string().describe("Brief session summary"),
      topics: z.string().optional().describe("Comma-separated topics discussed"),
    },
    { title: "Log This Session (full form)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ surface, summary, topics }) => {
      try {
        await ensureTables(env.DB);
        await env.DB
          .prepare("INSERT INTO sessions (surface, summary, topics, started_at) VALUES (?, ?, ?, datetime('now'))")
          .bind(surface, summary, topics || null)
          .run();
        return { content: [{ type: "text" as const, text: `Session logged: [${surface}] ${summary}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error logging session: ${e}` }] };
      }
    }
  );

  // ── recent_sessions (D1) ──────────────────────────────────
  // Per RULES §14, this tool was extended in-place (no new top-level tool) to
  // also serve Spanish-portal telemetry. Pass source="portal" to read from the
  // portal_events table instead of the default sessions table.
  server.tool(
    "recent_sessions",
    "Get recent session logs from D1. source='sessions' (default) returns Claude session logs; source='portal' returns s.user-site.example telemetry events (page_view, section_view, drill_attempt, …). Use the portal mode after a Spanish lesson to see which topics User actually engaged with between lessons.",
    {
      limit: z.coerce.number().default(10).describe("Number of rows to return"),
      surface: z.string().optional().describe("(sessions only) Filter by surface"),
      source: z.enum(["sessions", "portal"]).optional().describe("Data source: 'sessions' (default) or 'portal' for Spanish-portal telemetry"),
      kind: z.string().optional().describe("(portal only) Filter by event kind: page_view, section_view, drill_attempt, drill_correct, drill_wrong, …"),
      since_hours: z.coerce.number().optional().describe("(portal only) Only events from the last N hours (default 168 = 7d)"),
    },
    { title: "List Recent Sessions / Portal Events", readOnlyHint: true, openWorldHint: false },
    async ({ limit, surface, source, kind, since_hours }) => {
      try {
        await ensureTables(env.DB);

        // Portal telemetry mode
        if (source === "portal") {
          const conds: string[] = [];
          const args: (string | number)[] = [];
          if (kind) { conds.push("kind = ?"); args.push(kind); }
          const sinceMs = Date.now() - (since_hours ?? 168) * 3600 * 1000;
          conds.push("ts >= ?"); args.push(sinceMs);

          const lim = Math.max(1, Math.min(limit ?? 100, 500));
          const sql = `SELECT ts, kind, sid, data FROM portal_events WHERE ${conds.join(" AND ")} ORDER BY ts DESC LIMIT ?`;
          args.push(lim);

          const stmt = env.DB.prepare(sql).bind(...args);
          const r = await stmt.all();
          const rows = r.results as Array<{ ts: number; kind: string; sid: string; data: string }>;

          if (rows.length === 0) {
            return { content: [{ type: "text" as const, text: `No portal events in last ${since_hours ?? 168}h.` }] };
          }

          // Aggregate: kind counts + top paths + drill accuracy
          const kindCounts: Record<string, number> = {};
          const pathCounts: Record<string, number> = {};
          const sectionCounts: Record<string, number> = {};
          let drillCorrect = 0, drillWrong = 0;
          for (const row of rows) {
            kindCounts[row.kind] = (kindCounts[row.kind] || 0) + 1;
            try {
              const d = JSON.parse(row.data);
              if (d.path) pathCounts[d.path] = (pathCounts[d.path] || 0) + 1;
              if (row.kind === "section_view" && d.summary) {
                sectionCounts[d.summary] = (sectionCounts[d.summary] || 0) + 1;
              }
              if (row.kind === "drill_correct") drillCorrect++;
              if (row.kind === "drill_wrong") drillWrong++;
            } catch { /* skip malformed */ }
          }
          const kindSummary = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}=${c}`).join(", ");
          const topPaths = Object.entries(pathCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, c]) => `${c}× ${p}`).join("\n  ");
          const topSections = Object.entries(sectionCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, c]) => `${c}× ${s}`).join("\n  ");
          const drillTotal = drillCorrect + drillWrong;
          const drillLine = drillTotal > 0 ? `\nDrill accuracy: ${drillCorrect}/${drillTotal} (${Math.round(100 * drillCorrect / drillTotal)}%)` : "";

          const sample = rows.slice(0, 30).map((r) => {
            const d = new Date(r.ts).toISOString().slice(0, 19).replace("T", " ");
            return `${d} [${r.kind}] sid=${r.sid.slice(0, 6)} ${r.data}`;
          }).join("\n");

          const text =
            `${rows.length} portal events (last ${since_hours ?? 168}h)\n` +
            `Kinds: ${kindSummary}${drillLine}\n` +
            (topPaths ? `\nTop paths:\n  ${topPaths}\n` : "") +
            (topSections ? `\nTop sections opened:\n  ${topSections}\n` : "") +
            `\nLatest events:\n${sample}`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Default: sessions mode (original behaviour)
        let sql = "SELECT surface, summary, topics, started_at, created_at FROM sessions";
        const params: (string | number)[] = [];
        if (surface) {
          sql += " WHERE surface = ?";
          params.push(surface);
        }
        sql += " ORDER BY created_at DESC LIMIT ?";
        params.push(limit ?? 10);

        let stmt = env.DB.prepare(sql);
        if (params.length === 1) stmt = stmt.bind(params[0]);
        else if (params.length === 2) stmt = stmt.bind(params[0], params[1]);

        const results = await stmt.all();
        const rows = results.results as Array<{
          surface: string;
          summary: string;
          topics: string | null;
          started_at: string | null;
          created_at: string;
        }>;

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: "No sessions logged yet." }] };
        }

        const text = rows
          .map(
            (r) =>
              `[${r.surface}] ${r.created_at}: ${r.summary}${r.topics ? ` (${r.topics})` : ""}`
          )
          .join("\n");
        return { content: [{ type: "text" as const, text: `${rows.length} recent session(s):\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error querying sessions: ${e}` }] };
      }
    }
  );

  // ── auto_log (D1) — lightweight session close ─────────────
  server.tool(
    "auto_log",
    "Quick session log — just pass a one-line summary. Auto-detects surface as 'chat'. Use at end of any meaningful conversation.",
    {
      summary: z.string().describe("One-line session summary, e.g. 'debugged MCP auth, deployed v2.1'"),
      surface: z.string().default("chat").describe("Surface override if needed: chat, code, cowork, mobile"),
    },
    { title: "Log This Session", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ summary, surface }) => {
      try {
        await ensureTables(env.DB);
        await env.DB
          .prepare("INSERT INTO sessions (surface, summary, started_at) VALUES (?, ?, datetime('now'))")
          .bind(surface, summary)
          .run();
        return { content: [{ type: "text" as const, text: `✓ Session logged: [${surface}] ${summary}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }] };
      }
    }
  );

  // ── log_error (D1 — live schema) ──────────────────────────
  // Live errors table: (error_type, description, domain, severity, resolved).
  // Maps legacy (tool, message, context) → (error_type=tool, description=
  // message+context, severity='medium'). Previously shipped with the wrong
  // schema; fixed in v2.4.1.
  server.tool(
    "log_error",
    "Log an error to D1 for debugging. Use when a tool fails or unexpected behavior occurs.",
    {
      tool: z.string().optional().describe("Tool name or error type (maps to 'error_type' column)"),
      message: z.string().describe("Error message (maps to 'description' column)"),
      context: z.string().optional().describe("Additional context — appended to description"),
      domain: z.string().optional().describe("Domain hint for scoping"),
      severity: z.enum(["low", "medium", "high", "critical"]).default("medium").describe("Error severity"),
    },
    { title: "Report an Error", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ tool, message, context, domain, severity }) => {
      try {
        await ensureTables(env.DB);
        const errorType = (tool && tool.trim()) || "unknown";
        const description = context ? `${message} | ctx: ${context}` : message;
        await env.DB
          .prepare("INSERT INTO errors (error_type, description, domain, severity) VALUES (?, ?, ?, ?)")
          .bind(errorType, description, domain || null, severity)
          .run();
        return { content: [{ type: "text" as const, text: `Error logged: [${errorType}] (${severity}) ${message}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to log error: ${e}` }] };
      }
    }
  );

  // ── error_report (D1 — live schema) ───────────────────────
  server.tool(
    "error_report",
    "Get recent errors from D1. Useful for debugging persistent issues.",
    {
      limit: z.coerce.number().default(10).describe("Number of recent errors"),
      tool: z.string().optional().describe("Filter by tool / error_type"),
      unresolved_only: z.boolean().default(false).describe("Only show errors where resolved=0"),
    },
    { title: "Search Error Log", readOnlyHint: true, openWorldHint: false },
    async ({ limit, tool, unresolved_only }) => {
      try {
        await ensureTables(env.DB);
        const where: string[] = ["1=1"];
        const params: (string | number)[] = [];
        if (tool) {
          where.push("error_type = ?");
          params.push(tool);
        }
        if (unresolved_only) {
          where.push("resolved = 0");
        }
        const sql = `SELECT error_type, description, domain, severity, resolved, created_at FROM errors WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);

        const results = await env.DB.prepare(sql).bind(...params).all();
        const rows = results.results as Array<{
          error_type: string;
          description: string;
          domain: string | null;
          severity: string;
          resolved: number;
          created_at: string;
        }>;

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: "No errors logged." }] };
        }

        const text = rows
          .map(
            (r) =>
              `[${r.error_type}] (${r.severity}${r.resolved ? ", resolved" : ""}) ${r.created_at}: ${r.description}${r.domain ? ` {${r.domain}}` : ""}`
          )
          .join("\n");
        return { content: [{ type: "text" as const, text: `${rows.length} error(s):\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error querying errors: ${e}` }] };
      }
    }
  );

  // ── flush_cache ───────────────────────────────────────────
  server.tool(
    "flush_cache",
    "Clear any cached state. Useful after manual repo edits or when data seems stale.",
    {},
    { title: "Clear Cached Data", readOnlyHint: true, openWorldHint: false },
    async () => {
      // Workers are stateless between requests, so this is a no-op signal.
      // Its main purpose is to serve as a semantic hint that the caller
      // wants fresh data on subsequent calls.
      return {
        content: [
          {
            type: "text" as const,
            text: "Cache flushed. Next calls will fetch fresh data from GitHub and D1.",
          },
        ],
      };
    }
  );

  // ── kg_add (D1 — Knowledge Graph) ────────────────────────
  server.tool(
    "kg_add",
    "Add a temporal triple to the knowledge graph. Upserts by subject+predicate.",
    {
      subject: z.string().describe("Entity, e.g. '[pet]', 'user', '[side-project]'"),
      predicate: z.string().describe("Relationship, e.g. 'diet', 'location', 'on_leave'"),
      object: z.string().describe("Value, e.g. 'Royal Canin Renal', 'Belgrade'"),
      valid_from: z.string().describe("Start date ISO, e.g. '2026-04-01'"),
      valid_until: z.string().optional().describe("End date ISO, or omit for ongoing"),
      source: z.string().optional().describe("Source reference, e.g. 'hub08', 'conversation'"),
    },
    { title: "Add to Knowledge Graph", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ subject, predicate, object, valid_from, valid_until, source }) => {
      try {
        await ensureTables(env.DB);
        const existing = await env.DB
          .prepare("SELECT id FROM knowledge_graph WHERE subject = ? AND predicate = ?")
          .bind(subject.toLowerCase(), predicate.toLowerCase())
          .first();

        if (existing) {
          await env.DB
            .prepare(
              "UPDATE knowledge_graph SET object = ?, valid_from = ?, valid_until = ?, source = ? WHERE subject = ? AND predicate = ?"
            )
            .bind(
              object,
              valid_from,
              valid_until || null,
              source || null,
              subject.toLowerCase(),
              predicate.toLowerCase()
            )
            .run();
          return {
            content: [
              { type: "text" as const, text: `Updated: ${subject} --${predicate}--> ${object} [${valid_from}${valid_until ? " to " + valid_until : "+"}]` },
            ],
          };
        } else {
          await env.DB
            .prepare(
              "INSERT INTO knowledge_graph (subject, predicate, object, valid_from, valid_until, source) VALUES (?, ?, ?, ?, ?, ?)"
            )
            .bind(
              subject.toLowerCase(),
              predicate.toLowerCase(),
              object,
              valid_from,
              valid_until || null,
              source || null
            )
            .run();
          return {
            content: [
              { type: "text" as const, text: `Added: ${subject} --${predicate}--> ${object} [${valid_from}${valid_until ? " to " + valid_until : "+"}]` },
            ],
          };
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error adding to KG: ${e}` }] };
      }
    }
  );

  // ── kg_query (D1 — Knowledge Graph) ──────────────────────
  server.tool(
    "kg_query",
    "Query the knowledge graph. Filter by subject, predicate, object. active_only=true filters to currently valid triples.",
    {
      subject: z.string().optional().describe("Filter by subject entity"),
      predicate: z.string().optional().describe("Filter by predicate/relationship"),
      object: z.string().optional().describe("Filter by object value"),
      active_only: z.boolean().default(true).describe("Only return currently active triples"),
    },
    { title: "Search the Knowledge Graph", readOnlyHint: true, openWorldHint: false },
    async ({ subject, predicate, object, active_only }) => {
      try {
        await ensureTables(env.DB);
        let sql =
          "SELECT subject, predicate, object, valid_from, valid_until, source FROM knowledge_graph WHERE 1=1";
        const params: string[] = [];

        if (subject) {
          sql += " AND subject = ?";
          params.push(subject.toLowerCase());
        }
        if (predicate) {
          sql += " AND predicate = ?";
          params.push(predicate.toLowerCase());
        }
        if (object) {
          sql += " AND object = ?";
          params.push(object);
        }
        if (active_only) {
          sql +=
            " AND valid_from <= datetime('now') AND (valid_until IS NULL OR valid_until >= datetime('now'))";
        }
        sql += " ORDER BY valid_from DESC LIMIT 50";

        let stmt = env.DB.prepare(sql);
        if (params.length === 1) stmt = stmt.bind(params[0]);
        else if (params.length === 2) stmt = stmt.bind(params[0], params[1]);
        else if (params.length === 3) stmt = stmt.bind(params[0], params[1], params[2]);

        const results = await stmt.all();
        const rows = results.results as Array<{
          subject: string;
          predicate: string;
          object: string;
          valid_from: string;
          valid_until: string | null;
          source: string | null;
        }>;

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: active_only
                  ? "No active triples found. Try active_only=false to include expired."
                  : "No triples found matching query.",
              },
            ],
          };
        }

        const text = rows
          .map(
            (r) =>
              `${r.subject} --${r.predicate}--> ${r.object} [${r.valid_from}${r.valid_until ? " to " + r.valid_until : "+"}]${r.source ? ` (${r.source})` : ""}`
          )
          .join("\n");
        return {
          content: [{ type: "text" as const, text: `${rows.length} triple(s):\n${text}` }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error querying KG: ${e}` }] };
      }
    }
  );

  // ── search_in_hub (scoped hub search) ─────────────────────
  server.tool(
    "search_in_hub",
    "Search within a specific hub file by keyword. Faster and more focused than repo-wide search.",
    {
      domain: z.string().describe("Domain: [employer-ad-network], [pet], [side-project], relocation, spanish, finance, blog, meetings"),
      query: z.string().describe("Search keyword (case-insensitive)"),
    },
    { title: "Search Within One Hub", readOnlyHint: true, openWorldHint: true },
    async ({ domain, query }) => {
      const hubPath = resolveHubPath(domain);
      if (!hubPath) {
        // Try generic patterns
        const paths = [
          `hubs/${domain}.md`,
          `hubs/HUB_${domain.toUpperCase()}.md`,
        ];
        for (const p of paths) {
          const content = await readFile(env, p);
          if (content) {
            return searchInContent(content, query, domain);
          }
        }
        return {
          content: [
            { type: "text" as const, text: `Hub "${domain}" not found. Try: [employer-ad-network], [pet], [side-project], relocation, spanish, finance, blog, meetings.` },
          ],
        };
      }

      const content = await readFile(env, hubPath);
      if (!content) {
        return {
          content: [{ type: "text" as const, text: `Hub file not found: ${hubPath}` }],
        };
      }
      return searchInContent(content, query, domain);
    }
  );

  // ── diary_write (GitHub) — append timestamped diary entry ──
  server.tool(
    "diary_write",
    "Append a timestamped entry to a domain diary log. Creates file if needed.",
    {
      domain: z.string().describe("Domain: work, health, projects, finance, learning, blog, memory"),
      entry: z.string().describe("Diary entry text — auto-prefixed with timestamp"),
    },
    { title: "Append to Domain Diary", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ domain, entry }) => {
      const path = `logs/${domain}_diary.md`;
      const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const newEntry = `\n## ${timestamp}\n${entry}\n`;

      const existing = await readFile(env, path);
      const content = existing
        ? existing + newEntry
        : `# ${domain} diary\n${newEntry}`;

      const result = await writeFile(env, path, content, `diary: ${domain} — ${entry.slice(0, 50)}`);
      if (result.success) {
        return { content: [{ type: "text" as const, text: `Diary entry added to ${path}` }] };
      }
      return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
    }
  );

  // ── diary_read (GitHub) — read recent diary entries ────────
  server.tool(
    "diary_read",
    "Read recent entries from a domain diary.",
    {
      domain: z.string().describe("Domain: work, health, projects, finance, learning, blog, memory"),
      last_n: z.coerce.number().default(5).describe("Number of recent entries to return"),
    },
    { title: "Read Domain Diary", readOnlyHint: true, openWorldHint: true },
    async ({ domain, last_n }) => {
      const path = `logs/${domain}_diary.md`;
      const content = await readFile(env, path);
      if (!content) {
        return { content: [{ type: "text" as const, text: `No diary for ${domain} yet.` }] };
      }
      const entries = content.split(/(?=^## \d{4})/m).filter(e => e.startsWith("## "));
      const recent = entries.slice(-last_n);
      return {
        content: [{ type: "text" as const, text: `${domain} diary (last ${recent.length}):\n\n${recent.join("\n")}` }],
      };
    }
  );

  // ── get_tunnels (GitHub) — cross-hub entity search ─────────
  server.tool(
    "get_tunnels",
    "Find entities that appear in multiple hubs. Optionally filter by entity name.",
    {
      entity: z.string().optional().describe("Entity to search across hubs. Empty = auto-detect shared entities."),
    },
    { title: "Find Cross-Hub Connections", readOnlyHint: true, openWorldHint: true },
    async ({ entity }) => {
      const hubKeys = Object.keys(HUB_MAP);
      const seenPaths = new Set<string>();
      const hubContents: Array<{ name: string; content: string }> = [];

      for (const name of hubKeys) {
        const path = resolveHubPath(name);
        if (!path || seenPaths.has(path)) continue;
        seenPaths.add(path);
        const content = await readFile(env, path);
        if (content) hubContents.push({ name, content });
      }

      if (entity) {
        const matches = hubContents
          .filter(h => h.content.toLowerCase().includes(entity.toLowerCase()))
          .map(h => h.name);
        if (matches.length === 0) return { content: [{ type: "text" as const, text: `"${entity}" not found in any hub.` }] };
        return { content: [{ type: "text" as const, text: `"${entity}" appears in: ${matches.join(", ")}` }] };
      }

      const entityHubs = new Map<string, Set<string>>();
      for (const hub of hubContents) {
        const words = [...new Set(hub.content.match(/[A-ZА-ЯЁ][a-zа-яё]{3,}/g) || [])];
        for (const w of words) {
          if (!entityHubs.has(w)) entityHubs.set(w, new Set());
          entityHubs.get(w)!.add(hub.name);
        }
      }

      const shared = [...entityHubs.entries()]
        .filter(([, hubs]) => hubs.size >= 2)
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, 30)
        .map(([ent, hubs]) => `${ent}: ${[...hubs].join(", ")}`)
        .join("\n");

      return { content: [{ type: "text" as const, text: shared || "No cross-hub entities found." }] };
    }
  );

  // ── health_check (D1 + GitHub) — structured quality report ──
  server.tool(
    "health_check",
    "Run system health checks. Returns structured report for Chat to act on.",
    {},
    { title: "Check System Health", readOnlyHint: true, openWorldHint: true },
    async () => {
      const checks: string[] = [];

      // 1. Recent errors
      const errors = await env.DB
        .prepare("SELECT COUNT(*) as cnt FROM errors WHERE created_at > datetime('now', '-24 hours')")
        .first()
        .then((r) => (r as { cnt: number } | null)?.cnt ?? 0)
        .catch(() => -1);
      checks.push(`errors_24h: ${errors}`);

      // 2. Session logging health
      const sessions7d = await env.DB
        .prepare("SELECT COUNT(*) as cnt FROM sessions WHERE created_at > datetime('now', '-7 days')")
        .first()
        .then((r) => (r as { cnt: number } | null)?.cnt ?? 0)
        .catch(() => -1);
      checks.push(`sessions_7d: ${sessions7d}`);

      // 3. KG size
      const kgSize = await env.DB
        .prepare("SELECT COUNT(*) as cnt FROM knowledge_graph")
        .first()
        .then((r) => (r as { cnt: number } | null)?.cnt ?? 0)
        .catch(() => -1);
      checks.push(`kg_triples: ${kgSize}`);

      // 4. Facts count
      const factsCount = await env.DB
        .prepare("SELECT COUNT(*) as cnt FROM facts")
        .first()
        .then((r) => (r as { cnt: number } | null)?.cnt ?? 0)
        .catch(() => -1);
      checks.push(`facts: ${factsCount}`);

      // 5. Snapshot freshness
      const snapshot = await readFile(env, "STATUS_SNAPSHOT.md");
      const lastUpdated = snapshot?.match(/Last updated: (.+)/)?.[1] || "unknown";
      checks.push(`snapshot_updated: ${lastUpdated}`);

      // 6. TODO pending count
      const todo = await readFile(env, "TODO.md");
      const pendingCount = (todo?.match(/STATUS: TODO/g) || []).length;
      checks.push(`todo_pending: ${pendingCount}`);

      // 7. Memory file cache state (Phase 1.5 instrumentation).
      //    Surfaces cache size, dirty rows (write-through failures), and
      //    age of oldest entry so a stale-cache anomaly is visible during
      //    any health_check call without needing to query D1 directly.
      try {
        const cacheStats = await env.DB
          .prepare(
            `SELECT COUNT(*) AS files,
                    SUM(dirty) AS dirty,
                    SUM(size_bytes) AS total_bytes,
                    MAX(cached_at) AS newest,
                    MIN(cached_at) AS oldest
             FROM memory_files_cache`
          )
          .first<{ files: number; dirty: number; total_bytes: number; newest: string | null; oldest: string | null }>();
        if (cacheStats) {
          const sizeKb = Math.round((cacheStats.total_bytes ?? 0) / 1024);
          checks.push(`cache_files: ${cacheStats.files ?? 0}`);
          checks.push(`cache_size_kb: ${sizeKb}`);
          checks.push(`cache_dirty: ${cacheStats.dirty ?? 0}${(cacheStats.dirty ?? 0) > 0 ? " ⚠️ write-through pending" : ""}`);
          if (cacheStats.oldest && cacheStats.newest) {
            checks.push(`cache_oldest: ${cacheStats.oldest}`);
          }
        } else {
          checks.push("cache_files: 0 (table empty or missing)");
        }
      } catch {
        checks.push("cache: query failed");
      }

      // 8. Tool-call telemetry (2026-06-13) — which tools are actually used.
      try {
        const tc = await env.DB
          .prepare("SELECT COUNT(*) AS tools, COALESCE(SUM(calls),0) AS total FROM tool_calls")
          .first<{ tools: number; total: number }>();
        checks.push(`tool_calls_tracked: ${tc?.tools ?? 0} tools / ${tc?.total ?? 0} calls`);
      } catch {
        checks.push("tool_calls: table empty (no calls recorded yet)");
      }

      return { content: [{ type: "text" as const, text: checks.join("\n") }] };
    }
  );

  // ── dreaming_status (GitHub) — latest dreaming cycle + staleness ──
  server.tool(
    "dreaming_status",
    "Read the latest dreaming-cycle summary from logs/dreaming/ and report age in days. Catches gaps in seconds: if the last cycle was ≥2 days ago, the caller knows the protocol stalled.",
    {},
    { title: "Check Dreaming Cycle Status", readOnlyHint: true, openWorldHint: true },
    async () => {
      const files = await listDir(env, "logs/dreaming");
      // Strip the emoji prefix from listDir output and keep only summary files.
      const summaries = files
        .map((f) => f.replace(/^[^ ]+ /, ""))
        .filter((f) => /^\d{4}-\d{2}-\d{2}_summary.*\.md$/.test(f))
        .sort(); // lexical sort = chronological because filenames are date-prefixed
      if (summaries.length === 0) {
        return { content: [{ type: "text" as const, text: "dreaming_status: no summaries found in logs/dreaming/" }] };
      }
      const latest = summaries[summaries.length - 1];
      const dateMatch = latest.match(/^(\d{4}-\d{2}-\d{2})/);
      const lastDate = dateMatch ? dateMatch[1] : "unknown";
      const ageDays = dateMatch
        ? Math.floor((Date.now() - Date.parse(dateMatch[1] + "T00:00:00Z")) / 86400000)
        : -1;
      const body = (await readFile(env, `logs/dreaming/${latest}`)) || "";
      const mode = body.match(/\*\*Mode:\*\*\s*([^\n]+)/)?.[1]?.trim() || "unknown";
      const health = body.match(/[Hh]ealth[^\n]*?(\d+(?:\.\d+)?)[\s\/]*10/)?.[1] || "unknown";
      const tests = body.match(/(\d+\s*\/\s*\d+[^\n]*(?:PASS|pass|tests))/)?.[1]?.trim() || "unknown";
      const staleness =
        ageDays < 0 ? "unknown" : ageDays <= 1 ? "FRESH" : ageDays <= 3 ? "OK" : ageDays <= 7 ? "STALE" : "BROKEN";
      const lines = [
        `dreaming_status: ${staleness}`,
        `last_cycle: ${lastDate} (${ageDays}d ago)`,
        `latest_file: logs/dreaming/${latest}`,
        `mode: ${mode}`,
        `health: ${health}/10`,
        `tests: ${tests}`,
        `total_summaries_on_disk: ${summaries.length}`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ── quality_metrics_recent (GitHub) — last N quality probe rows ──
  server.tool(
    "quality_metrics_recent",
    "Read recent rows from logs/quality/*.jsonl (written by tests/test-quality-metrics.sh during dreaming Phase 4f + weekly Phase 5). Returns the last N rows as parsed JSON plus a 1-line summary of the latest. Answers 'show quality trend' without guessing.",
    {
      limit: z.coerce.number().int().min(1).max(30).default(5).describe("How many most-recent rows to return (default 5, max 30)"),
    },
    { title: "Read Recent Quality Metrics", readOnlyHint: true, openWorldHint: true },
    async ({ limit }) => {
      const files = await listDir(env, "logs/quality");
      const dateFiles = files
        .map((f) => f.replace(/^[^ ]+ /, ""))
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort(); // lexical = chronological (YYYY-MM-DD.jsonl)
      if (dateFiles.length === 0) {
        return { content: [{ type: "text" as const, text: "quality_metrics_recent: no logs/quality/*.jsonl files yet" }] };
      }
      // Walk files newest-first, accumulate rows until we hit `limit`.
      const rows: Record<string, unknown>[] = [];
      for (let i = dateFiles.length - 1; i >= 0 && rows.length < limit; i--) {
        const body = (await readFile(env, `logs/quality/${dateFiles[i]}`)) || "";
        const fileRows = body
          .split(/\r?\n/)
          .filter((l) => l.trim().startsWith("{"))
          .map((l) => {
            try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; }
          })
          .filter((r): r is Record<string, unknown> => r !== null);
        // newest-first within the file
        for (let j = fileRows.length - 1; j >= 0 && rows.length < limit; j--) {
          rows.push(fileRows[j]);
        }
      }
      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: "quality_metrics_recent: files exist but no parseable rows" }] };
      }
      const latest = rows[0];
      const summary =
        `latest: date=${latest.date} mode=${latest.mode} sessions=${latest.sessions} ` +
        `errors=${latest.errors_total} (h=${latest.errors_high}) tests=${latest.tests_pass}/${latest.tests_total} ` +
        `todo=${latest.todo_done}/${latest.todo_added} backlog_median=${latest.backlog_median_age_days}d ` +
        `alerts=${Array.isArray(latest.alerts) ? (latest.alerts as unknown[]).length : 0}`;
      const body = [summary, "", `last ${rows.length} row(s):`, ...rows.map((r) => JSON.stringify(r))].join("\n");
      return { content: [{ type: "text" as const, text: body }] };
    }
  );

  // ── commit_log_recent (GitHub) — recent commits on default branch ──
  server.tool(
    "commit_log_recent",
    "List recent commits on the default branch via GitHub API. Lets Chat see what Code committed without reading files. Returns author + date + subject for the last N commits.",
    {
      limit: z.coerce.number().int().min(1).max(30).default(10).describe("How many recent commits (default 10, max 30)"),
      author: z.string().optional().describe("Optional author filter (e.g. 'Claude (Code)' or 'Claude (Dreaming)')"),
    },
    { title: "List Recent Commits", readOnlyHint: true, openWorldHint: true },
    async ({ limit, author }) => {
      const url = new URL(`${GITHUB_API}/repos/${env.GITHUB_REPO}/commits`);
      url.searchParams.set("per_page", String(limit));
      if (author) url.searchParams.set("author", author);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${env.GITHUB_PAT}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": WORKER_UA,
        },
      });
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `commit_log_recent: HTTP ${res.status} ${res.statusText}` }] };
      }
      const commits = (await res.json()) as Array<{
        sha: string;
        commit: { author: { name: string; date: string }; message: string };
      }>;
      if (!Array.isArray(commits) || commits.length === 0) {
        return { content: [{ type: "text" as const, text: `commit_log_recent: 0 commits${author ? ` by ${author}` : ""}` }] };
      }
      const lines = commits.map((c) => {
        const subj = c.commit.message.split(/\r?\n/)[0];
        const date = c.commit.author.date.slice(0, 19).replace("T", " ");
        const shortSha = c.sha.slice(0, 8);
        return `${shortSha} ${date} [${c.commit.author.name}] ${subj}`;
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ── todo_add (GitHub) — Chat auto-TODO generation ─────────
  server.tool(
    "todo_add",
    "Append a TODO entry to TODO.md. Use when monitoring detects issues.",
    {
      priority: z.enum(["P0", "P1", "P2"]).describe("P0=breaking, P1=important, P2=nice-to-have"),
      title: z.string().describe("Short task title"),
      problem: z.string().describe("What's wrong"),
      fix: z.string().describe("Proposed fix — be specific about files and changes"),
      files: z.string().describe("Comma-separated file paths to modify"),
      source: z.string().default("auto").describe("What triggered this: error_report, session_check, staleness, manual"),
    },
    { title: "Add a TODO Item", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ priority, title, problem, fix, files, source }) => {
      const todoContent = await readFile(env, "TODO.md");
      if (!todoContent) {
        return { content: [{ type: "text" as const, text: "Error: TODO.md not found" }] };
      }

      const timestamp = new Date().toISOString().slice(0, 16);
      const entry = `\n\n## ${priority}. ${title} — STATUS: TODO — SOURCE: ${source} — ADDED: ${timestamp}\n\n### Problem\n${problem}\n\n### Proposed fix\n${fix}\n\n### Files\n${files}\n`;

      // Insert before "## Done" section
      const doneIdx = todoContent.indexOf("## Done");
      const updated = doneIdx > -1
        ? todoContent.slice(0, doneIdx) + entry + "\n---\n\n" + todoContent.slice(doneIdx)
        : todoContent + entry;

      const result = await writeFile(env, "TODO.md", updated, `auto-todo: ${priority} ${title}`);
      if (result.success) {
        return { content: [{ type: "text" as const, text: `Added ${priority} task: ${title}` }] };
      }
      return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
    }
  );

  // ── granola_sync ──────────────────────────────────────────
  server.tool(
    "granola_sync",
    "Sync recent Granola meetings to D1 cache. Fetches new meetings from Granola REST API, extracts summaries/action items/decisions, stores in granola_meetings table. Returns count of synced meetings.",
    {
      days_back: z.coerce.number().default(7).describe("How many days back to sync (default 7)"),
    },
    { title: "Refresh Meeting Notes from Granola", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ days_back }) => {
      if (!env.GRANOLA_API) {
        return { content: [{ type: "text" as const, text: "GRANOLA_API secret not configured. Add it via: npx wrangler secret put GRANOLA_API" }] };
      }
      try {
        await ensureTables(env.DB);
        const since = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString();
        const notes = await granolaListNotes(env, since);
        if (notes.length === 0) {
          return { content: [{ type: "text" as const, text: `No Granola notes found since ${since.slice(0, 10)}` }] };
        }

        let synced = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (const note of notes) {
          try {
            // Check if already synced
            const existing = await env.DB
              .prepare("SELECT id FROM granola_meetings WHERE id = ?")
              .bind(note.id)
              .first();
            if (existing) { skipped++; continue; }

            // Fetch full note with details
            const detail = await granolaGetNote(env, note.id);
            if (!detail) { skipped++; continue; }

            const summary = extractSummary(detail);
            if (!summary) { skipped++; continue; } // No AI summary yet

            const domain = autoDetectDomain(detail.title, summary);
            const actionItems = extractActionItems(summary);
            const decisions = extractDecisions(summary);
            const participants = (detail.attendees || [])
              .map((p) => p.name || p.email || "unknown")
              .filter(Boolean);
            const transcript = formatTranscript(detail.transcript);

            await env.DB
              .prepare(
                "INSERT OR REPLACE INTO granola_meetings (id, title, date, participants, summary, transcript, action_items, decisions, domain, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
              )
              .bind(
                detail.id,
                detail.title || "Untitled",
                detail.created_at,
                JSON.stringify(participants),
                summary,
                transcript.slice(0, 50000), // Cap transcript at 50KB
                JSON.stringify(actionItems),
                JSON.stringify(decisions),
                domain
              )
              .run();

            // Mirror into FTS5 so granola_context prefix-search finds new rows
            // on the next call. Non-fatal: if FTS write fails the LIKE fallback
            // still works and the next ensureTables() backfill will catch up.
            try {
              const searchable = [
                detail.title || "",
                summary,
                participants.join(" "),
                actionItems.join(" "),
                decisions.join(" "),
                transcript.slice(0, 50000),
              ].join(" ");
              await env.DB
                .prepare(
                  `INSERT INTO granola_fts(rowid, id, searchable)
                   VALUES ((SELECT rowid FROM granola_meetings WHERE id = ?), ?, ?)
                   ON CONFLICT(rowid) DO UPDATE SET id = excluded.id, searchable = excluded.searchable`
                )
                .bind(detail.id, detail.id, searchable)
                .run()
                .catch(async () => {
                  // FTS5 contentless tables don't support ON CONFLICT the same
                  // way; fall back to delete-then-insert on the second attempt.
                  await env.DB.prepare(
                    `INSERT INTO granola_fts(granola_fts, rowid, id, searchable)
                     VALUES ('delete', (SELECT rowid FROM granola_meetings WHERE id = ?), ?, ?)`
                  ).bind(detail.id, detail.id, searchable).run().catch(() => {});
                  await env.DB.prepare(
                    `INSERT INTO granola_fts(rowid, id, searchable)
                     VALUES ((SELECT rowid FROM granola_meetings WHERE id = ?), ?, ?)`
                  ).bind(detail.id, detail.id, searchable).run();
                });
            } catch (ftsErr) {
              console.warn(`granola_sync: FTS mirror failed for ${detail.id}`, (ftsErr as Error)?.message ?? ftsErr);
            }
            synced++;
          } catch (e) {
            errors.push(`${note.title}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        let result = `Granola sync complete: ${synced} synced, ${skipped} skipped (${notes.length} total)`;
        if (errors.length > 0) {
          result += `\nErrors (${errors.length}):\n${errors.slice(0, 5).join("\n")}`;
        }
        return { content: [{ type: "text" as const, text: result }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Granola sync error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  // ── granola_context ──────────────────────────────────────
  server.tool(
    "granola_context",
    "Search cached Granola meetings by keyword, domain, or date range. Uses FTS5 with prefix matching for Russian morphology; falls back to LIKE on error OR when FTS returns zero rows (improves recall on stemmed queries). Run granola_sync first to populate.",
    {
      query: z.string().optional().describe("Search keyword (RU/EN) — prefix-matched via FTS5"),
      domain: z.string().optional().describe("Filter by domain: [employer-ad-network], spanish, [pet], [side-project], relocation"),
      days_back: z.coerce.number().default(14).describe("How many days back to search (default 14)"),
      limit: z.coerce.number().default(10).describe("Max results (default 10)"),
    },
    { title: "Search Meetings by Topic", readOnlyHint: true, openWorldHint: false },
    async ({ query, domain, days_back, limit }) => {
      try {
        await ensureTables(env.DB);
        const since = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString();
        const capped = Math.min(limit, 20);

        type GranolaRow = {
          id: string; title: string; date: string; participants: string;
          summary: string; transcript: string; action_items: string; decisions: string; domain: string;
        };
        let meetings: GranolaRow[] = [];
        let path: "fts" | "like" = "like";

        // Path 1 — FTS5 MATCH with prefix-stemming. Handles Russian morphology
        // ("разреклам*" → "разрекламировал" etc.) and survives length/punctuation
        // better than LIKE. `IN (SELECT id FROM granola_fts WHERE ...)` keeps
        // the outer query on granola_meetings so domain/date filters stay in
        // the same plan.
        if (query) {
          const ftsExpr = buildFtsQuery(query);
          if (ftsExpr) {
            try {
              const ftsSql = `SELECT id, title, date, participants, summary, transcript, action_items, decisions, domain
                FROM granola_meetings
                WHERE date > ?
                  AND id IN (SELECT id FROM granola_fts WHERE granola_fts MATCH ?)
                  ${domain ? "AND domain = ?" : ""}
                ORDER BY date DESC LIMIT ${capped}`;
              const stmt = env.DB.prepare(ftsSql);
              const bound = domain
                ? stmt.bind(since, ftsExpr, domain)
                : stmt.bind(since, ftsExpr);
              const rows = await bound.all();
              meetings = rows.results as GranolaRow[];
              path = "fts";
            } catch (fe) {
              // FTS unavailable or query malformed — drop to LIKE path below.
              console.warn("granola_context: FTS path failed, falling back to LIKE", (fe as Error)?.message ?? fe);
            }
          }
        }

        // Path 2 — LIKE fallback. Runs whenever FTS returned no meetings
        // (either path failed in catch above, OR FTS succeeded but returned
        // zero rows — the latter is the RU-recall case: prefix-stemming may
        // miss morphological variants that plain substring finds, e.g.
        // `разрекл*` missing `разреклам`). Also used when query is absent
        // entirely. Query is reduced to the first ≥4-char token (or
        // truncated to 20 chars) — 4-way OR LIKE with long Cyrillic phrases
        // (UTF-8 multi-byte sequences in a pattern-matcher) still tripped
        // "LIKE or GLOB pattern too complex" even after the v2.8.0 fix.
        // Whole block is wrapped in try/catch so any residual edge case
        // degrades to empty results instead of bubbling a D1_ERROR to the
        // user — no-hits + log is strictly better than exception.
        // Fixed 2026-04-23 (BACKLOG claude-mcp granola-recall + error branch).
        if (meetings.length === 0) {
          try {
            let sql = "SELECT id, title, date, participants, summary, transcript, action_items, decisions, domain FROM granola_meetings WHERE date > ?";
            const params: string[] = [since];

            if (domain) {
              sql += " AND domain = ?";
              params.push(domain);
            }
            if (query) {
              const firstToken = query.trim().split(/\s+/).find((t) => t.length >= 4);
              const safeQuery = (firstToken ?? query.trim().slice(0, 20)).slice(0, 20).replace(/[%_]/g, "");
              sql += " AND (title LIKE ? OR summary LIKE ? OR participants LIKE ? OR transcript LIKE ?)";
              params.push(`%${safeQuery}%`, `%${safeQuery}%`, `%${safeQuery}%`, `%${safeQuery}%`);
            }
            sql += ` ORDER BY date DESC LIMIT ${capped}`;

            const stmt = env.DB.prepare(sql);
            const bound = params.length === 1 ? stmt.bind(params[0]) :
              params.length === 2 ? stmt.bind(params[0], params[1]) :
              params.length === 3 ? stmt.bind(params[0], params[1], params[2]) :
              params.length === 4 ? stmt.bind(params[0], params[1], params[2], params[3]) :
              params.length === 5 ? stmt.bind(params[0], params[1], params[2], params[3], params[4]) :
              stmt.bind(params[0], params[1], params[2], params[3], params[4], params[5]);

            const rows = await bound.all();
            meetings = rows.results as GranolaRow[];
          } catch (le) {
            console.warn("granola_context: LIKE fallback failed, returning empty", (le as Error)?.message ?? le);
          }
        }

        if (meetings.length === 0) {
          return { content: [{ type: "text" as const, text: `No meetings found${query ? ` matching "${query}"` : ""}${domain ? ` in domain "${domain}"` : ""} in last ${days_back} days. Run granola_sync first.` }] };
        }

        const parts = meetings.map((m) => {
          // ID exposed in output (added 2026-04-23) so callers can pipe into
          // granola_transcript without a separate lookup step. Without this,
          // the "get full transcript" workflow broke — granola_context gave
          // summary but not the meeting_id that granola_transcript requires.
          const lines = [`## ${m.title}`, `**ID:** \`${m.id}\``, `Date: ${m.date} | Domain: ${m.domain}`];
          try { const p = JSON.parse(m.participants); if (p.length > 0) lines.push(`Participants: ${p.join(", ")}`); } catch { /* skip */ }
          if (m.summary) lines.push(`\n${m.summary.slice(0, 800)}${m.summary.length > 800 ? "..." : ""}`);
          try { const a = JSON.parse(m.action_items); if (a.length > 0) lines.push(`\n**Action items:** ${a.join("; ")}`); } catch { /* skip */ }
          try { const d = JSON.parse(m.decisions); if (d.length > 0) lines.push(`\n**Decisions:** ${d.join("; ")}`); } catch { /* skip */ }
          if (m.transcript) lines.push(`\n**Transcript:** ${m.transcript.length} chars available — call granola_transcript(meeting_id='${m.id}') for full text`);
          return lines.join("\n");
        });

        return { content: [{ type: "text" as const, text: `${meetings.length} meeting(s) found:\n\n${parts.join("\n\n---\n\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  // ── granola_recent ──────────────────────────────────────
  server.tool(
    "granola_recent",
    "Get last N meetings from D1 cache with compact summaries. Designed for wake_up context injection. Returns title + domain + action items only.",
    {
      count: z.coerce.number().default(5).describe("Number of recent meetings (default 5)"),
    },
    { title: "List Recent Meetings", readOnlyHint: true, openWorldHint: false },
    async ({ count }) => {
      try {
        await ensureTables(env.DB);
        // ID included in SELECT (added 2026-04-23) so the wake_up context and
        // direct granola_recent callers can pipe into granola_transcript.
        const rows = await env.DB
          .prepare(`SELECT id, title, date, domain, action_items, decisions FROM granola_meetings ORDER BY date DESC LIMIT ?`)
          .bind(Math.min(count, 15))
          .all();
        const meetings = rows.results as Array<{
          id: string; title: string; date: string; domain: string; action_items: string; decisions: string;
        }>;

        if (meetings.length === 0) {
          return { content: [{ type: "text" as const, text: "No cached Granola meetings. Run granola_sync first." }] };
        }

        const lines = meetings.map((m) => {
          let line = `- **${m.title}** (${m.date.slice(0, 10)}, ${m.domain}) [id: \`${m.id}\`]`;
          try { const a = JSON.parse(m.action_items); if (a.length > 0) line += `\n  Actions: ${a.slice(0, 3).join("; ")}${a.length > 3 ? ` (+${a.length - 3} more)` : ""}`; } catch { /* skip */ }
          try { const d = JSON.parse(m.decisions); if (d.length > 0) line += `\n  Decisions: ${d.slice(0, 2).join("; ")}${d.length > 2 ? ` (+${d.length - 2} more)` : ""}`; } catch { /* skip */ }
          return line;
        });

        return { content: [{ type: "text" as const, text: `Recent Granola meetings (${meetings.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  // ── granola_transcript ──────────────────────────────────
  server.tool(
    "granola_transcript",
    "Get the full transcript of a specific meeting from D1 cache. Use granola_context first to find the meeting ID, then call this with the ID.",
    {
      meeting_id: z.string().describe("Granola meeting ID (not_* format)"),
    },
    { title: "Read Full Meeting Transcript", readOnlyHint: true, openWorldHint: false },
    async ({ meeting_id }) => {
      try {
        await ensureTables(env.DB);
        const row = await env.DB
          .prepare("SELECT title, date, domain, transcript, summary FROM granola_meetings WHERE id = ?")
          .bind(meeting_id)
          .first() as { title: string; date: string; domain: string; transcript: string; summary: string } | null;

        if (!row) {
          return { content: [{ type: "text" as const, text: `Meeting ${meeting_id} not found in D1 cache. Run granola_sync first.` }] };
        }
        if (!row.transcript) {
          return { content: [{ type: "text" as const, text: `Meeting "${row.title}" (${row.date.slice(0, 10)}) has no transcript. Summary:\n\n${row.summary?.slice(0, 1000) || "(none)"}` }] };
        }
        return {
          content: [{
            type: "text" as const,
            text: `## ${row.title}\nDate: ${row.date} | Domain: ${row.domain}\n\n### Transcript (${row.transcript.length} chars)\n\n${row.transcript}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  // ── meeting_context (5-source cache composer for mobile/chat) ──
  // P4-MEET-1 variant B: worker reads from D1 cache populated by local
  // routines. Real-time OAuth-direct path (variant A) stays future work.
  //
  // Goal: every Claude surface — Code, Chat, iPad, TG-bot-backed replies —
  // calls one tool and gets a digest ready to prep for a meeting without
  // re-running 5 MCPs across different hosts. Cache rows live in
  // granola_meetings (historical summaries + participants + action items)
  // and sessions (what Code did with the same meeting last time). The
  // helper dedupes by meeting_id and surfaces the smallest-possible
  // decision-shaped object.
  server.tool(
    "meeting_context",
    "Compose meeting context from D1 cache for any surface (Code/Chat/iPad/TG). Returns matching Granola meetings + action items + prior-session notes. Pass query OR participant OR both. For real-time corp enrichment use Code-local MCPs (wiki/mail/tracker/intrasearch/staff) — this tool surfaces only what's already cached.",
    {
      query: z.string().optional().describe("Topic keyword — FTS5-matched on title+summary+transcript"),
      participant: z.string().optional().describe("Participant login or display name (case-insensitive substring match)"),
      date_from: z.string().optional().describe("ISO date (YYYY-MM-DD) — lower bound. Default: 14 days ago"),
      date_to: z.string().optional().describe("ISO date (YYYY-MM-DD) — upper bound. Default: today+1"),
      limit: z.coerce.number().default(5).describe("Max meetings to return (default 5, max 15)"),
    },
    { title: "Load Meeting Context", readOnlyHint: true, openWorldHint: false },
    async ({ query, participant, date_from, date_to, limit }) => {
      try {
        await ensureTables(env.DB);
        const capped = Math.min(Math.max(limit, 1), 15);
        const lowerFrom = date_from
          ? new Date(date_from + "T00:00:00Z").toISOString()
          : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const upperTo = date_to
          ? new Date(date_to + "T23:59:59Z").toISOString()
          : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        type MR = { id: string; title: string; date: string; participants: string;
          summary: string; action_items: string; decisions: string; domain: string; };

        let meetings: MR[] = [];
        const whereParts: string[] = ["date > ?", "date < ?"];
        const binds: Array<string> = [lowerFrom, upperTo];

        if (query) {
          const fts = buildFtsQuery(query);
          if (fts) {
            whereParts.push("id IN (SELECT id FROM granola_fts WHERE granola_fts MATCH ?)");
            binds.push(fts);
          }
        }
        if (participant) {
          whereParts.push("LOWER(participants) LIKE ?");
          binds.push(`%${participant.toLowerCase().slice(0, 40)}%`);
        }

        try {
          const sql = `SELECT id, title, date, participants, summary, action_items, decisions, domain
                       FROM granola_meetings
                       WHERE ${whereParts.join(" AND ")}
                       ORDER BY date DESC LIMIT ${capped}`;
          const stmt = env.DB.prepare(sql);
          const bound = binds.length === 2 ? stmt.bind(binds[0], binds[1]) :
            binds.length === 3 ? stmt.bind(binds[0], binds[1], binds[2]) :
            binds.length === 4 ? stmt.bind(binds[0], binds[1], binds[2], binds[3]) :
            stmt.bind(binds[0], binds[1], binds[2], binds[3], binds[4]);
          const rows = await bound.all();
          meetings = rows.results as MR[];
        } catch (e) {
          // FTS MATCH can fail on exotic input; retry without it using LIKE.
          if (query) {
            const safe = query.trim().slice(0, 40).replace(/[%_]/g, "");
            const fallbackSql = `SELECT id, title, date, participants, summary, action_items, decisions, domain
                                 FROM granola_meetings
                                 WHERE date > ? AND date < ?
                                   AND (title LIKE ? OR summary LIKE ? OR transcript LIKE ?)
                                   ${participant ? "AND LOWER(participants) LIKE ?" : ""}
                                 ORDER BY date DESC LIMIT ${capped}`;
            const fallbackBinds: string[] = [lowerFrom, upperTo, `%${safe}%`, `%${safe}%`, `%${safe}%`];
            if (participant) fallbackBinds.push(`%${participant.toLowerCase().slice(0, 40)}%`);
            const stmt = env.DB.prepare(fallbackSql);
            const bound = fallbackBinds.length === 5
              ? stmt.bind(fallbackBinds[0], fallbackBinds[1], fallbackBinds[2], fallbackBinds[3], fallbackBinds[4])
              : stmt.bind(fallbackBinds[0], fallbackBinds[1], fallbackBinds[2], fallbackBinds[3], fallbackBinds[4], fallbackBinds[5]);
            const rows = await bound.all();
            meetings = rows.results as MR[];
          } else {
            throw e;
          }
        }

        if (meetings.length === 0) {
          return { content: [{ type: "text" as const, text: `No meetings found in [${lowerFrom.slice(0,10)} .. ${upperTo.slice(0,10)}]${query ? ` matching "${query}"` : ""}${participant ? ` with participant "${participant}"` : ""}. Cache: run granola_sync.` }] };
        }

        // Pull corresponding recent Code-session notes for the same topic
        // (best-effort). Gives Chat/iPad the delta of what the Mac side
        // already saw so replies don't duplicate.
        let sessionNotes: Array<{ surface: string; summary: string; created_at: string }> = [];
        if (query) {
          try {
            const safeQ = query.trim().slice(0, 40).replace(/[%_]/g, "");
            const rs = await env.DB
              .prepare(`SELECT surface, summary, created_at FROM sessions
                        WHERE summary LIKE ? AND created_at > datetime('now','-14 days')
                        ORDER BY created_at DESC LIMIT 3`)
              .bind(`%${safeQ}%`)
              .all();
            sessionNotes = (rs.results ?? []) as typeof sessionNotes;
          } catch { /* non-fatal */ }
        }

        const parts: string[] = [];
        parts.push(`## Meeting context (${meetings.length} from cache)\n`);
        for (const m of meetings) {
          parts.push(`### ${m.title}`);
          parts.push(`Date: ${m.date.slice(0, 10)} | Domain: ${m.domain}`);
          try { const p = JSON.parse(m.participants); if (p.length > 0) parts.push(`Participants: ${p.slice(0, 8).join(", ")}${p.length > 8 ? ` (+${p.length - 8})` : ""}`); } catch { /* skip */ }
          if (m.summary) parts.push(`\n${m.summary.slice(0, 500)}${m.summary.length > 500 ? "..." : ""}`);
          try { const a = JSON.parse(m.action_items); if (a.length > 0) parts.push(`**Actions:** ${a.slice(0, 5).join("; ")}`); } catch { /* skip */ }
          try { const d = JSON.parse(m.decisions); if (d.length > 0) parts.push(`**Decisions:** ${d.slice(0, 3).join("; ")}`); } catch { /* skip */ }
          parts.push("");
        }
        if (sessionNotes.length > 0) {
          parts.push(`### Cross-surface session notes (matching "${query}")`);
          for (const s of sessionNotes) {
            parts.push(`- [${(s.created_at || "").slice(0, 16)}] ${s.surface}: ${s.summary.slice(0, 200)}`);
          }
        }
        parts.push(`\n_Live corp-MCP enrichment (wiki/mail/tracker/intrasearch/staff) is Code-local. This tool surfaces D1 cache only — see RULES.md §13._`);

        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `meeting_context error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  // ── tg_dlq_report (DLQ visibility for TG bot delivery guarantees) ──
  // P3-TG-13: permanent-failed rows (retry_count≥3) rot silently. wake_up
  // already surfaces a count in "OPEN BLOCKERS" but gives no detail. This
  // tool returns the stuck rows + top error messages + the "queued but
  // un-swept" count so User can diagnose delivery gaps on any surface.
  // Read-only; safe for routines and for hub'ing into morning brief.
  server.tool(
    "tg_dlq_report",
    "Telegram bot delivery DLQ report: rows stuck at retry_count≥3 (status='failed'), rows queued >10min (cron sweep behind), and recent error samples. Use when diagnosing 'а где моё сообщение?'.",
    {
      limit: z.coerce.number().default(5).describe("Max stuck rows to return (default 5, max 20)"),
      include_samples: z.boolean().default(true).describe("If true, include the raw text of the first 5 DLQ rows"),
      check_webhook: z.boolean().default(true).describe("Probe Telegram getWebhookInfo live — catches the ingest-side failure DLQ can't see (worker rejecting deliveries, June'26 freeze pattern)."),
    },
    { title: "Telegram Delivery Health", readOnlyHint: true, openWorldHint: false },
    async ({ limit, include_samples, check_webhook }) => {
      try {
        const capped = Math.min(Math.max(limit, 1), 20);
        const counts = await env.DB
          .prepare(`
            SELECT
              (SELECT COUNT(*) FROM telegram_messages WHERE status='failed' AND retry_count>=3) as dlq,
              (SELECT COUNT(*) FROM telegram_messages WHERE status='queued' AND created_at < datetime('now','-10 minutes')) as stale_queued,
              (SELECT COUNT(*) FROM telegram_messages WHERE status='processing' AND created_at < datetime('now','-10 minutes')) as stuck_processing,
              (SELECT COUNT(*) FROM telegram_messages WHERE created_at > datetime('now','-1 days')) as last_24h,
              (SELECT COUNT(*) FROM telegram_messages WHERE status='done' AND created_at > datetime('now','-1 days')) as ok_24h,
              (SELECT MAX(created_at) FROM telegram_messages) as last_inbound
          `)
          .first()
          .catch(() => null) as { dlq: number; stale_queued: number; stuck_processing: number; last_24h: number; ok_24h: number; last_inbound: string | null } | null;

        if (!counts) {
          return { content: [{ type: "text" as const, text: "tg_dlq_report: telegram_messages table unreachable (bot not deployed?)." }] };
        }

        const parts: string[] = [];
        parts.push(`## Telegram delivery health (as of ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`);
        parts.push(`- last 24h: **${counts.last_24h}** inbound, ${counts.ok_24h} fully delivered`);
        parts.push(`- **DLQ (retry≥3):** ${counts.dlq} ${counts.dlq > 0 ? "⚠️" : "✅"}`);
        parts.push(`- stale queued (>10min): ${counts.stale_queued} ${counts.stale_queued > 0 ? "⚠️ cron sweep behind" : "✅"}`);
        parts.push(`- stuck processing (>10min): ${counts.stuck_processing} ${counts.stuck_processing > 0 ? "⚠️ CPU-limit deaths?" : "✅"}`);

        // Ingest-side probe (2026-07-07). The June'26 freeze: webhook secret
        // desync → worker 404'd every Telegram delivery for a MONTH while the
        // DLQ stayed green (nothing ingested = nothing to fail). Two signals:
        // D1 row staleness (soft) + live getWebhookInfo last_error (hard).
        const ageDays = counts.last_inbound
          ? Math.floor((Date.now() - new Date(counts.last_inbound.replace(" ", "T") + "Z").getTime()) / 86_400_000)
          : null;
        parts.push(`\n### Inbound ingest`);
        parts.push(`- last inbound row: ${counts.last_inbound ?? "(none)"}${ageDays !== null ? ` (${ageDays}d ago)` : ""} ${ageDays !== null && ageDays >= 7 ? "🟡 long silence — check webhook line below" : "✅"}`);
        let webhookBroken = false;
        if (check_webhook && env.TELEGRAM_BOT_TOKEN) {
          try {
            const whRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
            const wh = (await whRes.json()) as { ok: boolean; result?: { url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string } };
            const r = wh.result;
            if (wh.ok && r) {
              if (!r.url) {
                webhookBroken = true;
                parts.push(`- webhook: 🔴 NOT REGISTERED — inbound is dead. Fix on Mac: config/telegram-bot/rotate-webhook-secret.sh`);
              } else {
                const host = (() => { try { return new URL(r.url).host; } catch { return "?"; } })();
                const errAgeH = r.last_error_date ? Math.floor((Date.now() / 1000 - r.last_error_date) / 3600) : null;
                const recentErr = errAgeH !== null && errAgeH <= 72;
                if (recentErr) webhookBroken = true;
                parts.push(`- webhook: host ${host}, pending=${r.pending_update_count ?? 0}${r.last_error_date ? `, last_error ${errAgeH}h ago: "${(r.last_error_message ?? "").slice(0, 120)}"` : ", no recent errors"} ${recentErr ? '🔴 Telegram delivers but the worker rejects — secret desync (June\'26 pattern). Fix on Mac: config/telegram-bot/rotate-webhook-secret.sh' : "✅"}`);
              }
            } else {
              parts.push(`- webhook: probe failed (${JSON.stringify(wh).slice(0, 100)})`);
            }
          } catch (e) {
            parts.push(`- webhook: probe error ${(e as Error).message.slice(0, 100)}`);
          }
        } else if (check_webhook) {
          parts.push(`- webhook: probe skipped (TELEGRAM_BOT_TOKEN not configured on this worker)`);
        }

        if (include_samples && counts.dlq > 0) {
          const samples = await env.DB
            .prepare(`SELECT update_id, date, kind, text, error_msg, retry_count FROM telegram_messages
                      WHERE status='failed' AND retry_count>=3
                      ORDER BY date DESC LIMIT ?`)
            .bind(capped)
            .all()
            .catch(() => null);
          const rows = (samples?.results ?? []) as Array<{
            update_id: number; date: number; kind: string; text: string | null; error_msg: string | null; retry_count: number;
          }>;
          if (rows.length > 0) {
            parts.push(`\n### DLQ samples (top ${rows.length})`);
            for (const r of rows) {
              const when = new Date(r.date * 1000).toISOString().slice(0, 16).replace("T", " ");
              const body = r.text ? r.text.slice(0, 100) : `[${r.kind}]`;
              parts.push(`- #${r.update_id} [${when}] retries=${r.retry_count}: ${body}`);
              if (r.error_msg) parts.push(`    ↳ err: ${r.error_msg.slice(0, 200)}`);
            }
          }
        }

        if (counts.dlq === 0 && counts.stale_queued === 0 && counts.stuck_processing === 0 && !webhookBroken) {
          parts.push(`\n_All delivery invariants green. 🟢_`);
        } else {
          parts.push(`\n_If DLQ > 0: inspect samples above, then manually re-queue via D1 UPDATE telegram_messages SET status='queued', retry_count=0 WHERE update_id IN (...)._`);
        }

        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `tg_dlq_report error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  // ── r2_upload (R2) ─────────────────────────────────────────
  server.tool(
    "r2_upload",
    "Upload content to R2. Default bucket = claude-memory-store (backups, exports). Use bucket='artifacts' to publish HTML/JSON to a.user-site.example/<hash> for mobile sharing — auto-generates a 12-hex hash and stores at <hash>/index.<ext>; optionally PIN-protect with pin=true (4-digit PIN, SHA-256 stored at <hash>/.pin). Returns the URL (and PIN when applicable).",
    {
      key: z.string().describe("Object key (path-like), e.g. 'backups/2026-04-13/session.json'. Ignored when bucket='artifacts' AND auto_hash=true (the default for artifacts mode) — a random hash is generated instead."),
      content: z.string().describe("Content to store"),
      content_type: z.string().default("text/plain").describe("MIME type, e.g. 'text/html; charset=utf-8' or 'application/json'"),
      bucket: z.enum(["default", "artifacts"]).default("default").describe("default = claude-memory-store; artifacts = user-artifacts (a.user-site.example/<hash> host)"),
      auto_hash: z.boolean().default(true).describe("artifacts mode: auto-generate 12-hex hash key. Set false to use the explicit `key` param (e.g. for re-uploading to an existing hash). Ignored for default bucket."),
      pin: z.boolean().default(false).describe("artifacts mode: generate a 4-digit PIN, SHA-256 hash stored as <hash>/.pin so the artifact requires PIN entry. Returns the PIN (it is NOT stored in plaintext anywhere)."),
    },
    { title: "Save a File to Cloud Storage", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ key, content, content_type, bucket, auto_hash, pin }) => {
      // ── default bucket: legacy behavior, unchanged ────────────
      if (bucket === "default") {
        if (!env.STORE) {
          return { content: [{ type: "text" as const, text: "R2 bucket not bound. Add [[r2_buckets]] to wrangler.toml." }] };
        }
        try {
          await env.STORE.put(key, content, {
            httpMetadata: { contentType: content_type },
            customMetadata: { uploaded_at: new Date().toISOString() },
          });
          return { content: [{ type: "text" as const, text: `Uploaded ${key} (${content.length} bytes)` }] };
        } catch (e) {
          return { content: [{ type: "text" as const, text: `R2 upload error: ${e}` }] };
        }
      }

      // ── artifacts bucket: a.user-site.example/<hash> publish flow ───
      if (!env.ARTIFACTS_STORE) {
        return { content: [{ type: "text" as const, text: "ARTIFACTS_STORE binding missing. Add a second [[r2_buckets]] with bucket_name='user-artifacts' to wrangler.toml." }] };
      }

      // Derive the hash. auto_hash=true (default for artifacts mode) → random
      // 12-hex (48 bits, unguessable). false → reuse explicit `key` as the
      // hash component, useful for re-uploading to an existing URL.
      let hash: string;
      if (auto_hash) {
        const buf = new Uint8Array(6);
        crypto.getRandomValues(buf);
        hash = Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
      } else {
        // Strip leading slashes / index.* from explicit key so caller can pass
        // either the bare hash or a full path like "<hash>/index.html".
        const trimmed = key.replace(/^\/+/, "").replace(/\/?index\.[a-z0-9]+$/i, "");
        if (!/^[0-9a-f]{6,64}$/i.test(trimmed)) {
          return { content: [{ type: "text" as const, text: `auto_hash=false requires 'key' to be a 6-64 char hex hash (got '${trimmed}')` }] };
        }
        hash = trimmed.toLowerCase();
      }

      // Pick extension from content_type. Mirrors publish.sh logic so the
      // existing user-artifacts worker (which serves <hash>/index.<ext>)
      // can find the file without code changes there.
      const extMap: Record<string, string> = {
        "text/html": "html",
        "text/markdown": "md",
        "text/plain": "txt",
        "text/css": "css",
        "application/javascript": "js",
        "application/json": "json",
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/svg+xml": "svg",
      };
      const ctBase = content_type.split(";")[0].trim().toLowerCase();
      const ext = extMap[ctBase] ?? "html"; // default to html — most common artifact type
      const objectKey = `${hash}/index.${ext}`;

      try {
        await env.ARTIFACTS_STORE.put(objectKey, content, {
          httpMetadata: { contentType: content_type },
          customMetadata: { uploaded_at: new Date().toISOString(), source: "mcp-r2_upload" },
        });
      } catch (e) {
        return { content: [{ type: "text" as const, text: `R2 upload to artifacts bucket failed: ${e}` }] };
      }

      // Optional PIN: generate 4-digit, SHA-256 hash, store at <hash>/.pin so
      // the user-artifacts worker requires PIN entry. PIN is returned to
      // the caller in plaintext exactly once and never persisted anywhere
      // else (matches publish.sh --pin behavior).
      let pinDigits: string | null = null;
      if (pin) {
        const r = new Uint8Array(2);
        crypto.getRandomValues(r);
        const pinNum = ((r[0] << 8) | r[1]) % 10000;
        pinDigits = pinNum.toString().padStart(4, "0");
        try {
          const pinHash = await sha256Hex(pinDigits);
          await env.ARTIFACTS_STORE.put(`${hash}/.pin`, pinHash, {
            httpMetadata: { contentType: "text/plain" },
            customMetadata: { uploaded_at: new Date().toISOString(), source: "mcp-r2_upload-pin" },
          });
        } catch (e) {
          // PIN failed but content is already up — surface explicitly so
          // caller knows the artifact is unprotected.
          return { content: [{ type: "text" as const, text: `Uploaded https://a.user-site.example/${hash} (${content.length} bytes), but PIN setup FAILED: ${e}. Artifact is currently unprotected. Re-run with pin=true once the issue is fixed, or delete the object via wrangler.` }] };
        }
      }

      const url = `https://a.user-site.example/${hash}`;
      const lines = [
        `Published: ${url}`,
        `Object key: ${objectKey} (${content.length} bytes)`,
      ];
      if (pinDigits) {
        lines.push(`PIN: ${pinDigits} (share via different channel — not stored in plaintext)`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ── r2_download (R2) ──────────────────────────────────────
  server.tool(
    "r2_download",
    "Download content from R2 object storage. Returns the stored text content.",
    {
      key: z.string().describe("Object key to retrieve"),
    },
    { title: "Read a File from Cloud Storage", readOnlyHint: true, openWorldHint: false },
    async ({ key }) => {
      if (!env.STORE) {
        return { content: [{ type: "text" as const, text: "R2 bucket not bound." }] };
      }
      try {
        const obj = await env.STORE.get(key);
        if (!obj) {
          return { content: [{ type: "text" as const, text: `Not found: ${key}` }] };
        }
        const text = await obj.text();
        return { content: [{ type: "text" as const, text: text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `R2 download error: ${e}` }] };
      }
    }
  );

  // ── r2_list (R2) ──────────────────────────────────────────
  server.tool(
    "r2_list",
    "List objects in R2 storage. Optionally filter by prefix.",
    {
      prefix: z.string().optional().describe("Prefix filter, e.g. 'backups/' or 'exports/2026-04'"),
      limit: z.coerce.number().default(50).describe("Max results"),
    },
    { title: "List Files in Cloud Storage", readOnlyHint: true, openWorldHint: false },
    async ({ prefix, limit }) => {
      if (!env.STORE) {
        return { content: [{ type: "text" as const, text: "R2 bucket not bound." }] };
      }
      try {
        const listed = await env.STORE.list({ prefix: prefix || undefined, limit });
        if (listed.objects.length === 0) {
          return { content: [{ type: "text" as const, text: prefix ? `No objects with prefix "${prefix}"` : "R2 bucket is empty." }] };
        }
        const lines = listed.objects.map((o) => {
          const size = o.size < 1024 ? `${o.size}B` : `${(o.size / 1024).toFixed(1)}KB`;
          return `- ${o.key} (${size}, ${o.uploaded.toISOString().slice(0, 16)})`;
        });
        return { content: [{ type: "text" as const, text: `${listed.objects.length} object(s)${prefix ? ` (prefix: ${prefix})` : ""}:\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `R2 list error: ${e}` }] };
      }
    }
  );

  // ── Telegram bot archive (D1 — telegram_messages table) ───
  // The claude-telegram-bot worker writes every inbound message (text,
  // media, forwards) into the same D1 as this MCP server. These three
  // tools expose that archive so every Claude surface (Code/Chat/iPad)
  // can see what User dumped into the bot.
  server.tool(
    "tg_recent",
    "Read recent Telegram messages from the personal bot archive. Defaults to last 10 across all kinds.",
    {
      limit: z.coerce.number().int().positive().max(100).default(10),
      kind: z.string().optional().describe("Filter by kind: text|photo|video|voice|audio|document|forward|sticker|animation|video_note|location|contact|poll|reply"),
      since: z.string().optional().describe("ISO date (YYYY-MM-DD) — only messages from this date forward"),
    },
    { title: "Recent Telegram Messages", readOnlyHint: true, openWorldHint: true },
    async ({ limit, kind, since }) => {
      const filters: string[] = [];
      const binds: Array<string | number> = [];
      if (kind) { filters.push("kind = ?"); binds.push(kind); }
      if (since) {
        const unix = Math.floor(new Date(since + "T00:00:00Z").getTime() / 1000);
        if (!Number.isNaN(unix)) { filters.push("date >= ?"); binds.push(unix); }
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      binds.push(limit);

      try {
        const res = await env.DB.prepare(`
          SELECT update_id, chat_id, date, kind, text, forward_label,
                 media_r2_key, media_mime, media_bytes,
                 claude_reply, claude_tools_used, status
          FROM telegram_messages
          ${where}
          ORDER BY date DESC
          LIMIT ?
        `).bind(...binds).all();
        const rows = (res.results ?? []) as Array<{
          update_id: number; chat_id: number; date: number; kind: string;
          text: string | null; forward_label: string | null;
          media_r2_key: string | null; media_mime: string | null; media_bytes: number | null;
          claude_reply: string | null; claude_tools_used: string | null; status: string;
        }>;
        if (!rows.length) return { content: [{ type: "text" as const, text: "(no telegram messages)" }] };

        const lines = rows.map((r) => {
          const when = new Date(r.date * 1000).toISOString().slice(0, 16).replace("T", " ");
          const body = r.text ? r.text.slice(0, 400) : "(no text)";
          const fwd = r.forward_label ? ` · fwd ${r.forward_label}` : "";
          const media = r.media_r2_key ? ` · media ${r.media_r2_key} (${r.media_bytes ?? "?"}b)` : "";
          const status = r.status !== "done" ? ` · status=${r.status}` : "";
          const reply = r.claude_reply ? `\n    ↳ bot: ${r.claude_reply.slice(0, 200)}` : "";
          return `[${when}][#${r.update_id}][${r.kind}${fwd}${media}${status}]\n    ${body}${reply}`;
        });
        return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `tg_recent error: ${(e as Error).message}. Table may not exist yet — bot hasn't received its first message.` }] };
      }
    }
  );

  server.tool(
    "tg_search",
    "Full-text LIKE search over archived Telegram messages (text + forward_label).",
    {
      query: z.string().min(1),
      limit: z.coerce.number().int().positive().max(50).default(20),
    },
    { title: "Search Telegram Messages", readOnlyHint: true, openWorldHint: true },
    async ({ query, limit }) => {
      try {
        const like = `%${query}%`;
        const res = await env.DB.prepare(`
          SELECT update_id, date, kind, text, forward_label, claude_reply
          FROM telegram_messages
          WHERE text LIKE ? OR forward_label LIKE ? OR claude_reply LIKE ?
          ORDER BY date DESC
          LIMIT ?
        `).bind(like, like, like, limit).all();
        const rows = (res.results ?? []) as Array<{
          update_id: number; date: number; kind: string;
          text: string | null; forward_label: string | null; claude_reply: string | null;
        }>;
        if (!rows.length) return { content: [{ type: "text" as const, text: `No matches for "${query}" in telegram archive.` }] };
        const lines = rows.map((r) => {
          const when = new Date(r.date * 1000).toISOString().slice(0, 10);
          const body = (r.text ?? r.forward_label ?? r.claude_reply ?? "").slice(0, 300);
          return `[${when}][#${r.update_id}][${r.kind}] ${body}`;
        });
        return { content: [{ type: "text" as const, text: `${rows.length} match(es):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `tg_search error: ${(e as Error).message}` }] };
      }
    }
  );

  server.tool(
    "tg_get",
    "Get a single Telegram message by update_id, including raw payload and (optionally) media download URL.",
    {
      update_id: z.coerce.number().int().positive(),
      include_raw: z.boolean().default(false),
    },
    { title: "Get Telegram Message", readOnlyHint: true, openWorldHint: true },
    async ({ update_id, include_raw }) => {
      try {
        const row = await env.DB.prepare(`
          SELECT * FROM telegram_messages WHERE update_id = ?
        `).bind(update_id).first<{
          update_id: number; chat_id: number; message_id: number; date: number; kind: string;
          text: string | null; forward_origin: string | null; forward_label: string | null;
          media_r2_key: string | null; media_mime: string | null; media_bytes: number | null;
          claude_reply: string | null; claude_tools_used: string | null;
          status: string; retry_count: number; error_msg: string | null;
          raw_json: string; created_at: string; processed_at: string | null;
        }>();
        if (!row) return { content: [{ type: "text" as const, text: `Update ${update_id} not found.` }] };

        const when = new Date(row.date * 1000).toISOString();
        const lines: string[] = [];
        lines.push(`update_id: ${row.update_id}`);
        lines.push(`date: ${when}`);
        lines.push(`chat_id: ${row.chat_id}`);
        lines.push(`message_id: ${row.message_id}`);
        lines.push(`kind: ${row.kind}`);
        lines.push(`status: ${row.status} (retries: ${row.retry_count})`);
        if (row.error_msg) lines.push(`error: ${row.error_msg}`);
        if (row.forward_label) lines.push(`forwarded_from: ${row.forward_label}`);
        if (row.media_r2_key) lines.push(`media: ${row.media_r2_key} (${row.media_bytes}b, ${row.media_mime})`);
        if (row.text) lines.push(`\ntext:\n${row.text}`);
        if (row.claude_reply) lines.push(`\nbot reply:\n${row.claude_reply}`);
        if (row.claude_tools_used) lines.push(`tools used: ${row.claude_tools_used}`);
        if (include_raw) lines.push(`\nraw_json:\n${row.raw_json}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `tg_get error: ${(e as Error).message}` }] };
      }
    }
  );

  // ── tg_send — OUTBOUND Telegram (mobile/web parity with Mac tg-send.sh) ───
  // The Mac-only `scripts/tg-send.sh` reads creds from ~/.mcp_store and is
  // unreachable from mobile/web Claude Code (ephemeral container, no local
  // creds). This tool closes that gap: the bot token lives ONLY as a Worker
  // secret (TELEGRAM_BOT_TOKEN), so nothing sensitive touches the client.
  // Default target is User's chat (TG_DEFAULT_CHAT_ID). markdown_lite mirrors
  // the bash sender: *bold* _italic_ `code` → HTML, with safe &<> escaping so a
  // stray punctuation char never breaks the send. Bare URLs auto-link in TG.
  server.tool(
    "tg_send",
    "Send an outbound Telegram message to the personal bot (@rtmpplv_bot) — task-done pings, artifact URLs, alerts. Works from any surface (mobile/web/Code); the bot token lives only as a Worker secret. Defaults to User's chat. Style (TG-дисциплина): plain human Russian, first line = the outcome and why it matters; NO internal jargon (PR/CI/commit hashes/repo paths) — a kitchen-lint rejects violations. Use this from mobile/web instead of the Mac-only scripts/tg-send.sh.",
    {
      text: z.string().min(1).max(16000).describe("Message body. With markdown_lite (default) you may use *bold* _italic_ `code`; bare URLs auto-link; tracker keys (PCODE-123) become clickable st.[employer]-team.ru links."),
      chat_id: z.string().optional().describe("Override target chat id. Defaults to TG_DEFAULT_CHAT_ID (User)."),
      markdown_lite: z.boolean().default(true).describe("Convert *bold*/_italic_/`code` to HTML with safe escaping + tracker-key autolink. Set false to send raw plain text."),
      silent: z.boolean().default(false).describe("Deliver without a notification sound (disable_notification)."),
      skip_lint: z.boolean().default(false).describe("Bypass the internal-jargon kitchen-lint. ONLY when User explicitly asked for a technical/raw message."),
    },
    { title: "Send Telegram Message", readOnlyHint: false, openWorldHint: true },
    async ({ text, chat_id, markdown_lite, silent, skip_lint }) => {
      const token = env.TELEGRAM_BOT_TOKEN;
      const target = chat_id || env.TG_DEFAULT_CHAT_ID;
      if (!token) {
        return { content: [{ type: "text" as const, text: "tg_send: TELEGRAM_BOT_TOKEN not configured on the worker. Set it via deploy-mcp.yml secret-put (GitHub secret TELEGRAM_BOT_TOKEN) or `wrangler secret put TELEGRAM_BOT_TOKEN`." }] };
      }
      if (!target) {
        return { content: [{ type: "text" as const, text: "tg_send: no chat_id (pass chat_id or set TG_DEFAULT_CHAT_ID var in wrangler.toml)." }] };
      }

      // [employer-ad-network] purity: the acronym [employer-ad-network] has no legitimate Latin form, but
      // LLM-generated briefs default to "[employer-ad-network]". Normalize on egress so no
      // Cloud-routine/mobile output leaks Latin. Case-insensitive whole word
      // ([employer-ad-network]/[employer-ad-network]/[employer-ad-network]/…). Protect tracker prefix TRACKERQUEUE-NNN (\b after [employer-ad-network]
      // fails before "W"; (?!WEB) is belt-and-suspenders).
      // Mirrors scripts/tg-send.sh Stage 00 and telegram-bot sendText.
      text = text.replace(/\b[employer-ad-network]\b(?!WEB)/gi, "[employer-ad-network]");

      // Kitchen-lint (TG-дисциплина 2026-06-23, mechanized 2026-07-07): every
      // message lands on User's phone — plain human Russian only. Jargon
      // slips in from LLM-composed routine output (precedent: blog-capture
      // 2026-06-23 "PR #1139 blocked by status_snapshot_size FAIL…"). Reject
      // with a teaching error so the calling agent rewrites. Tracker keys
      // (PCODE-123) are fine — that's User's work vocabulary, not kitchen.
      // The commit-hash pattern requires ≥1 hex letter and no leading "/" so
      // pure numbers and a.user-site.example/<hash> URLs never false-positive.
      if (!skip_lint) {
        const KITCHEN: Array<[RegExp, string]> = [
          [/\bPR\s*#?\d+\b/i, "номер PR"],
          [/(?<![/\w])(?=[0-9]*[a-f])[0-9a-f]{7,40}\b/, "commit-хеш"],
          [/\bCI\b/, "«CI»"],
          [/\bFAIL(?:ED|URE|S)?\b/, "«FAIL»"],
          [/\b(?:STATUS_SNAPSHOT|BACKLOG|CLAUDE\.md|settings\.json|wrangler|deploy-mcp)\b/, "внутренний файл/тул"],
          [/\b(?:config|scripts|hubs|logs|tests|references|inbox)\/[\w.\-/]+/, "путь в репо"],
        ];
        const hits = [...new Set(KITCHEN.filter(([re]) => re.test(text)).map(([, label]) => label))];
        if (hits.length > 0) {
          return { content: [{ type: "text" as const, text: `tg_send: kitchen-lint отклонил сообщение (${hits.join(", ")}). Этот канал читает User-человек с телефона: перепиши живым русским — что случилось и почему ему важно, без внутренней кухни (PR/CI/хеши/пути/имена файлов). Тех-заминки, не требующие его действия, не отправляй вовсе. Если техническое сообщение запросил сам User — повтори с skip_lint:true.` }] };
        }
      }

      // Markdown-lite → HTML. Escape &<> FIRST so the only </> in the string
      // afterwards are the tags we insert — guarantees well-formed HTML and
      // never trips Telegram's parser on incidental punctuation in prose.
      let body = text;
      let parseMode: string | undefined;
      if (markdown_lite) {
        body = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        body = body.replace(/`([^`\n]+)`/g, "<code>$1</code>");
        body = body.replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/g, "$1<b>$2</b>");
        body = body.replace(/(^|[^\w_])_([^_\n]+?)_(?![\w_])/g, "$1<i>$2</i>");
        // Tracker-key autolink (2026-07-07, parity with tg-send.sh Stage 1a):
        // Cloud-routine briefs flow through THIS path and their PCODE-/
        // BSSERVER-keys arrived as plain text while the Mac path linked them.
        // Skip <code> spans (Telegram forbids <a> inside <code>) and keys
        // already inside a URL (preceded by "/").
        body = body
          .split(/(<code>[\s\S]*?<\/code>)/)
          .map((seg, i) =>
            i % 2 === 1 ? seg : seg.replace(
              /(^|[^\w/=";&-])([A-Z][A-Z0-9_]{1,20}-\d+)(?![\w-])/g,
              '$1<a href="https://st.[employer]-team.ru/$2">$2</a>'
            )
          )
          .join("");
        parseMode = "HTML";
      }

      // Telegram caps at 4096 chars/message; chunk at 4000 for entity headroom.
      // Cut at paragraph/newline boundaries (parity with tg-send.sh): a blind
      // fixed-offset slice can split an HTML tag mid-entity → Telegram rejects
      // BOTH halves with "can't parse entities".
      const chunks: string[] = [];
      let rest = body;
      while (rest.length > 4000) {
        let cut = rest.lastIndexOf("\n\n", 4000);
        if (cut < 2000) cut = rest.lastIndexOf("\n", 4000);
        if (cut < 2000) cut = 4000;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\s+/, "");
      }
      if (rest.length > 0) chunks.push(rest);

      // Numeric chat ids must go as JSON numbers; @channel usernames as strings.
      const chatIdNum = Number(target);
      const chatRef: string | number = Number.isFinite(chatIdNum) && String(chatIdNum) === String(target).trim() ? chatIdNum : target;

      try {
        for (let i = 0; i < chunks.length; i++) {
          const params: Record<string, unknown> = {
            chat_id: chatRef,
            text: chunks[i],
            disable_notification: silent,
            link_preview_options: { is_disabled: true },
          };
          if (parseMode) params.parse_mode = parseMode;
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
          });
          const data = (await res.json()) as { ok: boolean; description?: string };
          if (!data.ok) {
            return { content: [{ type: "text" as const, text: `tg_send: Telegram rejected chunk ${i + 1}/${chunks.length}: ${data.description ?? "unknown error"}` }] };
          }
        }
        const n = chunks.length > 1 ? ` (${chunks.length} chunks)` : "";
        return { content: [{ type: "text" as const, text: `sent ✓ → chat ${target}${n}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `tg_send error: ${(e as Error).message}` }] };
      }
    }
  );

  // ── memex_diff (GitHub) — compare with public memex repo ───
  server.tool(
    "memex_diff",
    "Compare claude-memory worker source with public memex repo. Returns list of files that differ or are missing.",
    {
      memex_repo: z.string().default("OWNER/memex").describe("Public memex repo (owner/name)"),
    },
    { title: "Compare with Public Memex", readOnlyHint: true, openWorldHint: true },
    async ({ memex_repo }) => {
      const filesToCompare = [
        "config/mcp-worker/src/index.ts",
        "config/mcp-worker/package.json",
        "config/mcp-worker/tsconfig.json",
        ".github/workflows/deploy-mcp.yml",
        "config/mcp-worker/setup-d1.sh",
      ];
      const diffs: string[] = [];

      for (const file of filesToCompare) {
        try {
          const privateContent = await readFile(env, file);
          const memexContent = await readFileFromRepo(env, memex_repo, file);

          if (!memexContent) {
            diffs.push(`${file}: missing in memex`);
          } else if (!privateContent) {
            diffs.push(`${file}: missing in claude-memory`);
          } else if (privateContent !== memexContent) {
            diffs.push(`${file}: differs`);
          }
        } catch {
          diffs.push(`${file}: error comparing`);
        }
      }

      if (diffs.length === 0) {
        return { content: [{ type: "text" as const, text: "Memex is in sync with claude-memory." }] };
      }
      return { content: [{ type: "text" as const, text: `Out of sync (${diffs.length} file(s)):\n${diffs.join("\n")}` }] };
    }
  );

  // ── search_index (progressive disclosure, 2026-04-20) ────────
  //
  // Returns a lightweight index of all hubs: slug + last-modified + first
  // ~120 chars summary. Caller (Claude) can then call get_hub(slug) only on
  // the ones that matter. Measured at ~50-100 tokens returned vs ~5000+
  // tokens when eagerly reading all 9 hubs. Community consensus
  // (claude-mem, token-savior 2026) — "index-first retrieval" is the
  // single biggest token-efficiency win at personal-memory scale.
  server.tool(
    "search_index",
    "Lightweight index of all hubs: slug, size, and first ~120 chars. Use BEFORE get_hub when you don't know which hub is relevant — one cheap call instead of loading all 9. Pass `query` to filter by keyword across titles/summaries.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Optional keyword filter. If omitted, returns all hubs sorted by slug."
        ),
    },
    {
      title: "Search Hub Index (progressive disclosure)",
      readOnlyHint: true,
      openWorldHint: true,
    },
    async ({ query }) => {
      const files = await listDir(env, "hubs");
      const hubs = files.filter((f) => f.endsWith(".md") && f !== "README.md");
      const rows: string[] = [];
      for (const f of hubs) {
        const content = await readFile(env, `hubs/${f}`);
        if (!content) continue;
        // Strip headings and frontmatter, find first substantial line.
        const summary = content
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("#") && !l.startsWith("---")) ?? "";
        const preview = summary.slice(0, 120);
        const line = `- ${f} (${content.length}B): ${preview}${summary.length > 120 ? "…" : ""}`;
        if (!query || line.toLowerCase().includes(query.toLowerCase())) {
          rows.push(line);
        }
      }
      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: query ? `No hubs match "${query}".` : "No hubs indexed.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Hub index${query ? ` (query: "${query}")` : ""}:\n${rows.join("\n")}\n\nNext step: call get_hub(domain=...) on the relevant slug only.`,
          },
        ],
      };
    }
  );

  // ── semantic_search (TZ 1, 2026-05-01) ───────────────────────
  //
  // Pure vector retrieval over the BGE-M3 multilingual index in Vectorize.
  // Multilingual: a Russian query can match English chunks and vice versa.
  // Use for "find me content about <concept>" when keyword search would miss.
  // Returns friendly error if VECTORIZE/AI bindings missing.
  server.tool(
    "semantic_search",
    "Semantic search across hubs/references/root .md via BGE-M3 embeddings (multilingual RU+EN). Use when keyword search would miss — finds content by meaning, not exact words.",
    {
      query: z.string().describe("Free-form search query in any language."),
      top_k: z.coerce.number().int().min(1).max(20).default(5).describe("Number of results to return (1-20)."),
      hub_slug: z.string().optional().describe("Optional hub slug filter (e.g. '08_jay_health')."),
      file_path: z.string().optional().describe("Optional file path filter (e.g. 'hubs/06_relocation.md')."),
    },
    { title: "Semantic Search (Vectorize)", readOnlyHint: true, openWorldHint: true },
    async ({ query, top_k, hub_slug, file_path }) => {
      if (!env.VECTORIZE || !env.AI) {
        return { content: [{ type: "text" as const, text: "semantic_search: VECTORIZE + AI bindings required but not configured. See config/SEMANTIC_SEARCH_GATEWAY_DEPLOYMENT.md Phase B.1 to provision." }] };
      }
      try {
        const filter = (hub_slug || file_path) ? { ...(hub_slug ? { hub_slug } : {}), ...(file_path ? { file_path } : {}) } : undefined;
        const results = await searchSemantic({ AI: env.AI, VECTORIZE: env.VECTORIZE }, query, top_k, filter);
        return { content: [{ type: "text" as const, text: formatSearchResults(query, results) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `semantic_search failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  // ── hybrid_search (TZ 1, 2026-05-01) ─────────────────────────
  //
  // Semantic top-N candidates re-ranked with local BM25. `alpha` is the
  // semantic weight in [0, 1] — alpha=1 → pure semantic, alpha=0 → pure
  // BM25 (lexical re-rank dominates), alpha=0.5 → balanced.
  // Use when exact-name matches matter (Eurobelka, Yulia, PCODE-XXXX).
  server.tool(
    "hybrid_search",
    "Hybrid semantic + BM25 search. Combines BGE-M3 vector similarity with lexical keyword re-ranking — surfaces exact name matches that pure semantic might rank lower. alpha=1 pure semantic, alpha=0 pure BM25, alpha=0.5 balanced.",
    {
      query: z.string().describe("Search query."),
      top_k: z.coerce.number().int().min(1).max(20).default(5).describe("Number of results to return (1-20)."),
      alpha: z.coerce.number().min(0).max(1).default(0.5).describe("Semantic weight in [0,1]. 1 = pure semantic, 0 = pure BM25, 0.5 = balanced."),
      hub_slug: z.string().optional().describe("Optional hub slug filter."),
      file_path: z.string().optional().describe("Optional file path filter."),
    },
    { title: "Hybrid Semantic + BM25 Search", readOnlyHint: true, openWorldHint: true },
    async ({ query, top_k, alpha, hub_slug, file_path }) => {
      if (!env.VECTORIZE || !env.AI) {
        return { content: [{ type: "text" as const, text: "hybrid_search: VECTORIZE + AI bindings required but not configured. See config/SEMANTIC_SEARCH_GATEWAY_DEPLOYMENT.md Phase B.1." }] };
      }
      try {
        const filter = (hub_slug || file_path) ? { ...(hub_slug ? { hub_slug } : {}), ...(file_path ? { file_path } : {}) } : undefined;
        const results = await searchHybrid({ AI: env.AI, VECTORIZE: env.VECTORIZE }, query, top_k, alpha, filter);
        return { content: [{ type: "text" as const, text: formatSearchResults(query, results) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `hybrid_search failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  // ── gateway_logs (TZ 2, 2026-05-01) ──────────────────────────
  //
  // Reads logs from the AI Gateway slug `claude-memory` via CF REST API.
  // Filters by `surface` metadata (telegram_bot today; web/mobile in future
  // when those surfaces start tagging metadata too) and time window.
  // Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN secrets (set via
  // wrangler secret put). Token must have `AI Gateway: Read` scope.
  server.tool(
    "gateway_logs",
    "Read AI Gateway logs for the `claude-memory` gateway. Filter by surface (telegram_bot etc.) and time window. Useful for cost attribution, debugging stuck requests, audit of LLM usage across surfaces.",
    {
      surface: z.string().optional().describe("Filter by metadata.surface (e.g. 'telegram_bot'). Omit for all surfaces."),
      since_iso: z.string().optional().describe("ISO 8601 start of window (e.g. '2026-05-01T00:00:00Z'). Default: 24h ago."),
      until_iso: z.string().optional().describe("ISO 8601 end of window. Default: now."),
      limit: z.coerce.number().int().min(1).max(100).default(20).describe("Max rows to return (1-100)."),
    },
    { title: "Read AI Gateway Logs", readOnlyHint: true, openWorldHint: true },
    async ({ surface, since_iso, until_iso, limit }) => {
      if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
        return { content: [{ type: "text" as const, text: "gateway_logs: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN secrets required but not configured. See config/SEMANTIC_SEARCH_GATEWAY_DEPLOYMENT.md Phase B.2 to provision." }] };
      }
      const params = new URLSearchParams();
      params.set("per_page", String(limit));
      if (surface) params.set("metadata.surface", surface);
      if (since_iso) params.set("start_date", since_iso);
      if (until_iso) params.set("end_date", until_iso);
      const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways/claude-memory/logs?${params.toString()}`;
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            Accept: "application/json",
            "User-Agent": WORKER_UA,
          },
        });
        if (!res.ok) {
          const body = await res.text();
          return { content: [{ type: "text" as const, text: `gateway_logs: CF API ${res.status}: ${body.slice(0, 400)}` }] };
        }
        const data = (await res.json()) as { result?: Array<Record<string, unknown>>; success?: boolean };
        const rows = data.result ?? [];
        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `gateway_logs: 0 rows in window${surface ? ` (surface=${surface})` : ""}.` }] };
        }
        const lines = rows.slice(0, limit).map((r) => {
          const ts = (r.created_at as string) ?? "?";
          const model = (r.model as string) ?? "?";
          const tokIn = (r.tokens_in as number) ?? 0;
          const tokOut = (r.tokens_out as number) ?? 0;
          const meta = r.metadata as Record<string, unknown> | undefined;
          const surf = meta?.surface ?? "—";
          const chat = meta?.chat_id ?? "—";
          const status = r.status_code ?? "?";
          return `- ${ts} [${status}] ${model} surface=${surf} chat=${chat} tok=${tokIn}→${tokOut}`;
        });
        return { content: [{ type: "text" as const, text: `gateway_logs (${rows.length} rows${surface ? `, surface=${surface}` : ""}):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `gateway_logs failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  // ── Prompts (MCP capability, 2026-04-20) ─────────────────────
  //
  // MCP `prompts` are reusable templates that clients can surface as
  // slash-commands or auto-insert at session start. Three prompts:
  //   1. wake_up — bootstrap a session with current status + last meetings
  //   2. memory_consolidation — weekly digest template
  //   3. brainstorm_with_memory — STRATEGY-mode ideation with hub context
  //
  // Registered via MCP SDK `server.prompt()`. Consumed by Claude Code
  // clients via /<plugin>:<prompt> slash commands.

  server.prompt(
    "wake_up",
    "Bootstrap a Claude session: load STATUS_SNAPSHOT, MEMORY_EDITS, mobile-kickoff + mobile-skills-catalog (hubs 00/18), last 5 meetings, unresolved errors. Use at the start of any session before making assertions about ongoing topics.",
    {},
    async () => {
      const snapshot = (await readFile(env, "STATUS_SNAPSHOT.md")) ?? "(STATUS_SNAPSHOT.md not available)";
      const rules = (await readFile(env, "MEMORY_EDITS.md")) ?? "(MEMORY_EDITS.md not available)";
      // Mobile bootstrap (hub00) + portable workflows catalog (hub18) are
      // loaded ALWAYS — on desktop they're ~0 cost (15K tokens combined) and
      // give the same surface-agnostic routing. On mobile they're essential
      // because claude.ai doesn't expose Claude Code skills system.
      const mobileKickoff = (await readFile(env, "hubs/00_mobile_kickoff.md")) ?? "(hubs/00_mobile_kickoff.md not available)";
      const mobileCatalog = (await readFile(env, "hubs/18_mobile_skills_catalog.md")) ?? "(hubs/18_mobile_skills_catalog.md not available)";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                "Bootstrap context. Read before answering anything about ongoing topics.\n\n" +
                "===== STATUS_SNAPSHOT.md =====\n" +
                snapshot +
                "\n\n===== MEMORY_EDITS.md =====\n" +
                rules +
                "\n\n===== hubs/00_mobile_kickoff.md =====\n" +
                mobileKickoff +
                "\n\n===== hubs/18_mobile_skills_catalog.md =====\n" +
                mobileCatalog +
                "\n\n===== Ready. =====\nCall get_hub(domain) for deeper topic reads. Call granola_context(domain|query) for meeting history. Call query_facts(query) for D1 facts. On mobile: every portable workflow (meeting prep, ticket triage, metrics digest, deepagent, publish artifact) is documented above with copy-paste prompts.",
            },
          },
        ],
      };
    }
  );

  server.prompt(
    "memory_consolidation",
    "Weekly/monthly memory consolidation routine. Finds stale facts, unresolved errors, and duplicate entries. Produces a compact action plan — no writes without explicit user approval.",
    {
      window_days: z
        .string()
        .optional()
        .describe("How many days back to look. Defaults to 7."),
    },
    async ({ window_days }) => {
      const days = Number(window_days ?? "7");
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Run a memory consolidation pass over the last ${days} days. ` +
                "Procedure:\n" +
                "1. query_facts({query: '*'}) — scan for duplicates by (entity, attribute)\n" +
                "2. error_report({unresolved_only: true}) — list open errors\n" +
                "3. search_index() — scan all hubs for staleness markers (TODO without date, >14d unrefreshed STATUS)\n" +
                "4. granola_context({domain: 'all'}) — last meetings for action-item drift\n" +
                "5. Produce a compact table: {finding, source, proposed action, confidence}. Do NOT call write-tools until the user approves.",
            },
          },
        ],
      };
    }
  );

  server.prompt(
    "brainstorm_with_memory",
    "STRATEGY-mode ideation with full memory context. Pulls relevant hubs + recent meetings + user profile, then acts as an aggressive devil's advocate on the given topic.",
    {
      topic: z.string().describe("The question, idea, or decision to brainstorm."),
    },
    async ({ topic }) => {
      const profile = (await readFile(env, "hubs/02_personal_profile.md")) ?? "";
      const snapshot = (await readFile(env, "STATUS_SNAPSHOT.md")) ?? "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                "Enter STRATEGY mode (from RULES.md: challenge hard, attack logic, demand evidence, find blind spots).\n\n" +
                `**Topic:** ${topic}\n\n` +
                "**User's profile** (for calibration):\n" +
                profile.slice(0, 3000) +
                "\n\n**Current status snapshot** (for context — check for conflicts with topic):\n" +
                snapshot.slice(0, 3000) +
                "\n\nRun: (1) four Edmans rungs on the topic's hidden assumptions, (2) devil's-advocate angles, (3) single sharpest question to resolve before any action. No agreement without disconfirmation attempted.",
            },
          },
        ],
      };
    }
  );

  return server;
}

function searchInContent(
  content: string,
  query: string,
  domain: string
): { content: Array<{ type: "text"; text: string }> } {
  const lines = content.split("\n");
  const lowerQuery = query.toLowerCase();
  const matches: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length - 1, i + 3);
      const block = lines
        .slice(start, end + 1)
        .map((l, idx) => `${start + idx + 1}${idx + start === i ? " >>>" : "    "} ${l}`)
        .join("\n");
      matches.push(block);
    }
  }

  if (matches.length === 0) {
    return {
      content: [
        { type: "text" as const, text: `No matches for "${query}" in ${domain} hub.` },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `${matches.length} match(es) for "${query}" in ${domain}:\n\n${matches.join("\n\n---\n\n")}`,
      },
    ],
  };
}

// ── Phase 1.5 cron extensions: cache hygiene + weekly snapshot ──
//
// Both run inside the existing daily 07:00 UTC cron. Cache hygiene fires
// every day; weekly snapshot is gated on UTC day-of-week === Sunday.
//
// Failure isolation: each is wrapped in its own try/catch so one failure
// doesn't cascade. Both append a one-line status to `checks[]` so the
// sessions-table heartbeat reflects success/failure count.

async function cacheHygiene(env: Env): Promise<string> {
  // Strategy: fetch the full git tree (one API call, all blob SHAs) and
  // compare against `last_seen_sha` in memory_files_cache. Mismatches
  // and missing-from-tree entries get DELETEd from the cache so the next
  // read repopulates from GitHub. This catches drift caused by direct
  // `git push` from Code sessions, cron tasks, or GitHub UI edits that
  // bypass MCP `update_file`.
  try {
    const cachedRows = await env.DB
      .prepare("SELECT path, last_seen_sha FROM memory_files_cache")
      .all<{ path: string; last_seen_sha: string | null }>();
    const cached = cachedRows.results ?? [];
    if (cached.length === 0) {
      return "✓ Cache hygiene: cache empty, nothing to verify";
    }

    const treeRes = await fetch(
      `${GITHUB_API}/repos/${env.GITHUB_REPO}/git/trees/main?recursive=1`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_PAT}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": WORKER_UA,
        },
      }
    );
    if (!treeRes.ok) {
      return `⚠️ Cache hygiene: git tree fetch failed (${treeRes.status})`;
    }
    const tree = (await treeRes.json()) as {
      truncated?: boolean;
      tree?: Array<{ path: string; sha: string; type: string }>;
    };
    if (tree.truncated) {
      // Repo grew past tree API limit — fall back to per-row HEAD checks
      // would be expensive. For now skip and surface as warning so we
      // know to switch strategies. claude-memory has <500 files, this is
      // a future-proofing branch.
      return "⚠️ Cache hygiene: git tree truncated — sweep skipped this run";
    }
    const treeMap = new Map<string, string>();
    for (const node of tree.tree ?? []) {
      if (node.type === "blob") treeMap.set(node.path, node.sha);
    }

    let invalidated = 0;
    let missing = 0;
    let kept = 0;
    for (const row of cached) {
      const upstreamSha = treeMap.get(row.path);
      if (!upstreamSha) {
        // File deleted from upstream (or path moved) — remove cache row.
        try {
          await env.DB.prepare("DELETE FROM memory_files_cache WHERE path = ?").bind(row.path).run();
          missing++;
        } catch { /* best-effort */ }
        continue;
      }
      if (row.last_seen_sha && row.last_seen_sha !== upstreamSha) {
        // External edit detected — invalidate so next read repopulates.
        try {
          await env.DB.prepare("DELETE FROM memory_files_cache WHERE path = ?").bind(row.path).run();
          invalidated++;
        } catch { /* best-effort */ }
        continue;
      }
      kept++;
    }
    return `✓ Cache hygiene: ${kept} fresh, ${invalidated} invalidated (drift), ${missing} purged (deleted upstream)`;
  } catch (e) {
    return `⚠️ Cache hygiene failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function weeklySnapshot(env: Env): Promise<string> {
  // Only fire on Sundays UTC. Phase 1.5 — provides cold backup for D1
  // tables that aren't reproducible from git: facts, knowledge_graph,
  // sessions, granola_meetings, errors, portal_events, telegram_messages.
  // memory_files_cache excluded (reproducible from git). session_log + cache
  // dropped 2026-06-13 — dead day-1 prototypes (0 readers/writers).
  const today = new Date();
  if (today.getUTCDay() !== 0) {
    return `✓ Weekly snapshot: skip (UTC day ${today.getUTCDay()}, fires Sundays only)`;
  }
  if (!env.STORE) {
    return "⚠️ Weekly snapshot: STORE binding missing, skipped";
  }

  const tables = [
    "facts",
    "knowledge_graph",
    "sessions",
    "granola_meetings",
    "errors",
    "portal_events",
    "telegram_messages",
  ];
  const dump: Record<string, unknown> = {
    snapshot_at: today.toISOString(),
    worker_version: WORKER_VERSION,
    tables: {} as Record<string, unknown[]>,
  };
  let totalRows = 0;
  for (const table of tables) {
    try {
      const res = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      const rows = res.results ?? [];
      (dump.tables as Record<string, unknown[]>)[table] = rows;
      totalRows += rows.length;
    } catch (e) {
      // Table missing on fresh DB or rare query failure — record but don't
      // abort the whole snapshot.
      (dump.tables as Record<string, unknown[]>)[table] = [];
      console.warn(`weeklySnapshot: ${table} dump failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const json = JSON.stringify(dump);
  const dateKey = today.toISOString().slice(0, 10);
  const key = `db-snapshots/${dateKey}.json.gz`;

  try {
    // Gzip via CompressionStream (available in CF Workers). R2 put rejects
    // streams of unknown length ("Provided readable stream must have a known
    // length … FixedLengthStream") — that broke every Sunday snapshot since
    // 2026-06-14 — so buffer the compressed bytes before upload. Falls back
    // to raw JSON if compression throws (older runtime).
    let body: ArrayBuffer | string = json;
    let contentEncoding = "identity";
    try {
      const stream = new Response(json).body!.pipeThrough(new CompressionStream("gzip"));
      body = await new Response(stream).arrayBuffer();
      contentEncoding = "gzip";
    } catch {
      // No compression — store raw
    }
    await env.STORE.put(key, body, {
      httpMetadata: { contentType: "application/json", contentEncoding },
      customMetadata: {
        snapshot_at: today.toISOString(),
        total_rows: String(totalRows),
        tables: tables.join(","),
      },
    });
    return `✓ Weekly snapshot: ${totalRows} rows across ${tables.length} tables → ${key} (${contentEncoding})`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Loud-fail: a silent R2 upload failure left db-snapshots/ empty for weeks
    // (audit 2026-06-13). Surface it as a high-severity errors row so the next
    // health_check / morning brief sees it instead of it vanishing into a heartbeat.
    try {
      await env.DB
        .prepare("INSERT INTO errors (error_type, description, severity) VALUES ('weekly_snapshot', ?, 'high')")
        .bind(`R2 db-snapshot upload failed: ${msg}`)
        .run();
    } catch {}
    return `⚠️ Weekly snapshot upload failed: ${msg}`;
  }
}

// ── Nightly deep analysis cron (2026-06-12) ─────────────────
//
// Migrated from .github/workflows/nightly-deep-analysis.yml (GHA quota
// exhausted 2026-05-28; migration decided in deliverables/mobile-brief-
// 2026-05-28.md §4, executed in the loop-engineering session 2026-06-12).
// Runs Mon/Wed/Fri 03:00 UTC on the worker cron — free tier, no GHA minutes.
//
// Loop contract (references/loop_engineering_2026-06-12.md):
//   - Stopping condition: one analysis file committed per run, or one
//     `errors` row explaining why not. Never silent.
//   - Kill switch (no redeploy): facts row entity='loop_control',
//     attribute='nightly_deep_analysis', value='off'. Toggle from any
//     surface via store_fact; re-enable with value='on' or forget_fact.
//   - Observability: sessions-table heartbeat + console.log (Workers Logs).
//
// Anthropic calls route through AI Gateway (slug `claude-memory`) when
// CLOUDFLARE_ACCOUNT_ID is set — usage then shows up in the gateway
// dashboard next to the Telegram bot's traffic. Falls back to the direct
// API endpoint otherwise. Model: claude-opus-4-8 (parity with the GHA
// script; deliberately NOT Fable — cheaper, and an unattended synthesis
// loop doesn't need frontier reasoning).
//
// Worker limits note: the Anthropic call is one long `fetch` await —
// wall-clock time while awaiting I/O does not consume Workers CPU budget,
// so an 8K-token generation is safe inside a cron invocation.

const NIGHTLY_ANALYSIS_PROMPT = `You are doing nightly deep analysis of User's claude-memory repo.

Read the loaded context carefully. Then produce comprehensive analysis with these sections:

## 1. State of the union (200 words)
Where is everything across all domains ([employer-ad-network] work, [side-project], Spanish, [pet], relocation, user-site.example)? Concrete facts, not vague summary.

## 2. Hidden patterns (5 findings, ~100 words each)
Cross-hub correlations not visible from any single hub. Cite specific files/lines.

## 3. Decisions in flight (3-5 items)
SETTLED decisions being implicitly re-tested by recent activity. Specific cases.

## 4. Risk items (3-5)
What's quietly drifting that User might miss? Each with specific «closes when» criterion.

## 5. Leverage points (3-5)
Single actions that unblock multiple downstream items. Each with specific «if X happens, Y/Z become possible» mapping.

## 6. Suggested next-7-days priorities (top 3)
With explicit rationale referring back to sections 1-5.

## 7. Self-improvement observations
What recurring patterns suggest mechanical guards needed (hook/test/converter/lint)? Be specific about implementation.

Output as markdown. Goal: 1500-2500 words. Conclusions-first writing style (per CLAUDE.md «Communication discipline»). Russian + English mix OK per User usage. Use absolute dates (CLAUDE.md rule).`;

async function nightlyDeepAnalysis(env: Env): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const startedAt = new Date().toISOString();

  const heartbeat = async (summary: string) => {
    try {
      await env.DB.prepare(
        "INSERT INTO sessions (surface, summary, topics, started_at, ended_at) VALUES (?, ?, ?, ?, ?)"
      ).bind("cron", summary, "nightly-analysis,cron", startedAt, new Date().toISOString()).run();
    } catch { /* best-effort */ }
  };
  const fileError = async (description: string, severity: "high" | "critical") => {
    try {
      // Same-day dedup, mirroring the TG DLQ pattern — a Mon/Wed/Fri cron
      // must not stack identical open rows.
      const existing = await env.DB.prepare(
        `SELECT id FROM errors WHERE error_type = 'nightly_analysis_failed' AND resolved = 0
           AND created_at > datetime('now','-1 days') LIMIT 1`
      ).first().catch(() => null);
      if (!existing) {
        await env.DB.prepare(
          "INSERT INTO errors (error_type, description, domain, severity, resolved) VALUES (?, ?, ?, ?, 0)"
        ).bind("nightly_analysis_failed", description, "claude-infra", severity).run();
      }
    } catch { /* best-effort */ }
  };

  try {
    // 0. Kill switch — checked before any work. Loop governance per
    //    references/loop_engineering_2026-06-12.md § What we change #4.
    const killRow = await env.DB.prepare(
      `SELECT value FROM facts WHERE entity = 'loop_control' AND attribute = 'nightly_deep_analysis'
         ORDER BY updated_at DESC LIMIT 1`
    ).first<{ value: string }>().catch(() => null);
    if (killRow && ["off", "0", "false"].includes(killRow.value.trim().toLowerCase())) {
      console.log(`[nightly-analysis] ${date}: kill switch is OFF — skipping run`);
      await heartbeat("Nightly analysis: skipped (kill switch off)");
      return;
    }

    if (!env.ANTHROPIC_API_KEY) {
      console.log(`[nightly-analysis] ${date}: ANTHROPIC_API_KEY secret missing — cannot run`);
      await fileError(
        "Nightly analysis cron fired but ANTHROPIC_API_KEY worker secret is not set. Run: cd config/mcp-worker && npx wrangler secret put ANTHROPIC_API_KEY",
        "high"
      );
      await heartbeat("Nightly analysis: FAILED (no API key)");
      return;
    }

    // 1. Build context — same recipe as the GHA workflow's "Build context
    //    file" step: snapshot + CLAUDE.md + all hubs + recent commits +
    //    BACKLOG head, capped at 250K chars (~60K tokens).
    const parts: string[] = [];
    const push = async (label: string, content: string | null) => {
      if (content) parts.push(`=== ${label} ===\n${content}`);
    };
    await push("STATUS_SNAPSHOT", await readFile(env, "STATUS_SNAPSHOT.md"));
    await push("CLAUDE.md", await readFile(env, "CLAUDE.md"));

    const hubEntries = await listDir(env, "hubs");
    const hubFiles = hubEntries
      .map((f) => f.replace(/^[^ ]+ /, ""))
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const hub of hubFiles) {
      await push(`hubs/${hub}`, await readFile(env, `hubs/${hub}`));
    }

    try {
      const commitsRes = await fetch(
        `${GITHUB_API}/repos/${env.GITHUB_REPO}/commits?per_page=30`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_PAT}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": WORKER_UA,
          },
        }
      );
      if (commitsRes.ok) {
        const commits = (await commitsRes.json()) as Array<{
          sha: string;
          commit: { message: string };
        }>;
        const lines = commits.map(
          (c) => `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]}`
        );
        await push("Recent commits (30)", lines.join("\n"));
      }
    } catch { /* commits are enrichment, not required */ }

    const backlog = await readFile(env, "BACKLOG.md");
    if (backlog) {
      await push("BACKLOG (head 300 lines)", backlog.split("\n").slice(0, 300).join("\n"));
    }

    let context = parts.join("\n\n");
    if (context.length > 250000) context = context.slice(0, 250000);
    if (context.length < 1000) {
      await fileError(`Nightly analysis: context build produced only ${context.length} chars — GitHub reads likely failing. Aborted before spending tokens.`, "high");
      await heartbeat("Nightly analysis: FAILED (context too small)");
      return;
    }

    // 2. Call Anthropic — via AI Gateway when account id is configured.
    const endpoint = env.CLOUDFLARE_ACCOUNT_ID
      ? `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/claude-memory/anthropic/v1/messages`
      : "https://api.anthropic.com/v1/messages";
    const model = "claude-opus-4-8";
    const apiRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        messages: [
          { role: "user", content: `${NIGHTLY_ANALYSIS_PROMPT}\n\n=== CONTEXT ===\n\n${context}` },
        ],
      }),
    });
    if (!apiRes.ok) {
      const errText = (await apiRes.text()).slice(0, 500);
      await fileError(`Nightly analysis: Anthropic API ${apiRes.status} via ${env.CLOUDFLARE_ACCOUNT_ID ? "AI Gateway" : "direct"}: ${errText}`, "high");
      await heartbeat(`Nightly analysis: FAILED (API ${apiRes.status})`);
      return;
    }
    const apiData = (await apiRes.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const outputText = apiData.content?.find((b) => b.type === "text")?.text ?? "";
    if (!outputText) {
      await fileError("Nightly analysis: API returned no text block (refusal or empty response).", "high");
      await heartbeat("Nightly analysis: FAILED (empty response)");
      return;
    }
    const inTok = apiData.usage?.input_tokens ?? 0;
    const outTok = apiData.usage?.output_tokens ?? 0;

    // 3. Commit the result to the repo — same destination as the GHA
    //    version, so downstream readers (morning briefing, dreaming) need
    //    no change.
    const header =
      `# Nightly Deep Analysis — ${date}\n\n` +
      `_Auto-generated by claude-memory-mcp worker cron (0 3 * * 1,3,5), migrated from GHA 2026-06-12_\n` +
      `_Model: ${model} · Input tokens: ${inTok.toLocaleString("en-US")} · Output tokens: ${outTok.toLocaleString("en-US")}_\n` +
      `_Context chars: ${context.length.toLocaleString("en-US")} · Route: ${env.CLOUDFLARE_ACCOUNT_ID ? "AI Gateway" : "direct API"}_\n\n---\n\n`;
    const write = await writeFile(
      env,
      `logs/nightly_analysis/${date}.md`,
      header + outputText,
      `nightly: deep analysis ${date} (worker cron)`
    );
    if (!write.success) {
      await fileError(`Nightly analysis: generated OK (${outTok} tokens) but repo commit failed: ${write.error}`, "critical");
      await heartbeat("Nightly analysis: FAILED (commit failed)");
      return;
    }

    console.log(`[nightly-analysis] ${date}: OK — ${outTok} output tokens, ${context.length} context chars`);
    await heartbeat(`Nightly analysis: OK (${outTok} out tokens → logs/nightly_analysis/${date}.md)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[nightly-analysis] ${date}: EXCEPTION ${msg}`);
    await fileError(`Nightly analysis: unhandled exception: ${msg}`, "high");
    await heartbeat("Nightly analysis: FAILED (exception)");
  }
}

// ── Request handler with URL path auth ──────────────────────

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check (no auth) — advertises the *declared* tool count. Keep this
    // constant in sync with the number of `server.tool(` registrations in this
    // file; `tests/run-all.sh` → `worker_root_tool_count_matches_source` guards
    // against drift between this literal and the source-truth count.
    if (path === "/" || path === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          name: "claude-memory-mcp",
          version: WORKER_VERSION,
          tools: 48,
          iconUrl: `${WORKER_PUBLIC_URL}/icon.svg`,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Connector-config (no auth) — surfaces the current recommended
    // connector URL so morning brief / wake_up / Chat sessions can tell when
    // the claude.ai connector falls behind the deployed worker. Behavior
    // change doesn't require reconnect; tool-list change does. User can
    // check freshness without rebuilding everything he already knows about
    // MCP caching. Used by MORNING_BRIEFING_TASK Step 1.5 + RULES §14.
    if (path === "/connector-config") {
      const toolsAsOf = 48;
      const frozenSince = "2026-05-01";
      // 2026-05-27: Recommended URL — clean, БЕЗ query-param `?v=`.
      // User один раз reconnects, дальше при изменениях instructions/tools
      // юзает кнопку «Refresh tools list» в claude.ai connector settings.
      // Worker отдаёт `cache-control: no-cache`, MCP capabilities включают
      // `tools.listChanged: true`. Стабильно к будущим изменениям.
      const currentUrl = `${WORKER_PUBLIC_URL}/mcp`;
      return new Response(
        JSON.stringify({
          worker_version: WORKER_VERSION,
          tools_advertised: toolsAsOf,
          tool_surface_frozen_since: frozenSince,
          recommended_connector_url: currentUrl,
          // NOTE: we intentionally do NOT echo AUTH_PATH_TOKEN here. The
          // path-token variant of the connector URL lives in the user's
          // password manager and is never surfaced by this unauthenticated
          // endpoint. A 2026-04-22 PM mistake briefly included it; fixed
          // same session and the token was rotated out-of-band.
          how_to_refresh: {
            ui: "При изменении instructions / tools — claude.ai → Settings → Connectors → Claude Memory → ⋮ → «Refresh tools list». Permissions сохранятся. URL менять НЕ нужно — раньше `?v=` был cache-buster, теперь убран. Если кнопка не пришла — re-edit URL: add temp `?r=<today>` → Save → remove обратно (force re-init).",
            policy: "Per RULES.md §14, the worker will not add new top-level tools; new functionality extends existing tools via params. Baseline raised 44→47 on 2026-05-01 (TZ 1+2 landing), then 47→48 on 2026-06-13 (tg_send — outbound Telegram from mobile/web). Any further increase above 48 means the §14 rule was intentionally overridden — check the commit body for rationale.",
          },
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // Spanish-portal telemetry ingest (no auth, CORS *).
    // Accepts {ns:"portal", kind, sid, ts?, data?} JSON. Browser-side caller
    // is /Users/<user>/GitHub/spanish-portal/src/lib/telemetry.ts. Reads use
    // the existing recent_sessions tool with source="portal" — no new MCP
    // tool needed (RULES §14, frozen tool surface).
    if (path === "/events") {
      const cors: Record<string, string> = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      };
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      try {
        await ensureTables(env.DB);
        const body = (await request.json().catch(() => ({}))) as {
          ns?: string; kind?: string; sid?: string; ts?: number; data?: unknown;
        };
        const ns = String(body?.ns ?? "").slice(0, 32);
        if (ns !== "portal") {
          return new Response(JSON.stringify({ error: "invalid ns; expected 'portal'" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...cors },
          });
        }
        const kind = String(body?.kind ?? "unknown").slice(0, 64);
        const sid = String(body?.sid ?? "anon").slice(0, 64);
        const ts = Number.isFinite(body?.ts) ? Number(body!.ts) : Date.now();
        const data = JSON.stringify(body?.data ?? {}).slice(0, 4096);

        await env.DB
          .prepare(`INSERT INTO portal_events (ts, kind, sid, data) VALUES (?, ?, ?, ?)`)
          .bind(ts, kind, sid, data)
          .run();
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }

    // ── Indexer endpoints (TZ 1, 2026-05-01) ─────────────────────────────
    //
    // POST /index/incremental — fired by GitHub Action `reindex.yml` on every
    // push to main that touches an indexable path. Body shape:
    //   { commit_sha: string, files: [{path: string, status: "added"|"modified"|"removed"}] }
    // For each indexable file: deleteByFilePath first (idempotent — nukes any
    // prior chunks with this path), then if status != "removed" also
    // chunkMarkdown + upsertChunks. status="removed" → delete only.
    //
    // POST /index/bootstrap — full repo reindex from scratch. Body: { confirm: true }.
    // Used once after Phase B Vectorize index creation, or when a chunking
    // change requires a full rebuild. Calls listIndexablePaths → for each
    // file: readFileFromRepo + chunkMarkdown + upsertChunks (no delete-first
    // because chunk IDs are deterministic from filepath+index, so upsert
    // overwrites cleanly).
    //
    // Both auth via Bearer == AUTH_PATH_TOKEN. Both return 503 if VECTORIZE/AI
    // bindings missing. Both write-bounded by Vectorize free-tier quota.
    if (path === "/index/incremental" || path === "/index/bootstrap") {
      // Auth: Bearer matches AUTH_PATH_TOKEN
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "POST only" }), {
          status: 405,
          headers: { "Content-Type": "application/json" },
        });
      }
      const auth = request.headers.get("Authorization") || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (!env.AUTH_PATH_TOKEN || token !== env.AUTH_PATH_TOKEN) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!env.VECTORIZE || !env.AI) {
        return new Response(
          JSON.stringify({ error: "VECTORIZE + AI bindings required but not configured" }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }

      const indexerEnv = { AI: env.AI, VECTORIZE: env.VECTORIZE };

      if (path === "/index/incremental") {
        const body = (await request.json().catch(() => ({}))) as {
          commit_sha?: string;
          files?: Array<{ path?: string; status?: string }>;
        };
        const commitSha = String(body.commit_sha ?? "unknown");
        const files = Array.isArray(body.files) ? body.files : [];
        let processed = 0;
        let upserted = 0;
        let deleted = 0;
        const errors: string[] = [];
        for (const f of files) {
          const fp = String(f.path ?? "");
          if (!fp || !isIndexable(fp)) continue;
          processed++;
          try {
            // Idempotent: delete-first regardless of status, then upsert if not removed.
            const del = await deleteByFilePath(indexerEnv, fp);
            deleted += del.deleted;
            if (f.status !== "removed") {
              const content = await readFile(env, fp);
              if (content) {
                const chunks = chunkMarkdown(fp, content, commitSha);
                const up = await upsertChunks(indexerEnv, chunks);
                upserted += up.upserted;
              }
            }
          } catch (e) {
            errors.push(`${fp}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return new Response(
          JSON.stringify({
            ok: errors.length === 0,
            commit_sha: commitSha,
            files_processed: processed,
            chunks_upserted: upserted,
            chunks_deleted: deleted,
            errors: errors.slice(0, 20),
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      // /index/bootstrap
      // Body: { confirm: true, start_after?: "path/to/last/processed", limit?: 30 }
      // Workers free/paid subrequest budget is finite per invocation; for the
      // current repo size (~76 indexable .md), one-shot bootstrap exceeds the
      // budget. The caller supplies start_after on subsequent calls to resume
      // (paths are deterministically sorted by listIndexablePaths). limit caps
      // the number of files processed per invocation; default 30 keeps each
      // call well under the per-invocation subrequest cap.
      const body = (await request.json().catch(() => ({}))) as {
        confirm?: boolean;
        start_after?: string;
        limit?: number;
      };
      if (!body.confirm) {
        return new Response(
          JSON.stringify({ error: "bootstrap requires { confirm: true } in body" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      const startAfter = typeof body.start_after === "string" ? body.start_after : "";
      const limitFiles = Math.max(1, Math.min(100, Number(body.limit ?? 30)));
      const allPaths = await listIndexablePaths(env);
      // Resume: skip until past start_after (lexically). When start_after is
      // empty, no skipping — full list from beginning.
      const resumeIdx = startAfter
        ? allPaths.findIndex((p) => p > startAfter)
        : 0;
      const sliceStart = resumeIdx < 0 ? allPaths.length : resumeIdx;
      const paths = allPaths.slice(sliceStart, sliceStart + limitFiles);
      const remaining = allPaths.length - sliceStart - paths.length;
      const lastProcessed = paths.length > 0 ? paths[paths.length - 1] : startAfter;
      let filesIndexed = 0;
      let totalChunks = 0;
      const errors: string[] = [];
      // Resolve commit SHA for metadata (best-effort — fall back to "bootstrap").
      let commitSha = "bootstrap";
      try {
        const r = await fetch(
          `${GITHUB_API}/repos/${env.GITHUB_REPO}/commits/main`,
          {
            headers: {
              Authorization: `Bearer ${env.GITHUB_PAT}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": WORKER_UA,
            },
          }
        );
        if (r.ok) {
          const d = (await r.json()) as { sha?: string };
          if (d.sha) commitSha = d.sha;
        }
      } catch { /* best-effort */ }

      for (const fp of paths) {
        try {
          const content = await readFile(env, fp);
          if (!content) continue;
          const chunks = chunkMarkdown(fp, content, commitSha);
          const up = await upsertChunks(indexerEnv, chunks);
          totalChunks += up.upserted;
          filesIndexed++;
        } catch (e) {
          errors.push(`${fp}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return new Response(
        JSON.stringify({
          ok: errors.length === 0,
          commit_sha: commitSha,
          files_indexed: filesIndexed,
          total_chunks: totalChunks,
          included_paths_total: allPaths.length,
          batch_size: paths.length,
          remaining,
          last_processed: lastProcessed,
          done: remaining === 0 && errors.length === 0,
          errors: errors.slice(0, 20),
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Server icon (no auth) — advertised in MCP server info so clients like
    // claude.ai render a real icon instead of the default placeholder.
    if (path === "/icon.svg") {
      return new Response(SERVER_ICON_SVG, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400, immutable",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Wake-queue (no auth, lightweight) — used by Mac launchd watcher to
    // decide whether to ping the CC tmux session. Returns counts and max
    // timestamps for telegram_messages + facts since `since` (Unix seconds).
    // Watcher compares with previous response; on delta → tmux send-keys.
    // No tokens burned in idle; this query is sub-ms in D1.
    if (path === "/wake-queue") {
      const sinceParam = url.searchParams.get("since") ?? "0";
      const since = Number(sinceParam);
      if (!Number.isFinite(since) || since < 0) {
        return new Response(
          JSON.stringify({ error: "invalid 'since' param; expected unix seconds" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      try {
        await ensureTables(env.DB);
        // facts.updated_at is TEXT in datetime('now') ISO-ish format.
        // telegram_messages.date is INTEGER unix seconds.
        const [tgRow, factRow] = await env.DB.batch([
          env.DB.prepare(
            `SELECT COUNT(*) AS n, COALESCE(MAX(date), 0) AS max_date
             FROM telegram_messages WHERE date > ?`
          ).bind(since),
          env.DB.prepare(
            `SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS max_updated_at
             FROM facts WHERE updated_at > datetime(?, 'unixepoch')`
          ).bind(since),
        ]);
        const tg = (tgRow.results?.[0] ?? {}) as { n?: number; max_date?: number };
        const fact = (factRow.results?.[0] ?? {}) as { n?: number; max_updated_at?: string };
        return new Response(
          JSON.stringify({
            since,
            server_now: Math.floor(Date.now() / 1000),
            tg_count: Number(tg.n ?? 0),
            tg_max_date: Number(tg.max_date ?? 0),
            fact_count: Number(fact.n ?? 0),
            fact_max_updated_at: String(fact.max_updated_at ?? ""),
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "query failed", detail: (e as Error).message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Auth: accept /mcp (for claude.ai connector) and /mcp/{token} (for direct calls)
    if (!path.startsWith("/mcp")) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // If /mcp/{token} — validate token against AUTH_PATH_TOKEN
    const pathMatch = path.match(/^\/mcp\/([^/]+)$/);
    if (pathMatch) {
      if (!env.AUTH_PATH_TOKEN || pathMatch[1] !== env.AUTH_PATH_TOKEN) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Rewrite the request URL to /mcp so createMcpHandler (which mounts
      // at exactly /mcp) actually handles the request. Without this rewrite,
      // /mcp/<token> passes the auth check but falls through to a 404.
      const rewrittenUrl = new URL(request.url);
      rewrittenUrl.pathname = "/mcp";
      request = new Request(rewrittenUrl.toString(), request);
    }

    // Initialize D1 tables on first request. MUST be awaited — scheduling
    // this on ctx.waitUntil was a data race: a tool that executes before the
    // background task finishes would see missing tables and crash with
    // "no such table" under D1. Cost is a few ms on cold start; correctness
    // wins. Creation statements are `IF NOT EXISTS` — idempotent, safe to
    // call every request.
    await ensureTables(env.DB);

    const server = createServer(env, ctx);
    return createMcpHandler(server)(request, env, ctx);
  },
  // ── Cron Triggers ─────────────────────────────────────────────
  //
  // Two schedules, dispatched on `controller.cron`:
  //   "0 7 * * *"     → daily self-diagnostic (the body below)
  //   "0 3 * * 1,3,5" → nightly deep analysis (nightlyDeepAnalysis), migrated
  //                     2026-06-12 from GHA per mobile-brief-2026-05-28 §4.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await ensureTables(env.DB);

    if (controller.cron === "0 3 * * 1,3,5") {
      await nightlyDeepAnalysis(env);
      return;
    }

    const now = new Date().toISOString();
    const checks: string[] = [];

    // 1. Check STATUS_SNAPSHOT freshness
    const snapshot = await readFile(env, "STATUS_SNAPSHOT.md");
    if (snapshot) {
      const match = snapshot.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/);
      if (match) {
        const lastUpdated = new Date(match[1]);
        const daysSince = Math.floor(
          (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (daysSince > 7) {
          checks.push(`⚠️ STATUS_SNAPSHOT stale: ${daysSince} days since last update`);
        } else {
          checks.push(`✓ STATUS_SNAPSHOT fresh (${daysSince}d ago)`);
        }
      }
    } else {
      checks.push("⚠️ STATUS_SNAPSHOT.md not found");
    }

    // 2. D1 health: count facts, sessions, errors
    try {
      const [factsRes, sessionsRes, errorsRes] = await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) as cnt FROM facts"),
        env.DB.prepare("SELECT COUNT(*) as cnt FROM sessions"),
        env.DB.prepare("SELECT COUNT(*) as cnt FROM errors WHERE resolved = 0"),
      ]);
      const facts = (factsRes.results[0] as Record<string, number>)?.cnt ?? 0;
      const sessions = (sessionsRes.results[0] as Record<string, number>)?.cnt ?? 0;
      const unresolvedErrors = (errorsRes.results[0] as Record<string, number>)?.cnt ?? 0;
      checks.push(`✓ D1: ${facts} facts, ${sessions} sessions, ${unresolvedErrors} unresolved errors`);
    } catch (e) {
      checks.push(`⚠️ D1 query failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3. GitHub API health (can we read the repo?)
    try {
      const res = await githubFetch(env, "CLAUDE.md");
      checks.push(res.ok ? "✓ GitHub API accessible" : `⚠️ GitHub API: ${res.status}`);
    } catch (e) {
      checks.push(`⚠️ GitHub unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3b. Dreaming staleness detector (P3-M mitigation).
    //
    //     Before this check, the cron would fire every day and log "0
    //     warnings" even when the dreaming protocol had been silently
    //     dead for days — because nothing was grading the protocol's own
    //     output. Now we surface staleness inline AND push a high-severity
    //     row to `errors` when the gap exceeds 3 days, so
    //     `error_report(unresolved_only=true)` and `health_check` catch it
    //     within 24h instead of weeks.
    //
    //     Filename pattern `YYYY-MM-DD_summary*.md` is the dreaming-cycle
    //     contract (see tests/run-all.sh → dreaming_summary_schema). Date
    //     parse is UTC-safe. Lexical sort = chronological because the
    //     prefix is always the ISO date.
    try {
      const dreamingFiles = await listDir(env, "logs/dreaming");
      const dreamingSummaries = dreamingFiles
        .map((f) => f.replace(/^[^ ]+ /, ""))
        .filter((f) => /^\d{4}-\d{2}-\d{2}_summary.*\.md$/.test(f))
        .sort();
      if (dreamingSummaries.length === 0) {
        checks.push("⚠️ Dreaming: no summaries in logs/dreaming/");
        try {
          await env.DB.prepare(
            "INSERT INTO errors (error_type, description, domain, severity, resolved) VALUES (?, ?, ?, ?, 0)"
          ).bind("dreaming_stale", "No dreaming summaries found in logs/dreaming/", "memory", "high").run();
        } catch { /* errors table might not exist on fresh DBs */ }
      } else {
        const latest = dreamingSummaries[dreamingSummaries.length - 1];
        const dateMatch = latest.match(/^(\d{4}-\d{2}-\d{2})/);
        const ageDays = dateMatch
          ? Math.floor((Date.now() - Date.parse(dateMatch[1] + "T00:00:00Z")) / 86400000)
          : -1;
        if (ageDays < 0) {
          checks.push(`⚠️ Dreaming: cannot parse date from ${latest}`);
        } else if (ageDays <= 1) {
          checks.push(`✓ Dreaming: last cycle ${ageDays}d ago (${latest})`);
        } else if (ageDays <= 3) {
          checks.push(`⚠️ Dreaming: last cycle ${ageDays}d ago (${latest}) — borderline, watch for gap`);
        } else {
          checks.push(`⚠️ Dreaming BROKEN: last cycle ${ageDays}d ago (${latest})`);
          try {
            await env.DB.prepare(
              "INSERT INTO errors (error_type, description, domain, severity, resolved) VALUES (?, ?, ?, ?, 0)"
            ).bind(
              "dreaming_stale",
              `Last dreaming cycle ${ageDays}d ago (${latest}). Routine or Cowork task likely stopped firing.`,
              "memory",
              ageDays >= 7 ? "critical" : "high"
            ).run();
          } catch { /* best-effort */ }
        }
      }
    } catch (e) {
      checks.push(`⚠️ Dreaming staleness check failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3c. Telegram bot DLQ check (P3-TG-13 auto-alert).
    //
    //     If permanently-failed rows (retry_count≥3) or stale-queued rows
    //     (>30min past created_at, cron sweep behind) cross thresholds, push
    //     high-severity rows to `errors` so `error_report(unresolved_only=true)`
    //     + `wake_up` "OPEN BLOCKERS" surface them within 24h on every surface
    //     (mobile Chat / Code / iPad). Matches the dreaming-staleness pattern
    //     above — ambient alerts without needing User to manually call
    //     `tg_dlq_report`.
    //
    //     Thresholds:
    //       dlq >= 1  → 'high'      (1 permanently-lost message is already bad)
    //       dlq >= 5  → 'critical'  (systemic delivery problem)
    //       stale_queued >= 3 over 30min → 'high' (sweep or bot worker broken)
    //     We also dedupe same-day alerts: if a DLQ error is already open from
    //     an earlier cron run today, skip — otherwise a daily cron would spam
    //     the errors table. Dedup by domain='telegram' + error_type match.
    try {
      const dlqCounts = await env.DB
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM telegram_messages WHERE status='failed' AND retry_count>=3) as dlq,
            (SELECT COUNT(*) FROM telegram_messages WHERE status='queued' AND created_at < datetime('now','-30 minutes')) as stale_queued,
            (SELECT COUNT(*) FROM telegram_messages WHERE status='processing' AND created_at < datetime('now','-30 minutes')) as stuck_processing
        `)
        .first()
        .catch(() => null) as { dlq: number; stale_queued: number; stuck_processing: number } | null;

      if (dlqCounts) {
        const problems: string[] = [];
        if (dlqCounts.dlq > 0) problems.push(`${dlqCounts.dlq} DLQ`);
        if (dlqCounts.stale_queued >= 3) problems.push(`${dlqCounts.stale_queued} stale-queued`);
        if (dlqCounts.stuck_processing >= 3) problems.push(`${dlqCounts.stuck_processing} stuck-processing`);

        if (problems.length > 0) {
          // Check if an open alert from today already covers this
          const existing = await env.DB
            .prepare(
              `SELECT id FROM errors
               WHERE error_type = 'tg_delivery_dlq' AND resolved = 0
                 AND created_at > datetime('now','-1 days')
               LIMIT 1`
            )
            .first()
            .catch(() => null);

          if (!existing) {
            const severity = dlqCounts.dlq >= 5 ? "critical" : "high";
            await env.DB
              .prepare(
                "INSERT INTO errors (error_type, description, domain, severity, resolved) VALUES (?, ?, ?, ?, 0)"
              )
              .bind(
                "tg_delivery_dlq",
                `Telegram delivery degraded: ${problems.join(", ")}. Call tg_dlq_report for samples.`,
                "telegram",
                severity
              )
              .run()
              .catch(() => { /* best-effort */ });
          }
          checks.push(`⚠️ TG delivery: ${problems.join(", ")} (alert already open: ${existing ? "yes" : "just filed"})`);
        } else {
          checks.push(`✓ TG delivery: 0 DLQ, 0 stale, 0 stuck`);
        }
      }
    } catch (e) {
      checks.push(`⚠️ TG DLQ check failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 4. Granola auto-sync (last 2 days, cron-safe)
    if (env.GRANOLA_API) {
      try {
        const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const notes = await granolaListNotes(env, since);
        let synced = 0;
        for (const note of notes.slice(0, 20)) {
          try {
            const existing = await env.DB
              .prepare("SELECT id FROM granola_meetings WHERE id = ?")
              .bind(note.id)
              .first();
            if (existing) continue;
            const detail = await granolaGetNote(env, note.id);
            if (!detail) continue;
            const summary = extractSummary(detail);
            if (!summary) continue;
            const domain = autoDetectDomain(detail.title, summary);
            const actionItems = extractActionItems(summary);
            const decisions = extractDecisions(summary);
            const participants = (detail.attendees || []).map((p) => p.name || p.email || "unknown");
            const transcript = formatTranscript(detail.transcript);
            await env.DB
              .prepare("INSERT OR REPLACE INTO granola_meetings (id, title, date, participants, summary, transcript, action_items, decisions, domain, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))")
              .bind(detail.id, detail.title || "Untitled", detail.created_at, JSON.stringify(participants), summary, transcript.slice(0, 50000), JSON.stringify(actionItems), JSON.stringify(decisions), domain)
              .run();
            synced++;
          } catch { /* skip individual note errors */ }
        }
        checks.push(synced > 0 ? `✓ Granola: synced ${synced} new meeting(s)` : "✓ Granola: up to date");
      } catch (e) {
        checks.push(`⚠️ Granola sync failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      checks.push("ℹ️ Granola: GRANOLA_API not configured, skipping sync");
    }

    // 5. Cache hygiene — sweep memory_files_cache for SHA drift caused by
    //    external git push (Code sessions / cron / GitHub UI edits that
    //    bypass MCP update_file). Phase 1.5.
    checks.push(await cacheHygiene(env));

    // 6. Weekly D1 → R2 snapshot (Sundays UTC). Cold backup for tables
    //    not reproducible from git (facts/kg/sessions/granola/errors/
    //    session_log/portal_events/telegram_messages). Phase 1.5.
    checks.push(await weeklySnapshot(env));

    // 7. Log heartbeat to D1
    const report = checks.join("\n");
    try {
      await env.DB.prepare(
        "INSERT INTO sessions (surface, summary, topics, started_at, ended_at) VALUES (?, ?, ?, ?, ?)"
      ).bind("cron", `Daily diagnostic: ${checks.filter(c => c.startsWith("⚠️")).length} warnings`, "diagnostic,cron", now, now).run();
    } catch {
      // Best-effort logging
    }

    console.log(`[cron] ${now}\n${report}`);
  },
} satisfies ExportedHandler<Env>;
