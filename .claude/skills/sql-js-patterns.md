# sql.js Patterns for memoria-solo

## Initialization

```typescript
import initSqlJs, { Database } from 'sql.js';

// Initialize WASM — must be called once before creating any database
const SQL = await initSqlJs();

// In-memory database (for tests)
const db = new SQL.Database();

// File-backed database (for production)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

const dbPath = path.join(os.homedir(), '.memoria-solo', 'store.db');
let db: Database;

if (existsSync(dbPath)) {
  const buffer = readFileSync(dbPath);
  db = new SQL.Database(buffer);
} else {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new SQL.Database();
}
```

## Saving to disk

sql.js operates in-memory. You must explicitly save after writes:

```typescript
function save(db: Database, dbPath: string): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);
}
```

Call `save()` after every INSERT, UPDATE, DELETE. Not after SELECTs.

## Query patterns

```typescript
// Parameterized query (ALWAYS use this — never string interpolation)
db.run(
  "INSERT INTO memories (id, project_path, content) VALUES (?, ?, ?)",
  [id, projectPath, content]
);

// SELECT returning rows
const stmt = db.prepare(
  "SELECT * FROM memories WHERE project_path = ? AND type = ?"
);
stmt.bind([projectPath, type]);
const results: Memory[] = [];
while (stmt.step()) {
  results.push(stmt.getAsObject() as Memory);
}
stmt.free(); // IMPORTANT: always free prepared statements

// Single row
const stmt = db.prepare("SELECT * FROM memories WHERE id = ?");
stmt.bind([id]);
const row = stmt.step() ? stmt.getAsObject() : null;
stmt.free();

// db.exec() for DDL (schema creation) — returns void
db.exec(`CREATE TABLE IF NOT EXISTS memories (...)`);

// db.run() for DML (INSERT/UPDATE/DELETE) — returns void
db.run("DELETE FROM memories WHERE id = ?", [id]);
```

## JSON columns

SQLite stores JSON as TEXT. Parse on read, stringify on write:

```typescript
// Write
db.run(
  "INSERT INTO goals (id, done_when) VALUES (?, ?)",
  [id, JSON.stringify(doneWhen)]
);

// Read
const row = stmt.getAsObject();
const goal = { ...row, done_when: JSON.parse(row.done_when as string) };
```

## Full-text search

sql.js supports FTS5 virtual tables:

```typescript
// Create FTS table alongside the main table
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(content, tags)
`);

// Populate FTS on insert (keep in sync manually)
db.run(
  "INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)",
  [rowid, content, tagsString]
);

// Search
const stmt = db.prepare(
  "SELECT m.* FROM memories m JOIN memories_fts f ON m.rowid = f.rowid WHERE memories_fts MATCH ?"
);
stmt.bind([query]);
```

## Schema creation pattern

Run all CREATE TABLE IF NOT EXISTS in a single exec call on initialization:

```typescript
function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('architecture','decision','pattern','gotcha','progress','context')),
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      confidence REAL DEFAULT 1.0,
      access_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','archived','superseded')),
      supersedes_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_path);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);

    -- repeat for all 8 tables per PLAN.md data model
  `);
}
```

## Common pitfalls
1. **Forgetting stmt.free()** — causes memory leaks in WASM
2. **Not saving after writes** — data lost on process exit
3. **String interpolation in queries** — SQL injection risk
4. **Not handling null** — sql.js returns `null` for NULL columns, not `undefined`
5. **Datetime** — use `datetime('now')` in SQL or `new Date().toISOString()` in TypeScript
6. **WASM init is async** — `initSqlJs()` returns a Promise, must await before creating Database
