Create an implementation plan for the described feature or change. Do NOT write any code.

$ARGUMENTS

## Steps

1. Read PLAN.md for full project context
2. Read CLAUDE.md for constraints and current state
3. Read all source files relevant to the requested change
4. Produce a structured plan:

### Plan: [Feature Name]

**Context:** Why this change is needed

**Scope:** What's in and out

**Steps:**
1. [Numbered steps with file paths]

**Files to modify:**
- `path/file.ts` — what changes and why

**Files to create:**
- `path/file.ts` — purpose

**Tests needed:**
- [Test cases to add/modify]

**Risks:**
- [What could go wrong]

**Constraints check:**
- [ ] No git branch manipulation
- [ ] Single SQLite DB (no per-project files)
- [ ] stdio transport only
- [ ] No API keys / anthropic SDK imports
- [ ] Max 4 dependencies
- [ ] CLAUDE.md ordering preserved
- [ ] sql.js WASM only
- [ ] ~200 line token budget for managed block
