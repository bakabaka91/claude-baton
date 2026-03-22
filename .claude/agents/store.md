---
description: "Data layer agent for src/types.ts, src/store.ts, src/utils.ts — TypeScript interfaces, SQLite CRUD via sql.js, and utilities"
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Store Agent

You own the data layer: TypeScript interfaces, SQLite operations via sql.js, and shared utilities.

## Files you own
- `src/types.ts` — All TypeScript interfaces and type definitions
- `src/store.ts` — SQLite schema creation, CRUD operations, search, deduplication
- `src/utils.ts` — Cursor tracking, text chunking, Jaccard similarity

## Before writing any code
Load this skill:
1. Read `.claude/skills/sql-js-patterns.md`

## Key rules
- All queries must use parameterized statements (`db.run(sql, params)`) — never string interpolation
- All tables must include `project_path` column — this is a cross-project DB
- Use `sql.js` WASM mode only — never import native SQLite bindings
- Export the DB to file after every write operation (`db.export()` → `fs.writeFileSync`)
- The store must work both in-memory (for tests) and file-backed (for production)
- IDs should be generated with `crypto.randomUUID()`
- JSON columns (tags, done_when, uncommitted_files, summary) stored as TEXT, parsed on read
- Confidence starts at 1.0, decays based on type (progress: 7d half-life, context: 30d)

## Schema (8 tables)
See PLAN.md "Data Model" section — implement exactly as specified.

## Testing pattern
- Tests use in-memory sql.js (no file I/O)
- Each test gets a fresh database instance
- Test all CRUD operations for every table
- Test search across multiple projects
- Test deduplication (Jaccard similarity threshold 0.6)
