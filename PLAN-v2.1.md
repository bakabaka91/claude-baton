# claude-baton v2.1 — Auto-Checkpoint Quality & Resume Resilience

## Context

**Problem discovered:** Auto-checkpoints produce low-quality data because they only see the transcript at compaction time. If the transcript is noisy (analysis, context-filling, debugging), haiku summarizes the noise instead of the actual work. Each auto-checkpoint is isolated — no continuity across multiple compactions or sessions. Resume has edge case failures: timezone date filtering misses checkpoints, path mismatches cause silent failures, no fallback when no checkpoints exist, no staleness detection.

**Root cause:** The auto-checkpoint handler receives only the current transcript and sends it to haiku with no prior context. There is no "before" state to diff against, so haiku cannot distinguish meaningful work from noise.

**Solution:** Three interconnected improvements:

1. **Chained auto-checkpoints (the writer)** — each auto-checkpoint gets previous checkpoint context + git diff since last checkpoint + transcript. This gives haiku a "before" snapshot to diff against.
2. **Resilient resume (the reader)** — additive-only changes: staleness detection, cold-start fallback, source label. No changes to how checkpoint fields are displayed. Manual checkpoint resume stays exactly as-is.
3. **Infrastructure fixes** — path normalization, timezone-safe date queries, source field in schema.

**Key constraint:** Never change the manual checkpoint flow or how resume displays checkpoint fields. All resume changes are additive only.

---

## Why This Matters

Without chaining, a session that compacts three times produces three isolated summaries, each capturing only its slice. The third compaction has no idea what the first two were about. With chaining, each auto-checkpoint builds on the last, creating an accumulating narrative that survives unlimited compactions.

Without resume resilience, users hit silent failures: no checkpoint found (when one exists but the date or path doesn't match), a stale checkpoint presented as current with no warning, or a blank screen on cold-start with no guidance.

---

## Architecture Changes

### Schema layer (`src/types.ts`, `src/store.ts`)

- Add `source` column to `checkpoints` table: `TEXT DEFAULT 'manual'`. Values: `"manual"`, `"auto"`.
- Add migration for existing databases (same pattern as existing `git_snapshot`/`plan_reference` migrations).
- Add `source` field to the `Checkpoint` TypeScript interface.
- Add `normalizeProjectPath()` to `src/utils.ts`: resolves symlinks via `fs.realpathSync`, removes trailing slashes, normalizes separators.
- Update `getCheckpointsByDate` to use range query instead of LIKE prefix for timezone safety.

### Auto-checkpoint layer (`src/cli.ts`, `prompts/auto_checkpoint.txt`)

- In `handleAutoCheckpoint()`: before calling LLM, fetch previous checkpoint (latest for this project, any source).
- Compute `git diff --stat <previous_checkpoint_top_commit>..HEAD` if previous checkpoint has `git_snapshot`.
- Build enriched prompt with three sections: previous checkpoint summary, git diff since last checkpoint, current transcript.
- Pass `source: "auto"` when calling `insertCheckpoint`.
- Prompt template gets two new sections (`{{PREVIOUS_CHECKPOINT}}` and `{{GIT_DIFF}}`), replacing the current single-section design.

### Resume layer (`commands/memo-resume.md`)

- Add staleness detection: compute time delta between checkpoint `created_at` and now; surface warning if > 24 hours.
- Add cold-start fallback: when no checkpoint exists, generate a briefing from git activity instead of showing nothing.
- Add source label: show whether the resumed checkpoint was `"manual"` or `"auto"` for transparency.
- All additions are new sections appended after existing sections. No existing display logic is modified.

### MCP server layer (`src/index.ts`)

- Update `save_checkpoint` tool to accept optional `source` parameter.
- Pass it through to `insertCheckpoint`. Defaults to `"manual"`.

---

## Commits

### Commit 1: `feat(store): add source column to checkpoints schema`

**Files:** `src/types.ts`, `src/store.ts`, `tests/store.test.ts`

**Changes in `src/types.ts`:**
- Add `source: "manual" | "auto"` to `Checkpoint` interface after `plan_reference`

**Changes in `src/store.ts`:**
- Add `source TEXT DEFAULT 'manual'` to CREATE TABLE statement for checkpoints, after `plan_reference TEXT`
- Add migration block (after existing `plan_reference` migration):
  ```typescript
  try {
    db.exec("ALTER TABLE checkpoints ADD COLUMN source TEXT DEFAULT 'manual'");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (!msg.includes("duplicate column")) throw e;
  }
  ```
- In `insertCheckpoint` opts type, add `source?: "manual" | "auto"`. Add `source` column to INSERT statement. Add `opts?.source ?? "manual"` to values array.
- In `parseCheckpointRow`, add: `source: (row.source as string | null) ?? "manual"`

**Tests to add (`tests/store.test.ts`):**
- `it("stores and retrieves source field as 'manual' by default")`
- `it("stores and retrieves source field as 'auto' when specified")`
- `it("migration adds source column to existing databases")`

---

### Commit 2: `feat(utils): add normalizeProjectPath helper`

**Files:** `src/utils.ts`, `tests/utils.test.ts` (new file)

**Changes in `src/utils.ts`:**
```typescript
import { realpathSync } from "fs";
import path from "path";

export function normalizeProjectPath(p: string): string {
  try {
    const resolved = realpathSync(p);
    return resolved.length > 1 && resolved.endsWith(path.sep)
      ? resolved.slice(0, -1)
      : resolved;
  } catch {
    const normalized = path.resolve(p);
    return normalized.length > 1 && normalized.endsWith(path.sep)
      ? normalized.slice(0, -1)
      : normalized;
  }
}
```

**Tests to add (`tests/utils.test.ts`):**
- `it("removes trailing slash")`
- `it("preserves root path")`
- `it("resolves relative paths")`
- `it("handles already-clean paths")`

---

### Commit 3: `feat: apply path normalization across all entry points`

**Files:** `src/cli.ts`, `src/index.ts`, `tests/cli.test.ts`

- Import `normalizeProjectPath` from `./utils.js` in both files
- Use `normalizeProjectPath(process.cwd())` in auto-checkpoint, handleStatus, handleExport, handleReset
- Use it in MCP server's `projectPath` computation (line 174 of index.ts)
- Fixes: `/Users/foo/bar/` vs `/Users/foo/bar`, symlinks, `~/` vs absolute

**Tests to add (`tests/cli.test.ts`):**
- Verify auto-checkpoint uses normalized path in insertCheckpoint call

---

### Commit 4: `feat(cli): chain auto-checkpoints with previous context and git diff`

**Files:** `src/cli.ts`, `prompts/auto_checkpoint.txt`, `tests/cli.test.ts`

This is the core change.

**Changes in `src/cli.ts` (`handleAutoCheckpoint`):**

After initializing database and computing projectPath, add:
1. Fetch previous checkpoint: `const prevCheckpoint = getLatestCheckpoint(db, projectPath)`
2. Compute git diff if previous checkpoint has `git_snapshot`:
   ```typescript
   let gitDiffSinceCheckpoint = "";
   if (prevCheckpoint?.git_snapshot) {
     const topCommitHash = prevCheckpoint.git_snapshot.split("\n")[0]?.split(" ")[0];
     if (topCommitHash) {
       gitDiffSinceCheckpoint = gitCmd(`git diff --stat ${topCommitHash}..HEAD`);
     }
   }
   ```
3. Build previous checkpoint context string from prevCheckpoint fields
4. Replace prompt construction to use three placeholders: `{{PREVIOUS_CHECKPOINT}}`, `{{GIT_DIFF}}`, `{{TRANSCRIPT}}`
5. Pass `source: "auto"` to insertCheckpoint

Note: `git diff --stat` is read-only — consistent with the git branch policy (never touch branches).

**New prompt template (`prompts/auto_checkpoint.txt`):**

Three sections:
- `PREVIOUS CHECKPOINT:` — previous checkpoint's what_was_built, current_state, next_steps, decisions
- `GIT CHANGES SINCE LAST CHECKPOINT:` — `git diff --stat` output
- `CURRENT TRANSCRIPT:` — existing transcript

Prompt instructions:
- Focus on what CHANGED since previous checkpoint
- Don't repeat already-captured work
- Be honest when transcript is noise ("Explored X and Y but no code changes yet")
- Note file changes from git diff not explained in transcript

Graceful fallbacks:
- No previous checkpoint → "No previous checkpoint exists for this project."
- Git diff fails → "No file changes since last checkpoint."

**Tests to add (`tests/cli.test.ts`):**
- `it("chains auto-checkpoint with previous checkpoint context")` — verify prompt contains previous checkpoint's what_was_built
- `it("includes git diff in auto-checkpoint prompt when previous checkpoint exists")` — verify prompt contains diff output
- `it("handles first auto-checkpoint with no previous checkpoint")` — verify "No previous checkpoint" fallback
- `it("saves auto-checkpoint with source 'auto'")` — verify source field
- `it("handles failed git diff gracefully")` — verify fallback text

---

### Commit 5: `feat(index): pass source field through save_checkpoint MCP tool`

**Files:** `src/index.ts`, `tests/index.test.ts`

- Add `source` to save_checkpoint tool inputSchema:
  ```typescript
  source: {
    type: "string",
    enum: ["manual", "auto"],
    description: "Checkpoint source. Defaults to manual.",
  }
  ```
- In handler, pass `source: (a?.source as "manual" | "auto" | undefined) ?? "manual"` to insertCheckpoint opts

**Tests:**
- `it("stores source field when provided via save_checkpoint")`
- `it("defaults source to 'manual' when not provided")`

---

### Commit 6: `feat(resume): add staleness detection, cold-start fallback, source label`

**Files:** `commands/memo-resume.md`

**New step 2.5 — Staleness check:**
After getting checkpoint, compute time delta from `created_at` to now:
- \> 7 days: `"WARNING: This checkpoint is [N] days old. Project state may have changed significantly."`
- \> 24 hours but ≤ 7 days: `"Note: This checkpoint is [N] hours/days old."`
- ≤ 24 hours: no note

**New step 2.75 — Cold-start fallback:**
When no checkpoint exists for this project:
- Run `git log --oneline -20`, `git diff --stat HEAD~5..HEAD`, `git branch --show-current`, `git status --short`
- Present a "Cold Start Briefing" with recent commits, file changes, uncommitted work
- End with: "No checkpoint to resume from, but here is the project state from git. What would you like to work on?"
- Skip remaining steps (4-8)

**Modified output template header:**
```
## Session Resume -- [Project Name] -- [DATE]

Resuming from checkpoint: [timestamp]
Source: [auto/manual] checkpoint
[Staleness warning if applicable]
```

All existing display sections (Branch, Where We Left Off, What Was Built, Decisions Made, Blockers, Active Plan Context, Changes Since Checkpoint, Next Steps, Uncommitted Work, Commits From Last Session, Git Activity Since Checkpoint) remain unchanged.

---

### Commit 7: `fix(store): timezone-safe date queries`

**Files:** `src/store.ts`, `tests/store.test.ts`

Replace `LIKE date || '%'` in `getCheckpointsByDate` with range query:
```typescript
const startLocal = new Date(`${date}T00:00:00`);
const endLocal = new Date(`${date}T23:59:59.999`);
const startUtc = startLocal.toISOString();
const endUtc = endLocal.toISOString();

const stmt = db.prepare(
  "SELECT * FROM checkpoints WHERE project_path = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC",
);
stmt.bind([projectPath, startUtc, endUtc]);
```

This works because `new Date('2026-03-24T00:00:00')` creates a Date in the local timezone, and `.toISOString()` converts to UTC. User at 11pm PST → checkpoint stored as next-day UTC → range query correctly includes it.

**Tests to add (`tests/store.test.ts`):**
- `it("finds checkpoints created near midnight UTC that fall in the local date")`
- `it("still finds checkpoints created during the day")`
- `it("does not return checkpoints from adjacent days")`

---

## Edge Cases → Commit Map

| Scenario | Commit | How It Is Handled |
|---|---|---|
| Multiple compactions lose context | 4 | Each chains from the last — context accumulates |
| Transcript is noise, no real work | 4 | Git diff provides ground truth, prompt instructs honest reporting |
| Abandoned direction captured | 4 | Git diff shows what actually stuck in code |
| No-commit exploration session | 4 | Previous checkpoint chain carries narrative forward |
| Path mismatch (symlink, trailing slash) | 2, 3 | normalizeProjectPath resolves to canonical form |
| No checkpoint exists (new user) | 6 | Cold-start git briefing instead of nothing |
| Stale checkpoint (days old) | 6 | Staleness warning surfaced prominently |
| Very stale checkpoint (> 7 days) | 6 | Prominent WARNING message |
| Timezone date mismatch | 7 | Range query using local-to-UTC conversion |
| First auto-checkpoint (no previous) | 4 | Prompt uses "No previous checkpoint" fallback |
| Previous checkpoint has no git_snapshot | 4 | Git diff step skipped, uses "No file changes" fallback |
| Git diff command fails | 4 | gitCmd() returns "", prompt uses fallback |
| LLM call fails during auto-checkpoint | Existing | Existing try/catch logs error, exits gracefully |

---

## What We Are NOT Changing

1. **Manual checkpoint flow** — `/memo-checkpoint` slash command, `save_checkpoint` MCP tool behavior (apart from optional `source` parameter), and how manual checkpoints are stored are all untouched.
2. **Resume display of existing checkpoint fields** — all sections (Branch, Where We Left Off, What Was Built, etc.) remain exactly as they are. Changes are additive only: source label, staleness note, cold-start fallback.
3. **EOD command** — `/memo-eod` is not modified.
4. **Daily summaries** — `daily_summary` MCP tool and `daily_summaries` table are not modified.
5. **LLM wrapper** — `src/llm.ts` is not modified. We continue to use `callClaudeJson` with haiku and 30s timeout.
6. **Dependencies** — no new dependencies. Still 3: `@modelcontextprotocol/sdk`, `sql.js`, `commander`.
7. **Auto-checkpoint timeout budget** — 30s haiku budget unchanged. New git diff and previous checkpoint lookup add <100ms.
8. **Database location** — still `~/.claude-baton/store.db`, single file for all projects.
9. **MCP transport** — still stdio.
10. **Git branch policy** — never touch branches, never create them, never switch them. `git diff --stat` is read-only.

---

## Verification

1. Auto-checkpoint with previous context: trigger compaction twice in one session → second checkpoint references first checkpoint's work, not just transcript noise
2. Auto-checkpoint with git diff: make code changes, trigger compaction → checkpoint mentions the changed files
3. Auto-checkpoint with no previous: fresh project, first compaction → checkpoint works standalone
4. Resume with source label: checkpoint shows "auto" or "manual" in the briefing
5. Resume staleness: checkpoint from 3 days ago → warning shown
6. Resume cold-start: project with no checkpoints → git-only briefing shown
7. Path normalization: access project via symlink → checkpoint and resume find each other
8. Timezone: create checkpoint at 11pm local → next morning resume finds it
9. Manual checkpoint unaffected: `/memo-checkpoint` → `/memo-resume` → same output as before
