<p align="center">
  <h1 align="center">🎭 claude-baton</h1>
  <p align="center"><strong>Never lose context between Claude Code sessions again.</strong></p>
  <p align="center">
    <a href="https://www.npmjs.com/package/claude-baton"><img src="https://img.shields.io/npm/v/claude-baton.svg" alt="npm version"></a>
    <a href="https://github.com/bakabaka91/claude-baton/actions/workflows/ci.yml"><img src="https://github.com/bakabaka91/claude-baton/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
    <a href="https://www.npmjs.com/package/claude-baton"><img src="https://img.shields.io/npm/dm/claude-baton.svg" alt="npm downloads"></a>
  </p>
</p>

---

## 😤 The Problem

You're deep in a Claude Code session — 45 minutes in, multiple files changed, complex decisions made. Then:

- Context gets compacted and Claude forgets what it was doing
- You `/clear` or start a new session and lose everything
- You spend 10 minutes re-explaining where you left off
- Claude makes the same wrong decisions you already corrected

**Sound familiar?**

## ✨ The Solution

claude-baton gives Claude Code **persistent memory across sessions**. It automatically saves what was built, what's next, and why — then restores it perfectly when you come back.

```
Session 1                          Session 2
┌─────────────────────┐            ┌─────────────────────┐
│  Work on features   │            │  /memo-resume       │
│  Make decisions      │            │  ↓                  │
│  Hit blockers       │            │  Full context restored│
│  ...context compacts │──💾──→    │  Decisions preserved │
│  (auto-saved!)      │   DB      │  Next steps ready    │
└─────────────────────┘            │  Git diff shown      │
                                   │  Ready to continue!  │
                                   └─────────────────────┘
```

## 🎯 What You Get

- **🔄 Seamless resume** — Start any session with `/memo-resume` and pick up exactly where you left off
- **💾 Auto-checkpoint** — PreCompact hook saves your session state *before* Claude compacts context. You never have to remember.
- **📊 Diff intelligence** — Resume shows what changed since your last session (new commits, modified files, dependency changes)
- **🧠 Decision memory** — Key decisions and their reasoning survive across sessions
- **📋 EOD summaries** — Generate end-of-day reports from all sessions with `/memo-eod`
- **🔒 Fully local** — All data in a local SQLite database. No cloud, no API keys, no data leaves your machine.

## 🏗️ Claude Code vs Claude Code + Baton

Claude Code is powerful, but it has structural limitations around context persistence. Here's what changes with claude-baton:

| Scenario | Claude Code alone | Claude Code + Baton |
|----------|-------------------|---------------------|
| **Context compaction** | 🔴 Claude silently loses session state. After compaction, it may forget decisions, repeat mistakes, or restart work already done. | 🟢 PreCompact hook auto-saves a structured checkpoint *before* compaction. Claude resumes with full context. |
| **New session** | 🔴 Blank slate. You re-explain everything from scratch. Claude has to re-read files and rediscover project state. | 🟢 `/memo-resume` loads the last checkpoint with what was built, decisions, blockers, next steps, and git diff since then. |
| **Decision persistence** | 🔴 "We decided not to use Redux because..." — gone after `/clear`. Claude may suggest Redux again next session. | 🟢 Decisions and their reasoning are stored in checkpoints and surfaced on resume. |
| **Long-running tasks** | 🔴 Multi-session tasks lose continuity. Each session starts from zero context. | 🟢 Chained checkpoints maintain a thread across sessions. Each auto-checkpoint includes the previous one for continuity. |
| **Team handover** | 🔴 No way to export what Claude was doing. Knowledge lives only in the conversation. | 🟢 `claude-baton export` produces JSON. `/memo-eod` generates daily summaries of all sessions. |
| **Git awareness** | 🟡 Claude can run git commands but doesn't automatically know what changed since last session. | 🟢 Resume computes git diff since checkpoint — shows new commits, modified files, dependency changes. |

### 🧱 The Moat: What Claude Code Can't Do Natively

Claude Code has no **persistent structured memory** across sessions. This is the fundamental gap:

1. **No session state survives `/compact` or `/clear`** — Claude Code's context window is ephemeral. When it compacts, the nuanced understanding of *why* you made decisions, *what* you tried and rejected, and *where* you were headed is lost. CLAUDE.md can store project rules, but not dynamic session state.

2. **No automatic preservation** — There's no built-in mechanism to save state before compaction. You'd have to manually write notes every time, which you won't.

3. **No structured handover** — Even if you paste notes into a new session, Claude has to parse free-text. claude-baton provides structured data (what was built, current state, next steps, decisions, blockers, git context) that Claude can act on immediately.

4. **No cross-session diff intelligence** — Claude Code can't tell you "3 files changed and 2 new commits landed since your last session." claude-baton compares checkpoint state against current git state and surfaces the delta.

5. **No session history** — There's no way to look back at what you accomplished across multiple sessions in a day. claude-baton's `/memo-eod` synthesizes all checkpoints into a daily summary.

claude-baton fills these gaps by sitting alongside Claude Code as an MCP server — it doesn't replace anything, it adds the persistence layer that's missing.

## 🚀 Quick Start

Two commands. That's it.

```bash
npm install -g claude-baton
claude-baton setup
```

Start a new Claude Code session and you're ready to go:

```
You: /memo-checkpoint     ← saves session state
You: /compact             ← safe, state is preserved
You: /memo-resume         ← restores everything
```

## 📸 What It Looks Like

### `/memo-resume` — Session handover briefing

```
## Session Resume — my-project — 2026-03-25

Resuming from checkpoint: 2026-03-25T15:26:07Z
Source: auto checkpoint

### Branch
main — currently on main

### Where We Left Off
v2.1.1 published on npm. Build clean. All tests passing.

### What Was Built (Last Session)
Implemented auto-checkpoint chaining with git diff context,
switched LLM from haiku to sonnet for better summarization quality.

### Decisions Made
Used claude mcp add for server registration instead of manual config.
Added source field (manual/auto) to distinguish checkpoint types.

### Next Steps
1. Test /memo-resume in a fresh session
2. Verify auto-checkpoint fires on context compaction

### Changes Since Checkpoint
No changes since checkpoint — clean working tree, HEAD at 795f9aa.

### Commits From Last Session
795f9aa 2.1.1
108b65e feat: switch LLM calls from haiku to sonnet
fe5dae0 docs: fix README to reflect claude mcp add registration
```

### `/memo-eod` — End-of-day summary

```
## EOD Summary — my-project — 2026-03-25

### What Was Built / Shipped
feat: auto-checkpoint chaining and resume resilience
feat: allowed tools for frictionless slash commands
fix: MCP server registration via claude mcp add

### Decisions Made
- Used claude mcp add for correct MCP discovery
- Chained auto-checkpoints with previous context + git diff

### Git Stats
- Commits today: 12
- Files changed: 15
- Feature areas: feat, fix, docs, style, chore
```

## 🔧 How It Works

```
┌──────────────────────────────────────────────────────────┐
│                    Claude Code Session                     │
│                                                           │
│  /memo-resume ←── reads latest checkpoint from DB         │
│       ↓                                                   │
│  You work normally                                        │
│       ↓                                                   │
│  /memo-checkpoint ──→ saves state + git context to DB     │
│       ↓                                                   │
│  /compact or /clear (safe!)                               │
│                                                           │
│  ┌─────────────────────────────────────────────┐         │
│  │ 🪝 PreCompact Hook (automatic)              │         │
│  │                                              │         │
│  │ Context about to compact?                    │         │
│  │   → Read conversation transcript             │         │
│  │   → Fetch previous checkpoint for chaining   │         │
│  │   → Extract state via claude -p --model sonnet│        │
│  │   → Save auto-checkpoint to DB               │         │
│  └─────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────┘
                          ↕
                 ~/.claude-baton/store.db
                    (local SQLite)
```

### The checkpoint lifecycle

1. **💾 Checkpoint** — Captures what you built, current state, next steps, decisions, blockers, and git context (branch, uncommitted files, recent commits)

2. **🪝 Auto-checkpoint** — Before context compaction, the PreCompact hook reads the transcript, fetches the previous checkpoint for continuity, and uses `claude -p --model sonnet` to extract a structured checkpoint automatically

3. **🔄 Resume** — Fetches the latest checkpoint, compares current git state vs checkpoint state, computes what changed (new commits, file diffs, dependency changes), and presents a structured handover briefing

4. **📊 EOD Summary** — Synthesizes all checkpoints from the day into a daily summary: what was built, decisions made, blockers, and next steps

## 📋 Slash Commands

| Command | Description |
|---------|-------------|
| `/memo-resume` | 🔄 Restore context from last checkpoint — run this at session start |
| `/memo-checkpoint` | 💾 Save session state with git context — safe to `/compact` after |
| `/memo-eod` | 📊 End-of-day summary combining all sessions |

## 🛠️ CLI Commands

```bash
claude-baton setup               # 🔧 one-time setup (MCP, hooks, commands)
claude-baton status              # 📊 checkpoint counts, db size
claude-baton projects            # 📁 list tracked projects
claude-baton export [--project]  # 📤 export as JSON
claude-baton import <file>       # 📥 import from JSON
claude-baton reset [--project]   # 🗑️  clear data (with confirmation)
claude-baton uninstall           # ❌ remove everything cleanly
claude-baton uninstall --keep-data  # ❌ uninstall but preserve your data
```

## 🔌 MCP Tools

For automation and advanced use cases, claude-baton exposes 4 MCP tools:

| Tool | Description |
|------|-------------|
| `save_checkpoint` | Save session state (what was built, current state, next steps, git context) |
| `get_checkpoint` | Retrieve a checkpoint by ID, or the latest for the project |
| `list_checkpoints` | List all checkpoints for a date |
| `daily_summary` | Generate EOD summary from the day's checkpoints |

## 🤔 Why Not Just...

| Alternative | Limitation |
|-------------|------------|
| **Manual notes** | You have to remember to write them. You won't. |
| **CLAUDE.md** | Great for project rules, not for session state that changes every hour |
| **TodoWrite** | Tracks tasks, not context. Doesn't capture decisions, blockers, or git state |
| **Just re-explain** | Wastes 5-10 minutes per session. Loses decision reasoning. |
| **Git commit messages** | Captures *what* changed, not *why* or *what's next* |

claude-baton captures the **full session context** — what was built, why decisions were made, what's blocked, and what to do next — automatically.

## 📦 What Setup Does

`claude-baton setup` is a single command that configures everything:

```
✓ Registered MCP server (user scope — works across all projects)
✓ Registered PreCompact hook for auto-checkpoint
✓ Registered allowed tools (slash commands run without prompts)
✓ Initialized database at ~/.claude-baton/store.db
✓ Installed slash commands to ~/.claude/commands/
```

## 🗄️ Data Model

All data lives locally in `~/.claude-baton/store.db`:

- **checkpoints** — session state snapshots with git context, source tracking (`manual` | `auto`)
- **daily_summaries** — LLM-generated EOD summaries

No data leaves your machine. No cloud. No API keys. LLM calls use your existing `claude -p` subscription.

## 📋 Requirements

- **Node.js** >= 18
- **Claude Code CLI** installed and authenticated
- **No API keys needed** — all LLM calls use `claude -p` (your existing subscription)

## 🧑‍💻 Development

```bash
git clone https://github.com/bakabaka91/claude-baton.git
cd claude-baton
npm install
npm run build
npm test            # 97 tests
```

## 🗑️ Uninstall

Clean removal — no traces left behind:

```bash
claude-baton uninstall        # removes hooks, MCP server, commands, and database
npm uninstall -g claude-baton # removes the binary
```

To keep your checkpoint data: `claude-baton uninstall --keep-data`

## 📄 License

MIT

---

<p align="center">
  <strong>Built for developers who are tired of re-explaining context to Claude.</strong><br>
  <a href="https://www.npmjs.com/package/claude-baton">npm</a> · <a href="https://github.com/bakabaka91/claude-baton/issues">Issues</a> · <a href="https://github.com/bakabaka91/claude-baton/blob/main/CONTRIBUTING.md">Contributing</a>
</p>
