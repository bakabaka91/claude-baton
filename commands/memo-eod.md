End-of-day summary combining git activity with stored checkpoints.

**Important: Run all git commands exactly as written below — do NOT add -C flags or path arguments. The working directory is already the project root.**

## Steps

1. Detect the project from the current working directory.

2. Collect git activity for today by running (replace YYYY-MM-DD with today's actual date as a literal string — do NOT use $() command substitution):
   - `git log --since="YYYY-MM-DD 00:00:00" --until="YYYY-MM-DD 23:59:59" --format="%h|||%s|||%ai|||%an" --all`
   - Parse and group commits by conventional commit prefix (feat/fix/chore/refactor/test/docs).

3. Review changed files:
   - `git diff --name-only HEAD~10 HEAD`

4. Call the `daily_summary` MCP tool (defaults to today).
   This internally gathers checkpoints and sends them to Sonnet for synthesis, then stores the result.

5. Merge git activity from step 2 with the daily_summary output.

6. Display formatted summary:

```
## 📊 EOD Summary — [Project Name] — [DATE]

### 🏗️ What Was Built / Shipped
[Commits grouped by area + what_was_built from daily_summary]

### 🧭 Decisions Made
[From daily_summary + checkpoint decisions]

### 🚧 Blockers and Failures
[From daily_summary blockers -- or "✅ None"]

### 🔮 Open Questions / Tomorrow
[next_steps from daily_summary]

### 📈 Git Stats
- 📝 Commits today: [count]
- 📁 Files changed: [count]
- 🏷️ Feature areas: [list of commit prefixes]

### 💰 Baton Usage
- LLM calls today: [usage.llm_calls_today from daily_summary response] ([N] auto-checkpoints + 1 EOD)
- Database: [usage.db_size from daily_summary response]
```

7. Confirm: "✅ EOD saved for [Project Name] — [DATE]. [N] commits today."
