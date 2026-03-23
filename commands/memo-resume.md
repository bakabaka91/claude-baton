Restore context from last checkpoint at session start.

## Steps

1. Detect the project from the current working directory.

2. Call the `list_checkpoints` MCP tool with today's date. If multiple checkpoints exist, show them and note which is latest.

3. Call the `get_checkpoint` MCP tool (latest by default, or by ID if the user specified one via $ARGUMENTS).

4. Call the `get_goal` MCP tool for the active goal.

5. Call the `get_insights` MCP tool with `since` set to the checkpoint's `created_at` timestamp.

6. Capture current git state by running these bash commands:
   - `git branch --show-current`
   - `git status --short`
   - `git log --oneline -10`
   - `git diff --stat main...HEAD`

7. If the checkpoint's current_state contains a plan reference (e.g. "PLAN.md Phase 3"), read the referenced file and extract the relevant section.

8. Present the structured handover briefing:

```
## Session Resume -- [Project Name] -- [DATE]

Resuming from checkpoint: [timestamp]

### Branch
[checkpoint branch] -- currently on [current branch]
[Flag if they differ]

### Where We Left Off
[current_state from checkpoint]

### What Was Built (Last Session)
[what_was_built from checkpoint]

### Decisions Made
[decisions from checkpoint -- or "None recorded"]

### Blockers
[blockers from checkpoint -- or "None"]

### Active Goal
[goal intent and done_when criteria -- or "No active goal"]

### Active Plan Context
[plan section content if referenced -- or "No active plan referenced"]

### Next Steps
[next_steps from checkpoint] -- this is where to pick up.

### Uncommitted Work
[checkpoint uncommitted_files vs current git status]
[Flag differences]

### Git Activity Since Checkpoint
[Diff checkpoint git_snapshot vs current git log --oneline -10]
[Show only new commits]

### Insights Since Checkpoint
[Insights from get_insights tool, time-ordered]
[Or "None captured"]
```

9. End with: "Ready to continue. The next step from your last session was: [next_steps]. Want me to pick that up, or are we doing something else?"
