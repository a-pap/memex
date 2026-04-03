# Contributing to the Blueprint

This blueprint is designed to evolve. Both humans and their Claude instances can propose improvements to the core architecture.

## How It Works

The open blueprint repo contains the **generic system** — templates, architecture docs, and patterns that work for anyone. Your private fork contains your **personalized instance** — your hubs, your memory edits, your skills.

Improvements flow in one direction: **specific learnings → generic patterns**.

## For Humans

If you've built something on top of this system that others would benefit from:

1. **Fork the blueprint repo** (if you haven't already)
2. **Add your improvement** to the relevant template or doc
3. **Submit a PR** with a clear description of what it solves

Good contributions:
- New skill templates (e.g., "weekly-review", "health-tracker", "job-search")
- Improved RULES.md patterns based on real failure modes
- Better context loading strategies
- New hub structure conventions that solve a real problem
- Integration patterns for MCP connectors

## For Claude Instances

When your Claude notices a systemic improvement during a conversation — a pattern that would benefit all users of this system, not just the current user — it should:

### Step 1: Flag the improvement

Tell your human:
```
I noticed a pattern that could improve the blueprint system:
[Description of the improvement]
Want me to draft a contribution?
```

### Step 2: Draft the change

If approved, create a file in your private repo under `contributions/`:
```
contributions/YYYY-MM-DD_short_description.md
```

With this structure:
```markdown
# Proposed Blueprint Improvement

## Problem
[What failure mode or inefficiency this addresses]

## Solution
[The specific change to templates/architecture]

## Evidence
[How this was discovered — what went wrong or could be better]

## Files affected
[Which blueprint files would change]

## Diff
[The actual proposed changes]
```

### Step 3: Human reviews and submits

The human reviews the contribution and, if they agree, submits it as a PR to the open blueprint repo.

## What Makes a Good Contribution

**Include:**
- Patterns that are **domain-agnostic** (work for any user, not just yours)
- Failure modes with concrete prevention rules
- Token optimization strategies with measured impact
- New skill templates that solve common needs

**Don't include:**
- Personal data, names, or domain-specific content
- Changes that only matter for your specific setup
- Speculative improvements without evidence from real usage

## Versioning

The blueprint uses semantic versioning in key files:
- Skills have `version:` in their frontmatter
- Breaking changes to CLAUDE.md or BOOTSTRAP.md bump the major version
- New templates or patterns bump the minor version

## Architecture Decisions

Major changes to the system architecture should include an ADR (Architecture Decision Record) in `docs/decisions/`:

```markdown
# ADR-NNN: [Title]

## Status: [Proposed | Accepted | Deprecated]

## Context
[Why this decision is needed]

## Decision
[What we decided]

## Consequences
[What changes as a result]
```
