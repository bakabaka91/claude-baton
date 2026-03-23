import { describe, it, expect, beforeEach } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import {
  initSchema,
  insertMemory,
  getMemory,
  getMemoriesByProject,
  updateMemoryStatus,
  updateMemoryConfidence,
  incrementAccessCount,
  deleteMemory,
  insertDeadEnd,
  getDeadEnd,
  getDeadEndsByProject,
  resolveDeadEnd,
  insertConstraint,
  getConstraint,
  getConstraintsByProject,
  insertGoal,
  getGoal,
  getActiveGoal,
  updateGoalStatus,
  insertCheckpoint,
  getCheckpoint,
  getLatestCheckpoint,
  insertInsight,
  getInsight,
  getInsightsByProject,
  getInsightsSince,
  insertDailySummary,
  getDailySummary,
  insertExtractionLog,
  getLastExtraction,
  countByType,
  countAll,
  listProjects,
  deleteProjectData,
  deleteAllData,
  getCheckpointsByDate,
  getInsightsByDate,
  getMemoriesByDate,
  getExtractionLogsByDate,
} from "../src/store.js";

let db: Database;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  initSchema(db);
});

describe("memories CRUD", () => {
  it("inserts and retrieves a memory", () => {
    const id = insertMemory(db, "/proj", "decision", "Use SQLite", [
      "db",
      "storage",
    ]);
    const mem = getMemory(db, id);
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe("Use SQLite");
    expect(mem!.type).toBe("decision");
    expect(mem!.tags).toEqual(["db", "storage"]);
    expect(mem!.confidence).toBe(1.0);
    expect(mem!.access_count).toBe(0);
    expect(mem!.status).toBe("active");
  });

  it("queries by project and type", () => {
    insertMemory(db, "/proj-a", "decision", "Decision A");
    insertMemory(db, "/proj-a", "pattern", "Pattern A");
    insertMemory(db, "/proj-b", "decision", "Decision B");

    const all = getMemoriesByProject(db, "/proj-a");
    expect(all).toHaveLength(2);

    const decisions = getMemoriesByProject(db, "/proj-a", "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].content).toBe("Decision A");
  });

  it("updates status", () => {
    const id = insertMemory(db, "/proj", "progress", "WIP");
    updateMemoryStatus(db, id, "archived");
    const mem = getMemory(db, id);
    expect(mem!.status).toBe("archived");
  });

  it("updates confidence", () => {
    const id = insertMemory(db, "/proj", "context", "Some context");
    updateMemoryConfidence(db, id, 0.5);
    const mem = getMemory(db, id);
    expect(mem!.confidence).toBe(0.5);
  });

  it("increments access count", () => {
    const id = insertMemory(db, "/proj", "pattern", "Singleton");
    incrementAccessCount(db, id);
    incrementAccessCount(db, id);
    const mem = getMemory(db, id);
    expect(mem!.access_count).toBe(2);
  });

  it("deletes a memory", () => {
    const id = insertMemory(db, "/proj", "gotcha", "Watch out");
    deleteMemory(db, id);
    expect(getMemory(db, id)).toBeNull();
  });

  it("filters by status", () => {
    insertMemory(db, "/proj", "decision", "Active one");
    const id2 = insertMemory(db, "/proj", "decision", "Archived one");
    updateMemoryStatus(db, id2, "archived");

    const active = getMemoriesByProject(db, "/proj", undefined, "active");
    expect(active).toHaveLength(1);
    expect(active[0].content).toBe("Active one");
  });

  it("JSON round-trips tags", () => {
    const id = insertMemory(db, "/proj", "architecture", "Layered", [
      "layer",
      "arch",
      "clean",
    ]);
    const mem = getMemory(db, id);
    expect(mem!.tags).toEqual(["layer", "arch", "clean"]);
    expect(Array.isArray(mem!.tags)).toBe(true);
  });
});

describe("dead_ends CRUD", () => {
  it("inserts and retrieves", () => {
    const id = insertDeadEnd(
      db,
      "/proj",
      "Redis caching",
      "Tried Redis",
      "Overkill for single user",
      "When multi-user",
    );
    const de = getDeadEnd(db, id);
    expect(de).not.toBeNull();
    expect(de!.summary).toBe("Redis caching");
    expect(de!.approach_tried).toBe("Tried Redis");
    expect(de!.blocker).toBe("Overkill for single user");
    expect(de!.resume_when).toBe("When multi-user");
    expect(de!.resolved).toBe(false);
  });

  it("queries by project", () => {
    insertDeadEnd(db, "/proj-a", "Attempt 1", "Tried X", "Failed");
    insertDeadEnd(db, "/proj-b", "Attempt 2", "Tried Y", "Failed");
    const results = getDeadEndsByProject(db, "/proj-a");
    expect(results).toHaveLength(1);
  });

  it("resolves a dead end", () => {
    const id = insertDeadEnd(db, "/proj", "Bug", "Old approach", "Blocked");
    resolveDeadEnd(db, id);
    const de = getDeadEnd(db, id);
    expect(de!.resolved).toBe(true);
  });
});

describe("constraints CRUD", () => {
  it("inserts and retrieves", () => {
    const id = insertConstraint(
      db,
      "/proj",
      "No secrets in git",
      "security",
      "must",
      "global",
      "audit",
    );
    const c = getConstraint(db, id);
    expect(c).not.toBeNull();
    expect(c!.rule).toBe("No secrets in git");
    expect(c!.type).toBe("security");
    expect(c!.severity).toBe("must");
  });

  it("queries by project", () => {
    insertConstraint(db, "/proj", "Rule 1", "security", "must");
    insertConstraint(db, "/proj", "Rule 2", "convention", "should");
    const results = getConstraintsByProject(db, "/proj");
    expect(results).toHaveLength(2);
  });
});

describe("goals CRUD", () => {
  it("inserts and retrieves with JSON done_when", () => {
    const doneWhen = ["Task A done", "Task B done"];
    const id = insertGoal(db, "/proj", "Ship v1", doneWhen);
    const goal = getGoal(db, id);
    expect(goal).not.toBeNull();
    expect(goal!.intent).toBe("Ship v1");
    expect(goal!.done_when).toEqual(doneWhen);
    expect(goal!.status).toBe("active");
  });

  it("gets active goal", () => {
    insertGoal(db, "/proj", "Goal 1", ["done"]);
    const id2 = insertGoal(db, "/proj", "Goal 2", ["done"]);
    const active = getActiveGoal(db, "/proj");
    expect(active).not.toBeNull();
    expect(active!.id).toBe(id2);
  });

  it("updates goal status", () => {
    const id = insertGoal(db, "/proj", "Goal", ["done"]);
    updateGoalStatus(db, id, "completed");
    const goal = getGoal(db, id);
    expect(goal!.status).toBe("completed");
  });

  it("no active goal returns null", () => {
    expect(getActiveGoal(db, "/proj")).toBeNull();
  });
});

describe("checkpoints CRUD", () => {
  it("inserts and retrieves with JSON uncommitted_files", () => {
    const id = insertCheckpoint(
      db,
      "/proj",
      "sess-1",
      "Working on auth",
      "Auth module",
      "Add tests",
      {
        branch: "main",
        decisionsMade: "JWT over sessions",
        blockers: "None",
        uncommittedFiles: ["src/auth.ts", "src/middleware.ts"],
      },
    );
    const cp = getCheckpoint(db, id);
    expect(cp).not.toBeNull();
    expect(cp!.what_was_built).toBe("Auth module");
    expect(cp!.uncommitted_files).toEqual(["src/auth.ts", "src/middleware.ts"]);
  });

  it("gets latest checkpoint", () => {
    insertCheckpoint(db, "/proj", "sess-1", "State 1", "Built 1", "Next 1");
    insertCheckpoint(db, "/proj", "sess-2", "State 2", "Built 2", "Next 2");
    const latest = getLatestCheckpoint(db, "/proj");
    expect(latest).not.toBeNull();
    expect(latest!.session_id).toBe("sess-2");
  });

  it("no checkpoint returns null", () => {
    expect(getLatestCheckpoint(db, "/proj")).toBeNull();
  });
});

describe("insights CRUD", () => {
  it("inserts and retrieves", () => {
    const id = insertInsight(
      db,
      "/proj",
      "Haiku is fast enough",
      "architecture",
      "Testing models",
    );
    const ins = getInsight(db, id);
    expect(ins).not.toBeNull();
    expect(ins!.content).toBe("Haiku is fast enough");
    expect(ins!.category).toBe("architecture");
  });

  it("queries by project and category", () => {
    insertInsight(db, "/proj", "Insight 1", "decision");
    insertInsight(db, "/proj", "Insight 2", "workflow");
    const decisions = getInsightsByProject(db, "/proj", "decision");
    expect(decisions).toHaveLength(1);
  });
});

describe("daily_summaries CRUD", () => {
  it("inserts and retrieves with JSON summary", () => {
    const summary = { highlights: ["Shipped auth"], blockers: [] };
    insertDailySummary(db, "/proj", "2026-03-22", summary);
    const ds = getDailySummary(db, "/proj", "2026-03-22");
    expect(ds).not.toBeNull();
    expect(ds!.summary).toEqual(summary);
  });

  it("returns null for missing date", () => {
    expect(getDailySummary(db, "/proj", "2026-01-01")).toBeNull();
  });
});

describe("extraction_log CRUD", () => {
  it("inserts and retrieves last extraction", () => {
    insertExtractionLog(db, "/proj", "sess-1", "Stop", 3, 5);
    insertExtractionLog(db, "/proj", "sess-1", "SessionEnd", 2, 1);
    const last = getLastExtraction(db, "/proj", "sess-1");
    expect(last).not.toBeNull();
    expect(last!.event_type).toBe("SessionEnd");
    expect(last!.chunks_processed).toBe(2);
  });

  it("returns null when no extractions", () => {
    expect(getLastExtraction(db, "/proj")).toBeNull();
  });
});

describe("aggregate queries", () => {
  it("counts by type", () => {
    insertMemory(db, "/proj", "decision", "D1");
    insertMemory(db, "/proj", "decision", "D2");
    insertMemory(db, "/proj", "pattern", "P1");
    const counts = countByType(db, "/proj");
    expect(counts.decision).toBe(2);
    expect(counts.pattern).toBe(1);
  });

  it("counts all tables", () => {
    insertMemory(db, "/proj", "decision", "D1");
    insertDeadEnd(db, "/proj", "DE1", "Tried", "Blocked");
    insertConstraint(db, "/proj", "Rule", "security", "must");
    const counts = countAll(db, "/proj");
    expect(counts.memories).toBe(1);
    expect(counts.dead_ends).toBe(1);
    expect(counts.constraints).toBe(1);
  });

  it("lists projects", () => {
    insertMemory(db, "/proj-a", "decision", "D1");
    insertMemory(db, "/proj-a", "pattern", "P1");
    insertMemory(db, "/proj-b", "decision", "D2");
    const projects = listProjects(db);
    expect(projects).toHaveLength(2);
    expect(projects[0].project_path).toBe("/proj-a");
    expect(projects[0].memory_count).toBe(2);
  });
});

describe("cross-project isolation", () => {
  it("memories are isolated by project", () => {
    insertMemory(db, "/proj-a", "decision", "A decision");
    insertMemory(db, "/proj-b", "decision", "B decision");
    expect(getMemoriesByProject(db, "/proj-a")).toHaveLength(1);
    expect(getMemoriesByProject(db, "/proj-b")).toHaveLength(1);
  });

  it("deleteProjectData only affects target project", () => {
    insertMemory(db, "/proj-a", "decision", "Keep");
    insertMemory(db, "/proj-b", "decision", "Delete");
    insertDeadEnd(db, "/proj-b", "DE", "Tried", "Blocked");
    deleteProjectData(db, "/proj-b");
    expect(getMemoriesByProject(db, "/proj-a")).toHaveLength(1);
    expect(getMemoriesByProject(db, "/proj-b")).toHaveLength(0);
    expect(getDeadEndsByProject(db, "/proj-b")).toHaveLength(0);
  });

  it("deleteAllData clears everything", () => {
    insertMemory(db, "/proj-a", "decision", "D1");
    insertMemory(db, "/proj-b", "decision", "D2");
    deleteAllData(db);
    expect(countAll(db).memories).toBe(0);
  });
});

describe("date-range queries", () => {
  const project = "/proj";
  const targetDate = "2026-03-22";
  const otherDate = "2026-03-21";

  describe("getCheckpointsByDate", () => {
    it("returns only checkpoints matching the target date", () => {
      insertCheckpoint(db, project, "s1", "State A", "Built A", "Next A");
      insertCheckpoint(db, project, "s2", "State B", "Built B", "Next B");
      insertCheckpoint(db, project, "s3", "State C", "Built C", "Next C");

      db.run(
        `UPDATE checkpoints SET created_at = '${targetDate}T09:00:00.000Z' WHERE current_state = 'State A'`,
      );
      db.run(
        `UPDATE checkpoints SET created_at = '${targetDate}T14:00:00.000Z' WHERE current_state = 'State B'`,
      );
      db.run(
        `UPDATE checkpoints SET created_at = '${otherDate}T10:00:00.000Z' WHERE current_state = 'State C'`,
      );

      const results = getCheckpointsByDate(db, project, targetDate);
      expect(results).toHaveLength(2);
      expect(results[0].current_state).toBe("State A");
      expect(results[1].current_state).toBe("State B");
    });

    it("returns empty array when no checkpoints match", () => {
      insertCheckpoint(db, project, "s1", "State", "Built", "Next");
      db.run(
        `UPDATE checkpoints SET created_at = '${otherDate}T10:00:00.000Z'`,
      );

      const results = getCheckpointsByDate(db, project, targetDate);
      expect(results).toHaveLength(0);
    });
  });

  describe("getInsightsByDate", () => {
    it("returns only insights matching the target date", () => {
      insertInsight(db, project, "Insight A", "decision");
      insertInsight(db, project, "Insight B", "workflow");
      insertInsight(db, project, "Insight C", "architecture");

      db.run(
        `UPDATE insights SET created_at = '${targetDate}T08:00:00.000Z' WHERE content = 'Insight A'`,
      );
      db.run(
        `UPDATE insights SET created_at = '${targetDate}T16:00:00.000Z' WHERE content = 'Insight B'`,
      );
      db.run(
        `UPDATE insights SET created_at = '${otherDate}T12:00:00.000Z' WHERE content = 'Insight C'`,
      );

      const results = getInsightsByDate(db, project, targetDate);
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe("Insight A");
      expect(results[1].content).toBe("Insight B");
    });

    it("returns empty array when no insights match", () => {
      insertInsight(db, project, "Insight X", "cost");
      db.run(`UPDATE insights SET created_at = '${otherDate}T10:00:00.000Z'`);

      const results = getInsightsByDate(db, project, targetDate);
      expect(results).toHaveLength(0);
    });
  });

  describe("getMemoriesByDate", () => {
    it("returns only memories matching the target date", () => {
      insertMemory(db, project, "decision", "Memory A");
      insertMemory(db, project, "pattern", "Memory B");
      insertMemory(db, project, "gotcha", "Memory C");

      db.run(
        `UPDATE memories SET created_at = '${targetDate}T07:00:00.000Z' WHERE content = 'Memory A'`,
      );
      db.run(
        `UPDATE memories SET created_at = '${targetDate}T18:00:00.000Z' WHERE content = 'Memory B'`,
      );
      db.run(
        `UPDATE memories SET created_at = '${otherDate}T09:00:00.000Z' WHERE content = 'Memory C'`,
      );

      const results = getMemoriesByDate(db, project, targetDate);
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe("Memory A");
      expect(results[1].content).toBe("Memory B");
    });

    it("returns empty array when no memories match", () => {
      insertMemory(db, project, "decision", "Memory X");
      db.run(`UPDATE memories SET created_at = '${otherDate}T10:00:00.000Z'`);

      const results = getMemoriesByDate(db, project, targetDate);
      expect(results).toHaveLength(0);
    });
  });

  describe("getExtractionLogsByDate", () => {
    it("returns only extraction logs matching the target date", () => {
      insertExtractionLog(db, project, "s1", "Stop", 3, 5);
      insertExtractionLog(db, project, "s1", "SessionEnd", 2, 1);
      insertExtractionLog(db, project, "s2", "Stop", 1, 0);

      db.run(
        `UPDATE extraction_log SET created_at = '${targetDate}T06:00:00.000Z' WHERE chunks_processed = 3`,
      );
      db.run(
        `UPDATE extraction_log SET created_at = '${targetDate}T20:00:00.000Z' WHERE chunks_processed = 2`,
      );
      db.run(
        `UPDATE extraction_log SET created_at = '${otherDate}T15:00:00.000Z' WHERE chunks_processed = 1`,
      );

      const results = getExtractionLogsByDate(db, project, targetDate);
      expect(results).toHaveLength(2);
      expect(results[0].chunks_processed).toBe(3);
      expect(results[1].chunks_processed).toBe(2);
    });

    it("returns empty array when no extraction logs match", () => {
      insertExtractionLog(db, project, "s1", "Stop", 4, 2);
      db.run(
        `UPDATE extraction_log SET created_at = '${otherDate}T10:00:00.000Z'`,
      );

      const results = getExtractionLogsByDate(db, project, targetDate);
      expect(results).toHaveLength(0);
    });
  });
});

describe("git_snapshot in checkpoints", () => {
  it("stores and retrieves git_snapshot", () => {
    const snapshot = "abc1234 feat: add auth\ndef5678 fix: typo";
    const id = insertCheckpoint(
      db,
      "/proj",
      "sess-1",
      "Working",
      "Auth",
      "Tests",
      {
        branch: "main",
        gitSnapshot: snapshot,
      },
    );
    const cp = getCheckpoint(db, id);
    expect(cp).not.toBeNull();
    expect(cp!.git_snapshot).toBe(snapshot);
  });

  it("returns null git_snapshot when not provided", () => {
    const id = insertCheckpoint(
      db,
      "/proj",
      "sess-1",
      "Working",
      "Auth",
      "Tests",
    );
    const cp = getCheckpoint(db, id);
    expect(cp).not.toBeNull();
    expect(cp!.git_snapshot).toBeNull();
  });

  it("stores branch and uncommitted_files via opts", () => {
    const id = insertCheckpoint(
      db,
      "/proj",
      "sess-1",
      "Working",
      "Auth",
      "Tests",
      {
        branch: "feature/auth",
        uncommittedFiles: ["M src/auth.ts", "?? src/new.ts"],
        gitSnapshot: "abc1234 feat: start",
      },
    );
    const cp = getCheckpoint(db, id);
    expect(cp!.branch).toBe("feature/auth");
    expect(cp!.uncommitted_files).toEqual(["M src/auth.ts", "?? src/new.ts"]);
    expect(cp!.git_snapshot).toBe("abc1234 feat: start");
  });

  it("getCheckpoint by ID returns correct checkpoint", () => {
    const id1 = insertCheckpoint(
      db,
      "/proj",
      "sess-1",
      "State 1",
      "Built 1",
      "Next 1",
    );
    const id2 = insertCheckpoint(
      db,
      "/proj",
      "sess-1",
      "State 2",
      "Built 2",
      "Next 2",
    );
    const cp = getCheckpoint(db, id1);
    expect(cp!.current_state).toBe("State 1");
    const cp2 = getCheckpoint(db, id2);
    expect(cp2!.current_state).toBe("State 2");
  });
});

describe("getInsightsSince", () => {
  const project = "/proj";

  it("returns only insights after the given timestamp", () => {
    insertInsight(db, project, "Old insight", "decision");
    insertInsight(db, project, "New insight", "workflow");
    insertInsight(db, project, "Newest insight", "architecture");

    db.run(
      `UPDATE insights SET created_at = '2026-03-22T08:00:00.000Z' WHERE content = 'Old insight'`,
    );
    db.run(
      `UPDATE insights SET created_at = '2026-03-22T14:00:00.000Z' WHERE content = 'New insight'`,
    );
    db.run(
      `UPDATE insights SET created_at = '2026-03-22T18:00:00.000Z' WHERE content = 'Newest insight'`,
    );

    const results = getInsightsSince(db, project, "2026-03-22T12:00:00.000Z");
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("New insight");
    expect(results[1].content).toBe("Newest insight");
  });

  it("returns empty array when no insights match", () => {
    insertInsight(db, project, "Early insight", "cost");
    db.run(`UPDATE insights SET created_at = '2026-03-20T08:00:00.000Z'`);

    const results = getInsightsSince(db, project, "2026-03-22T00:00:00.000Z");
    expect(results).toHaveLength(0);
  });

  it("includes insights at exactly the since timestamp", () => {
    insertInsight(db, project, "Exact match", "surprise");
    db.run(`UPDATE insights SET created_at = '2026-03-22T12:00:00.000Z'`);

    const results = getInsightsSince(db, project, "2026-03-22T12:00:00.000Z");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Exact match");
  });

  it("filters by project path", () => {
    insertInsight(db, "/proj-a", "A insight", "decision");
    insertInsight(db, "/proj-b", "B insight", "decision");

    db.run(`UPDATE insights SET created_at = '2026-03-22T12:00:00.000Z'`);

    const results = getInsightsSince(db, "/proj-a", "2026-03-22T00:00:00.000Z");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("A insight");
  });
});
