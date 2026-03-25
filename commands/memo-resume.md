Restore context from last checkpoint at session start.

## Steps

1. Detect the project from the current working directory.

2. Call the `list_checkpoints` MCP tool with today's date. If multiple checkpoints exist, show them and note which is latest.

3. Call the `get_checkpoint` MCP tool (latest by default, or by ID if the user specified one via $ARGUMENTS).

3.5. **Staleness check:** If a checkpoint was found, compute the time delta between the checkpoint's `created_at` and now:
   - More than 7 days old: display `"⚠️ WARNING: This checkpoint is [N] days old. Project state may have changed significantly."`
   - More than 24 hours but 7 days or less: display `"📌 Note: This checkpoint is [N] hours/days old."`
   - 24 hours or less: no staleness note

3.75. **Cold-start fallback:** If NO checkpoint exists for this project:
   - Run `git log --oneline -20`, `git diff --stat HEAD~5..HEAD`, `git branch --show-current`, `git status --short`
   - Present a "🆕 Cold Start Briefing" with recent commits, file changes, and uncommitted work
   - End with: "No checkpoint to resume from, but here is the project state from git. What would you like to work on?"
   - Skip remaining steps (4-8)

4. Capture current git state by running these bash commands:
   - `git branch --show-current`
   - `git status --short`
   - `git log --oneline -10`
   - `git diff --stat main...HEAD`

5. If the checkpoint has a `plan_reference` field (e.g. "docs/v2-plan.md Phase 2 Step 3"), read the referenced file and extract the relevant section. Parse the plan_reference to get the file path (everything before the section identifier like "Phase" or "Step") and the section name.

6. Diff intelligence -- compare checkpoint state to current state:
   - If checkpoint has a `git_snapshot`, extract the top commit hash and run `git diff --stat <hash>..HEAD` to see what files changed since checkpoint
   - Compare checkpoint `uncommitted_files` vs current `git status --short` -- note any files that were added, removed, or committed since checkpoint
   - If `package.json` appears in changed files, run `git diff <hash>..HEAD -- package.json` to check for dependency changes
   - Summarize as: "X files modified, Y new commits, Z dependency changes" (or "No changes since checkpoint" if clean)

7. Present the structured handover briefing:

```
## 🔄 Session Resume — [Project Name] — [DATE]

📍 Resuming from checkpoint: [timestamp]
🏷️ Source: [auto/manual] checkpoint
[Staleness warning if applicable]

### 🌿 Branch
`[checkpoint branch]` — currently on `[current branch]`
[Flag if they differ with ⚠️]

### 📍 Where We Left Off
[current_state from checkpoint]

### 🏗️ What Was Built (Last Session)
[what_was_built from checkpoint]

### 🧭 Decisions Made
[decisions from checkpoint -- or "None recorded"]

### 🚧 Blockers
[blockers from checkpoint -- or "✅ None"]
[If blockers exist, surface them prominently with ⚠️]

### 📋 Active Plan Context
[If plan_reference exists: show the reference, then the extracted section content from step 5]
[If no plan_reference: "No active plan"]

### 🔀 Changes Since Checkpoint
[Diff intelligence summary from step 6]
[Files changed, new commits, dependency changes]

### 🎯 Next Steps
Present as numbered action items:
1. [first action from next_steps]
2. [second action if applicable]
...

### 📝 Uncommitted Work
[checkpoint uncommitted_files vs current git status]
[Flag if they differ with ⚠️ -- someone may have stashed or committed manually]

### 📜 Commits From Last Session
[git_snapshot from checkpoint -- these are the commits made during that session]
[If empty: "No commits were made in the last session"]

### 🆕 Git Activity Since Checkpoint
[Any NEW commits since the checkpoint timestamp that were NOT in git_snapshot]
[If none: "No new commits since checkpoint"]
```

8. End with: "✅ Ready to continue. Want me to start with step 1, or are we doing something else?" (referring to the numbered action items above)
