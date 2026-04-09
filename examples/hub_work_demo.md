# Hub: Work — TechCorp Ad Platform
<!-- fresh: 2026-04-09 -->

## My role
Product Manager → Ad Platform team. Reports to VP Product. Manages 3 experiments, 2 cross-team initiatives.

## Team
| Name | Role | Notes |
|------|------|-------|
| Sarah | Engineering Lead | Primary partner. Prefers async, detailed specs. |
| Mike | Senior Engineer | Owns auto-placement backend. Leaving end of April. |
| Elena | Data Scientist | A/B test design, metric definitions. |
| Tom | Designer | Fast turnaround, prefers Figma links over descriptions. |
| Priya | QA Lead | Regression suites. Flag her early on breaking changes. |

## Active experiments <!-- fresh: 2026-04-07 -->

### Auto-placement (P0 — revenue impact)
- **What:** Algorithmic ad placement replacing manual rules
- **Status:** Beta, +25-30% revenue uplift in test cohort
- **Q2 goal:** Exit beta, 100% rollout
- **Metrics:** Revenue per session, fill rate, latency p99
- **Blockers:** Mike leaving → knowledge transfer by Apr 25
- **Key decision (SETTLED):** Use ML model v3, not rule-based fallback (2026-03-15)

### Neural banners (P1 — growth)
- **What:** AI-generated banner creatives from product feeds
- **Status:** Prototype, 0.45% of total ad blocks
- **Q2 goal:** Multi-banner generation pipeline → 10%+ coverage
- **Metrics:** CTR, creative diversity score, generation latency
- **Next:** Design review with Tom (Apr 11)

### Content overlay (P2 — engagement)
- **What:** Contextual overlay on content pages
- **Status:** 75% of design approved. Team returned from offsite Apr 7.
- **Next:** Implementation kickoff Apr 14

## Meeting index <!-- fresh: 2026-04-09 -->

| Day | Time | Meeting | Prep needed? |
|-----|------|---------|-------------|
| Mon | 11:00 | Auto-placement standup | Check weekend metrics |
| Tue | 10:00 | Product sync (VP) | Status slides |
| Wed | 14:00 | Neural banners review | Latest CTR data |
| Thu | 11:00 | Cross-team alignment | Blockers list |
| Fri | 11:00 | All-hands | None |
| Fri | 13:30 | Auto-placement deep dive | A/B test results |

## Quarterly goals (Q2 2026)
1. Auto-placement → GA (100% traffic)
2. Neural banners → 10%+ ad block coverage
3. Content overlay → beta launch
4. Team transition plan (Mike, Elena interim coverage)

## Decision log
| Date | Decision | Context |
|------|----------|---------|
| 2026-03-15 | ML model v3 for auto-placement | Rule-based fallback too brittle for edge cases |
| 2026-03-22 | Delay overlay to Q2 | Team bandwidth, auto-placement priority |
| 2026-04-01 | Neural banners: multi-banner first | Single-banner adoption too slow |
