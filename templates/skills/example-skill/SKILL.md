---
name: example-skill
description: >
  Scaffold for creating your own skill — a repeatable procedure Claude runs when a
  trigger phrase or context matches. Copy this directory, rename it, and replace the
  body. Trigger phrases: "example trigger", "run example".
---

# [Skill Name]

[One line: what this skill does and when to use it.]

## Trigger phrases

- "[phrase 1]"
- "[phrase 2]"

## Inputs

| Input | Source | Required? |
|-------|--------|-----------|
| [Data 1] | Hub file / user input | Yes |
| [Data 2] | Connected tool (optional) | No |

## Steps

### 1. Gather context

```bash
git pull --ff-only 2>/dev/null
cat hubs/[relevant_hub].md
```

### 2. Process

[What Claude does with the gathered data — analysis, extraction, generation.]

### 3. Persist (only if it changed state)

```bash
git add -A && git commit -m "update: [domain] — [what the skill did]" && git push
```

## Edge cases

- **Missing data:** [what to do if a required input is unavailable].
- **Stale hub:** note the age, proceed with a caveat.
