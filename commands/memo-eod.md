End-of-day summary combining git activity with stored data.

## Steps

1. Detect the project from the current working directory.

2. Collect git activity for today by running:
   - `git log --since="$(date '+%Y-%m-%d') 00:00:00" --until="$(date '+%Y-%m-%d') 23:59:59" --format="%h|||%s|||%ai|||%an" --all`
   - Parse and group commits by conventional commit prefix (feat/fix/chore/refactor/test/docs).

3. Review changed files:
   - `git diff --name-only HEAD~10 HEAD 2>/dev/null | head -30`

4. Call the `daily_summary` MCP tool (defaults to today).
   This internally gathers checkpoints, insights, memories, and extraction logs, sends them to Haiku for synthesis, and stores the result.

5. Merge git activity from step 2 with the daily_summary output.

6. Display formatted summary:

```
## EOD Summary -- [Project Name] -- [DATE]

### What Was Built / Shipped
[Commits grouped by area + what_was_built from daily_summary]

### Decisions Made
[From daily_summary + checkpoint decisions]

### Blockers and Failures
[From daily_summary blockers]

### Insights from Today
[Insights gathered by daily_summary]

### Open Questions / Tomorrow
[next_steps from daily_summary]

### Git Stats
- Commits today: [count]
- Files changed: [count]
- Feature areas: [list of commit prefixes]
```

7. Confirm: "EOD saved for [Project Name] -- [DATE]. [N] commits today."
