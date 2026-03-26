import initSqlJs, { type Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type { Checkpoint, DailySummary } from "./types.js";

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
  return path.join(os.homedir(), ".claude-baton", "store.db");
}

export function initSchema(db: Database): void {
  db.exec(`
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
      git_snapshot TEXT,
      plan_reference TEXT,
      source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(project_path);

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
  `);

  // Migration: add git_snapshot column for existing databases
  try {
    db.exec("ALTER TABLE checkpoints ADD COLUMN git_snapshot TEXT");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (!msg.includes("duplicate column")) throw e;
  }

  // Migration: add plan_reference column for existing databases
  try {
    db.exec("ALTER TABLE checkpoints ADD COLUMN plan_reference TEXT");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (!msg.includes("duplicate column")) throw e;
  }

  // Migration: add source column for existing databases
  try {
    db.exec("ALTER TABLE checkpoints ADD COLUMN source TEXT DEFAULT 'manual'");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (!msg.includes("duplicate column")) throw e;
  }
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
    gitSnapshot?: string;
    planReference?: string;
    source?: "manual" | "auto";
  },
  dbPath?: string,
): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO checkpoints (id, project_path, session_id, branch, current_state, what_was_built, next_steps, decisions_made, blockers, uncommitted_files, git_snapshot, plan_reference, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      opts?.gitSnapshot ?? null,
      opts?.planReference ?? null,
      opts?.source ?? "manual",
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
    git_snapshot: (row.git_snapshot as string | null) ?? null,
    plan_reference: (row.plan_reference as string | null) ?? null,
    source: (row.source as string | null) ?? "manual",
  } as Checkpoint;
}

export function getCheckpointsByDate(
  db: Database,
  projectPath: string,
  date: string,
): Checkpoint[] {
  const startLocal = new Date(`${date}T00:00:00`);
  const endLocal = new Date(`${date}T23:59:59.999`);
  const startUtc = startLocal.toISOString();
  const endUtc = endLocal.toISOString();
  const stmt = db.prepare(
    "SELECT * FROM checkpoints WHERE project_path = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC",
  );
  stmt.bind([projectPath, startUtc, endUtc]);
  const results: Checkpoint[] = [];
  while (stmt.step()) {
    results.push(parseCheckpointRow(stmt.getAsObject()));
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

// --- Aggregate queries ---

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
      checkpoints: countTable(
        db,
        "SELECT COUNT(*) as count FROM checkpoints WHERE project_path = ?",
        p,
      ),
      auto_checkpoints: countTable(
        db,
        "SELECT COUNT(*) as count FROM checkpoints WHERE project_path = ? AND source = 'auto'",
        p,
      ),
      daily_summaries: countTable(
        db,
        "SELECT COUNT(*) as count FROM daily_summaries WHERE project_path = ?",
        p,
      ),
    };
  }
  return {
    checkpoints: countTable(
      db,
      "SELECT COUNT(*) as count FROM checkpoints",
      [],
    ),
    auto_checkpoints: countTable(
      db,
      "SELECT COUNT(*) as count FROM checkpoints WHERE source = 'auto'",
      [],
    ),
    daily_summaries: countTable(
      db,
      "SELECT COUNT(*) as count FROM daily_summaries",
      [],
    ),
  };
}

export function listProjects(
  db: Database,
): Array<{ project_path: string; checkpoint_count: number }> {
  const stmt = db.prepare(
    "SELECT project_path, COUNT(*) as count FROM checkpoints GROUP BY project_path ORDER BY count DESC",
  );
  const results: Array<{ project_path: string; checkpoint_count: number }> = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push({
      project_path: row.project_path as string,
      checkpoint_count: row.count as number,
    });
  }
  stmt.free();
  return results;
}

// --- Delete operations ---

export function deleteProjectData(
  db: Database,
  projectPath: string,
  dbPath?: string,
): void {
  db.run("DELETE FROM checkpoints WHERE project_path = ?", [projectPath]);
  db.run("DELETE FROM daily_summaries WHERE project_path = ?", [projectPath]);
  if (dbPath) saveDatabase(db, dbPath);
}

export function deleteAllData(db: Database, dbPath?: string): void {
  db.run("DELETE FROM checkpoints");
  db.run("DELETE FROM daily_summaries");
  if (dbPath) saveDatabase(db, dbPath);
}
