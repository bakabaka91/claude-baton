# claude-baton

Never lose context between Claude Code sessions again.

claude-baton is an MCP server that gives Claude Code session continuity. It saves checkpoints of your session state, auto-saves before context compaction, and restores full context when you start a new session.

## Workflow

```
/memo-resume → work → /memo-checkpoint → /compact or /clear → repeat
```

1. **Resume** — start a session with `/memo-resume` to pick up where you left off
2. **Work** — do your thing
3. **Checkpoint** — run `/memo-checkpoint` before `/compact` or `/clear` (or let the auto-checkpoint handle `/compact` for you)

## Install

```bash
npm install -g claude-baton
```

## Setup

```bash
claude-baton setup
```

This:
- Registers the MCP server in `~/.claude/settings.json`
- Registers the PreCompact hook for auto-checkpoint
- Initializes the SQLite database at `~/.claude-baton/store.db`
- Installs slash commands to `~/.claude/commands/`

## MCP Tools

| Tool | Description |
|------|-------------|
| `save_checkpoint` | Save session state (what was built, current state, next steps, git context) |
| `get_checkpoint` | Retrieve a checkpoint by ID, or the latest for the project |
| `list_checkpoints` | List all checkpoints for a date |
| `daily_summary` | Generate EOD summary from the day's checkpoints |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/memo-checkpoint` | Save session state with git context — safe to `/compact` or `/clear` after |
| `/memo-resume` | Restore context from last checkpoint at session start |
| `/memo-eod` | End-of-day summary combining git activity with stored data |

## Auto-checkpoint

A PreCompact hook automatically saves a checkpoint before Claude Code compacts context. This means you never lose session state during long conversations — it happens transparently.

## How it works

1. **Checkpoint** — `/memo-checkpoint` (or the MCP tool) captures what you built, current state, next steps, decisions, blockers, and git context. Stored in a local SQLite database.

2. **Auto-checkpoint** — Before context compaction, the PreCompact hook reads the conversation transcript, sends it to `claude -p --model haiku` to extract session state, and saves a checkpoint automatically.

3. **Resume** — `/memo-resume` fetches the latest checkpoint, compares git state, shows what changed since the checkpoint, and presents a structured handover briefing with actionable next steps.

4. **EOD Summary** — `/memo-eod` generates a daily summary from all checkpoints, combining what was built, decisions made, and blockers across sessions.

## CLI Commands

```bash
claude-baton status              # checkpoint counts, db size
claude-baton projects            # list tracked projects
claude-baton export [--project]  # export as JSON
claude-baton import <file>       # import from JSON
claude-baton reset [--project]   # clear data (with confirmation)
claude-baton uninstall           # remove hooks, commands, MCP server, and database
claude-baton uninstall --keep-data  # uninstall but preserve the database
```

## Uninstall

```bash
# Remove hooks, MCP server, slash commands, and database
claude-baton uninstall

# Remove the binary
npm uninstall -g claude-baton
```

To keep your data: `claude-baton uninstall --keep-data`

## Data model

All data lives in `~/.claude-baton/store.db`:

- **checkpoints** — session state snapshots (what was built, current state, next steps, decisions, blockers, git context)
- **daily_summaries** — LLM-generated EOD summaries

## Requirements

- Node.js >= 18
- Claude Code with a Claude subscription (for `claude -p` calls)
- No API keys needed

## Development

```bash
git clone https://github.com/bakabaka91/claude-baton.git
cd claude-baton
npm install
npm run build
npm test
```

## License

MIT
