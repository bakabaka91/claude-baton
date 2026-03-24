# claude-baton — Implementation Plan

## Context

**Problem:** AI coding agents start every session with a blank slate. memory-mcp partially solves this with automatic extraction, but it's API-dependent (costs money), local-only, lacks session lifecycle tools, and doesn't track dead ends or constraints.

**Solution:** claude-baton — an open-source MCP server for Claude Code that combines:
- memory-mcp's automatic extraction (but using `claude -p` instead of API — zero extra cost)
- Memoria's richer data model (dead ends, constraints, goals)
- The user's skill workflow (checkpoint/resume/insight/eod) absorbed as MCP tools
- Cross-project SQLite storage (single DB per user)

**Target users:** Solo builders and engineering leaders using Claude Code.

---

## Decided Parameters

| Decision | Choice |
|----------|--------|
| Name | claude-baton |
| Language | TypeScript (npm package) |
| Storage | SQLite via sql.js (pure WASM, zero native deps) |
| LLM engine | `claude -p` (subscription, no API key needed) |
| Transport | stdio (standard MCP) |
| Distribution | `npm install -g claude-baton` |
| Data model | Full (decisions, dead ends, constraints, goals, checkpoints, insights, architecture, patterns, gotchas) |
| Skills | Absorbed into MCP tools |

---

## Data Model (SQLite tables in `~/.claude-baton/store.db`)

### memories
- id, project_path, type (architecture|decision|pattern|gotcha|progress|context), content, tags (JSON), confidence, access_count, status (active|archived|superseded), supersedes_id, created_at, updated_at

### dead_ends
- id, project_path, summary, approach_tried, blocker, resume_when, resolved (bool), created_at

### constraints
- id, project_path, rule, type (security|performance|compliance|convention), severity (must|should|prefer), scope, source, created_at

### goals
- id, project_path, intent, done_when (JSON array), status (active|completed|paused), created_at, updated_at

### checkpoints
- id, project_path, session_id, branch, current_state, what_was_built, next_steps, decisions_made, blockers, uncommitted_files (JSON), created_at

### insights
- id, project_path, content, context, category (decision|workflow|architecture|surprise|cost), created_at

### daily_summaries
- id, project_path, date, summary (JSON), created_at

### extraction_log
- id, project_path, session_id, event_type, chunks_processed, memories_extracted, created_at

---

## MCP Tools (16 tools)

### Memory
1. `memory_search(query, project?, type?)` — search across all memory types
2. `memory_save(type, content, tags?)` — manually save a memory
3. `memory_recall(topic)` — RAG-style synthesized answer via claude -p
4. `memory_stats()` — counts by type/project, last extraction time

### Dead Ends
5. `log_dead_end(summary, approach_tried, blocker, resume_when?)` — record a failed approach
6. `check_dead_ends(approach)` — pre-work check: was this already tried and failed?

### Constraints
7. `add_constraint(rule, type, severity, scope?)` — add a project rule
8. `get_constraints(project?)` — list active constraints

### Goals
9. `set_goal(intent, done_when[])` — set current sprint/task goal
10. `get_goal(project?)` — get active goal

### Session Lifecycle (absorbed skills)
11. `save_checkpoint(what_was_built, current_state, next_steps, decisions?, blockers?)` — save state before context loss
12. `get_checkpoint(project?)` — retrieve latest checkpoint for resumption
13. `save_insight(content, category?)` — capture real-time insight
14. `daily_summary(date?)` — generate EOD summary from checkpoints, insights, git activity, memories

### Admin
15. `consolidate()` — manually trigger merge/prune/decay
16. `sync_claude_md()` — manually refresh CLAUDE.md managed block

---

## Hooks (automatic, silent)

Configured in `~/.claude/settings.json` during `claude-baton setup`:

- **Stop** — extract memories from session transcript
- **PreCompact** — auto-checkpoint before context compaction
- **SessionEnd** — final extraction + consolidation if needed

### Hook handler flow:
1. Read session transcript from cursor position
2. Chunk if > 6000 chars (500-char overlap)
3. Send to `claude -p --model haiku` with extraction prompt
4. Parse JSON response → insert into SQLite
5. Update CLAUDE.md managed block
6. Advance cursor

---

## CLAUDE.md Managed Block

Constraints and dead ends appear FIRST — agents see "don't" before "do" (Memoria's ADR-004).

```markdown
<!-- MEMORIA:START -->
## Constraints
- [rules agents must follow]

## Dead Ends
- [failed approaches — don't retry]

## Key Decisions
- [architectural choices with rationale]

## Active Goal
- [current sprint intent + done-when]

## Recent Context
- [patterns, gotchas, active progress]

## Last Checkpoint
- [what was built, next steps, blockers]
<!-- MEMORIA:END -->
```

Token budget: ~200 lines, allocated by priority (constraints > dead ends > decisions > goal > context > checkpoint).

---

## CLI Commands

- `claude-baton setup` — configure hooks, create ~/.claude-baton/, init SQLite
- `claude-baton status` — memory counts, last extraction, db size
- `claude-baton search <query>` — search from terminal
- `claude-baton projects` — list tracked projects
- `claude-baton export [project]` — export as JSON
- `claude-baton import <file>` — import from JSON
- `claude-baton reset [project]` — clear memories for a project

---

## Project Structure

```
claude-baton/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE (MIT)
├── src/
│   ├── index.ts          — MCP server entry, tool definitions
│   ├── types.ts          — TypeScript interfaces
│   ├── store.ts          — SQLite operations (CRUD, search, dedup)
│   ├── extractor.ts      — Hook handler: transcript → memories
│   ├── consolidator.ts   — Merge/prune/decay logic
│   ├── claude-md.ts      — CLAUDE.md managed block sync
│   ├── llm.ts            — claude -p wrapper
│   ├── cli.ts            — CLI commands
│   └── utils.ts          — Cursor tracking, chunking, similarity
├── prompts/
│   ├── extract.txt       — Extraction prompt template
│   ├── consolidate.txt   — Consolidation prompt template
│   └── recall.txt        — RAG recall prompt template
├── tests/
│   ├── store.test.ts
│   ├── extractor.test.ts
│   ├── consolidator.test.ts
│   ├── claude-md.test.ts
│   └── cli.test.ts
└── bin/
    └── claude-baton.js   — CLI entry point
```

---

## Key Differentiators vs memory-mcp

| Feature | memory-mcp | claude-baton |
|---------|-----------|--------------|
| LLM engine | Anthropic API ($) | claude -p (subscription, free) |
| Dead end tracking | No | Yes |
| Constraints | No | Yes |
| Goals | No | Yes |
| Session lifecycle | No | Yes (checkpoint/resume/insight/eod) |
| Cross-project | No (per-project JSON) | Yes (single SQLite DB) |
| Storage | JSON files | SQLite (sql.js, WASM) |
| Git snapshots | Yes (invasive) | No — never touches git branches |
| CLAUDE.md ordering | By confidence score | Constraints → Dead ends → Decisions (intentional) |
| Daily summaries | No | Yes |
| API key required | Yes | No |

---

## Dependencies (4 only)

- `@modelcontextprotocol/sdk` — MCP protocol
- `sql.js` — SQLite in WASM
- `zod` — schema validation
- `commander` — CLI framework

---

## Implementation Phases

### Phase 1: Foundation
- Project scaffolding (package.json, tsconfig, build pipeline)
- TypeScript types for all data models (types.ts)
- SQLite store with sql.js — schema creation, CRUD for all tables (store.ts)
- Tests for store operations

### Phase 2: MCP Server + Tools
- MCP server with stdio transport (index.ts)
- All 16 tools implemented
- claude -p wrapper (llm.ts)
- CLAUDE.md managed block sync (claude-md.ts)

### Phase 3: Extraction & Hooks
- Transcript parser (session.jsonl → readable summary)
- Chunking with overlap
- Extraction via claude -p with structured prompts (extractor.ts)
- Extraction prompt templates (prompts/)
- CLI setup command — configure hooks in settings.json
- Cursor tracking (utils.ts)

### Phase 4: Intelligence
- Confidence decay (progress: 7d, context: 30d)
- Deduplication (Jaccard similarity, threshold 0.6)
- Consolidation via claude -p — merge/prune/drop (consolidator.ts)
- Memory recall — RAG-style search + synthesis
- check_dead_ends — pre-work validation

### Phase 5: CLI & Polish
- All CLI commands (status, search, projects, export, import, reset)
- README with installation, usage, comparison to memory-mcp
- npm package config (bin, main, types)
- End-to-end testing

### Phase 6: Optional Enhancements (post-launch)
- Optional Supabase sync plugin
- StatusLine integration
- Usage/cost tracking
- VS Code extension (capture panel)

---

## Verification

1. `npm install -g claude-baton` succeeds on macOS/Linux/Windows
2. `claude-baton setup` configures hooks in settings.json
3. Start a Claude Code session → Stop → verify memories extracted to SQLite
4. `/checkpoint` → close session → new session → `/resume` returns context
5. `claude-baton search "auth"` returns relevant cross-project results
6. CLAUDE.md shows managed block with constraints before decisions
7. `check_dead_ends("try approach X")` warns if X was already tried
8. `daily_summary()` generates coherent EOD from day's activity
