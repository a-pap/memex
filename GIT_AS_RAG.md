# Git as RAG — Curated Retrieval as Long-Term Memory for AI Agents

*Personal memory is the photographic negative of the corpus RAG was built for.
This is the case for building an agent's memory as a version-controlled git repo
of plain text — curated retrieval primary, embeddings as a fallback built from the
same files — and an honest account of where that loses.*

> Design rationale behind Memex. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
> spec, [README.md](README.md) for setup, and [SECURITY.md](SECURITY.md) for the
> threat model and what not to commit.

---

## 1. The oldest idea in the room

In July 1945, before the first stored-program computer ran, Vannevar Bush
described the **memex**: a desk that would hold all of a person's books, records,
and letters and let them be "consulted with exceeding speed and flexibility — an
enlarged intimate supplement to [the] memory." Its defining trick was retrieval by
*association* — Bush wanted to replace the rigid hierarchical index with **trails**
the user builds by hand, one item linked to the next
([*As We May Think*, The Atlantic, July 1945](https://www.w3.org/History/1945/vbush/vbush6.shtml)).

Large language models invert Bush's problem. They arrive with a vast parametric
memory — everything in the training set, compressed into weights — and almost no
memory of *you*. Close the tab and the model forgets your project, your
decisions, the thing you told it twice. The question is no longer how to store a
lifetime of documents. It is narrower:

> Where should an agent's long-term memory of one user live, and how should it be
> retrieved into a context window that is small, expensive, and degrades when you
> overfill it?

Most answers reach for a vector database. This document argues for a different
substrate — a git repository of markdown, retrieved by curation — and tries to be
honest about where that choice wins and where it does not.

## 2. RAG is a contract, not a vector database

Retrieval-Augmented Generation was introduced by
[Lewis et al. (2020)](https://arxiv.org/abs/2005.11401) at NeurIPS: pair a
parametric generator with a *non-parametric* memory — in the original paper, "a
dense vector index of Wikipedia, accessed with a pre-trained neural retriever" —
and condition each generation on the passages it retrieves. RAG keeps knowledge
*outside* the weights, where you can inspect it, update it, and swap it without
retraining.

That is the durable idea. The dense vector index is one *implementation* of it.
So was Lewis's retriever, which was trained end-to-end with the generator — more
than an index you swap, and still just an implementation. The pattern that
calcified into "RAG" since 2020 — chunk every document, embed the chunks, search
by nearest neighbor, paste the top-k into the prompt — is also one
implementation. It is an excellent one for the problem RAG was born to solve:
open-domain question answering over a large corpus you did not write and cannot
curate.

The contract is narrower than any of these: *condition generation on knowledge
retrieved from outside the weights.* Grep satisfies it. A routing table satisfies
it. A fine-tuned neural retriever satisfies it. Personal agent memory satisfies a
very different version of the problem — and swapping the corpus quietly breaks the
assumptions the vectors rest on.

## 3. Why personal memory inverts the assumptions

A vector index is tuned for a corpus that is **large, foreign, static, and queried
by semantic similarity**. A person's memory is the negative of that image, and one
axis carries the whole argument:

> It is ranked by **authority and recency**, not similarity. "The launch is in Q2"
> and "the launch is in Q3" are near-twins to an embedding model — but they are not
> two results to rank. One is *true now*; the other is *history*. Knowing which is
> the entire job.

The other differences are real but mostly follow from one fact — the corpus is
small and self-authored. You will never have a million personal documents, so
approximate nearest-neighbor search solves a scale problem you do not have; and
because you wrote it, you can *structure* it as you go, declining the very cost —
"a pile nobody organized" — that justifies embeddings in the first place. Add that
it changes constantly (memory is mostly *edits*, not appends) and the picture is
complete: this is not the corpus dense retrieval was designed for.

A fair opponent is not the naive pipeline. A production vector store carries
metadata per record, filters and time-weights on it, re-ranks with a cross-encoder,
and upserts to overwrite stale facts; temporal knowledge graphs like
[Zep/Graphiti](https://arxiv.org/abs/2501.13956) go further and invalidate
superseded facts on a validity timeline so you can ask what was true *then* versus
*now*. These are serious designs. But notice what they are: scaffolding bolted
around the embedding to re-introduce the structure a curated store has natively —
and none of it touches the part that actually decides memory quality, which is the
*write* side (§5). Strip the scaffolding and the raw mechanism shows three failure
modes that matter for personal memory:

1. **Contradiction accumulates.** The default pipeline embeds every utterance, so
   it embeds every superseded fact beside its replacement. Nearest-neighbor search
   returns both, equidistant. Overwriting the prior value requires a stable
   logical-fact ID and explicit delete logic — exactly the discipline the
   embed-everything reflex omits, and exactly what upsert and temporal graphs add
   back at a cost.
2. **The embedding geometry has no recency or authority.** Two sentences that differ
   only in the bit you came for — a date, a number, a yes/no — sit on top of each
   other in vector space. You do not separate Q2 from Q3 by cosine distance; you
   separate them by a `status` field. The disambiguator lives in metadata, never in
   the embedding — which is the admission that the structure, not the vector, does
   the work.
3. **The store is opaque.** You cannot read a vector index and see what your agent
   believes, diff it against last week, or point at one wrong fact and fix it. You
   re-embed and hope.

None of this makes embeddings bad. It means they optimize the *read* side of a
problem whose difficulty sits almost entirely on the *write* side.

## 4. The alternative: curated retrieval over a repo

Replace the vector index with a git repository of plain-text markdown, and retrieve
with three mechanisms instead of one — each exact where the embedding was fuzzy.

**A routing table — a curated index.** One file (here, `CLAUDE.md`) maps topics to
files: *relocation → `hubs/relocation.md`*. This is a controlled vocabulary, not a
ranking function: it sits on the sparse, lexical side of the retrieval axis, but
unlike BM25 it does not score candidates — it *resolves* to one. The mapping is
authored, not inferred, so lookup costs zero embedding calls and returns no false
neighbor. It is precise *when the query maps cleanly to a curated topic*; for when
it does not, there is the third mechanism below.

**Graduated loading — a cost-aware retrieval policy.** A vector store has no opinion
about *how much* to retrieve; it returns k chunks and stops. A curated store stages
retrieval by cost:

- **Level 0** — a single status snapshot (~3K tokens) that answers most questions on
  its own.
- **Level 1** — one domain file, pulled only when the snapshot is not enough.
- **Level 2+** — a procedure file or cross-domain read, rare by design.

You load the cheapest layer that answers the question and escalate only on a miss.
This is the piece dense retrieval structurally lacks: a notion that the 3K-token
summary should be read *before* the 30K-token deep file, and usually *instead* of
it.

**Grep — exact search for the long tail.** When routing does not cover a query,
literal full-text search finds it with no false positives. It is the fallback that
embedding similarity is supposed to be, minus the hallucinated neighbors.

Three retrieval paths, all legible, none requiring a vector database for the core
loop.

## 5. The contribution is the write loop — made legible

Retrieval is the easy half.

> **Memory quality is a write-side property**, and the write side is where the
> field's effort is least visible to the user choosing a memory tool.

Write-side work is not new. Generative Agents *reflect*; MemGPT *self-edits*;
[mem0](https://github.com/mem0ai/mem0) extracts facts and runs an
add/update/delete pass; [LangMem](https://github.com/langchain-ai/langmem)
consolidates in the background. What is different here is not *that* the write loop
exists but *where* it lives: as **human-legible rules over plain text, enforceable
at commit time**, rather than as LLM-driven operations inside an opaque store. You
can read the rules, and a pre-commit hook can refuse a write that breaks one:

- **One canonical home per fact.** Every fact lives in exactly one file; everywhere
  else references it. Duplication is how a memory drifts into self-contradiction, so
  the system forbids it at write time instead of reconciling it at read time.
- **Freshness decay.** A settled decision is durable; a project status holds for
  about a week; a deadline expires when it passes. Each class carries an explicit
  lifetime, and the system flags or archives stale items instead of serving them as
  current.
- **Don't store the derivable.** If the agent can compute or look something up, it
  is not written down. Every stored fact is a future contradiction waiting to be
  missed.
- **Refuse the sensitive.** Some facts are kept out not because they are derivable
  but because they should never enter a repo at all — secrets, other people's
  private data, raw records (see [SECURITY.md](SECURITY.md)). Git history is
  permanent; the cheapest place to stop a leak is the write.
- **Distill on a budget.** When a file crosses a size threshold, the oldest resolved
  material is pruned to an archive and replaced by a pointer. The hot path stays
  small on purpose.
- **A consolidation pass, separate from the writer.** The agent that records a
  memory is not the only thing that trusts it. A periodic pass — generator ≠
  checker — dedupes, ages out stale facts, and merges the day's scratch notes into
  the durable files. It is the legible cousin of reflection and background
  consolidation, and without it any memory rots in about a week regardless of how it
  is retrieved.

Git is not required to state these rules. Git is what makes them *enforceable and
observable*: every write is a diff, every diff is reviewable, and the check runs
before the fact enters the store.

## 6. Retrieve less, because the window is the bottleneck

Write-discipline has a read-side dividend: a small, deduped store is a small thing
to load. That matters because a bigger context window is not a free upgrade. Model
accuracy degrades as the input grows — by *position*, where the middle of a long
context is lost
([Liu et al., "Lost in the Middle," 2023](https://aclanthology.org/2024.tacl-1.9/)),
and independently by *length*, where accuracy falls as total tokens rise
([Chroma, "Context Rot," 2025](https://www.trychroma.com/research/context-rot)).
Every irrelevant token you retrieve is not just wasted spend; it degrades the
answer. Graduated loading is the policy that keeps the window filled with the
minimum — context engineering, made mechanical.

## 7. Where this loses

A design that only lists its own strengths is marketing. Curated retrieval over a
repo has real limits:

- **It runs on curation.** A routing table and one-canonical-home discipline must be
  *maintained* — by a person, or by a disciplined agent loop that pays the
  consolidation cost. Embeddings ask for none of that: dump everything, search later.
  Where no one will curate, vectors degrade more gracefully than a routing table
  nobody updates.
- **A flat routing table has a ceiling.** Dozens of domains route cleanly; many
  hundreds strain a hand-authored index, and there you want embedding search *within*
  the long tail.
- **Fuzzy recall is the embedding's home turf.** "That thing about the blue one" — a
  half-remembered query with no shared vocabulary — is what semantic similarity is
  for, and what a lexical routing table and grep handle worst.

So the honest position is **curated-primary, embeddings-as-fallback** — not a
rejection of vectors. Lexical and dense retrieval are
[complementary by construction](https://milvus.io/ai-quick-reference/what-is-the-difference-between-sparse-and-dense-retrieval),
and mature systems run both. Memex's optional layer indexes the *same files* into a
vector store as enrichment: the curated path stays authoritative; semantic search
covers the fuzzy tail. The repo is the source of truth; the embeddings are built
from it, never the other way around.

## 8. Standing in a real landscape

This is a synthesis, not a discovery. The debts, and the honest deltas:

- **[MemGPT](https://arxiv.org/abs/2310.08560)** (Packer et al., 2023; now
  [Letta](https://www.letta.com/blog/memgpt-and-letta)) framed agent memory as an
  operating-system problem — tiered memory, paging facts into a limited main context.
  Graduated loading is the same hierarchy as files and read levels rather than a
  managed paging runtime.
- **[Generative Agents](https://arxiv.org/abs/2304.03442)** (Park et al., 2023)
  scored each memory by **recency, importance, and relevance**. Freshness decay is
  that scoring rewritten as explicit, human-legible rules.
- **[Zep / Graphiti](https://arxiv.org/abs/2501.13956)** (Rasmussen et al., 2025)
  is the serious answer to supersession: a bi-temporal knowledge graph that
  *invalidates* superseded facts on a validity timeline. It solves "what is true
  now" properly — at the cost of a graph database to operate and an index you cannot
  read by eye. The repo trades that machinery for a plain-text store a human owns.
- **[A-MEM](https://arxiv.org/abs/2502.12110)** (Xu et al., 2025) builds
  Zettelkasten-style atomic notes with LLM-generated links that evolve as new notes
  arrive — Bush's trails, as a research system.
- **[mem0](https://github.com/mem0ai/mem0)** and
  **[LangMem](https://github.com/langchain-ai/langmem)** do real write-side work —
  extraction, consolidation, contradiction resolution — over a vector store. They
  are the well-built version of the approach this document argues against for
  personal memory, and the fair benchmark to measure against.
- **[Basic Memory](https://github.com/basicmachines-co/basic-memory)** is the
  closest cousin: persistent memory as local markdown over MCP, parsed into a
  knowledge graph with sync and reflection. It already does much of §5's write-side
  work. The remaining delta is narrow and specific: **git** as substrate
  (line-level history, diff, blame, branching, offline restore) plus the **curated
  routing table and graduated loading** as an explicit, cost-staged retrieval
  policy on top.

The genuinely less-trodden parts are two: **cost-graduated loading as a first-class
retrieval policy**, and **curated routing as primary with embeddings built from the
same repo as fallback**. Bolted together on a versioned substrate, they produce one
outcome no cited predecessor delivers — a single plain-text artifact that is at once
the memory, its own audit log, its disaster-recovery image, and a substrate portable
across models and vendors, operable by a person who runs no database and no embedding
model. That artifact, not "markdown for memory," is the contribution.

## 9. What the substrate buys you

Choosing git is not nostalgia for the command line. A version-controlled, plain-text,
user-owned repo hands you four things a database does not:

- **Portability across models and surfaces.** The memory is text in a repo you own.
  It survives a model swap, a vendor change, a fresh account, and reads identically
  from a laptop, a phone, or a scheduled job. Embeddings are bound to the embedding
  model; change it and you re-embed the world.
- **Auditability.** `git log` is a complete, honest history of what the agent learned
  and when — readable in an afternoon, diffable against last month.
- **Precise correction.** One wrong fact, one reviewable edit. No opaque index to coax.
- **Disaster recovery and sovereignty.** Because the repo *is* the source of truth,
  full restoration from zero is a clone plus a bootstrap prompt. Your memory is an
  artifact you keep, not a feature you rent.

The same transparency is a liability if the repo leaks: a plain-text, fully versioned
memory is trivially readable by anyone who gets read access, and git history is
permanent, so a secret or piece of PII committed once survives its own deletion. The
power and the hazard are the same property — which is why "refuse the sensitive" (§5)
is a load-bearing rule, not a footnote. Treat what goes in with discipline; see
[SECURITY.md](SECURITY.md).

## 10. Back to the trail

Bush's memex was never really about microfilm. It was about **trails** — memory worth
having is *built*, deliberately, one association at a time, by the person whose memory
it is. The embed-everything reflex is the opposite instinct: capture all of it,
organize none of it, and hope similarity reconstructs meaning at query time.

For a corpus you neither own nor authored, that reflex is right. For your own
memory — small, changing, ranked by what is true *now* — the older idea wins. Curate
the trail. Keep it in plain text. Own the repo. Let the agent walk it.

---

## Sources

- Vannevar Bush, "As We May Think," *The Atlantic*, July 1945 — [text](https://www.w3.org/History/1945/vbush/vbush6.shtml) · [overview](https://en.wikipedia.org/wiki/As_We_May_Think)
- Lewis et al., "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks," NeurIPS 2020 — [arXiv:2005.11401](https://arxiv.org/abs/2005.11401)
- Liu et al., "Lost in the Middle: How Language Models Use Long Contexts," TACL 2024 — [ACL Anthology](https://aclanthology.org/2024.tacl-1.9/) · [arXiv:2307.03172](https://arxiv.org/abs/2307.03172)
- Hong, Troynikov, Huber, "Context Rot: How Increasing Input Tokens Impacts LLM Performance," Chroma, 2025 — [report](https://www.trychroma.com/research/context-rot)
- Packer et al., "MemGPT: Towards LLMs as Operating Systems," 2023 — [arXiv:2310.08560](https://arxiv.org/abs/2310.08560) · [Letta](https://www.letta.com/blog/memgpt-and-letta)
- Park et al., "Generative Agents: Interactive Simulacra of Human Behavior," UIST 2023 — [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)
- Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent Memory," 2025 — [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) · [Graphiti](https://github.com/getzep/graphiti)
- Xu et al., "A-MEM: Agentic Memory for LLM Agents," 2025 — [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)
- mem0 — [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0) · LangMem — [github.com/langchain-ai/langmem](https://github.com/langchain-ai/langmem) · Basic Memory — [github.com/basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory)
- Sparse vs. dense vs. hybrid retrieval — [reference](https://milvus.io/ai-quick-reference/what-is-the-difference-between-sparse-and-dense-retrieval)

*License: [CC BY-NC 4.0](LICENSE). Part of [Memex](README.md).*
