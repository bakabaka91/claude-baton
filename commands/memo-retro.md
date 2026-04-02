Analyze recent checkpoints to surface learnings and suggest memory updates.

Run periodically (weekly or after major milestones) to close the learning loop.

## Steps

1. Detect the project from the current working directory. Construct the project slug by replacing all `/` with `-` in the full path.

2. Call the `list_checkpoints` MCP tool with `limit: 10` (no date) to fetch the 10 most recent checkpoints.

3. Load current memory state:
   - Read all files in `~/.claude/projects/[PROJECT_SLUG]/memory/`
   - Read `MEMORY.md` in the memory directory
   - Read the project's `CLAUDE.md` (in the working directory root)

4. Check git history for correction patterns:
   ```bash
   git log --oneline -30
   ```
   Look for reverts, quick-follow fix commits (e.g., "fix: ..." immediately after a feature commit), and patterns indicating repeated mistakes.

5. Analyze the checkpoint data:

   **Extract learnings:**
   - Pull the `learnings` array from each checkpoint (may be empty or absent on older checkpoints)
   - Also extract signals from `decisions_made`, `blockers`, and `what_was_built`

   **Frequency analysis:**
   - Count how many times each learning (or semantically similar learning) appears
   - Single occurrence = note only
   - 2+ occurrences = high confidence, propose as rule

   **Cross-reference:**
   - Is this learning already captured in a memory file? → skip
   - Is this learning already a CLAUDE.md rule? → skip
   - Is this a correction/preference? → propose as feedback memory
   - Is this about the project? → propose as project memory

6. Present the report:

```
## 🔄 Retro — [PROJECT_NAME] — [DATE]

### 🧠 Memory Health

- 📁 Total memories: [count of files in memory dir]
- 📏 MEMORY.md line count: [N]/200 (⚠️ warn if >150)
- 🪦 Stale memories: [any referencing completed/outdated work]
- 🔀 Duplicate/overlapping memories: [any found]

### 📚 Learnings Summary

**🔁 Recurring (2+ times) — propose as rules:**

- [learning] — appeared in [N] checkpoints
- ...

**📌 Single occurrence — note only:**

- [learning]
- ...

### 🔍 Git Correction Patterns

[Reverts, quick-follow fixes that indicate recurring mistakes, or "✅ None detected"]

### 🛠️ Proposed Changes

**📝 Memory file actions:**

- ➕ **Create:** [new memory file if a pattern warrants it, with suggested filename and content]
- ✏️ **Update:** [existing memory with outdated info]
- 🔗 **Merge:** [overlapping memories to consolidate]
- 🗑️ **Prune:** [stale memories to delete]

**📐 CLAUDE.md rules** (only for recurring learnings not already captured):

1. Add to section [X]: "[exact rule wording]"
   _Reason: appeared in [N] checkpoints, e.g., [quote from learning]_
```

7. Ask: **"Which changes should I apply? (all / list numbers / none)"**

   Do NOT modify CLAUDE.md, memory files, or any project files without explicit approval.
