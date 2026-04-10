import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  GITHUB_PAT: string;
  GITHUB_REPO: string;
  AUTH_PATH_TOKEN?: string;
  DB: D1Database;
}

const GITHUB_API = "https://api.github.com";

// ── GitHub helpers ──────────────────────────────────────────

async function githubFetch(env: Env, path: string): Promise<Response> {
  return fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "claude-memory-mcp/2.3",
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

async function readFile(env: Env, path: string): Promise<string | null> {
  const res = await githubFetch(env, path);
  if (!res.ok) return null;
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (data.content && data.encoding === "base64") {
    return base64ToUtf8(data.content);
  }
  return null;
}

async function readFileFromRepo(env: Env, repo: string, path: string): Promise<string | null> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "claude-memory-mcp/2.3",
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

async function writeFile(
  env: Env,
  path: string,
  content: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const existing = await githubFetch(env, path);
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
    `${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "claude-memory-mcp/2.3",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    return { success: false, error: `GitHub API ${res.status}: ${err}` };
  }
  return { success: true };
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
        "User-Agent": "claude-memory-mcp/2.3",
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
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      domain TEXT,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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
      tool TEXT,
      message TEXT NOT NULL,
      context TEXT,
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
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_key ON facts(key)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_facts_domain ON facts(domain)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_surface ON sessions(surface)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_kg_subject ON knowledge_graph(subject)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_kg_predicate ON knowledge_graph(predicate)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_kg_subject_pred ON knowledge_graph(subject, predicate)`),
  ]);
}

// Hub domain-to-path mapping — customize with your own domains.
// Keys are aliases, values are file paths relative to repo root.
// Multiple aliases can point to the same hub file (e.g. shorthand + canonical).
const HUB_MAP: Record<string, string> = {
  work: "hubs/01_WORK.md",
  projects: "hubs/02_PROJECTS.md",
  health: "hubs/03_HEALTH.md",
  finance: "hubs/04_FINANCE.md",
  learning: "hubs/05_LEARNING.md",
  blog: "hubs/06_BLOG.md",
  // Add your own domains here, e.g.:
  // meetings: "hubs/07_MEETINGS.md",
  // travel: "hubs/08_TRAVEL.md",
};

function resolveHubPath(domain: string): string | null {
  const key = domain.toLowerCase().trim();
  return HUB_MAP[key] || null;
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

// ── Server factory ──────────────────────────────────────────

function createServer(env: Env) {
  const server = new McpServer({
    name: "claude-memory",
    version: "2.3.0",
  });

  // ── get_snapshot ──────────────────────────────────────────
  server.tool(
    "get_snapshot",
    "Load STATUS_SNAPSHOT.md — the main routing file with current status across all domains.",
    {},
    { title: "Load Status Snapshot", readOnlyHint: true, openWorldHint: true },
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
    "Load a domain hub file. Domain must match a key configured in HUB_MAP, or be a file under hubs/.",
    { domain: z.string().describe("Domain name, e.g. 'work', 'health', 'projects' — see HUB_MAP in src/index.ts") },
    { title: "Load Domain Hub", readOnlyHint: true, openWorldHint: true },
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
    { title: "Load Memory Edits", readOnlyHint: true, openWorldHint: true },
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
    { title: "List Repo Files", readOnlyHint: true, openWorldHint: true },
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
    "Read any file from the memory repo by path.",
    { path: z.string().describe("File path relative to repo root") },
    { title: "Read File", readOnlyHint: true, openWorldHint: true },
    async ({ path }) => {
      const content = await readFile(env, path);
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
    { title: "Search Repo", readOnlyHint: true, openWorldHint: true },
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
    "Write or update a file in the memory repo. Creates a git commit.",
    {
      path: z.string().describe("File path relative to repo root"),
      content: z.string().describe("Full file content to write"),
      commit_message: z.string().default("update via claude-memory-mcp").describe("Git commit message"),
    },
    { title: "Write/Update File", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async ({ path, content, commit_message }) => {
      const result = await writeFile(env, path, content, commit_message);
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }] };
      }
      const contradictions = await checkContradictions(env.DB, content);
      let response = `Committed: ${path}\nMessage: ${commit_message}`;
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
    { title: "Session Warm-up", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ compact, surface }) => {
      if (compact) {
        const compressed = await readFile(env, "STATUS_COMPRESSED.md");
        if (compressed) {
          return { content: [{ type: "text" as const, text: compressed }] };
        }
        // Fallback to full if compressed file doesn't exist
      }

      const [snapshot, rules, hubFiles, recentFacts, sessionCount] = await Promise.all([
        readFile(env, "STATUS_SNAPSHOT.md"),
        readFile(env, "MEMORY_EDITS.md"),
        listDir(env, "hubs"),
        env.DB
          .prepare("SELECT key, value, domain FROM facts ORDER BY updated_at DESC LIMIT 10")
          .all()
          .then((r) => r.results as Array<{ key: string; value: string; domain: string | null }>)
          .catch(() => [] as Array<{ key: string; value: string; domain: string | null }>),
        env.DB
          .prepare("SELECT COUNT(*) as cnt FROM sessions WHERE created_at > datetime('now', '-7 days')")
          .first()
          .then((r) => (r as { cnt: number } | null)?.cnt ?? 0)
          .catch(() => 0),
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
            .map((f) => `- [${f.domain || "general"}] ${f.key}: ${f.value}`)
            .join("\n")
        );
      }
      if (sessionCount < 3) {
        parts.push("\n⚠️ SESSION LOGGING: Only " + sessionCount + " session(s) in last 7 days. Call auto_log before ending this conversation.");
      }

      // Surface sync tracking
      const syncKey = `last_sync_${surface}`;
      const prevSync = await env.DB
        .prepare("SELECT value FROM facts WHERE key = ?")
        .bind(syncKey)
        .first()
        .then((r) => (r as { value: string } | null)?.value)
        .catch(() => null);

      await env.DB
        .prepare("INSERT INTO facts (key, value, domain, source) VALUES (?, datetime('now'), 'memory', 'wake_up') ON CONFLICT(key) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')")
        .bind(syncKey)
        .run()
        .catch(() => {});

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
    { title: "Get Repo Structure", readOnlyHint: true, openWorldHint: true },
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

  // ── store_fact (D1) ───────────────────────────────────────
  server.tool(
    "store_fact",
    "Store a key-value fact in D1. Upserts by key — if key exists, updates value and timestamp.",
    {
      key: z.string().describe("Fact key, e.g. 'user_location', 'project_status'"),
      value: z.string().describe("Fact value"),
      domain: z.string().optional().describe("Domain name — see HUB_MAP in src/index.ts for configured domains"),
      source: z.string().optional().describe("Source of fact, e.g. 'hub01', 'conversation', 'manual'"),
    },
    { title: "Store Fact (D1)", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ key, value, domain, source }) => {
      try {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare("SELECT id FROM facts WHERE key = ?").bind(key).first();
        if (existing) {
          await env.DB
            .prepare("UPDATE facts SET value = ?, domain = ?, source = ?, updated_at = datetime('now') WHERE key = ?")
            .bind(value, domain || null, source || null, key)
            .run();
          return { content: [{ type: "text" as const, text: `Updated fact: ${key} = ${value}` }] };
        } else {
          await env.DB
            .prepare("INSERT INTO facts (key, value, domain, source) VALUES (?, ?, ?, ?)")
            .bind(key, value, domain || null, source || null)
            .run();
          return { content: [{ type: "text" as const, text: `Stored fact: ${key} = ${value}` }] };
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error storing fact: ${e}` }] };
      }
    }
  );

  // ── query_facts (D1) ──────────────────────────────────────
  server.tool(
    "query_facts",
    "Query facts from D1. Filter by key pattern, domain, or get all.",
    {
      key: z.string().optional().describe("Exact key or LIKE pattern (use % for wildcard)"),
      domain: z.string().optional().describe("Filter by domain"),
      limit: z.number().default(20).describe("Max results"),
    },
    { title: "Query Facts (D1)", readOnlyHint: true, openWorldHint: false },
    async ({ key, domain, limit }) => {
      try {
        await ensureTables(env.DB);
        let sql = "SELECT key, value, domain, source, updated_at FROM facts WHERE 1=1";
        const params: string[] = [];
        if (key) {
          sql += key.includes("%") ? " AND key LIKE ?" : " AND key = ?";
          params.push(key);
        }
        if (domain) {
          sql += " AND domain = ?";
          params.push(domain);
        }
        sql += " ORDER BY updated_at DESC LIMIT ?";
        params.push(String(limit));

        let stmt = env.DB.prepare(sql);
        for (let i = 0; i < params.length; i++) {
          stmt = stmt.bind(...params);
          break;
        }
        // Rebuild with all params at once
        stmt = env.DB.prepare(sql);
        if (params.length === 1) stmt = stmt.bind(params[0]);
        else if (params.length === 2) stmt = stmt.bind(params[0], params[1]);
        else if (params.length === 3) stmt = stmt.bind(params[0], params[1], params[2]);

        const results = await stmt.all();
        const rows = results.results as Array<{
          key: string;
          value: string;
          domain: string | null;
          source: string | null;
          updated_at: string;
        }>;

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: "No facts found matching query." }] };
        }

        const text = rows
          .map((r) => `[${r.domain || "general"}] ${r.key}: ${r.value} (${r.updated_at}, src: ${r.source || "unknown"})`)
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
    { title: "Log Session (D1)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
  server.tool(
    "recent_sessions",
    "Get recent session logs from D1. Useful for understanding recent activity across surfaces.",
    {
      limit: z.number().default(10).describe("Number of recent sessions to return"),
      surface: z.string().optional().describe("Filter by surface"),
    },
    { title: "Recent Sessions (D1)", readOnlyHint: true, openWorldHint: false },
    async ({ limit, surface }) => {
      try {
        await ensureTables(env.DB);
        let sql = "SELECT surface, summary, topics, started_at, created_at FROM sessions";
        const params: (string | number)[] = [];
        if (surface) {
          sql += " WHERE surface = ?";
          params.push(surface);
        }
        sql += " ORDER BY created_at DESC LIMIT ?";
        params.push(limit);

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
    { title: "Auto-log Session", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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

  // ── log_error (D1) ────────────────────────────────────────
  server.tool(
    "log_error",
    "Log an error to D1 for debugging. Use when a tool fails or unexpected behavior occurs.",
    {
      tool: z.string().optional().describe("Tool name that failed"),
      message: z.string().describe("Error message"),
      context: z.string().optional().describe("Additional context"),
    },
    { title: "Log Error (D1)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ tool, message, context }) => {
      try {
        await ensureTables(env.DB);
        await env.DB
          .prepare("INSERT INTO errors (tool, message, context) VALUES (?, ?, ?)")
          .bind(tool || null, message, context || null)
          .run();
        return { content: [{ type: "text" as const, text: `Error logged: [${tool || "unknown"}] ${message}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to log error: ${e}` }] };
      }
    }
  );

  // ── error_report (D1) ─────────────────────────────────────
  server.tool(
    "error_report",
    "Get recent errors from D1. Useful for debugging persistent issues.",
    {
      limit: z.number().default(10).describe("Number of recent errors"),
      tool: z.string().optional().describe("Filter by tool name"),
    },
    { title: "Error Report (D1)", readOnlyHint: true, openWorldHint: false },
    async ({ limit, tool }) => {
      try {
        await ensureTables(env.DB);
        let sql = "SELECT tool, message, context, created_at FROM errors";
        const params: (string | number)[] = [];
        if (tool) {
          sql += " WHERE tool = ?";
          params.push(tool);
        }
        sql += " ORDER BY created_at DESC LIMIT ?";
        params.push(limit);

        let stmt = env.DB.prepare(sql);
        if (params.length === 1) stmt = stmt.bind(params[0]);
        else if (params.length === 2) stmt = stmt.bind(params[0], params[1]);

        const results = await stmt.all();
        const rows = results.results as Array<{
          tool: string | null;
          message: string;
          context: string | null;
          created_at: string;
        }>;

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: "No errors logged." }] };
        }

        const text = rows
          .map(
            (r) =>
              `[${r.tool || "unknown"}] ${r.created_at}: ${r.message}${r.context ? ` | ctx: ${r.context}` : ""}`
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
    { title: "Flush Cache", readOnlyHint: true, openWorldHint: false },
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
      subject: z.string().describe("Entity, e.g. 'user', 'project', 'device'"),
      predicate: z.string().describe("Relationship, e.g. 'status', 'location', 'owner'"),
      object: z.string().describe("Value, e.g. 'active', 'Berlin', 'team-alpha'"),
      valid_from: z.string().describe("Start date ISO, e.g. '2026-04-01'"),
      valid_until: z.string().optional().describe("End date ISO, or omit for ongoing"),
      source: z.string().optional().describe("Source reference, e.g. 'hub01', 'conversation', 'manual'"),
    },
    { title: "Add KG Triple", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    { title: "Query KG", readOnlyHint: true, openWorldHint: false },
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
      domain: z.string().describe("Domain key from HUB_MAP, or a bare hub filename (without .md)"),
      query: z.string().describe("Search keyword (case-insensitive)"),
    },
    { title: "Search In Hub", readOnlyHint: true, openWorldHint: true },
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
            { type: "text" as const, text: `Hub "${domain}" not found. Check HUB_MAP keys or hubs/ directory contents.` },
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
    { title: "Write Diary Entry", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
      last_n: z.number().default(5).describe("Number of recent entries to return"),
    },
    { title: "Read Diary", readOnlyHint: true, openWorldHint: true },
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
    { title: "Cross-Hub Entities", readOnlyHint: true, openWorldHint: true },
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
    { title: "Health Check", readOnlyHint: true, openWorldHint: true },
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

      return { content: [{ type: "text" as const, text: checks.join("\n") }] };
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
    { title: "Add TODO Entry", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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

  // ── memex_diff (GitHub) — compare private memory repo with a public fork ───
  server.tool(
    "memex_diff",
    "Compare this worker source with a public fork (e.g. your own memex blueprint clone). Returns list of files that differ or are missing.",
    {
      memex_repo: z.string().describe("Public fork to compare against (owner/name, e.g. 'your-username/memex')"),
    },
    { title: "Memex Diff", readOnlyHint: true, openWorldHint: true },
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

// ── Request handler with URL path auth ──────────────────────

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check (no auth)
    if (path === "/" || path === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          name: "claude-memory-mcp",
          version: "2.3.0",
          tools: 26,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Auth: accept /mcp (for claude.ai connector) and /mcp/{token} (for direct calls)
    if (!path.startsWith("/mcp")) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // If /mcp/{token} — validate token
    if (env.AUTH_PATH_TOKEN) {
      const match = path.match(/^\/mcp\/(.+)$/);
      if (match && match[1] !== env.AUTH_PATH_TOKEN) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Initialize D1 tables on first request (idempotent)
    ctx.waitUntil(ensureTables(env.DB));

    const server = createServer(env);
    return createMcpHandler(server)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
