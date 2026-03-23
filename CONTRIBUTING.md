# Contributing to memoria-solo

Thanks for your interest in contributing! Here's how to get started.

## Development setup

```bash
git clone https://github.com/bakabaka91/memoria-solo.git
cd memoria-solo
npm install
npm run build
npm test
```

## Project structure

- `src/index.ts` — MCP server entry, tool definitions
- `src/types.ts` — TypeScript interfaces
- `src/store.ts` — SQLite operations (CRUD, search, dedup)
- `src/extractor.ts` — Hook handler: transcript to memories
- `src/consolidator.ts` — Merge/prune/decay logic
- `src/claude-md.ts` — CLAUDE.md managed block sync
- `src/llm.ts` — `claude -p` wrapper
- `src/cli.ts` — CLI commands and setup
- `src/utils.ts` — Cursor tracking, chunking, similarity
- `prompts/` — Extraction, consolidation, recall templates
- `commands/` — Slash command files
- `tests/` — Test suite (vitest)

## Making changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run build` to check for type errors
4. Run `npm test` to ensure all 181+ tests pass
5. Open a pull request

## Constraints

These are non-negotiable project rules:

- **4 dependencies max** — `@modelcontextprotocol/sdk`, `sql.js`, `zod`, `commander`
- **No API keys** — all LLM calls via `claude -p`
- **sql.js only** — no native SQLite bindings
- **stdio transport** — standard MCP, not SSE
- **Single SQLite DB** — `~/.memoria-solo/store.db`, never per-project files

## Reporting bugs

Open an issue at https://github.com/bakabaka91/memoria-solo/issues with:

- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

## Code style

- TypeScript with strict mode
- ES modules (`import`/`export`)
- Keep functions focused and small
- Add tests for new functionality
