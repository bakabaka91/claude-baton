Save session state before context loss.

## Steps

1. Detect the project from the current working directory.

2. Capture git state by running these bash commands:
   - `git branch --show-current`
   - `git status --short`
   - `git diff --name-only HEAD`
   - `git log --since="2 hours ago" --format="%h %s"`
   - `git log --oneline -10` (this becomes the git_snapshot)

3. Check if any plan documents exist (PLAN.md, docs/*.md specs, roadmaps). If one is being actively worked on, note the file path and the current phase/step (e.g. "docs/v2-plan.md Phase 2 Step 3").

4. Summarize the session state from the conversation context:
   - **what_was_built**: what was accomplished this session
   - **current_state**: where things stand now
   - **next_steps**: what should happen next
   - **decisions**: key choices made and WHY
   - **blockers**: anything blocking progress
   - **plan_reference**: file path and section of the active plan document (e.g. "docs/v2-plan.md Phase 2 Step 3"), or omit if no plan is active

5. Call the `save_checkpoint` MCP tool with all fields:
   - what_was_built
   - current_state
   - next_steps
   - decisions
   - blockers
   - plan_reference (from step 3, if applicable)
   - branch (from step 2)
   - uncommitted_files (array of lines from git status --short)
   - git_snapshot (from git log --oneline -10)

6. Print structured confirmation:

```
💾 Checkpoint saved — safe to /compact or /clear

🌿 Branch: [branch name]
📍 State: [current_state summary]
🎯 Next: [next_steps]
📝 Uncommitted: [count] files
```
