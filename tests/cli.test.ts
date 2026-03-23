import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import {
  initSchema,
  insertMemory,
  insertDeadEnd,
  insertConstraint,
  insertGoal,
  insertInsight,
  insertCheckpoint,
  insertExtractionLog,
  countAll,
  getMemoriesByProject,
  getDeadEndsByProject,
  getConstraintsByProject,
  getInsightsByProject,
  listProjects,
} from "../src/store.js";

// --- Mocks ---

// Mock commander to prevent program.parse() from executing on import
vi.mock("commander", () => {
  const mockCommand = {
    name: vi.fn().mockReturnThis(),
    description: vi.fn().mockReturnThis(),
    version: vi.fn().mockReturnThis(),
    command: vi.fn().mockReturnThis(),
    requiredOption: vi.fn().mockReturnThis(),
    option: vi.fn().mockReturnThis(),
    action: vi.fn().mockReturnThis(),
    parse: vi.fn(),
  };
  return { Command: vi.fn(() => mockCommand) };
});

// Mock fs to control existsSync/statSync checks in handlers
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({ size: 4096 }),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    mkdirSync: vi.fn(),
  };
});

// Mock store module — override getDefaultDbPath, initDatabase, saveDatabase
// while keeping all the real CRUD functions
vi.mock("../src/store.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/store.js")>("../src/store.js");
  return {
    ...actual,
    getDefaultDbPath: vi.fn().mockReturnValue("/mock/db/path/store.db"),
    initDatabase: vi.fn(),
    saveDatabase: vi.fn(),
  };
});

import {
  existsSync,
  readFileSync,
  statSync,
  copyFileSync,
  readdirSync,
} from "fs";
import {
  initDatabase as mockInitDb,
  getDefaultDbPath,
  saveDatabase,
} from "../src/store.js";
import {
  handleStatus,
  handleSearch,
  handleProjects,
  handleExport,
  handleImport,
  handleReset,
  installCommands,
} from "../src/cli.js";

const mockExistsSync = vi.mocked(existsSync);
const mockInitDatabase = vi.mocked(mockInitDb);
const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);
const mockCopyFileSync = vi.mocked(copyFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

let db: Database;
const PROJECT = "/test/project";

beforeEach(async () => {
  vi.clearAllMocks();
  const SQL = await initSqlJs();
  db = new SQL.Database();
  initSchema(db);
  mockInitDatabase.mockResolvedValue(db);
  mockExistsSync.mockReturnValue(true);
  mockStatSync.mockReturnValue({ size: 4096 } as ReturnType<typeof statSync>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- handleStatus ---

describe("handleStatus", () => {
  it("prints counts and project info", async () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite", ["db"]);
    insertMemory(db, PROJECT, "pattern", "Singleton pattern", ["design"]);
    insertDeadEnd(db, PROJECT, "Redis", "Tried Redis", "Overkill");
    insertConstraint(db, PROJECT, "No API keys", "security", "must");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleStatus({ project: PROJECT });

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain(`Project: ${PROJECT}`);
    expect(output).toContain("Database:");
    expect(output).toContain("Counts:");
    expect(output).toContain("memories: 2");
    expect(output).toContain("dead_ends: 1");
    expect(output).toContain("constraints: 1");

    logSpy.mockRestore();
  });

  it("prints last extraction info when available", async () => {
    insertExtractionLog(db, PROJECT, "sess-1", "Stop", 3, 5);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleStatus({ project: PROJECT });

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Last extraction:");
    expect(output).toContain("Stop");
    expect(output).toContain("5 memories from 3 chunks");

    logSpy.mockRestore();
  });

  it("shows error and returns early when no database exists", async () => {
    mockExistsSync.mockReturnValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleStatus({});

    expect(errorSpy).toHaveBeenCalledWith(
      "No database found. Run 'memoria-solo setup' first.",
    );
    expect(logSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// --- handleSearch ---

describe("handleSearch", () => {
  it("finds memories matching query", async () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage", ["db"]);
    insertMemory(db, PROJECT, "pattern", "Singleton for config", ["design"]);
    insertMemory(db, PROJECT, "decision", "REST over GraphQL", ["api"]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleSearch("SQLite", { project: PROJECT });

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Use SQLite for storage");
    expect(output).toContain("[decision]");
    expect(output).toContain("1 result(s)");
    expect(output).not.toContain("Singleton");
    expect(output).not.toContain("GraphQL");

    logSpy.mockRestore();
  });

  it("shows 'no memories found' when nothing matches", async () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite", ["db"]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleSearch("nonexistent-query-xyz", { project: PROJECT });

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("No memories found matching your query.");

    logSpy.mockRestore();
  });

  it("filters by type when specified", async () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage", ["db"]);
    insertMemory(db, PROJECT, "pattern", "SQLite connection pooling", ["perf"]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleSearch("SQLite", { project: PROJECT, type: "pattern" });

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("[pattern]");
    expect(output).toContain("SQLite connection pooling");
    expect(output).toContain("1 result(s)");
    expect(output).not.toContain("[decision]");

    logSpy.mockRestore();
  });

  it("displays tags when present", async () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage", [
      "db",
      "persistence",
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleSearch("SQLite", { project: PROJECT });

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("tags: db, persistence");

    logSpy.mockRestore();
  });

  it("shows error when no database exists", async () => {
    mockExistsSync.mockReturnValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleSearch("test", {});

    expect(errorSpy).toHaveBeenCalledWith(
      "No database found. Run 'memoria-solo setup' first.",
    );

    errorSpy.mockRestore();
  });
});

// --- handleProjects ---

describe("handleProjects", () => {
  it("lists projects with memory counts", async () => {
    insertMemory(db, "/proj-a", "decision", "Decision A");
    insertMemory(db, "/proj-a", "pattern", "Pattern A");
    insertMemory(db, "/proj-b", "decision", "Decision B");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleProjects();

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("/proj-a (2 memories)");
    expect(output).toContain("/proj-b (1 memories)");

    logSpy.mockRestore();
  });

  it("shows message when no projects exist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleProjects();

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("No projects with memories yet.");

    logSpy.mockRestore();
  });

  it("shows error when no database exists", async () => {
    mockExistsSync.mockReturnValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleProjects();

    expect(errorSpy).toHaveBeenCalledWith(
      "No database found. Run 'memoria-solo setup' first.",
    );

    errorSpy.mockRestore();
  });
});

// --- handleExport ---

describe("handleExport", () => {
  it("exports all data as JSON with correct structure", async () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite", ["db"]);
    insertDeadEnd(db, PROJECT, "Redis", "Tried Redis", "Overkill");
    insertConstraint(db, PROJECT, "No API keys", "security", "must");
    insertGoal(db, PROJECT, "Ship v1", ["pass tests"]);
    insertCheckpoint(db, PROJECT, "sess-1", "Working", "Auth", "Tests");
    insertInsight(db, PROJECT, "WASM is fast", "architecture");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleExport({ project: PROJECT });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const exported = JSON.parse(logSpy.mock.calls[0][0]);

    expect(exported.version).toBe(1);
    expect(exported.exported_at).toBeDefined();
    expect(exported.memories).toHaveLength(1);
    expect(exported.memories[0].content).toBe("Use SQLite");
    expect(exported.dead_ends).toHaveLength(1);
    expect(exported.dead_ends[0].summary).toBe("Redis");
    expect(exported.constraints).toHaveLength(1);
    expect(exported.constraints[0].rule).toBe("No API keys");
    expect(exported.goals).toHaveLength(1);
    expect(exported.goals[0].intent).toBe("Ship v1");
    expect(exported.checkpoints).toHaveLength(1);
    expect(exported.checkpoints[0].current_state).toBe("Working");
    expect(exported.insights).toHaveLength(1);
    expect(exported.insights[0].content).toBe("WASM is fast");
    expect(exported.daily_summaries).toHaveLength(0);
    expect(exported.extraction_logs).toHaveLength(0);

    logSpy.mockRestore();
  });

  it("exports only data for specified project", async () => {
    insertMemory(db, "/proj-a", "decision", "Keep this");
    insertMemory(db, "/proj-b", "decision", "Skip this");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleExport({ project: "/proj-a" });

    const exported = JSON.parse(logSpy.mock.calls[0][0]);
    expect(exported.memories).toHaveLength(1);
    expect(exported.memories[0].content).toBe("Keep this");

    logSpy.mockRestore();
  });

  it("exports all projects when no project filter specified", async () => {
    insertMemory(db, "/proj-a", "decision", "A");
    insertMemory(db, "/proj-b", "decision", "B");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleExport({});

    const exported = JSON.parse(logSpy.mock.calls[0][0]);
    expect(exported.memories).toHaveLength(2);

    logSpy.mockRestore();
  });

  it("shows error when no database exists", async () => {
    mockExistsSync.mockReturnValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleExport({});

    expect(errorSpy).toHaveBeenCalledWith(
      "No database found. Run 'memoria-solo setup' first.",
    );

    errorSpy.mockRestore();
  });
});

// --- handleImport ---

describe("handleImport", () => {
  it("imports memories from JSON file", async () => {
    const importData = {
      version: 1,
      memories: [
        {
          project_path: PROJECT,
          type: "decision",
          content: "Imported decision",
          tags: ["imported"],
          confidence: 0.9,
        },
      ],
      dead_ends: [],
      constraints: [],
      goals: [],
      checkpoints: [],
      insights: [],
    };

    mockReadFileSync.mockReturnValue(JSON.stringify(importData));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleImport("/fake/path/export.json");

    expect(errorSpy).toHaveBeenCalledWith("Imported 1 items.");
    const memories = getMemoriesByProject(db, PROJECT);
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe("Imported decision");
    expect(memories[0].tags).toEqual(["imported"]);

    errorSpy.mockRestore();
  });

  it("imports dead_ends, constraints, goals, checkpoints, and insights", async () => {
    const importData = {
      version: 1,
      memories: [
        {
          project_path: PROJECT,
          type: "decision",
          content: "A decision",
          tags: [],
          confidence: 1.0,
        },
      ],
      dead_ends: [
        {
          project_path: PROJECT,
          summary: "Redis attempt",
          approach_tried: "Tried Redis",
          blocker: "Too complex",
          resume_when: null,
        },
      ],
      constraints: [
        {
          project_path: PROJECT,
          rule: "No API keys",
          type: "security",
          severity: "must",
          scope: null,
          source: null,
        },
      ],
      goals: [
        {
          project_path: PROJECT,
          intent: "Ship v1",
          done_when: ["all tests pass"],
        },
      ],
      checkpoints: [
        {
          project_path: PROJECT,
          session_id: "sess-1",
          current_state: "Working on auth",
          what_was_built: "Auth module",
          next_steps: "Add tests",
          branch: "main",
          decisions_made: "JWT",
          blockers: null,
          uncommitted_files: [],
        },
      ],
      insights: [
        {
          project_path: PROJECT,
          content: "WASM startup is fast",
          category: "architecture",
          context: null,
        },
      ],
    };

    mockReadFileSync.mockReturnValue(JSON.stringify(importData));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleImport("/fake/path/export.json");

    expect(errorSpy).toHaveBeenCalledWith("Imported 6 items.");
    expect(getMemoriesByProject(db, PROJECT)).toHaveLength(1);
    expect(getDeadEndsByProject(db, PROJECT)).toHaveLength(1);
    expect(getConstraintsByProject(db, PROJECT)).toHaveLength(1);
    expect(getInsightsByProject(db, PROJECT)).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it("handles import file read errors gracefully", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleImport("/nonexistent/file.json");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read import file:"),
    );

    errorSpy.mockRestore();
  });

  it("handles invalid JSON gracefully", async () => {
    mockReadFileSync.mockReturnValue("not valid json {{{");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleImport("/fake/bad.json");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read import file:"),
    );

    errorSpy.mockRestore();
  });

  it("imports zero items when arrays are missing", async () => {
    const importData = { version: 1 };

    mockReadFileSync.mockReturnValue(JSON.stringify(importData));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleImport("/fake/empty.json");

    expect(errorSpy).toHaveBeenCalledWith("Imported 0 items.");

    errorSpy.mockRestore();
  });
});

// --- handleReset ---

describe("handleReset", () => {
  it("resets all data with --force flag", async () => {
    insertMemory(db, "/proj-a", "decision", "A");
    insertMemory(db, "/proj-b", "decision", "B");
    insertDeadEnd(db, "/proj-a", "DE", "Tried", "Blocked");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleReset({ force: true });

    expect(errorSpy).toHaveBeenCalledWith("Reset all data.");
    // deleteAllData was called on the db — verify counts are zero
    const counts = countAll(db);
    expect(counts.memories).toBe(0);
    expect(counts.dead_ends).toBe(0);

    errorSpy.mockRestore();
  });

  it("resets only specified project data with --force flag", async () => {
    insertMemory(db, "/proj-a", "decision", "Keep this");
    insertMemory(db, "/proj-b", "decision", "Delete this");
    insertDeadEnd(db, "/proj-b", "DE", "Tried", "Blocked");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleReset({ project: "/proj-b", force: true });

    expect(errorSpy).toHaveBeenCalledWith("Reset data for project: /proj-b");
    expect(getMemoriesByProject(db, "/proj-a")).toHaveLength(1);
    expect(getMemoriesByProject(db, "/proj-b")).toHaveLength(0);
    expect(getDeadEndsByProject(db, "/proj-b")).toHaveLength(0);

    errorSpy.mockRestore();
  });

  it("shows error when no database exists", async () => {
    mockExistsSync.mockReturnValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleReset({ force: true });

    expect(errorSpy).toHaveBeenCalledWith(
      "No database found. Nothing to reset.",
    );

    errorSpy.mockRestore();
  });
});

// --- installCommands ---

describe("installCommands", () => {
  it("copies files when target does not exist", () => {
    mockReaddirSync.mockReturnValue([
      "memo-checkpoint.md",
      "memo-resume.md",
      "memo-insight.md",
      "memo-eod.md",
    ] as unknown as ReturnType<typeof readdirSync>);
    mockExistsSync.mockReturnValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = installCommands();

    expect(result.installed).toBe(4);
    expect(result.skipped).toBe(0);
    expect(mockCopyFileSync).toHaveBeenCalledTimes(4);

    errorSpy.mockRestore();
  });

  it("skips files when target already exists", () => {
    mockReaddirSync.mockReturnValue([
      "memo-checkpoint.md",
      "memo-resume.md",
    ] as unknown as ReturnType<typeof readdirSync>);
    mockExistsSync.mockReturnValue(true);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = installCommands();

    expect(result.installed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(mockCopyFileSync).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("handles mix of new and existing files", () => {
    mockReaddirSync.mockReturnValue([
      "memo-checkpoint.md",
      "memo-resume.md",
      "memo-insight.md",
    ] as unknown as ReturnType<typeof readdirSync>);

    // First call: ensureDir check, second+: per-file existsSync
    let callCount = 0;
    mockExistsSync.mockImplementation(() => {
      callCount++;
      // First call is ensureDir check (returns false to trigger mkdir)
      if (callCount <= 1) return false;
      // memo-checkpoint.md exists, memo-resume.md and memo-insight.md don't
      return callCount === 2;
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = installCommands();

    expect(result.installed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(mockCopyFileSync).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });

  it("logs installed and skipped command names", () => {
    mockReaddirSync.mockReturnValue([
      "memo-checkpoint.md",
      "memo-resume.md",
    ] as unknown as ReturnType<typeof readdirSync>);

    let callCount = 0;
    mockExistsSync.mockImplementation(() => {
      callCount++;
      if (callCount <= 1) return false;
      return callCount === 2; // first file exists, second doesn't
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    installCommands();

    const output = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Skipping memo-checkpoint");
    expect(output).toContain("Installed /memo-resume");

    errorSpy.mockRestore();
  });
});
