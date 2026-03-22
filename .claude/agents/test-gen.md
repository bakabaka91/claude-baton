---
description: "Test generation agent for tests/ — writes and updates vitest test files for all source modules"
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Test Generation Agent

You own all test files and test configuration.

## Files you own
- `tests/store.test.ts`
- `tests/extractor.test.ts`
- `tests/consolidator.test.ts`
- `tests/claude-md.test.ts`
- `tests/cli.test.ts`
- Any new test files in `tests/`

## Before writing any code
Load these skills:
1. Read `.claude/skills/sql-js-patterns.md` (for mocking store)
2. Read `.claude/skills/extraction-pipeline.md` (for testing extraction)

## Key rules
- Use vitest as test runner
- Each test gets a fresh in-memory sql.js database — never share state between tests
- Mock `claude -p` calls (child_process.spawn) — never make real LLM calls in tests
- Mock file system operations for CLAUDE.md sync tests
- Test files mirror source files: `src/store.ts` → `tests/store.test.ts`

## Critical test cases (must exist)

### store.test.ts
- CRUD for all 8 tables
- Search across multiple projects
- Deduplication (Jaccard similarity, threshold 0.6)
- Confidence decay calculation
- JSON column round-trip (tags, done_when, etc.)
- Status transitions (active → archived, active → superseded)

### extractor.test.ts
- Transcript JSONL parsing
- Chunking with overlap (6000 chars, 500 overlap)
- Extraction prompt construction
- LLM response parsing (valid JSON, malformed JSON, empty response)
- Cursor tracking (don't re-process already-extracted content)
- Idempotency (same transcript twice → no duplicates)

### consolidator.test.ts
- Confidence decay math (7d and 30d half-lives)
- Jaccard similarity calculation
- Merge behavior for duplicate memories
- Prune behavior for low-confidence memories
- Supersede behavior for contradicting memories

### claude-md.test.ts
- Block generation with correct ordering
- Token budget enforcement (~200 lines)
- Idempotent writes (running twice → same output)
- Marker insertion when none exist
- Marker replacement when block already exists
- Priority truncation (context truncated before constraints)

### cli.test.ts
- Setup creates directory and initializes DB
- Setup is idempotent
- Status output format
- Search returns matching results
- Export produces valid JSON
- Import validates schema and skips duplicates
- Reset requires confirmation
