# CLAUDE.md Managed Block Sync

## Block format

```markdown
<!-- MEMORIA:START -->
## Constraints
- [MUST] Never commit secrets to git (source: security audit)
- [SHOULD] Use parameterized queries (source: convention)

## Dead Ends
- Tried native sqlite3 bindings — failed on Windows ARM (2024-03-15)
- Redis caching abandoned — overkill for single-user (2024-03-16)

## Key Decisions
- SQLite via sql.js (WASM) for zero native deps
- stdio transport for standard MCP compatibility

## Active Goal
**Intent:** Ship v1.0 with all 16 MCP tools
- [ ] Store CRUD for all 8 tables
- [ ] MCP server with stdio transport
- [x] TypeScript types defined

## Recent Context
- Pattern: all store functions take db as first param (dependency injection for tests)
- Gotcha: sql.js stmt.free() required after every prepare()

## Last Checkpoint
- **Built:** Store layer with all 8 tables, types.ts complete
- **Next:** MCP server + tool definitions
- **Blockers:** None
<!-- MEMORIA:END -->
```

## Section ordering (mandatory — ADR-004)
1. Constraints (never truncated)
2. Dead Ends (never truncated)
3. Decisions
4. Active Goal
5. Recent Context
6. Last Checkpoint

## Token budget

~200 lines total. When over budget, truncate from the bottom up:
1. Truncate Last Checkpoint to 3 lines
2. Truncate Recent Context to 5 items
3. Truncate Decisions to 10 items
4. Never truncate Constraints or Dead Ends

## File detection

```typescript
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

function findClaudeMd(projectPath: string): string | null {
  let dir = projectPath;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'CLAUDE.md');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}
```

## Write logic

```typescript
function syncBlock(filePath: string, block: string): void {
  let content = readFileSync(filePath, 'utf-8');

  const startMarker = '<!-- MEMORIA:START -->';
  const endMarker = '<!-- MEMORIA:END -->';
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing block
    content =
      content.slice(0, startIdx) +
      startMarker +
      '\n' +
      block +
      '\n' +
      endMarker +
      content.slice(endIdx + endMarker.length);
  } else {
    // Append new block
    content += '\n\n' + startMarker + '\n' + block + '\n' + endMarker + '\n';
  }

  writeFileSync(filePath, content);
}
```

## Key rules
1. **Idempotent** — running sync twice produces identical output
2. **Never delete content outside markers** — only modify between MEMORIA:START and MEMORIA:END
3. **Constraints severity format:** `[MUST]`, `[SHOULD]`, `[PREFER]`
4. **Dead ends include date** — so agents know recency
5. **Goal uses checkbox format** — `[x]` done, `[ ]` pending
6. **If no CLAUDE.md exists** — create one with just the managed block
