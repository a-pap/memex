# First-Time Setup Prompt

Copy everything below the line into a new Claude conversation. Replace `<CLONE_URL>` with your actual URL.

If you haven't yet: create a **private** GitHub repo, generate a Personal Access Token (Settings → Developer Settings → Tokens (classic) → scope: `repo`), and construct your clone URL: `https://<TOKEN>@github.com/<username>/claude-memory.git`

---

I want to set up a persistent memory system based on the Memex blueprint.

Clone the blueprint and my private repo, then run the onboarding:

```bash
git clone https://github.com/a-pap/memex.git /home/claude/memex-blueprint
git clone <CLONE_URL> /home/claude/claude-memory
```

Read `/home/claude/memex-blueprint/ONBOARDING.md` and follow it exactly.
