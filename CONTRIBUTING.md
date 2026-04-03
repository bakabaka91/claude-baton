# Contributing to claude-baton

Thanks for your interest in contributing! Here's how to get started.

## Development setup

```bash
git clone https://github.com/bakabaka91/claude-baton.git
cd claude-baton
npm install
npm run build
npm test
```

## Development workflow

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run all checks before pushing:
   ```bash
   npm run build          # must compile
   npm test               # must pass
   npm run format:check   # must pass
   ```
4. Open a pull request against `main`
5. CI will run automatically — build, test, and format checks must all pass
6. Wait for review from a maintainer

## Constraints

These are non-negotiable project rules:

- **3 dependencies max** — `@modelcontextprotocol/sdk`, `sql.js`, `commander`
- **No API keys** — all LLM calls via `claude -p`
- **sql.js only** — no native SQLite bindings
- **stdio transport** — standard MCP, not SSE
- **Single SQLite DB** — `~/.claude-baton/store.db`, never per-project files

## Code style

- TypeScript with strict mode
- ES modules (`import`/`export`)
- Format with Prettier: `npm run format`
- No hardcoded versions — the CLI reads from `package.json` at runtime
- Add tests for new functionality

## Reporting bugs

Open an issue at https://github.com/bakabaka91/claude-baton/issues with:

- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

## Releases

Only maintainers publish to npm. Contributors should not bump versions.
