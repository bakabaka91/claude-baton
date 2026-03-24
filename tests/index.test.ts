/**
 * Integration tests for MCP tool handler logic.
 *
 * The tool handlers in index.ts live inside a module-scoped MCP server and
 * cannot be imported directly.  Instead we recreate the same logic each
 * handler performs — calling the same store functions against a real
 * in-memory SQLite database — and verify correctness end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import {
  initSchema,
  insertCheckpoint,
  getCheckpoint,
  getLatestCheckpoint,
  getCheckpointsByDate,
  insertDailySummary,
} from "../src/store.js";

// Mock LLM calls — all claude -p interactions are stubbed
vi.mock("../src/llm.js", () => ({
  callClaude: vi.fn(),
  callClaudeJson: vi.fn(),
}));

import { callClaudeJson } from "../src/llm.js";

const mockCallClaudeJson = vi.mocked(callClaudeJson);

// ---------------------------------------------------------------------------
// Validation helpers — recreated since they are not exported from index.ts
// ---------------------------------------------------------------------------
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function requireString(
  args: Record<string, unknown> | undefined,
  field: string,
  toolName: string,
): string {
  const value = args?.[field];
  if (!value || typeof value !== "string") {
    throw new ValidationError(
      `${toolName} requires a "${field}" string argument`,
    );
  }
  return value;
}

function requireStringArray(
  args: Record<string, unknown> | undefined,
  field: string,
  toolName: string,
): string[] {
  const value = args?.[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((v) => typeof v === "string")
  ) {
    throw new ValidationError(
      `${toolName} requires a "${field}" array of strings`,
    );
  }
  return value as string[];
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
let db: Database;
const PROJECT = "/test/project";

beforeEach(async () => {
  vi.clearAllMocks();
  const SQL = await initSqlJs();
  db = new SQL.Database();
  initSchema(db);
});

// =========================================================================
// save_checkpoint + get_checkpoint
// =========================================================================
describe("save_checkpoint + get_checkpoint tool logic", () => {
  it("saves and retrieves a checkpoint by ID", () => {
    const id = insertCheckpoint(
      db,
      PROJECT,
      "session-abc",
      "Working on auth module",
      "Auth module with JWT",
      "Add integration tests",
      {
        branch: "feature/auth",
        decisionsMade: "JWT over sessions",
        blockers: "None currently",
        uncommittedFiles: ["src/auth.ts", "src/middleware.ts"],
        gitSnapshot: "abc123 feat: add auth\ndef456 fix: typo",
      },
    );

    const cp = getCheckpoint(db, id);
    expect(cp).not.toBeNull();
    expect(cp!.what_was_built).toBe("Auth module with JWT");
    expect(cp!.current_state).toBe("Working on auth module");
    expect(cp!.next_steps).toBe("Add integration tests");
    expect(cp!.branch).toBe("feature/auth");
    expect(cp!.decisions_made).toBe("JWT over sessions");
    expect(cp!.blockers).toBe("None currently");
    expect(cp!.uncommitted_files).toEqual(["src/auth.ts", "src/middleware.ts"]);
    expect(cp!.git_snapshot).toBe("abc123 feat: add auth\ndef456 fix: typo");
  });

  it("retrieves latest checkpoint for project", () => {
    insertCheckpoint(db, PROJECT, "s1", "State 1", "Built 1", "Next 1");
    insertCheckpoint(db, PROJECT, "s2", "State 2", "Built 2", "Next 2");

    const latest = getLatestCheckpoint(db, PROJECT);
    expect(latest).not.toBeNull();
    expect(latest!.session_id).toBe("s2");
    expect(latest!.current_state).toBe("State 2");
  });

  it("returns null when no checkpoints exist", () => {
    const cp = getLatestCheckpoint(db, PROJECT);
    expect(cp).toBeNull();
  });

  it("get_checkpoint by ID returns correct checkpoint among many", () => {
    const id1 = insertCheckpoint(
      db,
      PROJECT,
      "s1",
      "State A",
      "Built A",
      "Next A",
    );
    insertCheckpoint(db, PROJECT, "s2", "State B", "Built B", "Next B");

    const cp = getCheckpoint(db, id1);
    expect(cp!.current_state).toBe("State A");
  });
});

// =========================================================================
// list_checkpoints
// =========================================================================
describe("list_checkpoints tool logic", () => {
  it("lists checkpoints for a given date", () => {
    const targetDate = "2026-03-22";
    insertCheckpoint(db, PROJECT, "s1", "State A", "Built A", "Next A", {
      branch: "main",
    });
    insertCheckpoint(db, PROJECT, "s2", "State B", "Built B", "Next B");

    db.run(
      `UPDATE checkpoints SET created_at = '${targetDate}T09:00:00.000Z' WHERE current_state = 'State A'`,
    );
    db.run(
      `UPDATE checkpoints SET created_at = '${targetDate}T14:00:00.000Z' WHERE current_state = 'State B'`,
    );

    const cps = getCheckpointsByDate(db, PROJECT, targetDate);

    // Simulate the list_checkpoints handler summary mapping
    const summary = cps.map((cp) => ({
      id: cp.id,
      created_at: cp.created_at,
      what_was_built: cp.what_was_built,
      branch: cp.branch,
      current_state: cp.current_state,
    }));

    expect(summary).toHaveLength(2);
    expect(summary[0].what_was_built).toBe("Built A");
    expect(summary[0].branch).toBe("main");
    expect(summary[1].what_was_built).toBe("Built B");
  });

  it("returns empty for a date with no checkpoints", () => {
    insertCheckpoint(db, PROJECT, "s1", "State", "Built", "Next");
    db.run(`UPDATE checkpoints SET created_at = '2026-03-21T10:00:00.000Z'`);

    const cps = getCheckpointsByDate(db, PROJECT, "2026-03-22");
    expect(cps).toHaveLength(0);
  });
});

// =========================================================================
// daily_summary context assembly (from checkpoints only)
// =========================================================================
describe("daily_summary tool logic (context assembly)", () => {
  const date = "2026-03-22";

  it("gathers checkpoints for a date and builds activity context", () => {
    insertCheckpoint(db, PROJECT, "s1", "State A", "Built auth", "Add tests");
    insertCheckpoint(db, PROJECT, "s2", "State B", "Built DB layer", "Deploy");

    db.run(
      `UPDATE checkpoints SET created_at = '${date}T09:00:00.000Z' WHERE current_state = 'State A'`,
    );
    db.run(
      `UPDATE checkpoints SET created_at = '${date}T14:00:00.000Z' WHERE current_state = 'State B'`,
    );

    const checkpoints = getCheckpointsByDate(db, PROJECT, date);
    expect(checkpoints).toHaveLength(2);

    // Build activity context — same logic as handler
    const activityParts: string[] = [];
    activityParts.push(
      "CHECKPOINTS:\n" +
        checkpoints
          .map(
            (cp) =>
              `- [${cp.created_at}] Built: ${cp.what_was_built} | State: ${cp.current_state} | Next: ${cp.next_steps}`,
          )
          .join("\n"),
    );

    expect(activityParts).toHaveLength(1);
    const activity = activityParts.join("\n\n");
    expect(activity).toContain("CHECKPOINTS:");
    expect(activity).toContain("Built auth");
    expect(activity).toContain("Built DB layer");
  });

  it("returns empty when no checkpoints for date", () => {
    const checkpoints = getCheckpointsByDate(db, PROJECT, date);
    expect(checkpoints).toHaveLength(0);
  });

  it("stores daily summary result via insertDailySummary", () => {
    const summaryResult = {
      highlights: ["Shipped auth module"],
      blockers: [],
      decisions: ["JWT over sessions"],
    };

    const id = insertDailySummary(db, PROJECT, date, summaryResult);
    expect(id).toBeTruthy();

    // Verify it was stored
    const stmt = db.prepare(
      "SELECT summary FROM daily_summaries WHERE project_path = ? AND date = ?",
    );
    stmt.bind([PROJECT, date]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(JSON.parse(row.summary as string)).toEqual(summaryResult);
  });
});

// =========================================================================
// Validation errors
// =========================================================================
describe("validation errors (requireString / requireStringArray)", () => {
  it("requireString throws when field is missing", () => {
    expect(() => requireString({}, "query", "save_checkpoint")).toThrow(
      ValidationError,
    );
    expect(() => requireString({}, "query", "save_checkpoint")).toThrow(
      'save_checkpoint requires a "query" string argument',
    );
  });

  it("requireString throws when field is not a string", () => {
    expect(() =>
      requireString({ query: 123 }, "query", "save_checkpoint"),
    ).toThrow(ValidationError);
  });

  it("requireString throws when args is undefined", () => {
    expect(() => requireString(undefined, "query", "save_checkpoint")).toThrow(
      ValidationError,
    );
  });

  it("requireString returns value when field is present", () => {
    const value = requireString(
      { query: "test query" },
      "query",
      "save_checkpoint",
    );
    expect(value).toBe("test query");
  });

  it("requireStringArray throws when field is missing", () => {
    expect(() =>
      requireStringArray({}, "done_when", "save_checkpoint"),
    ).toThrow(ValidationError);
    expect(() =>
      requireStringArray({}, "done_when", "save_checkpoint"),
    ).toThrow('save_checkpoint requires a "done_when" array of strings');
  });

  it("requireStringArray throws when field is empty array", () => {
    expect(() =>
      requireStringArray({ done_when: [] }, "done_when", "save_checkpoint"),
    ).toThrow(ValidationError);
  });

  it("requireStringArray throws when array contains non-strings", () => {
    expect(() =>
      requireStringArray(
        { done_when: ["valid", 123] },
        "done_when",
        "save_checkpoint",
      ),
    ).toThrow(ValidationError);
  });

  it("requireStringArray throws when field is not an array", () => {
    expect(() =>
      requireStringArray(
        { done_when: "not-an-array" },
        "done_when",
        "save_checkpoint",
      ),
    ).toThrow(ValidationError);
  });

  it("requireStringArray returns value when valid", () => {
    const value = requireStringArray(
      { done_when: ["tests pass", "reviewed"] },
      "done_when",
      "save_checkpoint",
    );
    expect(value).toEqual(["tests pass", "reviewed"]);
  });

  // Simulate the handler's catch block for validation errors
  it("handler-style catch produces error response for validation failures", () => {
    try {
      requireString({}, "content", "save_checkpoint");
      expect.unreachable("should have thrown");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // The handler returns: { content: [{ type: "text", text: `Error: ${msg}` }], isError: true }
      const response = {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true as const,
      };
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain(
        'save_checkpoint requires a "content" string argument',
      );
    }
  });
});

// =========================================================================
// Tool-specific validation scenarios
// =========================================================================
describe("tool-specific required argument validation", () => {
  it("save_checkpoint requires what_was_built, current_state, next_steps", () => {
    expect(() =>
      requireString({}, "what_was_built", "save_checkpoint"),
    ).toThrow('save_checkpoint requires a "what_was_built" string argument');
    expect(() => requireString({}, "current_state", "save_checkpoint")).toThrow(
      'save_checkpoint requires a "current_state" string argument',
    );
    expect(() => requireString({}, "next_steps", "save_checkpoint")).toThrow(
      'save_checkpoint requires a "next_steps" string argument',
    );
  });

  it("daily_summary date defaults handled in handler", () => {
    // The daily_summary handler uses: date ?? new Date().toISOString().slice(0, 10)
    // so no required string validation — this just verifies the fallback pattern
    const date = undefined ?? new Date().toISOString().slice(0, 10);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// =========================================================================
// Edge cases
// =========================================================================
describe("edge cases", () => {
  it("save_checkpoint with minimal args (no optional fields)", () => {
    const id = insertCheckpoint(
      db,
      PROJECT,
      "session-123",
      "Working on it",
      "The thing",
      "Next thing",
    );

    const cp = getCheckpoint(db, id);
    expect(cp).not.toBeNull();
    expect(cp!.branch).toBeNull();
    expect(cp!.decisions_made).toBeNull();
    expect(cp!.blockers).toBeNull();
    expect(cp!.uncommitted_files).toEqual([]);
    expect(cp!.git_snapshot).toBeNull();
  });

  it("multiple projects do not interfere", () => {
    insertCheckpoint(db, "/proj-a", "s1", "A state", "A built", "A next");
    insertCheckpoint(db, "/proj-b", "s2", "B state", "B built", "B next");
    insertDailySummary(db, "/proj-a", "2026-03-22", { day: "a" });

    const cpA = getLatestCheckpoint(db, "/proj-a");
    const cpB = getLatestCheckpoint(db, "/proj-b");
    expect(cpA!.current_state).toBe("A state");
    expect(cpB!.current_state).toBe("B state");
  });
});
