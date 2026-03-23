# memoria-solo — Development Guide

## What is this?
Open-source MCP server for Claude Code — persistent memory across sessions using local SQLite. See PLAN.md for full spec.

## Quick start
```bash
npm install
npm run build        # compile TypeScript
npm test             # run tests
npm run dev          # start MCP server (stdio)
```

## Project structure
- `src/index.ts` — MCP server entry, tool definitions
- `src/types.ts` — TypeScript interfaces for all data models
- `src/store.ts` — SQLite operations via sql.js (CRUD, search, dedup)
- `src/extractor.ts` — Hook handler: transcript → memories
- `src/consolidator.ts` — Merge/prune/decay logic
- `src/claude-md.ts` — CLAUDE.md managed block sync
- `src/llm.ts` — claude -p wrapper
- `src/cli.ts` — CLI commands (setup, status, search, export, import, reset) + command installer
- `src/utils.ts` — Cursor tracking, chunking, similarity
- `prompts/` — Extraction, consolidation, recall prompt templates
- `commands/` — Slash command files (memo-checkpoint, memo-resume, memo-insight, memo-eod)
- `tests/` — Test suite
- `bin/memoria-solo.js` — CLI entry point

## Non-negotiable constraints
1. **Never touch git branches** — no snapshots, no switching, no creating branches
2. **Single SQLite DB** — all projects in `~/.memoria-solo/store.db`, never per-project files
3. **stdio transport** — standard MCP, not SSE
4. **Zero API keys** — all LLM calls via `claude -p`, never import anthropic SDK
5. **4 dependencies max** — `@modelcontextprotocol/sdk`, `sql.js`, `zod`, `commander`
6. **CLAUDE.md ordering** — constraints → dead ends → decisions → goal → context → checkpoint
7. **sql.js pure WASM** — no native SQLite bindings, no better-sqlite3, no node-sqlite3
8. **~200 line token budget** for managed CLAUDE.md block

## Agent routing (mandatory)

When working on code, use the scoped agent for that domain. Never let one agent touch another's files.

| Work being done | Agent | Files owned |
|---|---|---|
| Data types, SQLite operations, utilities | `store` | `src/types.ts`, `src/store.ts`, `src/utils.ts` |
| MCP server, tool definitions, claude -p wrapper | `server` | `src/index.ts`, `src/llm.ts` |
| Extraction, consolidation, CLAUDE.md sync, prompts | `pipeline` | `src/extractor.ts`, `src/consolidator.ts`, `src/claude-md.ts`, `prompts/` |
| CLI commands, bin entry point, slash commands | `cli` | `src/cli.ts`, `bin/`, `commands/` |
| Writing or updating tests | `test-gen` | `tests/` |

**Rules:**
- Every agent must load its required skills before writing code (listed in each agent's .md)
- After any agent writes code: run `/build` and `/test` in the main conversation
- Never trust agent output without verification — always run tests yourself

## Available commands

| Command | Purpose |
|---|---|
| `/build` | Compile TypeScript |
| `/test` | Run test suite |
| `/lint` | Run ESLint + Prettier check |
| `/dev` | Start MCP server in dev mode |
| `/plan [description]` | Create implementation plan (no coding) |
| `/pr` | Pre-flight, test, lint, create PR |
| `/verify` | Run acceptance checklist from PLAN.md |

## Slash commands (shipped with product)

Installed to `~/.claude/commands/` during `memoria-solo setup`.

| Command | Purpose |
|---|---|
| `/memo-checkpoint` | Save session state with git context before /compact or /clear |
| `/memo-resume` | Restore context from last checkpoint at session start |
| `/memo-insight <text>` | Capture a real-time insight with auto-categorization |
| `/memo-eod` | End-of-day summary combining git activity with stored data |

## Releasing & versioning

- **Version source of truth**: `package.json` only. The CLI reads it at runtime — never hardcode versions elsewhere.
- **npm published**: package is `memoria-solo` on npmjs.com, owned by `santoshus`.

**To release a new version:**
```bash
npm version patch     # or minor/major — bumps package.json, commits, tags
npm publish           # publishes to npm registry
git push && git push --tags   # push commit + tag to GitHub
```

**Rules:**
- Always run `/build` and `/test` before publishing
- Never publish with failing tests
- The `prepare` script runs `tsc` automatically before `npm publish`
- Use `npm version` to bump — never edit version in package.json manually

## Current state
All phases complete. 18 MCP tools, 4 slash commands, 286 tests passing. Published on npm.
