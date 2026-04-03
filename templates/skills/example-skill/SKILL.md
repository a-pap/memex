---
name: example-skill
version: "1.0"
description: >
  Template for creating custom skills. A skill is a repeatable procedure that
  Claude executes when triggered by specific phrases or contexts. Replace this
  with your actual skill. Trigger phrases: "example trigger", "run example".
  Skills should be specific enough to be useful, generic enough to be reusable.
---

# [Skill Name]

[One-line description of what this skill does and when to use it.]

## Trigger phrases

<!-- List phrases that should activate this skill -->
- "[phrase 1]"
- "[phrase 2]"
- "[phrase 3]"

## Inputs

<!-- What data does the skill need? Where does it come from? -->

| Input | Source | Required? |
|-------|--------|-----------|
| [Data 1] | Hub file / Calendar / Reminders / user input | Yes |
| [Data 2] | Granola / Google Drive / conversation | No |

## Steps

### Step 1: Gather context

```bash
# Pull repo if needed
cd /home/claude/claude-memory && git pull
cat hubs/[relevant_hub].md
```

[Additional data gathering from MCP tools, search, etc.]

### Step 2: Process

[What Claude does with the gathered data — analysis, extraction, generation, etc.]

### Step 3: Output

[What the skill produces — a report, file, reminders, hub updates, etc.]

### Step 4: Persist (if applicable)

```bash
# Update hub file if the skill changed any state
git add -A && git commit -m "update: [domain] — [what skill did]" && git push
```

## Edge cases

- **Missing data:** [What to do if a required input is unavailable]
- **Stale data:** [How to handle outdated hub files]
- **Tool unavailable:** [Fallback if an MCP connector is down]

## Example output

```
[Show what a good output from this skill looks like]
```
