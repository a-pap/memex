# Security

Memex stores personal context in a Git repository. This document describes the threat model, what's protected, and what you should be aware of.

## Threat model

### What Memex protects

| Threat | Mitigation |
|--------|-----------|
| Claude losing context | Repo is the source of truth — survives conversation resets, account changes, platform migrations |
| Unauthorized repo access | Private repo + fine-grained PAT with minimal scope |
| Context injection via stale data | Pre-flight check rule: always `git pull` before asserting facts |
| Accidental data in public repo | Blueprint contains only templates and anonymized examples. Personal data lives in your private fork |

### What Memex does NOT protect against

| Risk | Why | Mitigation |
|------|-----|-----------|
| GitHub account compromise | Your PAT grants read/write access to the memory repo | Use fine-grained PAT, set expiration, enable 2FA |
| Cloudflare Worker compromise (Full mode) | Worker has GitHub PAT in secrets, can read/write repo | Restrict Cloudflare account access, rotate tokens |
| Claude reading private data | That's the whole point — Claude needs to read your data to provide context. Data sent to Anthropic per their [usage policy](https://www.anthropic.com/policies) | Only store what you're comfortable sharing with Claude |
| Man-in-the-middle on MCP | MCP traffic goes over HTTPS, but the MCP connector trusts the Worker endpoint | Use `AUTH_PATH_TOKEN` to prevent unauthorized tool calls |

## PAT (Personal Access Token) guidelines

### Recommended scope

Use **fine-grained tokens** (not classic) when possible:

| Setting | Value | Why |
|---------|-------|-----|
| Repository access | **Only select repositories** → your memory repo | Limits blast radius |
| Permissions | **Contents: Read and write** | Minimum needed for git push |
| Expiration | 90 days | Balance between security and convenience |

### Where the PAT lives

The PAT is stored in **Claude's memory edits** (embedded in the clone URL). This is by design — Claude needs authenticated git access to function. The tradeoff:

- **Pro:** Claude can autonomously pull/push without asking for credentials every time
- **Con:** The PAT is visible to Claude and stored in Anthropic's systems

If this tradeoff is unacceptable, use **Claude Code in Lite mode** — git authentication happens via your local credential helper, and no PAT is stored in memory edits.

## What NOT to store in the repo

| Category | Why | Alternative |
|----------|-----|-------------|
| API keys and secrets (other than PAT) | Git history is permanent — deleted secrets remain in history | Use a secrets manager |
| Passwords | Same as above | Password manager |
| Financial account numbers | Sensitive PII | Reference by institution name only |
| Medical records (raw) | Privacy regulations (HIPAA, GDPR) | Store summaries and decisions, not raw records |
| Other people's private data | Privacy and consent | Use anonymized references |

**Rule of thumb:** If you wouldn't put it in a private Google Doc, don't put it in the repo.

## What's OK to store

- Work project status, decisions, meeting notes (your own)
- Health tracking summaries (your pet, your own — not raw medical records)
- Learning progress, goals, preferences
- Behavioral rules for Claude
- Technical architecture decisions

## MCP Worker security (Full mode)

### Authentication

The MCP Worker supports Bearer token auth via `AUTH_PATH_TOKEN`:

```
Connector URL: https://your-worker.your-subdomain.workers.dev/mcp
Authorization: Bearer <your-token>
```

Without `AUTH_PATH_TOKEN` set, the `/mcp` endpoint is open — anyone who knows the URL can call your tools. **Always set `AUTH_PATH_TOKEN` in production.**

### Cloudflare Worker secrets

| Secret | Exposure |
|--------|----------|
| `GITHUB_PAT` | Stored in Cloudflare's encrypted secrets store. Not in code, not in git. |
| `AUTH_PATH_TOKEN` | Same. Used for MCP endpoint auth. |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret. Used only for deployment. |

### D1 Database

D1 data is stored in Cloudflare's infrastructure, encrypted at rest. The database contains:
- Facts (domain, key, value)
- Session logs (summaries, not full transcripts)
- Error logs
- Knowledge graph triples

No raw credentials or secrets should be stored in D1.

## Incident response

If you suspect your PAT was compromised:

1. **Revoke immediately:** GitHub → Settings → Developer settings → Personal access tokens → Delete
2. **Generate a new PAT** with the same minimal scope
3. **Update memory edit** with the new clone URL
4. **Check git log** for any unauthorized commits
5. **Rotate `AUTH_PATH_TOKEN`** if MCP Worker is deployed

## Incident history

Transparency matters more than looking clean. If this blueprint leaks a secret, the fix is logged here.

### 2026-04-10 — `setup-d1.sh` leaked a Cloudflare token + legacy MCP bearer + personal KG seed

**What happened.** The initial public sync (2026-04-09, original commit `09e6f99 sync: add MCP worker ...`) copied `config/mcp-worker/setup-d1.sh` as-is from the private memory repo. That file contained:

1. A live `CLOUDFLARE_API_TOKEN` (prefix `cfut_X3R…`, redacted) — hardcoded in `export`.
2. A legacy MCP URL-path bearer (`1be0cca6…`, redacted) — superseded by the v2.2 auth migration but not revoked.
3. A `wrangler d1 execute` call seeding the knowledge graph with real personal facts (pet medical history + owner location plans).

**Why the lint didn't catch it.** The initial `.github/workflows/lint-templates.yml` scanned only `templates/` and `examples/` — not `config/` or root scripts. The offending file sat outside the scanned paths.

**Remediation (2026-04-10, in one force-push).**

1. **HEAD scrub.** Rewrote `setup-d1.sh` to require `CLOUDFLARE_API_TOKEN`, `MCP_AUTH_TOKEN`, and `GITHUB_PAT` from the environment (never hardcoded), and replaced the KG seed with a generic placeholder that runs only if an optional `KG_SEED_FILE` is provided.
2. **History rewrite.** Ran `git filter-repo --path config/mcp-worker/setup-d1.sh --invert-paths --force` to remove every past revision of the file from git history, then re-added the sanitized version in a new commit. Force-pushed `main` with `--force-with-lease`.
3. **Token rotation** (performed by the repo owner out-of-band):
   - Cloudflare API token → revoked + regenerated, stored only in Cloudflare dashboard + GitHub Actions `CLOUDFLARE_API_TOKEN` secret.
   - MCP bearer → regenerated with `openssl rand -hex 32`, stored via `wrangler secret put AUTH_PATH_TOKEN`.
4. **Lint hardening.** `.github/workflows/lint-templates.yml` now scans `config/`, `.github/`, and all top-level `*.md` / `*.sh` / `*.toml` / `*.yml` files, and explicitly greps for `cfut_`, `ghp_`, `grn_`, and long hex strings that look like bearers.
5. **CHANGELOG entry** under 2026-04-10 v2.3 documents the change for anyone pulling a fresh fork.

**Takeaways baked into the blueprint.**

- `setup-d1.sh` never keeps secrets in source — it *requires* env vars via the `:?Need …` bash pattern, so missing vars fail the script loudly at step 0.
- KG seeding is opt-in (`KG_SEED_FILE=...`) and defaults to a generic two-row example. Personal data belongs in your own gitignored seed file.
- Lint workflow patterns treat every token prefix + high-entropy hex string as a blocker, not just those in templates/examples.

**What this does not fix.** GitHub's API cache still holds the pre-rewrite commit SHAs for a window — cached pages may surface a leaked token for a short time even after force-push. **Token rotation is non-negotiable and already performed.** If you forked memex before 2026-04-10, reset to the new `main`:

```bash
git fetch origin
git reset --hard origin/main
```

## Reporting

If you find a security issue in the Memex blueprint, please open an issue on the [GitHub repo](https://github.com/a-pap/memex/issues) or contact the maintainer directly.
