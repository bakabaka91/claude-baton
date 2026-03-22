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
- `src/cli.ts` — CLI commands (setup, status, search, export, import, reset)
- `src/utils.ts` — Cursor tracking, chunking, similarity
- `prompts/` — Extraction, consolidation, recall prompt templates
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
| CLI commands, bin entry point | `cli` | `src/cli.ts`, `bin/` |
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

## Current state
Phase 1 not started. Only PLAN.md exists.
