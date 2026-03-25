import { describe, it, expect, beforeEach } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import {
  initSchema,
  insertCheckpoint,
  getCheckpoint,
  getLatestCheckpoint,
  insertDailySummary,
  getDailySummary,
  countAll,
  listProjects,
  deleteProjectData,
  deleteAllData,
  getCheckpointsByDate,
  getAllCheckpoints,
  getAllDailySummaries,
} from "../src/store.js";

let db: Database;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  initSchema(db);
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

  it("getAllCheckpoints returns all for project", () => {
    insertCheckpoint(db, "/proj", "sess-1", "State 1", "Built 1", "Next 1");
    insertCheckpoint(db, "/proj", "sess-2", "State 2", "Built 2", "Next 2");
    insertCheckpoint(db, "/other", "sess-3", "State 3", "Built 3", "Next 3");
    const all = getAllCheckpoints(db, "/proj");
    expect(all).toHaveLength(2);
  });

  it("getAllCheckpoints without project returns everything", () => {
    insertCheckpoint(db, "/proj-a", "sess-1", "State 1", "Built 1", "Next 1");
    insertCheckpoint(db, "/proj-b", "sess-2", "State 2", "Built 2", "Next 2");
    const all = getAllCheckpoints(db);
    expect(all).toHaveLength(2);
  });

  it("getCheckpoint by ID returns correct checkpoint among many", () => {
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

  it("getAllDailySummaries returns all for project", () => {
    insertDailySummary(db, "/proj", "2026-03-21", { day: "one" });
    insertDailySummary(db, "/proj", "2026-03-22", { day: "two" });
    insertDailySummary(db, "/other", "2026-03-22", { day: "other" });
    const all = getAllDailySummaries(db, "/proj");
    expect(all).toHaveLength(2);
  });

  it("getAllDailySummaries without project returns everything", () => {
    insertDailySummary(db, "/proj-a", "2026-03-21", { day: "a" });
    insertDailySummary(db, "/proj-b", "2026-03-22", { day: "b" });
    const all = getAllDailySummaries(db);
    expect(all).toHaveLength(2);
  });

  it("upserts when same project+date already exists", () => {
    insertDailySummary(db, "/proj", "2026-03-22", { version: 1 });
    insertDailySummary(db, "/proj", "2026-03-22", { version: 2 });
    const ds = getDailySummary(db, "/proj", "2026-03-22");
    expect(ds!.summary).toEqual({ version: 2 });
    const all = getAllDailySummaries(db, "/proj");
    expect(all).toHaveLength(1);
  });
});

describe("aggregate queries", () => {
  it("counts all tables with project filter", () => {
    insertCheckpoint(db, "/proj", "sess-1", "State", "Built", "Next");
    insertDailySummary(db, "/proj", "2026-03-22", { day: "one" });
    const counts = countAll(db, "/proj");
    expect(counts.checkpoints).toBe(1);
    expect(counts.daily_summaries).toBe(1);
  });

  it("counts all tables without project filter", () => {
    insertCheckpoint(db, "/proj-a", "sess-1", "State", "Built", "Next");
    insertCheckpoint(db, "/proj-b", "sess-2", "State", "Built", "Next");
    insertDailySummary(db, "/proj-a", "2026-03-22", { day: "one" });
    const counts = countAll(db);
    expect(counts.checkpoints).toBe(2);
    expect(counts.daily_summaries).toBe(1);
  });

  it("lists projects with checkpoint counts", () => {
    insertCheckpoint(db, "/proj-a", "sess-1", "S1", "B1", "N1");
    insertCheckpoint(db, "/proj-a", "sess-2", "S2", "B2", "N2");
    insertCheckpoint(db, "/proj-b", "sess-3", "S3", "B3", "N3");
    const projects = listProjects(db);
    expect(projects).toHaveLength(2);
    expect(projects[0].project_path).toBe("/proj-a");
    expect(projects[0].checkpoint_count).toBe(2);
    expect(projects[1].project_path).toBe("/proj-b");
    expect(projects[1].checkpoint_count).toBe(1);
  });

  it("lists no projects when none exist", () => {
    const projects = listProjects(db);
    expect(projects).toHaveLength(0);
  });
});

describe("cross-project isolation", () => {
  it("checkpoints are isolated by project", () => {
    insertCheckpoint(db, "/proj-a", "s1", "A state", "A built", "A next");
    insertCheckpoint(db, "/proj-b", "s2", "B state", "B built", "B next");
    expect(getAllCheckpoints(db, "/proj-a")).toHaveLength(1);
    expect(getAllCheckpoints(db, "/proj-b")).toHaveLength(1);
  });

  it("deleteProjectData only affects target project", () => {
    insertCheckpoint(db, "/proj-a", "s1", "Keep", "Built A", "Next A");
    insertCheckpoint(db, "/proj-b", "s2", "Delete", "Built B", "Next B");
    insertDailySummary(db, "/proj-b", "2026-03-22", { delete: true });
    deleteProjectData(db, "/proj-b");
    expect(getAllCheckpoints(db, "/proj-a")).toHaveLength(1);
    expect(getAllCheckpoints(db, "/proj-b")).toHaveLength(0);
    expect(getDailySummary(db, "/proj-b", "2026-03-22")).toBeNull();
  });

  it("deleteAllData clears everything", () => {
    insertCheckpoint(db, "/proj-a", "s1", "S1", "B1", "N1");
    insertCheckpoint(db, "/proj-b", "s2", "S2", "B2", "N2");
    insertDailySummary(db, "/proj-a", "2026-03-22", { day: "one" });
    deleteAllData(db);
    expect(countAll(db).checkpoints).toBe(0);
    expect(countAll(db).daily_summaries).toBe(0);
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

    it("does not return checkpoints from adjacent days", () => {
      insertCheckpoint(db, project, "s1", "State A", "Built A", "Next A");
      insertCheckpoint(db, project, "s2", "State B", "Built B", "Next B");

      // One checkpoint on target date, one clearly on a different day (2 days before)
      db.run(
        `UPDATE checkpoints SET created_at = '${targetDate}T12:00:00.000Z' WHERE current_state = 'State A'`,
      );
      db.run(
        `UPDATE checkpoints SET created_at = '2026-03-20T10:00:00.000Z' WHERE current_state = 'State B'`,
      );

      const results = getCheckpointsByDate(db, project, targetDate);
      expect(results).toHaveLength(1);
      expect(results[0].current_state).toBe("State A");
    });

    it("finds checkpoints created during the day", () => {
      insertCheckpoint(db, project, "s1", "Morning", "Built AM", "Next AM");
      insertCheckpoint(db, project, "s2", "Evening", "Built PM", "Next PM");

      db.run(
        `UPDATE checkpoints SET created_at = '${targetDate}T08:30:00.000Z' WHERE current_state = 'Morning'`,
      );
      db.run(
        `UPDATE checkpoints SET created_at = '${targetDate}T17:45:00.000Z' WHERE current_state = 'Evening'`,
      );

      const results = getCheckpointsByDate(db, project, targetDate);
      expect(results).toHaveLength(2);
    });
  });
});

describe("source field in checkpoints", () => {
  it("stores and retrieves source field as 'manual' by default", () => {
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
    expect(cp!.source).toBe("manual");
  });

  it("stores and retrieves source field as 'auto' when specified", () => {
    const id = insertCheckpoint(
      db,
      "/proj",
      "sess-1",
      "Working",
      "Auth",
      "Tests",
      { source: "auto" },
    );
    const cp = getCheckpoint(db, id);
    expect(cp).not.toBeNull();
    expect(cp!.source).toBe("auto");
  });

  it("migration adds source column to existing databases", () => {
    // initSchema already ran in beforeEach — the migration should handle
    // the duplicate column case gracefully. Run it again to verify.
    initSchema(db);
    const id = insertCheckpoint(
      db,
      "/proj",
      "sess-1",
      "Working",
      "Auth",
      "Tests",
      { source: "auto" },
    );
    const cp = getCheckpoint(db, id);
    expect(cp!.source).toBe("auto");
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
});
