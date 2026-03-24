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

<!-- MEMORIA:START -->
## Dead Ends
- Global install from GitHub failed with stale symlink and prepare script errors — Previous `npm link` left a stale symlink; `prepare` script uses bare `tsc` instead of `npx tsc`, breaking build during global install from git (2026-03-24)

## Key Decisions
- memoria-solo uses automated GitHub Actions CI/CD with gated merges: all checks (build/test/lint) must pass, 1 approval required, no force pushes allowed
- Made memoria-solo repo public to enable GitHub branch protection (was previously private)
- memoria-solo should be published to npm for normal usage; GitHub installs are a secondary developer workflow. The `prepare` script is designed for `npm publish` (to build before packaging), not for end-user GitHub installs.

## Recent Context
- pattern: Contributor workflow: fork → branch → code → build/test/lint locally → PR → CI gates → admin review → admin merge → admin releases to npm
- gotcha: `git log --oneline -10` captures the last 10 commits from repo history, not session-scoped commits. If a session has >10 commits, older ones are cut off; if session has <10 commits, unrelated historical commits are included.
- gotcha: Test suite mocks readFileSync globally; code reading package.json for runtime version needs special mock handling to return actual content instead of undefined
- gotcha: The `prepare` script in package.json runs during `npm install -g` from GitHub, but devDependencies like TypeScript aren't available in the PATH yet. Bare `tsc` fails; must use `npx tsc` or guard the script.
- architecture: The memo-resume command fetches the latest checkpoint by timestamp, regardless of how old it is. The git_snapshot is stored inside the checkpoint data itself, so it comes along when the checkpoint is retrieved.
- architecture: CONTRIBUTING.md and PR template document contributor rules, build/test/format requirements, and agent routing constraints
- architecture: Project is properly configured for npm publishing with `files`, `bin`, `main`, `types`, `engines`, `repository`, and `license` fields in package.json. Publishing workflow: authenticate with `npm login`, build with `npm run build`, bump version, run `npm publish`.
- architecture: Memory extraction system has dual-stage deduplication: extraction-time (Jaccard similarity >= 0.6) and consolidation-time. Extraction-time dedup prevents items from being stored, so consolidation-time dedup never sees them.
<!-- MEMORIA:END -->
