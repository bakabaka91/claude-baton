import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import {
  initSchema,
  insertCheckpoint,
  insertDailySummary,
  countAll,
  listProjects,
  getAllCheckpoints,
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
  const mockReadFileSync = vi
    .fn()
    .mockImplementation((p: string, ...args: unknown[]) => {
      // Allow package.json reads to pass through for version loading
      if (typeof p === "string" && p.endsWith("package.json")) {
        return actual.readFileSync(p, ...(args as [BufferEncoding]));
      }
      return undefined;
    });
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({ size: 4096 }),
    readFileSync: mockReadFileSync,
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// Mock os to return a consistent test home path
vi.mock("os", () => {
  return {
    default: {
      homedir: vi.fn().mockReturnValue("/mock/home"),
      platform: vi.fn().mockReturnValue("darwin"),
      tmpdir: vi.fn().mockReturnValue("/tmp"),
    },
    homedir: vi.fn().mockReturnValue("/mock/home"),
    platform: vi.fn().mockReturnValue("darwin"),
    tmpdir: vi.fn().mockReturnValue("/tmp"),
  };
});

// Mock LLM calls
vi.mock("../src/llm.js", () => ({
  callClaude: vi.fn(),
  callClaudeJson: vi.fn(),
}));

// Mock child_process for git commands in auto-checkpoint
vi.mock("child_process", () => ({
  execSync: vi.fn().mockReturnValue(""),
}));

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
  writeFileSync,
  statSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
  rmSync,
} from "fs";
import {
  initDatabase as mockInitDb,
  getDefaultDbPath,
  saveDatabase,
  getLatestCheckpoint,
} from "../src/store.js";
import {
  handleStatus,
  handleProjects,
  handleExport,
  handleImport,
  handleReset,
  handleUninstall,
  handleSetup,
  handleAutoCheckpoint,
  installCommands,
} from "../src/cli.js";
import { callClaudeJson } from "../src/llm.js";
import os from "os";

const mockCallClaudeJson = vi.mocked(callClaudeJson);

const mockExistsSync = vi.mocked(existsSync);
const mockInitDatabase = vi.mocked(mockInitDb);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockStatSync = vi.mocked(statSync);
const mockCopyFileSync = vi.mocked(copyFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockRmSync = vi.mocked(rmSync);

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
  vi.mocked(os.homedir).mockReturnValue("/mock/home");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- handleStatus ---

describe("handleStatus", () => {
  it("prints counts and project info", async () => {
    insertCheckpoint(db, PROJECT, "sess-1", "Working", "Auth", "Tests");
    insertCheckpoint(
      db,
      PROJECT,
      "sess-2",
      "Refactoring",
      "DB layer",
      "Deploy",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleStatus({ project: PROJECT });

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain(`Project: ${PROJECT}`);
    expect(output).toContain("Database:");
    expect(output).toContain("Counts:");
    expect(output).toContain("checkpoints: 2");

    logSpy.mockRestore();
  });

  it("shows error and returns early when no database exists", async () => {
    mockExistsSync.mockReturnValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleStatus({});

    expect(errorSpy).toHaveBeenCalledWith(
      "No database found. Run 'claude-baton setup' first.",
    );
    expect(logSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// --- handleProjects ---

describe("handleProjects", () => {
  it("lists projects with checkpoint counts", async () => {
    insertCheckpoint(db, "/proj-a", "sess-1", "Working", "Auth", "Tests");
    insertCheckpoint(db, "/proj-a", "sess-2", "Refactoring", "DB", "Deploy");
    insertCheckpoint(db, "/proj-b", "sess-3", "Starting", "Setup", "Code");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleProjects();

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("/proj-a (2 checkpoints)");
    expect(output).toContain("/proj-b (1 checkpoints)");

    logSpy.mockRestore();
  });

  it("shows message when no projects exist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleProjects();

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("No projects with checkpoints yet.");

    logSpy.mockRestore();
  });

  it("shows error when no database exists", async () => {
    mockExistsSync.mockReturnValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleProjects();

    expect(errorSpy).toHaveBeenCalledWith(
      "No database found. Run 'claude-baton setup' first.",
    );

    errorSpy.mockRestore();
  });
});

// --- handleExport ---

describe("handleExport", () => {
  it("exports checkpoints and daily summaries as JSON", async () => {
    insertCheckpoint(db, PROJECT, "sess-1", "Working", "Auth", "Tests");
    insertDailySummary(db, PROJECT, "2025-01-01", {
      commits: 5,
      summary: "Good day",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleExport({ project: PROJECT });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const exported = JSON.parse(logSpy.mock.calls[0][0]);

    expect(exported.version).toBe(2);
    expect(exported.exported_at).toBeDefined();
    expect(exported.checkpoints).toHaveLength(1);
    expect(exported.checkpoints[0].current_state).toBe("Working");
    expect(exported.daily_summaries).toHaveLength(1);
    expect(exported.daily_summaries[0].summary.summary).toBe("Good day");

    logSpy.mockRestore();
  });

  it("exports only data for specified project", async () => {
    insertCheckpoint(db, "/proj-a", "sess-1", "Working", "Auth", "Tests");
    insertCheckpoint(db, "/proj-b", "sess-2", "Starting", "Setup", "Code");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleExport({ project: "/proj-a" });

    const exported = JSON.parse(logSpy.mock.calls[0][0]);
    expect(exported.checkpoints).toHaveLength(1);
    expect(exported.checkpoints[0].current_state).toBe("Working");

    logSpy.mockRestore();
  });

  it("exports all projects when no project filter specified", async () => {
    insertCheckpoint(db, "/proj-a", "sess-1", "Working", "Auth", "Tests");
    insertCheckpoint(db, "/proj-b", "sess-2", "Starting", "Setup", "Code");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleExport({});

    const exported = JSON.parse(logSpy.mock.calls[0][0]);
    expect(exported.checkpoints).toHaveLength(2);

    logSpy.mockRestore();
  });

  it("shows error when no database exists", async () => {
    mockExistsSync.mockReturnValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleExport({});

    expect(errorSpy).toHaveBeenCalledWith(
      "No database found. Run 'claude-baton setup' first.",
    );

    errorSpy.mockRestore();
  });
});

// --- handleImport ---

describe("handleImport", () => {
  it("imports checkpoints from JSON file", async () => {
    const importData = {
      version: 2,
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
          git_snapshot: "abc123 Initial commit",
        },
      ],
    };

    mockReadFileSync.mockReturnValue(JSON.stringify(importData));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleImport("/fake/path/export.json");

    expect(errorSpy).toHaveBeenCalledWith("Imported 1 items.");
    const checkpoints = getAllCheckpoints(db, PROJECT);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].current_state).toBe("Working on auth");

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
    const importData = { version: 2 };

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
    insertCheckpoint(db, "/proj-a", "sess-1", "Working", "Auth", "Tests");
    insertCheckpoint(db, "/proj-b", "sess-2", "Starting", "Setup", "Code");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleReset({ force: true });

    expect(errorSpy).toHaveBeenCalledWith("Reset all data.");
    const counts = countAll(db);
    expect(counts.checkpoints).toBe(0);

    errorSpy.mockRestore();
  });

  it("resets only specified project data with --force flag", async () => {
    insertCheckpoint(db, "/proj-a", "sess-1", "Keep this", "Auth", "Tests");
    insertCheckpoint(db, "/proj-b", "sess-2", "Delete this", "Setup", "Code");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleReset({ project: "/proj-b", force: true });

    expect(errorSpy).toHaveBeenCalledWith("Reset data for project: /proj-b");
    expect(getAllCheckpoints(db, "/proj-a")).toHaveLength(1);
    expect(getAllCheckpoints(db, "/proj-b")).toHaveLength(0);

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

    // Per-file existsSync: memo-checkpoint.md exists, others don't
    let callCount = 0;
    mockExistsSync.mockImplementation(() => {
      callCount++;
      return callCount === 1;
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
      return callCount === 1; // first file exists (skip), second doesn't (install)
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    installCommands();

    const output = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Skipping memo-checkpoint");
    expect(output).toContain("Installed /memo-resume");

    errorSpy.mockRestore();
  });
});

// --- handleUninstall ---

describe("handleUninstall", () => {
  const settingsPath = "/mock/home/.claude/settings.json";
  const commandsDir = "/mock/home/.claude/commands";

  it("removes MCP server from settings.json", async () => {
    const settings = {
      mcpServers: {
        "claude-baton": {
          command: "npx",
          args: ["-y", "claude-baton", "serve"],
        },
        "other-server": {
          command: "node",
          args: ["other.js"],
        },
      },
    };

    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return true;
      if (p === commandsDir) return false;
      if (p === "/mock/home/.claude-baton") return false;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(settings));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleUninstall({ keepData: true });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      settingsPath,
      expect.any(String),
    );
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers["claude-baton"]).toBeUndefined();
    expect(written.mcpServers["other-server"]).toBeDefined();

    errorSpy.mockRestore();
  });

  it("removes mcpServers key when empty after removal", async () => {
    const settings = {
      someOtherSetting: true,
      mcpServers: {
        "claude-baton": {
          command: "npx",
          args: ["-y", "claude-baton", "serve"],
        },
      },
    };

    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return true;
      if (p === commandsDir) return false;
      if (p === "/mock/home/.claude-baton") return false;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(settings));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleUninstall({ keepData: true });

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers).toBeUndefined();
    expect(written.someOtherSetting).toBe(true);

    errorSpy.mockRestore();
  });

  it("removes memo-*.md command files", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return false;
      if (p === commandsDir) return true;
      if (p === "/mock/home/.claude-baton") return false;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      "memo-checkpoint.md",
      "memo-resume.md",
      "memo-insight.md",
      "memo-eod.md",
    ] as unknown as ReturnType<typeof readdirSync>);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleUninstall({ keepData: true });

    expect(mockUnlinkSync).toHaveBeenCalledTimes(4);
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      `${commandsDir}/memo-checkpoint.md`,
    );
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      `${commandsDir}/memo-resume.md`,
    );
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      `${commandsDir}/memo-insight.md`,
    );
    expect(mockUnlinkSync).toHaveBeenCalledWith(`${commandsDir}/memo-eod.md`);

    const output = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Removed 4 slash commands");

    errorSpy.mockRestore();
  });

  it("does not remove non-memo command files", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return false;
      if (p === commandsDir) return true;
      if (p === "/mock/home/.claude-baton") return false;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      "memo-checkpoint.md",
      "other-command.md",
      "review-pr.md",
      "memo-eod.md",
    ] as unknown as ReturnType<typeof readdirSync>);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleUninstall({ keepData: true });

    // Only the memo-* files should be removed
    expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      `${commandsDir}/memo-checkpoint.md`,
    );
    expect(mockUnlinkSync).toHaveBeenCalledWith(`${commandsDir}/memo-eod.md`);

    const output = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Removed 2 slash commands");

    errorSpy.mockRestore();
  });

  it("deletes database directory with --force", async () => {
    const dbDir = "/mock/home/.claude-baton";

    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return false;
      if (p === commandsDir) return false;
      if (p === dbDir) return true;
      return false;
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleUninstall({ force: true });

    expect(mockRmSync).toHaveBeenCalledWith(dbDir, { recursive: true });

    const output = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Deleted database");

    errorSpy.mockRestore();
  });

  it("keeps database with --keep-data", async () => {
    const dbDir = "/mock/home/.claude-baton";

    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return false;
      if (p === commandsDir) return false;
      if (p === dbDir) return true;
      return false;
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleUninstall({ keepData: true });

    expect(mockRmSync).not.toHaveBeenCalled();

    const output = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Kept database (--keep-data)");

    errorSpy.mockRestore();
  });

  it("handles missing settings.json gracefully", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return false;
      if (p === commandsDir) return false;
      if (p === "/mock/home/.claude-baton") return false;
      return false;
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleUninstall({ keepData: true });

    // Should not attempt to read or write settings.json
    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();

    // Should still complete successfully
    const output = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Uninstall complete");

    errorSpy.mockRestore();
  });

  it("handles missing commands directory gracefully", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return false;
      if (p === commandsDir) return false;
      if (p === "/mock/home/.claude-baton") return false;
      return false;
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleUninstall({ keepData: true });

    // Should not try to read or unlink files from missing dir
    expect(mockUnlinkSync).not.toHaveBeenCalled();

    const output = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Removed 0 slash commands");

    errorSpy.mockRestore();
  });

  it("removes PreCompact hook from settings.json", async () => {
    const settings = {
      mcpServers: {
        "claude-baton": {
          command: "npx",
          args: ["-y", "claude-baton", "serve"],
        },
      },
      hooks: {
        PreCompact: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "npx -y claude-baton auto-checkpoint",
              },
            ],
          },
        ],
      },
    };

    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return true;
      if (p === commandsDir) return false;
      if (p === "/mock/home/.claude-baton") return false;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(settings));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleUninstall({ keepData: true });

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.hooks).toBeUndefined();

    errorSpy.mockRestore();
  });

  it("preserves non-memoria PreCompact hooks during uninstall", async () => {
    const settings = {
      hooks: {
        PreCompact: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "npx -y claude-baton auto-checkpoint",
              },
            ],
          },
          {
            matcher: "",
            hooks: [{ type: "command", command: "npx other-tool pre-compact" }],
          },
        ],
      },
    };

    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return true;
      if (p === commandsDir) return false;
      if (p === "/mock/home/.claude-baton") return false;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(settings));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleUninstall({ keepData: true });

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.hooks.PreCompact).toHaveLength(1);
    expect(written.hooks.PreCompact[0].hooks[0].command).toBe(
      "npx other-tool pre-compact",
    );

    errorSpy.mockRestore();
  });
});

// --- handleSetup ---

describe("handleSetup", () => {
  const settingsPath = "/mock/home/.claude/settings.json";

  it("registers PreCompact hook in settings.json", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({}));
    mockReaddirSync.mockReturnValue(
      [] as unknown as ReturnType<typeof readdirSync>,
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleSetup();

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.hooks.PreCompact).toHaveLength(1);
    expect(written.hooks.PreCompact[0].hooks[0].command).toContain(
      "claude-baton.js auto-checkpoint",
    );

    errorSpy.mockRestore();
  });

  it("preserves existing hooks during setup", async () => {
    const existing = {
      hooks: {
        Stop: [{ type: "command", command: "echo done" }],
      },
    };

    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));
    mockReaddirSync.mockReturnValue(
      [] as unknown as ReturnType<typeof readdirSync>,
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleSetup();

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.hooks.Stop).toHaveLength(1);
    expect(written.hooks.Stop[0].command).toBe("echo done");
    expect(written.hooks.PreCompact).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it("skips PreCompact hook if already registered", async () => {
    const existing = {
      hooks: {
        PreCompact: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "npx -y claude-baton auto-checkpoint",
              },
            ],
          },
        ],
      },
    };

    mockExistsSync.mockImplementation((p) => {
      if (p === settingsPath) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));
    mockReaddirSync.mockReturnValue(
      [] as unknown as ReturnType<typeof readdirSync>,
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleSetup();

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    // Should still have exactly 1, not duplicated
    expect(written.hooks.PreCompact).toHaveLength(1);

    errorSpy.mockRestore();
  });
});

// --- handleAutoCheckpoint ---

describe("handleAutoCheckpoint", () => {
  it("saves checkpoint from transcript via LLM", async () => {
    const hookInput = {
      transcript_path: "/tmp/test-transcript.txt",
      session_id: "test-session",
      hook_event_name: "PreCompact",
    };

    // Mock stdin read
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === 0) return JSON.stringify(hookInput);
      if (p === "/tmp/test-transcript.txt")
        return "User asked to build auth module. Assistant built it.";
      if (typeof p === "string" && p.endsWith("package.json")) {
        return '{"version":"2.0.0"}';
      }
      if (typeof p === "string" && p.endsWith("auto_checkpoint.txt"))
        return "Extract: {{TRANSCRIPT}}";
      return "";
    });

    mockCallClaudeJson.mockResolvedValue({
      what_was_built: "Auth module",
      current_state: "Tests passing",
      next_steps: "Deploy",
      decisions_made: "JWT",
      blockers: "None",
      plan_reference: null,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleAutoCheckpoint();

    expect(mockCallClaudeJson).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[claude-baton] Auto-checkpoint saved before compaction",
    );

    // Verify checkpoint was saved to DB
    const checkpoints = getAllCheckpoints(db);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].what_was_built).toBe("Auth module");
    expect(checkpoints[0].current_state).toBe("Tests passing");

    errorSpy.mockRestore();
  });

  it("exits gracefully when no stdin data", async () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === 0) throw new Error("EOF");
      if (typeof p === "string" && p.endsWith("package.json"))
        return '{"version":"2.0.0"}';
      return "";
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleAutoCheckpoint();

    expect(errorSpy).toHaveBeenCalledWith(
      "[claude-baton] No stdin data, skipping auto-checkpoint",
    );
    expect(mockCallClaudeJson).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("exits gracefully when transcript file not found", async () => {
    const hookInput = {
      transcript_path: "/nonexistent/transcript.txt",
      session_id: "test-session",
      hook_event_name: "PreCompact",
    };

    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === 0) return JSON.stringify(hookInput);
      if (typeof p === "string" && p.endsWith("package.json"))
        return '{"version":"2.0.0"}';
      return "";
    });
    mockExistsSync.mockImplementation((p) => {
      if (p === "/nonexistent/transcript.txt") return false;
      return true;
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleAutoCheckpoint();

    expect(errorSpy).toHaveBeenCalledWith(
      "[claude-baton] Transcript not found, skipping auto-checkpoint",
    );
    expect(mockCallClaudeJson).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("exits gracefully when LLM call fails", async () => {
    const hookInput = {
      transcript_path: "/tmp/test-transcript.txt",
      session_id: "test-session",
      hook_event_name: "PreCompact",
    };

    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === 0) return JSON.stringify(hookInput);
      if (p === "/tmp/test-transcript.txt") return "Some transcript content";
      if (typeof p === "string" && p.endsWith("package.json"))
        return '{"version":"2.0.0"}';
      if (typeof p === "string" && p.endsWith("auto_checkpoint.txt"))
        return "Extract: {{TRANSCRIPT}}";
      return "";
    });

    mockCallClaudeJson.mockRejectedValue(new Error("LLM timeout"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleAutoCheckpoint();

    expect(errorSpy).toHaveBeenCalledWith(
      "[claude-baton] Auto-checkpoint failed: LLM timeout",
    );

    errorSpy.mockRestore();
  });

  it("chains auto-checkpoint with previous checkpoint context", async () => {
    // Insert a previous checkpoint
    insertCheckpoint(db, process.cwd(), "prev-session", "Build passing", "Auth module", "Add tests", {
      gitSnapshot: "abc1234 feat: add auth",
      source: "auto",
    });

    const hookInput = {
      transcript_path: "/tmp/test-transcript.txt",
      session_id: "test-session",
      hook_event_name: "PreCompact",
    };

    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === 0) return JSON.stringify(hookInput);
      if (p === "/tmp/test-transcript.txt") return "User added more features.";
      if (typeof p === "string" && p.endsWith("package.json"))
        return '{"version":"2.0.0"}';
      if (typeof p === "string" && p.endsWith("auto_checkpoint.txt"))
        return "PREV: {{PREVIOUS_CHECKPOINT}}\nDIFF: {{GIT_DIFF}}\nTRANSCRIPT: {{TRANSCRIPT}}";
      return "";
    });

    mockCallClaudeJson.mockResolvedValue({
      what_was_built: "More features",
      current_state: "All passing",
      next_steps: "Deploy",
      decisions_made: "None",
      blockers: "None",
      plan_reference: null,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleAutoCheckpoint();

    // Verify prompt contains previous checkpoint's what_was_built
    const promptArg = mockCallClaudeJson.mock.calls[0][0];
    expect(promptArg).toContain("Auth module");
    expect(promptArg).toContain("Build passing");

    errorSpy.mockRestore();
  });

  it("handles first auto-checkpoint with no previous checkpoint", async () => {
    const hookInput = {
      transcript_path: "/tmp/test-transcript.txt",
      session_id: "test-session",
      hook_event_name: "PreCompact",
    };

    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === 0) return JSON.stringify(hookInput);
      if (p === "/tmp/test-transcript.txt") return "Starting fresh project.";
      if (typeof p === "string" && p.endsWith("package.json"))
        return '{"version":"2.0.0"}';
      if (typeof p === "string" && p.endsWith("auto_checkpoint.txt"))
        return "PREV: {{PREVIOUS_CHECKPOINT}}\nDIFF: {{GIT_DIFF}}\nTRANSCRIPT: {{TRANSCRIPT}}";
      return "";
    });

    mockCallClaudeJson.mockResolvedValue({
      what_was_built: "Initial setup",
      current_state: "Fresh",
      next_steps: "Build features",
      decisions_made: "None",
      blockers: "None",
      plan_reference: null,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleAutoCheckpoint();

    // Verify "No previous checkpoint" fallback in prompt
    const promptArg = mockCallClaudeJson.mock.calls[0][0];
    expect(promptArg).toContain("No previous checkpoint");

    errorSpy.mockRestore();
  });

  it("saves auto-checkpoint with source 'auto'", async () => {
    const hookInput = {
      transcript_path: "/tmp/test-transcript.txt",
      session_id: "test-session",
      hook_event_name: "PreCompact",
    };

    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === 0) return JSON.stringify(hookInput);
      if (p === "/tmp/test-transcript.txt") return "Did some work.";
      if (typeof p === "string" && p.endsWith("package.json"))
        return '{"version":"2.0.0"}';
      if (typeof p === "string" && p.endsWith("auto_checkpoint.txt"))
        return "PREV: {{PREVIOUS_CHECKPOINT}}\nDIFF: {{GIT_DIFF}}\nTRANSCRIPT: {{TRANSCRIPT}}";
      return "";
    });

    mockCallClaudeJson.mockResolvedValue({
      what_was_built: "Some work",
      current_state: "Passing",
      next_steps: "More work",
      decisions_made: "None",
      blockers: "None",
      plan_reference: null,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleAutoCheckpoint();

    const checkpoints = getAllCheckpoints(db);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].source).toBe("auto");

    errorSpy.mockRestore();
  });
});
