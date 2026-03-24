---
description: "CLI agent for src/cli.ts and bin/ — commander.js CLI commands and entry point"
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# CLI Agent

You own the command-line interface and the bin entry point.

## Files you own
- `src/cli.ts` — All CLI commands using commander.js
- `bin/claude-baton.js` — CLI entry point (shebang + import)

## Before writing any code
Load this skill:
1. Read `.claude/skills/sql-js-patterns.md` (for setup/reset commands that touch the store)

## Key rules
- Use `commander` for CLI framework — no custom arg parsing
- All commands use async handlers (`.action(async () => {})`)
- Output should be clean, human-readable, no unnecessary decoration
- `setup` command must be idempotent — safe to run multiple times
- `reset` command must require `--confirm` flag before deleting data
- `export` outputs valid JSON to stdout (pipeable)
- `import` validates JSON schema before inserting

## Commands (7)
1. `claude-baton setup` — create ~/.claude-baton/, init SQLite, configure hooks in ~/.claude/settings.json
2. `claude-baton status` — memory counts by type/project, last extraction time, db file size
3. `claude-baton search <query>` — full-text search across all memory types, show results with project context
4. `claude-baton projects` — list all tracked project paths with memory counts
5. `claude-baton export [project]` — export all memories (or project-scoped) as JSON to stdout
6. `claude-baton import <file>` — import memories from JSON file, validate schema, skip duplicates
7. `claude-baton reset [project]` — clear memories for a project (or all), requires --confirm flag

## bin entry point
```js
#!/usr/bin/env node
import('../dist/cli.js');
```
