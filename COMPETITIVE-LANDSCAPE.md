# claude-baton — Competitive Landscape

*Last updated: 2026-03-25*

## Claude Code's Built-In Session Features

Claude Code already has native session management capabilities that are expanding over time.

### What exists today

| Feature | Details |
|---|---|
| **Auto memory** | Claude writes notes to `~/.claude/projects/<project>/memory/`. A `MEMORY.md` entrypoint (first 200 lines loaded) plus topic files read on demand. Machine-local, per-git-repo. |
| **CLAUDE.md** | User-written markdown loaded at every session start. Supports project, user, and organization scopes. Can import other files via `@path` syntax. Survives compaction (re-read from disk). |
| **Session resume** | `claude --continue` / `claude -c` reopens the most recent conversation. `claude --resume <id>` / `claude -r <id>` reopens a specific past session by ID. Conversation history stored in SQLite under `~/.claude/`. |
| **Compaction** | `/compact` manually compresses conversation into a summary. Auto-compact triggers at ~95% context capacity. CLAUDE.md and rules survive compaction; in-conversation instructions may be lost. |
| **Hooks system** | `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `PostToolUse` hooks available. Enables third-party auto-checkpoint workflows (exactly what claude-baton's PreCompact hook uses). |
| **Remote control** | Continue local terminal sessions from mobile/web via `/remote-control`. Available to Max subscribers. Session runs locally; only chat messages transit the encrypted bridge. |

### What Claude Code does NOT have natively

- No structured checkpoint/resume with metadata (decisions, blockers, next steps)
- No EOD summaries
- No cross-session decision registry or architectural decision log
- No explicit session lifecycle state machine (checkpoint → resume → handoff)
- No project-scoped session history with queryable structured data

### Native resume vs. claude-baton checkpoint/resume

| | Claude Code native resume | claude-baton checkpoint/resume |
|---|---|---|
| **What's saved** | Raw conversation transcript (all messages) | Structured metadata: decisions made, blockers, next steps, plan progress, git context |
| **After compaction** | Transcript is compressed/summarized, details lost | Checkpoint captures state *before* compaction, so nothing is lost |
| **Cross-session handoff** | Same person continuing their own session | Designed for handoff — another session (or person) can pick up with full context |
| **EOD summary** | Not a concept | Generates a summary combining git activity + session data |
| **Queryable history** | No structured query over past sessions | Structured fields you can query across sessions/projects |

The key gap: `claude --continue` gives you back the *conversation*, but after compaction or context limits, the nuanced details (why a decision was made, what was tried and failed, what's blocked) are gone. claude-baton captures that structured context explicitly.

---

## Direct Competitors (MCP Servers)

### 1. CONTINUITY

- **GitHub:** [duke-of-beans/CONTINUITY](https://github.com/duke-of-beans/CONTINUITY)
- **Tools:** 8 MCP tools — `continuity_save_session`, `continuity_load_session`, `continuity_checkpoint`, `continuity_recover_crash`, `continuity_log_decision`, `continuity_query_decisions`, `continuity_compress_context`, `continuity_handoff_quality`
- **Storage:** SQLite + JSONL decision logs + JSON session snapshots
- **Lifecycle:** Startup crash recovery → load session → periodic checkpoints → handoff quality check → save session
- **vs. claude-baton:** Closest direct competitor. Has a decision registry and crash recovery that claude-baton lacks. Does NOT have EOD summaries or slash commands for user workflows.

### 2. MCP Memory Keeper

- **GitHub:** [mkreyman/mcp-memory-keeper](https://github.com/mkreyman/mcp-memory-keeper)
- **Tools:** 38 tools (configurable via profiles: minimal/8, standard/22, full/38)
- **Storage:** SQLite with channels (auto-derived from git branches), sessions, checkpoints, categories, priorities
- **Features:** Full-text search, batch operations, export/import, git integration, context relationship linking
- **vs. claude-baton:** More of a general-purpose "persistent memory database" than a session lifecycle manager. Very broad surface area. Less focused on the checkpoint/resume/handoff workflow.

### 3. Context Mode

- **GitHub:** [mksglu/context-mode](https://github.com/mksglu/context-mode)
- **Approach:** Intercepts tool calls, sandboxes raw output (claims 98% context window reduction)
- **Storage:** SQLite with FTS5/BM25 search
- **Features:** Tracks every file edit, git operation, task, and user decision. Automatically rebuilds state after compaction or `--continue`. Works with both Claude Code and Gemini CLI.
- **vs. claude-baton:** Focus is context window optimization + session continuity, not structured lifecycle management.

### 4. ContextStream

- **GitHub:** [contextstream/mcp-server](https://github.com/contextstream/mcp-server)
- **Approach:** Cloud-based (requires API key). 9 MCP tools: init, context, search, session, memory, graph, project, media, integration.
- **Features:** Semantic code indexing, knowledge graph, GitHub/Slack/Notion integration, cross-session learning.
- **vs. claude-baton:** Different positioning — cloud-hosted intelligence layer vs. local session management. Requires API key (violates claude-baton's zero-API-keys principle).

### 5. Smaller session continuity MCPs

Multiple smaller implementations on LobeHub and GitHub:
- `claude-session-continuity-mcp` by leesgit
- `mcp-session-continuity` by briannolan
- `mcp-claude-context-continuity` by tethiro

Generally simpler: save/load session state, maintain context across restarts. Less feature-rich than CONTINUITY or Memory Keeper.

---

## Other Tools & Products

### 1. Claude-Mem

- **GitHub:** [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Type:** Claude Code plugin (not MCP server). Published on npm.
- **Approach:** Automatic capture via lifecycle hooks (SessionStart, PostToolUse, Stop, SessionEnd).
- **Storage:** SQLite + Chroma vector database for hybrid semantic/keyword search.
- **Features:** AI-powered compression using Claude's agent-sdk. Progressive disclosure: lightweight indexes first, full details on demand (~10x token savings). Web viewer UI at localhost:37777.
- **vs. claude-baton:** Focus is automatic observation capture and retrieval, not structured checkpoints/handoffs.

### 2. Continuous Claude v3

- **GitHub:** [parcadei/Continuous-Claude-v3](https://github.com/parcadei/Continuous-Claude-v3)
- **Scale:** 109 skills, 32 agents, 30 hooks.
- **Storage:** PostgreSQL + pgvector backend, FAISS indexing.
- **Features:** YAML handoffs for token-efficient state transfer. Continuity ledgers in markdown. AST-based code analysis with 95% token savings (1,200 tokens vs 23,000 raw). Daemon-based learning extraction between sessions.
- **Philosophy:** "Compound, don't compact."
- **vs. claude-baton:** Much heavier — requires PostgreSQL, Python, multiple services. More of a full development platform than a lightweight session manager.

### 3. Claude Memory Skill

- **GitHub:** [SomeStay07/claude-memory-skill](https://github.com/SomeStay07/claude-memory-skill)
- **Approach:** Single .md file approach. Skills: `/memory update | prune | reflect | status`.
- **Features:** Zero dependencies. Learns from corrections, catches contradictions, cleans duplicates.
- **vs. claude-baton:** Minimal and lightweight, but no structured session lifecycle.

### 4. ClaudeFast Code Kit

- **Website:** [claudefa.st](https://claudefa.st)
- **Features:** ContextRecoveryHook — threshold-based backups at 30%, 15%, and 5% remaining context. Session lifecycle hooks for auto-loading context.
- **vs. claude-baton:** More of a hooks/recipes collection than a standalone product.

---

## Summary Comparison Matrix

| Product | Structured Checkpoints | Resume/Handoff | EOD Summaries | Slash Commands | Decision Log | Crash Recovery | Storage | Dependencies |
|---|---|---|---|---|---|---|---|---|
| **claude-baton** | Yes | Yes | Yes | Yes | No | No | SQLite (sql.js WASM) | 3 |
| **Claude Code native** | No | Partial (raw transcript) | No | N/A | No | No | SQLite | N/A |
| **CONTINUITY** | Yes | Yes | No | No | Yes | Yes | SQLite + JSONL + JSON | Unknown |
| **MCP Memory Keeper** | Yes | Partial | No | No | No | No | SQLite | Unknown |
| **Context Mode** | Partial | Yes | No | No | Yes | No | SQLite (FTS5) | Unknown |
| **ContextStream** | Partial | Yes | No | No | No | No | Cloud | Requires API key |
| **Claude-Mem** | No | Partial | No | No | No | No | SQLite + Chroma | Multiple |
| **Continuous Claude v3** | Yes | Yes | No | No | Yes | No | PostgreSQL + pgvector | Heavy |

---

## claude-baton's Differentiators

1. **EOD summaries** — no competitor found with this feature
2. **Slash commands** (`/memo-checkpoint`, `/memo-resume`, `/memo-eod`) integrated into user workflow
3. **PreCompact auto-checkpoint** via hooks — captures state before context is lost
4. **Lightweight** — 3 dependencies, single SQLite DB, pure WASM
5. **Zero API keys** — all LLM calls via `claude -p`
6. **No git branch manipulation** — safe for any workflow

## Risk Assessment

- Claude Code's native memory + hooks + session resume keeps getting better. The auto memory system and PreCompact hooks specifically enable the pattern claude-baton implements.
- Over time, Anthropic could build structured checkpoints natively, which would reduce demand for external tools.
- CONTINUITY is the strongest direct competitor — has decision logging and crash recovery that claude-baton lacks.
- The EOD summary and structured handoff workflow remain claude-baton's strongest unique value propositions.
