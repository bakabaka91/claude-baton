# memoria-solo

Persistent memory MCP server for Claude Code — cross-session knowledge via local SQLite.

memoria-solo gives Claude Code a memory that survives session restarts. It automatically extracts decisions, patterns, dead ends, and constraints from your conversations, stores them in a local SQLite database, and makes them available in future sessions.

## Features

- **Automatic extraction** — hook into Claude Code session events to extract memories from transcripts
- **16 MCP tools** — search, save, recall, checkpoint, insight, goal tracking, constraint management, dead end logging
- **RAG-style recall** — synthesized answers from stored memories via `claude -p`
- **Dead end tracking** — records failed approaches so they aren't retried
- **Constraints** — project rules that persist across sessions
- **Session lifecycle** — checkpoint/resume/insight/EOD summary
- **Consolidation** — automatic decay, deduplication, and LLM-assisted merging
- **CLAUDE.md sync** — managed block with constraints, dead ends, decisions, goals
- **Zero API keys** — all LLM calls via `claude -p` (uses your Claude subscription)
- **Cross-project** — single SQLite database tracks all your projects

## Install

```bash
npm install -g memoria-solo
```

## Setup

```bash
memoria-solo setup
```

This configures Claude Code hooks in `~/.claude/settings.json` and initializes the SQLite database at `~/.memoria-solo/store.db`.

## Usage

### As an MCP server

memoria-solo runs as a stdio MCP server. After `setup`, Claude Code automatically connects to it.

### MCP Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Search across all memory types |
| `memory_save` | Manually save a memory |
| `memory_recall` | RAG-style synthesized recall on a topic |
| `memory_stats` | Memory counts by type/project |
| `log_dead_end` | Record a failed approach |
| `check_dead_ends` | Check if an approach was already tried |
| `add_constraint` | Add a project rule/constraint |
| `get_constraints` | List active constraints |
| `set_goal` | Set current sprint/task goal |
| `get_goal` | Get active goal |
| `save_checkpoint` | Save session state before context loss |
| `get_checkpoint` | Retrieve latest checkpoint |
| `save_insight` | Capture a real-time insight |
| `daily_summary` | Generate EOD summary from day's activity |
| `consolidate` | Manually trigger memory merge/prune/decay |
| `sync_claude_md` | Manually refresh CLAUDE.md managed block |

### CLI Commands

```bash
memoria-solo status              # memory counts, last extraction, db size
memoria-solo search <query>      # search memories from terminal
memoria-solo projects            # list tracked projects
memoria-solo export [project]    # export as JSON
memoria-solo import <file>       # import from JSON
memoria-solo reset [project]     # clear memories (with confirmation)
```

### Hooks

After setup, these hooks run automatically:

- **Stop** — extracts memories from the session transcript
- **PreCompact** — auto-checkpoints before context compaction
- **SessionEnd** — final extraction + consolidation

## How it works

1. **Extraction** — When a Claude Code session ends, the hook reads the transcript, chunks it, and sends each chunk to `claude -p --model haiku` with a structured extraction prompt. Extracted items (memories, dead ends, constraints, insights) are stored in SQLite with deduplication.

2. **Recall** — When `memory_recall` is called, relevant memories are retrieved via text search, dead ends are filtered by Jaccard similarity, all constraints are included, and the bundle is sent to `claude -p` for synthesis.

3. **Consolidation** — Periodically, confidence decay reduces stale memory scores (progress: 7-day period, context: 30-day). Deduplication merges near-identical memories (Jaccard > 0.6). When memory count exceeds thresholds, LLM-assisted consolidation merges or prunes related items.

4. **CLAUDE.md sync** — A managed block is written to your project's CLAUDE.md with constraints first (things to avoid), then dead ends, key decisions, active goal, recent context, and last checkpoint.

## Data model

All data lives in `~/.memoria-solo/store.db`:

- **memories** — architecture, decision, pattern, gotcha, progress, context
- **dead_ends** — failed approaches with blockers and resume conditions
- **constraints** — project rules with type, severity, and scope
- **goals** — sprint/task goals with completion criteria
- **checkpoints** — session state snapshots for resumption
- **insights** — real-time observations categorized by type
- **daily_summaries** — LLM-generated EOD summaries
- **extraction_log** — tracking for transcript processing

## Comparison to memory-mcp

| Feature | memory-mcp | memoria-solo |
|---------|-----------|--------------|
| LLM engine | Anthropic API ($) | `claude -p` (free with subscription) |
| Dead end tracking | No | Yes |
| Constraints | No | Yes |
| Goals | No | Yes |
| Session lifecycle | No | Yes |
| Cross-project | No | Yes |
| Storage | JSON files | SQLite |
| CLAUDE.md ordering | By confidence | Constraints first |
| Daily summaries | No | Yes |
| API key required | Yes | No |

## Development

```bash
git clone https://github.com/yourusername/memoria-solo.git
cd memoria-solo
npm install
npm run build
npm test
npm run dev    # start MCP server for testing
```

## License

MIT
