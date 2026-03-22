import initSqlJs, { type Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type {
  Memory,
  MemoryType,
  MemoryStatus,
  DeadEnd,
  Constraint,
  ConstraintType,
  ConstraintSeverity,
  Goal,
  GoalStatus,
  Checkpoint,
  Insight,
  InsightCategory,
  DailySummary,
  ExtractionLog,
} from "./types.js";

// --- Database lifecycle ---

export async function initDatabase(dbPath?: string): Promise<Database> {
  const SQL = await initSqlJs();
  let db: Database;

  if (dbPath && existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    if (dbPath) {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    db = new SQL.Database();
  }

  initSchema(db);
  if (dbPath) saveDatabase(db, dbPath);
  return db;
}

export function saveDatabase(db: Database, dbPath: string): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);
}

export function getDefaultDbPath(): string {
  return path.join(os.homedir(), ".memoria-solo", "store.db");
}

export function initSchema(db: Database): void {
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

    CREATE TABLE IF NOT EXISTS dead_ends (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      summary TEXT NOT NULL,
      approach_tried TEXT NOT NULL,
      blocker TEXT NOT NULL,
      resume_when TEXT,
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dead_ends_project ON dead_ends(project_path);

    CREATE TABLE IF NOT EXISTS constraints (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      rule TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('security','performance','compliance','convention')),
      severity TEXT NOT NULL CHECK(severity IN ('must','should','prefer')),
      scope TEXT,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_constraints_project ON constraints(project_path);

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      intent TEXT NOT NULL,
      done_when TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','paused')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_path);
    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      branch TEXT,
      current_state TEXT NOT NULL,
      what_was_built TEXT NOT NULL,
      next_steps TEXT NOT NULL,
      decisions_made TEXT,
      blockers TEXT,
      uncommitted_files TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(project_path);

    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT,
      category TEXT NOT NULL CHECK(category IN ('decision','workflow','architecture','surprise','cost')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_insights_project ON insights(project_path);

    CREATE TABLE IF NOT EXISTS daily_summaries (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      date TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_daily_summaries_project ON daily_summaries(project_path);
    CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_summaries_project_date ON daily_summaries(project_path, date);

    CREATE TABLE IF NOT EXISTS extraction_log (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      chunks_processed INTEGER DEFAULT 0,
      memories_extracted INTEGER DEFAULT 0,
      bytes_processed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_extraction_log_project ON extraction_log(project_path);
    CREATE INDEX IF NOT EXISTS idx_extraction_log_session ON extraction_log(session_id);
  `);
}

// --- Memories CRUD ---

export function insertMemory(
  db: Database,
  projectPath: string,
  type: MemoryType,
  content: string,
  tags: string[] = [],
  confidence: number = 1.0,
  dbPath?: string,
  supersedesId?: string,
): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO memories (id, project_path, type, content, tags, confidence, access_count, status, supersedes_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`,
    [
      id,
      projectPath,
      type,
      content,
      JSON.stringify(tags),
      confidence,
      supersedesId ?? null,
      now,
      now,
    ],
  );
  if (dbPath) saveDatabase(db, dbPath);
  return id;
}

export function getMemory(db: Database, id: string): Memory | null {
  const stmt = db.prepare("SELECT * FROM memories WHERE id = ?");
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return parseMemoryRow(row);
}

export function getMemoriesByProject(
  db: Database,
  projectPath: string,
  type?: MemoryType,
  status?: MemoryStatus,
): Memory[] {
  let sql = "SELECT * FROM memories WHERE project_path = ?";
  const params: unknown[] = [projectPath];
  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC";
  return queryMemories(db, sql, params);
}

export function updateMemoryStatus(
  db: Database,
  id: string,
  status: MemoryStatus,
  dbPath?: string,
): void {
  db.run("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?", [
    status,
    new Date().toISOString(),
    id,
  ]);
  if (dbPath) saveDatabase(db, dbPath);
}

export function updateMemoryConfidence(
  db: Database,
  id: string,
  confidence: number,
  dbPath?: string,
): void {
  db.run("UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?", [
    confidence,
    new Date().toISOString(),
    id,
  ]);
  if (dbPath) saveDatabase(db, dbPath);
}

export function incrementAccessCount(
  db: Database,
  id: string,
  dbPath?: string,
): void {
  db.run(
    "UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?",
    [new Date().toISOString(), id],
  );
  if (dbPath) saveDatabase(db, dbPath);
}

export function deleteMemory(db: Database, id: string, dbPath?: string): void {
  db.run("DELETE FROM memories WHERE id = ?", [id]);
  if (dbPath) saveDatabase(db, dbPath);
}

function queryMemories(db: Database, sql: string, params: unknown[]): Memory[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: Memory[] = [];
  while (stmt.step()) {
    results.push(parseMemoryRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

function parseMemoryRow(row: Record<string, unknown>): Memory {
  return {
    ...row,
    tags: JSON.parse(row.tags as string),
    confidence: row.confidence as number,
    access_count: row.access_count as number,
  } as Memory;
}

// --- Dead Ends CRUD ---

export function insertDeadEnd(
  db: Database,
  projectPath: string,
  summary: string,
  approachTried: string,
  blocker: string,
  resumeWhen?: string,
  dbPath?: string,
): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO dead_ends (id, project_path, summary, approach_tried, blocker, resume_when, resolved, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      id,
      projectPath,
      summary,
      approachTried,
      blocker,
      resumeWhen ?? null,
      new Date().toISOString(),
    ],
  );
  if (dbPath) saveDatabase(db, dbPath);
  return id;
}

export function getDeadEnd(db: Database, id: string): DeadEnd | null {
  const stmt = db.prepare("SELECT * FROM dead_ends WHERE id = ?");
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return parseDeadEndRow(row);
}

export function getDeadEndsByProject(
  db: Database,
  projectPath: string,
): DeadEnd[] {
  const stmt = db.prepare(
    "SELECT * FROM dead_ends WHERE project_path = ? ORDER BY created_at DESC",
  );
  stmt.bind([projectPath]);
  const results: DeadEnd[] = [];
  while (stmt.step()) {
    results.push(parseDeadEndRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function resolveDeadEnd(
  db: Database,
  id: string,
  dbPath?: string,
): void {
  db.run("UPDATE dead_ends SET resolved = 1 WHERE id = ?", [id]);
  if (dbPath) saveDatabase(db, dbPath);
}

function parseDeadEndRow(row: Record<string, unknown>): DeadEnd {
  return { ...row, resolved: Boolean(row.resolved) } as DeadEnd;
}

// --- Constraints CRUD ---

export function insertConstraint(
  db: Database,
  projectPath: string,
  rule: string,
  type: ConstraintType,
  severity: ConstraintSeverity,
  scope?: string,
  source?: string,
  dbPath?: string,
): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO constraints (id, project_path, rule, type, severity, scope, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectPath,
      rule,
      type,
      severity,
      scope ?? null,
      source ?? null,
      new Date().toISOString(),
    ],
  );
  if (dbPath) saveDatabase(db, dbPath);
  return id;
}

export function getConstraint(db: Database, id: string): Constraint | null {
  const stmt = db.prepare("SELECT * FROM constraints WHERE id = ?");
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return parseConstraintRow(row);
}

export function getConstraintsByProject(
  db: Database,
  projectPath: string,
): Constraint[] {
  const stmt = db.prepare(
    "SELECT * FROM constraints WHERE project_path = ? ORDER BY severity, created_at DESC",
  );
  stmt.bind([projectPath]);
  const results: Constraint[] = [];
  while (stmt.step()) {
    results.push(parseConstraintRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

function parseConstraintRow(row: Record<string, unknown>): Constraint {
  return {
    id: row.id as string,
    project_path: row.project_path as string,
    rule: row.rule as string,
    type: row.type as ConstraintType,
    severity: row.severity as ConstraintSeverity,
    scope: (row.scope as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

// --- Goals CRUD ---

export function insertGoal(
  db: Database,
  projectPath: string,
  intent: string,
  doneWhen: string[],
  dbPath?: string,
): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO goals (id, project_path, intent, done_when, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [id, projectPath, intent, JSON.stringify(doneWhen), now, now],
  );
  if (dbPath) saveDatabase(db, dbPath);
  return id;
}

export function getGoal(db: Database, id: string): Goal | null {
  const stmt = db.prepare("SELECT * FROM goals WHERE id = ?");
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return parseGoalRow(row);
}

export function getActiveGoal(db: Database, projectPath: string): Goal | null {
  const stmt = db.prepare(
    "SELECT * FROM goals WHERE project_path = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1",
  );
  stmt.bind([projectPath]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return parseGoalRow(row);
}

export function updateGoalStatus(
  db: Database,
  id: string,
  status: GoalStatus,
  dbPath?: string,
): void {
  db.run("UPDATE goals SET status = ?, updated_at = ? WHERE id = ?", [
    status,
    new Date().toISOString(),
    id,
  ]);
  if (dbPath) saveDatabase(db, dbPath);
}

function parseGoalRow(row: Record<string, unknown>): Goal {
  return { ...row, done_when: JSON.parse(row.done_when as string) } as Goal;
}

// --- Checkpoints CRUD ---

export function insertCheckpoint(
  db: Database,
  projectPath: string,
  sessionId: string,
  currentState: string,
  whatWasBuilt: string,
  nextSteps: string,
  opts?: {
    branch?: string;
    decisionsMade?: string;
    blockers?: string;
    uncommittedFiles?: string[];
  },
  dbPath?: string,
): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO checkpoints (id, project_path, session_id, branch, current_state, what_was_built, next_steps, decisions_made, blockers, uncommitted_files, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectPath,
      sessionId,
      opts?.branch ?? null,
      currentState,
      whatWasBuilt,
      nextSteps,
      opts?.decisionsMade ?? null,
      opts?.blockers ?? null,
      JSON.stringify(opts?.uncommittedFiles ?? []),
      new Date().toISOString(),
    ],
  );
  if (dbPath) saveDatabase(db, dbPath);
  return id;
}

export function getCheckpoint(db: Database, id: string): Checkpoint | null {
  const stmt = db.prepare("SELECT * FROM checkpoints WHERE id = ?");
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return parseCheckpointRow(row);
}

export function getLatestCheckpoint(
  db: Database,
  projectPath: string,
): Checkpoint | null {
  const stmt = db.prepare(
    "SELECT * FROM checkpoints WHERE project_path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  );
  stmt.bind([projectPath]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return parseCheckpointRow(row);
}

function parseCheckpointRow(row: Record<string, unknown>): Checkpoint {
  return {
    ...row,
    uncommitted_files: JSON.parse(row.uncommitted_files as string),
  } as Checkpoint;
}

// --- Insights CRUD ---

export function insertInsight(
  db: Database,
  projectPath: string,
  content: string,
  category: InsightCategory,
  context?: string,
  dbPath?: string,
): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO insights (id, project_path, content, context, category, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectPath,
      content,
      context ?? null,
      category,
      new Date().toISOString(),
    ],
  );
  if (dbPath) saveDatabase(db, dbPath);
  return id;
}

export function getInsight(db: Database, id: string): Insight | null {
  const stmt = db.prepare("SELECT * FROM insights WHERE id = ?");
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return parseInsightRow(row);
}

export function getInsightsByProject(
  db: Database,
  projectPath: string,
  category?: InsightCategory,
): Insight[] {
  let sql = "SELECT * FROM insights WHERE project_path = ?";
  const params: unknown[] = [projectPath];
  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }
  sql += " ORDER BY created_at DESC";
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: Insight[] = [];
  while (stmt.step()) {
    results.push(parseInsightRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

function parseInsightRow(row: Record<string, unknown>): Insight {
  return {
    id: row.id as string,
    project_path: row.project_path as string,
    content: row.content as string,
    context: (row.context as string | null) ?? null,
    category: row.category as InsightCategory,
    created_at: row.created_at as string,
  };
}

// --- Daily Summaries CRUD ---

export function insertDailySummary(
  db: Database,
  projectPath: string,
  date: string,
  summary: Record<string, unknown>,
  dbPath?: string,
): string {
  const existing = getDailySummary(db, projectPath, date);
  if (existing) {
    db.run("UPDATE daily_summaries SET summary = ? WHERE id = ?", [
      JSON.stringify(summary),
      existing.id,
    ]);
    if (dbPath) saveDatabase(db, dbPath);
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO daily_summaries (id, project_path, date, summary, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, projectPath, date, JSON.stringify(summary), new Date().toISOString()],
  );
  if (dbPath) saveDatabase(db, dbPath);
  return id;
}

export function getDailySummary(
  db: Database,
  projectPath: string,
  date: string,
): DailySummary | null {
  const stmt = db.prepare(
    "SELECT * FROM daily_summaries WHERE project_path = ? AND date = ?",
  );
  stmt.bind([projectPath, date]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return parseDailySummaryRow(row);
}

function parseDailySummaryRow(row: Record<string, unknown>): DailySummary {
  return { ...row, summary: JSON.parse(row.summary as string) } as DailySummary;
}

// --- Extraction Log CRUD ---

export function insertExtractionLog(
  db: Database,
  projectPath: string,
  sessionId: string,
  eventType: string,
  chunksProcessed: number,
  memoriesExtracted: number,
  bytesProcessed: number = 0,
  dbPath?: string,
): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO extraction_log (id, project_path, session_id, event_type, chunks_processed, memories_extracted, bytes_processed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectPath,
      sessionId,
      eventType,
      chunksProcessed,
      memoriesExtracted,
      bytesProcessed,
      new Date().toISOString(),
    ],
  );
  if (dbPath) saveDatabase(db, dbPath);
  return id;
}

export function getLastExtraction(
  db: Database,
  projectPath: string,
  sessionId?: string,
): ExtractionLog | null {
  let sql = "SELECT * FROM extraction_log WHERE project_path = ?";
  const params: unknown[] = [projectPath];
  if (sessionId) {
    sql += " AND session_id = ?";
    params.push(sessionId);
  }
  sql += " ORDER BY created_at DESC, rowid DESC LIMIT 1";
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return parseExtractionLogRow(row);
}

function parseExtractionLogRow(row: Record<string, unknown>): ExtractionLog {
  return {
    ...row,
    chunks_processed: row.chunks_processed as number,
    memories_extracted: row.memories_extracted as number,
    bytes_processed: (row.bytes_processed as number) ?? 0,
  } as ExtractionLog;
}

export function getCursorPosition(
  db: Database,
  projectPath: string,
  sessionId: string,
): number {
  const stmt = db.prepare(
    "SELECT bytes_processed FROM extraction_log WHERE project_path = ? AND session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  );
  stmt.bind([projectPath, sessionId]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return 0;
  return (row.bytes_processed as number) ?? 0;
}

// --- Aggregate queries ---

export function countByType(
  db: Database,
  projectPath?: string,
): Record<string, number> {
  let sql =
    "SELECT type, COUNT(*) as count FROM memories WHERE status = 'active'";
  const params: unknown[] = [];
  if (projectPath) {
    sql += " AND project_path = ?";
    params.push(projectPath);
  }
  sql += " GROUP BY type";
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const result: Record<string, number> = {};
  while (stmt.step()) {
    const row = stmt.getAsObject();
    result[row.type as string] = row.count as number;
  }
  stmt.free();
  return result;
}

function countTable(db: Database, sql: string, params: unknown[]): number {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  const count = (stmt.getAsObject().count as number) ?? 0;
  stmt.free();
  return count;
}

export function countAll(
  db: Database,
  projectPath?: string,
): Record<string, number> {
  if (projectPath) {
    const p = [projectPath];
    return {
      memories: countTable(
        db,
        "SELECT COUNT(*) as count FROM memories WHERE project_path = ?",
        p,
      ),
      dead_ends: countTable(
        db,
        "SELECT COUNT(*) as count FROM dead_ends WHERE project_path = ?",
        p,
      ),
      constraints: countTable(
        db,
        "SELECT COUNT(*) as count FROM constraints WHERE project_path = ?",
        p,
      ),
      goals: countTable(
        db,
        "SELECT COUNT(*) as count FROM goals WHERE project_path = ?",
        p,
      ),
      checkpoints: countTable(
        db,
        "SELECT COUNT(*) as count FROM checkpoints WHERE project_path = ?",
        p,
      ),
      insights: countTable(
        db,
        "SELECT COUNT(*) as count FROM insights WHERE project_path = ?",
        p,
      ),
      daily_summaries: countTable(
        db,
        "SELECT COUNT(*) as count FROM daily_summaries WHERE project_path = ?",
        p,
      ),
      extraction_log: countTable(
        db,
        "SELECT COUNT(*) as count FROM extraction_log WHERE project_path = ?",
        p,
      ),
    };
  }
  return {
    memories: countTable(db, "SELECT COUNT(*) as count FROM memories", []),
    dead_ends: countTable(db, "SELECT COUNT(*) as count FROM dead_ends", []),
    constraints: countTable(
      db,
      "SELECT COUNT(*) as count FROM constraints",
      [],
    ),
    goals: countTable(db, "SELECT COUNT(*) as count FROM goals", []),
    checkpoints: countTable(
      db,
      "SELECT COUNT(*) as count FROM checkpoints",
      [],
    ),
    insights: countTable(db, "SELECT COUNT(*) as count FROM insights", []),
    daily_summaries: countTable(
      db,
      "SELECT COUNT(*) as count FROM daily_summaries",
      [],
    ),
    extraction_log: countTable(
      db,
      "SELECT COUNT(*) as count FROM extraction_log",
      [],
    ),
  };
}

export function listProjects(
  db: Database,
): Array<{ project_path: string; memory_count: number }> {
  const stmt = db.prepare(
    "SELECT project_path, COUNT(*) as count FROM memories WHERE status = 'active' GROUP BY project_path ORDER BY count DESC",
  );
  const results: Array<{ project_path: string; memory_count: number }> = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push({
      project_path: row.project_path as string,
      memory_count: row.count as number,
    });
  }
  stmt.free();
  return results;
}

export function deleteProjectData(
  db: Database,
  projectPath: string,
  dbPath?: string,
): void {
  db.run("DELETE FROM memories WHERE project_path = ?", [projectPath]);
  db.run("DELETE FROM dead_ends WHERE project_path = ?", [projectPath]);
  db.run("DELETE FROM constraints WHERE project_path = ?", [projectPath]);
  db.run("DELETE FROM goals WHERE project_path = ?", [projectPath]);
  db.run("DELETE FROM checkpoints WHERE project_path = ?", [projectPath]);
  db.run("DELETE FROM insights WHERE project_path = ?", [projectPath]);
  db.run("DELETE FROM daily_summaries WHERE project_path = ?", [projectPath]);
  db.run("DELETE FROM extraction_log WHERE project_path = ?", [projectPath]);
  if (dbPath) saveDatabase(db, dbPath);
}

export function deleteAllData(db: Database, dbPath?: string): void {
  db.run("DELETE FROM memories");
  db.run("DELETE FROM dead_ends");
  db.run("DELETE FROM constraints");
  db.run("DELETE FROM goals");
  db.run("DELETE FROM checkpoints");
  db.run("DELETE FROM insights");
  db.run("DELETE FROM daily_summaries");
  db.run("DELETE FROM extraction_log");
  if (dbPath) saveDatabase(db, dbPath);
}

export function getAllMemories(db: Database, projectPath?: string): Memory[] {
  let sql = "SELECT * FROM memories";
  const params: unknown[] = [];
  if (projectPath) {
    sql += " WHERE project_path = ?";
    params.push(projectPath);
  }
  sql += " ORDER BY created_at DESC";
  return queryMemories(db, sql, params);
}

export function getAllDeadEnds(db: Database, projectPath?: string): DeadEnd[] {
  let sql = "SELECT * FROM dead_ends";
  const params: unknown[] = [];
  if (projectPath) {
    sql += " WHERE project_path = ?";
    params.push(projectPath);
  }
  sql += " ORDER BY created_at DESC";
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: DeadEnd[] = [];
  while (stmt.step()) {
    results.push(parseDeadEndRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getAllConstraints(
  db: Database,
  projectPath?: string,
): Constraint[] {
  let sql = "SELECT * FROM constraints";
  const params: unknown[] = [];
  if (projectPath) {
    sql += " WHERE project_path = ?";
    params.push(projectPath);
  }
  sql += " ORDER BY created_at DESC";
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: Constraint[] = [];
  while (stmt.step()) {
    results.push(parseConstraintRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getAllGoals(db: Database, projectPath?: string): Goal[] {
  let sql = "SELECT * FROM goals";
  const params: unknown[] = [];
  if (projectPath) {
    sql += " WHERE project_path = ?";
    params.push(projectPath);
  }
  sql += " ORDER BY created_at DESC";
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: Goal[] = [];
  while (stmt.step()) {
    results.push(parseGoalRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getAllCheckpoints(
  db: Database,
  projectPath?: string,
): Checkpoint[] {
  let sql = "SELECT * FROM checkpoints";
  const params: unknown[] = [];
  if (projectPath) {
    sql += " WHERE project_path = ?";
    params.push(projectPath);
  }
  sql += " ORDER BY created_at DESC";
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: Checkpoint[] = [];
  while (stmt.step()) {
    results.push(parseCheckpointRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getAllInsights(db: Database, projectPath?: string): Insight[] {
  let sql = "SELECT * FROM insights";
  const params: unknown[] = [];
  if (projectPath) {
    sql += " WHERE project_path = ?";
    params.push(projectPath);
  }
  sql += " ORDER BY created_at DESC";
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: Insight[] = [];
  while (stmt.step()) {
    results.push(parseInsightRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getAllDailySummaries(
  db: Database,
  projectPath?: string,
): DailySummary[] {
  let sql = "SELECT * FROM daily_summaries";
  const params: unknown[] = [];
  if (projectPath) {
    sql += " WHERE project_path = ?";
    params.push(projectPath);
  }
  sql += " ORDER BY date DESC";
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: DailySummary[] = [];
  while (stmt.step()) {
    results.push(parseDailySummaryRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getAllExtractionLogs(
  db: Database,
  projectPath?: string,
): ExtractionLog[] {
  let sql = "SELECT * FROM extraction_log";
  const params: unknown[] = [];
  if (projectPath) {
    sql += " WHERE project_path = ?";
    params.push(projectPath);
  }
  sql += " ORDER BY created_at DESC";
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: ExtractionLog[] = [];
  while (stmt.step()) {
    results.push(parseExtractionLogRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}
