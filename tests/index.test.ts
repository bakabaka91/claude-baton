/**
 * Integration tests for MCP tool handler logic.
 *
 * The tool handlers in index.ts live inside a module-scoped MCP server and
 * cannot be imported directly.  Instead we recreate the same logic each
 * handler performs — calling the same store / utils / claude-md functions
 * against a real in-memory SQLite database — and verify correctness
 * end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import {
  initSchema,
  insertMemory,
  getMemoriesByProject,
  insertDeadEnd,
  getDeadEndsByProject,
  insertConstraint,
  getConstraintsByProject,
  insertGoal,
  getActiveGoal,
  updateGoalStatus,
  insertCheckpoint,
  getCheckpoint,
  getLatestCheckpoint,
  insertInsight,
  getInsightsSince,
  getInsightsByDate,
  countByType,
  countAll,
  insertDailySummary,
  incrementAccessCount,
  getCheckpointsByDate,
  getMemoriesByDate,
  getExtractionLogsByDate,
  insertExtractionLog,
} from "../src/store.js";
import {
  searchMemories,
  checkDuplicate,
  jaccardSimilarity,
} from "../src/utils.js";
import { generateBlock } from "../src/claude-md.js";

// Mock LLM calls — all claude -p interactions are stubbed
vi.mock("../src/llm.js", () => ({
  callClaude: vi.fn(),
  callClaudeJson: vi.fn(),
}));

import { callClaude, callClaudeJson } from "../src/llm.js";

const mockCallClaude = vi.mocked(callClaude);
const mockCallClaudeJson = vi.mocked(callClaudeJson);

// Mock claude-md's syncClaudeMd for consolidate tests, but keep generateBlock real
vi.mock("../src/claude-md.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/claude-md.js")>();
  return {
    ...actual,
    syncClaudeMd: vi.fn().mockReturnValue("Synced."),
  };
});

import { syncClaudeMd } from "../src/claude-md.js";
import { consolidate } from "../src/consolidator.js";

const mockSyncClaudeMd = vi.mocked(syncClaudeMd);

// ---------------------------------------------------------------------------
// Constants matching index.ts
// ---------------------------------------------------------------------------
const DEAD_END_MATCH_THRESHOLD = 0.3;
const DEAD_END_RECALL_THRESHOLD = 0.2;

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
// memory_search
// =========================================================================
describe("memory_search tool logic", () => {
  it("returns matching memories for a query", () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage", ["db"]);
    insertMemory(db, PROJECT, "pattern", "Singleton pattern for connections", [
      "patterns",
    ]);
    insertMemory(db, PROJECT, "gotcha", "Never use eval in production", [
      "security",
    ]);

    const results = searchMemories(db, "SQLite storage", PROJECT);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.content.includes("SQLite"))).toBe(true);
  });

  it("filters by type when provided", () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage");
    insertMemory(db, PROJECT, "pattern", "SQLite is a good pattern");

    const results = searchMemories(db, "SQLite", PROJECT, "decision");

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("decision");
  });

  it("returns empty array when no matches", () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage");

    const results = searchMemories(db, "kubernetes docker", PROJECT);

    expect(results).toHaveLength(0);
  });

  it("only returns active memories", () => {
    const id = insertMemory(db, PROJECT, "decision", "Use SQLite for storage");
    db.run("UPDATE memories SET status = 'archived' WHERE id = ?", [id]);

    const results = searchMemories(db, "SQLite", PROJECT);

    expect(results).toHaveLength(0);
  });

  it("matches individual words with OR logic", () => {
    insertMemory(db, PROJECT, "decision", "Use Redis for caching");
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage");

    const results = searchMemories(db, "Redis SQLite", PROJECT);

    expect(results).toHaveLength(2);
  });
});

// =========================================================================
// memory_save + duplicate detection
// =========================================================================
describe("memory_save tool logic", () => {
  it("saves a memory and returns an id", () => {
    const id = insertMemory(
      db,
      PROJECT,
      "decision",
      "Use TypeScript for the project",
      ["lang"],
    );

    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");

    const memories = getMemoriesByProject(db, PROJECT);
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe("Use TypeScript for the project");
    expect(memories[0].tags).toEqual(["lang"]);
  });

  it("detects near-duplicates with checkDuplicate", () => {
    insertMemory(
      db,
      PROJECT,
      "decision",
      "Use SQLite for persistent storage database layer",
    );

    const existing = checkDuplicate(
      db,
      "Use SQLite for persistent storage in the database layer",
      PROJECT,
    );

    expect(existing).not.toBeNull();
    expect(existing!.content).toContain("SQLite");
  });

  it("allows non-duplicate content", () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage");

    const existing = checkDuplicate(
      db,
      "Deploy to AWS Lambda for serverless",
      PROJECT,
    );

    expect(existing).toBeNull();
  });

  it("duplicate check respects project scope", () => {
    insertMemory(
      db,
      "/other-project",
      "decision",
      "Use SQLite for persistent storage database layer",
    );

    const existing = checkDuplicate(
      db,
      "Use SQLite for persistent storage in the database layer",
      PROJECT,
    );

    expect(existing).toBeNull();
  });
});

// =========================================================================
// memory_stats
// =========================================================================
describe("memory_stats tool logic", () => {
  it("returns counts by type", () => {
    insertMemory(db, PROJECT, "decision", "Decision 1");
    insertMemory(db, PROJECT, "decision", "Decision 2");
    insertMemory(db, PROJECT, "pattern", "Pattern 1");
    insertMemory(db, PROJECT, "gotcha", "Gotcha 1");

    const byType = countByType(db, PROJECT);

    expect(byType.decision).toBe(2);
    expect(byType.pattern).toBe(1);
    expect(byType.gotcha).toBe(1);
  });

  it("returns total counts across all tables", () => {
    insertMemory(db, PROJECT, "decision", "D1");
    insertDeadEnd(db, PROJECT, "DE1", "Tried X", "Blocked");
    insertConstraint(db, PROJECT, "No secrets", "security", "must");
    insertGoal(db, PROJECT, "Ship v1", ["tests pass"]);
    insertCheckpoint(db, PROJECT, "sess-1", "Working", "Auth", "Tests");
    insertInsight(db, PROJECT, "Fast enough", "architecture");

    const totals = countAll(db, PROJECT);

    expect(totals.memories).toBe(1);
    expect(totals.dead_ends).toBe(1);
    expect(totals.constraints).toBe(1);
    expect(totals.goals).toBe(1);
    expect(totals.checkpoints).toBe(1);
    expect(totals.insights).toBe(1);
  });

  it("only counts active memories in countByType", () => {
    insertMemory(db, PROJECT, "decision", "Active");
    const id = insertMemory(db, PROJECT, "decision", "Archived");
    db.run("UPDATE memories SET status = 'archived' WHERE id = ?", [id]);

    const byType = countByType(db, PROJECT);

    expect(byType.decision).toBe(1);
  });
});

// =========================================================================
// log_dead_end + check_dead_ends
// =========================================================================
describe("log_dead_end + check_dead_ends tool logic", () => {
  it("logs a dead end and retrieves it", () => {
    const id = insertDeadEnd(
      db,
      PROJECT,
      "Redis caching attempt",
      "Tried using Redis for session caching",
      "Too complex for single-user setup",
      "When multi-user support is needed",
    );

    expect(id).toBeTruthy();

    const deadEnds = getDeadEndsByProject(db, PROJECT);
    expect(deadEnds).toHaveLength(1);
    expect(deadEnds[0].summary).toBe("Redis caching attempt");
    expect(deadEnds[0].blocker).toBe("Too complex for single-user setup");
    expect(deadEnds[0].resume_when).toBe("When multi-user support is needed");
    expect(deadEnds[0].resolved).toBe(false);
  });

  it("check_dead_ends finds matching approaches above threshold", () => {
    insertDeadEnd(
      db,
      PROJECT,
      "Redis caching failed",
      "Tried using Redis for session caching layer",
      "Too complex for single user",
    );

    const approach = "Using Redis for caching session data";
    const deadEnds = getDeadEndsByProject(db, PROJECT);
    const matches = deadEnds
      .filter((de) => !de.resolved)
      .map((de) => ({
        ...de,
        similarity: jaccardSimilarity(approach, de.approach_tried),
      }))
      .filter((de) => de.similarity > DEAD_END_MATCH_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity);

    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].similarity).toBeGreaterThan(DEAD_END_MATCH_THRESHOLD);
  });

  it("check_dead_ends returns no matches for unrelated approach", () => {
    insertDeadEnd(
      db,
      PROJECT,
      "Redis caching failed",
      "Tried using Redis for session caching",
      "Too complex for single user",
    );

    const approach = "Deploy serverless functions to AWS Lambda";
    const deadEnds = getDeadEndsByProject(db, PROJECT);
    const matches = deadEnds
      .filter((de) => !de.resolved)
      .map((de) => ({
        ...de,
        similarity: jaccardSimilarity(approach, de.approach_tried),
      }))
      .filter((de) => de.similarity > DEAD_END_MATCH_THRESHOLD);

    expect(matches).toHaveLength(0);
  });

  it("check_dead_ends skips resolved dead ends", () => {
    const id = insertDeadEnd(
      db,
      PROJECT,
      "Redis caching failed",
      "Tried using Redis for session caching layer",
      "Too complex",
    );
    db.run("UPDATE dead_ends SET resolved = 1 WHERE id = ?", [id]);

    const approach = "Using Redis for caching session data";
    const deadEnds = getDeadEndsByProject(db, PROJECT);
    const matches = deadEnds
      .filter((de) => !de.resolved)
      .map((de) => ({
        ...de,
        similarity: jaccardSimilarity(approach, de.approach_tried),
      }))
      .filter((de) => de.similarity > DEAD_END_MATCH_THRESHOLD);

    expect(matches).toHaveLength(0);
  });
});

// =========================================================================
// memory_recall context assembly
// =========================================================================
describe("memory_recall tool logic (context assembly)", () => {
  it("assembles memories + dead ends + constraints into context parts", () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage", ["db"]);
    insertMemory(db, PROJECT, "pattern", "Singleton connection pool");
    insertDeadEnd(
      db,
      PROJECT,
      "Redis caching",
      "Tried Redis caching",
      "Too complex",
    );
    insertConstraint(db, PROJECT, "No API keys", "security", "must");

    const topic = "database storage SQLite";

    // Same logic as index.ts memory_recall handler
    const memories = searchMemories(db, topic, PROJECT);
    const deadEnds = getDeadEndsByProject(db, PROJECT)
      .filter((de) => !de.resolved)
      .filter(
        (de) =>
          jaccardSimilarity(topic, de.summary) > DEAD_END_RECALL_THRESHOLD,
      );
    const constraints = getConstraintsByProject(db, PROJECT);

    const contextParts: string[] = [];
    if (memories.length > 0) {
      contextParts.push(
        "MEMORIES:\n" +
          memories.map((m) => `- [${m.type}] ${m.content}`).join("\n"),
      );
    }
    if (deadEnds.length > 0) {
      contextParts.push(
        "DEAD ENDS:\n" +
          deadEnds.map((de) => `- ${de.summary}: ${de.blocker}`).join("\n"),
      );
    }
    if (constraints.length > 0) {
      contextParts.push(
        "CONSTRAINTS:\n" +
          constraints.map((c) => `- [${c.severity}] ${c.rule}`).join("\n"),
      );
    }

    expect(memories.length).toBeGreaterThanOrEqual(1);
    expect(constraints.length).toBe(1);
    expect(contextParts.length).toBeGreaterThanOrEqual(2); // at least memories + constraints
    expect(contextParts.join("\n\n")).toContain("MEMORIES:");
    expect(contextParts.join("\n\n")).toContain("CONSTRAINTS:");
  });

  it("returns empty when no data matches", () => {
    const topic = "kubernetes cluster management";

    const memories = searchMemories(db, topic, PROJECT);
    const deadEnds = getDeadEndsByProject(db, PROJECT)
      .filter((de) => !de.resolved)
      .filter(
        (de) =>
          jaccardSimilarity(topic, de.summary) > DEAD_END_RECALL_THRESHOLD,
      );
    const constraints = getConstraintsByProject(db, PROJECT);

    expect(memories).toHaveLength(0);
    expect(deadEnds).toHaveLength(0);
    expect(constraints).toHaveLength(0);
  });

  it("increments access count for retrieved memories", () => {
    const id = insertMemory(db, PROJECT, "decision", "Use SQLite for storage");

    const memories = searchMemories(db, "SQLite", PROJECT);
    expect(memories).toHaveLength(1);

    // Simulate recall — increment access count
    for (const m of memories) {
      incrementAccessCount(db, m.id);
    }

    const updated = getMemoriesByProject(db, PROJECT);
    const mem = updated.find((m) => m.id === id);
    expect(mem!.access_count).toBe(1);
  });
});

// =========================================================================
// add_constraint + get_constraints
// =========================================================================
describe("add_constraint + get_constraints tool logic", () => {
  it("adds and retrieves constraints", () => {
    const id1 = insertConstraint(
      db,
      PROJECT,
      "No API keys in code",
      "security",
      "must",
      "global",
      "security audit",
    );
    const id2 = insertConstraint(
      db,
      PROJECT,
      "Prefer functional components",
      "convention",
      "should",
    );

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();

    const constraints = getConstraintsByProject(db, PROJECT);
    expect(constraints).toHaveLength(2);

    const mustConstraint = constraints.find((c) => c.severity === "must");
    expect(mustConstraint).toBeDefined();
    expect(mustConstraint!.rule).toBe("No API keys in code");
    expect(mustConstraint!.type).toBe("security");
    expect(mustConstraint!.scope).toBe("global");
    expect(mustConstraint!.source).toBe("security audit");
  });

  it("constraints are isolated by project", () => {
    insertConstraint(db, PROJECT, "Rule for project A", "security", "must");
    insertConstraint(
      db,
      "/other",
      "Rule for other project",
      "security",
      "must",
    );

    const constraints = getConstraintsByProject(db, PROJECT);
    expect(constraints).toHaveLength(1);
    expect(constraints[0].rule).toBe("Rule for project A");
  });
});

// =========================================================================
// set_goal + get_goal
// =========================================================================
describe("set_goal + get_goal tool logic", () => {
  it("sets a goal and retrieves it", () => {
    const doneWhen = ["All tests pass", "Code reviewed"];
    const id = insertGoal(db, PROJECT, "Ship v1.0", doneWhen);

    expect(id).toBeTruthy();

    const goal = getActiveGoal(db, PROJECT);
    expect(goal).not.toBeNull();
    expect(goal!.intent).toBe("Ship v1.0");
    expect(goal!.done_when).toEqual(doneWhen);
    expect(goal!.status).toBe("active");
  });

  it("pauses existing goal when setting a new one", () => {
    const id1 = insertGoal(db, PROJECT, "Goal 1", ["done criterion"]);

    // Simulate set_goal handler: pause existing, insert new
    const existing = getActiveGoal(db, PROJECT);
    expect(existing).not.toBeNull();
    expect(existing!.id).toBe(id1);

    updateGoalStatus(db, existing!.id, "paused");
    const id2 = insertGoal(db, PROJECT, "Goal 2", ["new criterion"]);

    const active = getActiveGoal(db, PROJECT);
    expect(active).not.toBeNull();
    expect(active!.id).toBe(id2);
    expect(active!.intent).toBe("Goal 2");

    // Verify first goal is paused (query it by checking all goals)
    const stmt = db.prepare("SELECT status FROM goals WHERE id = ?");
    stmt.bind([id1]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row.status).toBe("paused");
  });

  it("returns null when no active goal", () => {
    const goal = getActiveGoal(db, PROJECT);
    expect(goal).toBeNull();
  });
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
// save_insight + get_insights
// =========================================================================
describe("save_insight + get_insights tool logic", () => {
  it("saves an insight with category and context", () => {
    const id = insertInsight(
      db,
      PROJECT,
      "Haiku model is fast enough for extraction",
      "architecture",
      "Tested with 100 memories",
    );

    expect(id).toBeTruthy();
  });

  it("defaults category to surprise if not specified (handler logic)", () => {
    // In the handler, category defaults to 'surprise'
    const category = undefined ?? "surprise";
    const id = insertInsight(
      db,
      PROJECT,
      "Unexpected behavior found",
      category as "surprise",
    );

    const stmt = db.prepare("SELECT category FROM insights WHERE id = ?");
    stmt.bind([id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row.category).toBe("surprise");
  });

  it("retrieves insights by date", () => {
    const targetDate = "2026-03-22";
    insertInsight(db, PROJECT, "Insight A", "decision");
    insertInsight(db, PROJECT, "Insight B", "workflow");

    db.run(
      `UPDATE insights SET created_at = '${targetDate}T10:00:00.000Z' WHERE content = 'Insight A'`,
    );
    db.run(
      `UPDATE insights SET created_at = '${targetDate}T15:00:00.000Z' WHERE content = 'Insight B'`,
    );

    const results = getInsightsByDate(db, PROJECT, targetDate);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("Insight A");
    expect(results[1].content).toBe("Insight B");
  });

  it("retrieves insights since a timestamp", () => {
    insertInsight(db, PROJECT, "Old insight", "decision");
    insertInsight(db, PROJECT, "New insight", "workflow");

    db.run(
      `UPDATE insights SET created_at = '2026-03-22T08:00:00.000Z' WHERE content = 'Old insight'`,
    );
    db.run(
      `UPDATE insights SET created_at = '2026-03-22T16:00:00.000Z' WHERE content = 'New insight'`,
    );

    const results = getInsightsSince(db, PROJECT, "2026-03-22T12:00:00.000Z");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("New insight");
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
// daily_summary context assembly
// =========================================================================
describe("daily_summary tool logic (context assembly)", () => {
  const date = "2026-03-22";

  it("gathers checkpoints, insights, memories, and extraction logs for a date", () => {
    // Insert data and backdate to target date
    insertCheckpoint(db, PROJECT, "s1", "State A", "Built auth", "Add tests");
    insertInsight(db, PROJECT, "Haiku is fast", "architecture");
    insertMemory(db, PROJECT, "decision", "Use JWT for auth");
    insertExtractionLog(db, PROJECT, "s1", "Stop", 3, 5);

    db.run(`UPDATE checkpoints SET created_at = '${date}T09:00:00.000Z'`);
    db.run(`UPDATE insights SET created_at = '${date}T10:00:00.000Z'`);
    db.run(`UPDATE memories SET created_at = '${date}T11:00:00.000Z'`);
    db.run(`UPDATE extraction_log SET created_at = '${date}T12:00:00.000Z'`);

    const checkpoints = getCheckpointsByDate(db, PROJECT, date);
    const insights = getInsightsByDate(db, PROJECT, date);
    const memories = getMemoriesByDate(db, PROJECT, date);
    const extractionLogs = getExtractionLogsByDate(db, PROJECT, date);

    expect(checkpoints).toHaveLength(1);
    expect(insights).toHaveLength(1);
    expect(memories).toHaveLength(1);
    expect(extractionLogs).toHaveLength(1);

    // Build activity context — same logic as handler
    const activityParts: string[] = [];
    if (checkpoints.length > 0) {
      activityParts.push(
        "CHECKPOINTS:\n" +
          checkpoints
            .map(
              (cp) =>
                `- [${cp.created_at}] Built: ${cp.what_was_built} | State: ${cp.current_state} | Next: ${cp.next_steps}`,
            )
            .join("\n"),
      );
    }
    if (insights.length > 0) {
      activityParts.push(
        "INSIGHTS:\n" +
          insights
            .map(
              (ins) =>
                `- [${ins.category}] ${ins.content}${ins.context ? ` (${ins.context})` : ""}`,
            )
            .join("\n"),
      );
    }
    if (memories.length > 0) {
      activityParts.push(
        "MEMORIES CREATED:\n" +
          memories.map((m) => `- [${m.type}] ${m.content}`).join("\n"),
      );
    }
    if (extractionLogs.length > 0) {
      activityParts.push(
        "EXTRACTION LOGS:\n" +
          extractionLogs
            .map(
              (log) =>
                `- [${log.event_type}] ${log.chunks_processed} chunks, ${log.memories_extracted} memories extracted`,
            )
            .join("\n"),
      );
    }

    expect(activityParts).toHaveLength(4);
    expect(activityParts.join("\n\n")).toContain("CHECKPOINTS:");
    expect(activityParts.join("\n\n")).toContain("Built auth");
    expect(activityParts.join("\n\n")).toContain("INSIGHTS:");
    expect(activityParts.join("\n\n")).toContain("MEMORIES CREATED:");
    expect(activityParts.join("\n\n")).toContain("EXTRACTION LOGS:");
  });

  it("returns empty when no activity for date", () => {
    const checkpoints = getCheckpointsByDate(db, PROJECT, date);
    const insights = getInsightsByDate(db, PROJECT, date);
    const memories = getMemoriesByDate(db, PROJECT, date);
    const extractionLogs = getExtractionLogsByDate(db, PROJECT, date);

    const hasActivity =
      checkpoints.length > 0 ||
      insights.length > 0 ||
      memories.length > 0 ||
      extractionLogs.length > 0;

    expect(hasActivity).toBe(false);
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
// consolidate
// =========================================================================
describe("consolidate tool logic", () => {
  it("runs consolidation and returns result structure", async () => {
    // Insert some memories to consolidate
    insertMemory(db, PROJECT, "decision", "Decision A about testing");
    insertMemory(db, PROJECT, "pattern", "Pattern B about architecture");

    const result = await consolidate(db, PROJECT, { syncMd: false });

    expect(result).toHaveProperty("decayed");
    expect(result).toHaveProperty("archived");
    expect(result).toHaveProperty("deduplicated");
    expect(result).toHaveProperty("merged");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("deduplicates similar memories during consolidation", async () => {
    insertMemory(
      db,
      PROJECT,
      "decision",
      "Use SQLite for persistent storage database layer",
    );
    insertMemory(
      db,
      PROJECT,
      "decision",
      "Use SQLite for persistent storage in the database layer",
    );

    const result = await consolidate(db, PROJECT, { syncMd: false });

    expect(result.deduplicated).toBe(1);
    const active = getMemoriesByProject(db, PROJECT, undefined, "active");
    expect(active).toHaveLength(1);
  });

  it("calls syncClaudeMd when syncMd is true", async () => {
    insertMemory(db, PROJECT, "decision", "Some decision");

    await consolidate(db, PROJECT, { syncMd: true });

    expect(mockSyncClaudeMd).toHaveBeenCalledWith(db, PROJECT);
  });
});

// =========================================================================
// sync_claude_md (generateBlock)
// =========================================================================
describe("sync_claude_md tool logic (generateBlock)", () => {
  it("generates block with constraints, dead ends, decisions, goals, context, checkpoint", () => {
    insertConstraint(db, PROJECT, "No API keys", "security", "must");
    insertDeadEnd(db, PROJECT, "Redis failed", "Tried Redis", "Too complex");
    insertMemory(db, PROJECT, "decision", "Use SQLite");
    insertGoal(db, PROJECT, "Ship v1", ["tests pass"]);
    insertMemory(db, PROJECT, "pattern", "Singleton pool");
    insertCheckpoint(db, PROJECT, "s1", "Working", "Auth module", "Add tests");

    const block = generateBlock(db, PROJECT);

    expect(block).toContain("## Constraints");
    expect(block).toContain("No API keys");
    expect(block).toContain("## Dead Ends");
    expect(block).toContain("Redis failed");
    expect(block).toContain("## Key Decisions");
    expect(block).toContain("Use SQLite");
    expect(block).toContain("## Active Goal");
    expect(block).toContain("Ship v1");
    expect(block).toContain("## Recent Context");
    expect(block).toContain("Singleton pool");
    expect(block).toContain("## Last Checkpoint");
    expect(block).toContain("Auth module");
  });

  it("returns empty string when no data exists", () => {
    const block = generateBlock(db, PROJECT);
    expect(block.trim()).toBe("");
  });
});

// =========================================================================
// Validation errors
// =========================================================================
describe("validation errors (requireString / requireStringArray)", () => {
  it("requireString throws when field is missing", () => {
    expect(() => requireString({}, "query", "memory_search")).toThrow(
      ValidationError,
    );
    expect(() => requireString({}, "query", "memory_search")).toThrow(
      'memory_search requires a "query" string argument',
    );
  });

  it("requireString throws when field is not a string", () => {
    expect(() =>
      requireString({ query: 123 }, "query", "memory_search"),
    ).toThrow(ValidationError);
  });

  it("requireString throws when args is undefined", () => {
    expect(() => requireString(undefined, "query", "memory_search")).toThrow(
      ValidationError,
    );
  });

  it("requireString returns value when field is present", () => {
    const value = requireString(
      { query: "test query" },
      "query",
      "memory_search",
    );
    expect(value).toBe("test query");
  });

  it("requireStringArray throws when field is missing", () => {
    expect(() => requireStringArray({}, "done_when", "set_goal")).toThrow(
      ValidationError,
    );
    expect(() => requireStringArray({}, "done_when", "set_goal")).toThrow(
      'set_goal requires a "done_when" array of strings',
    );
  });

  it("requireStringArray throws when field is empty array", () => {
    expect(() =>
      requireStringArray({ done_when: [] }, "done_when", "set_goal"),
    ).toThrow(ValidationError);
  });

  it("requireStringArray throws when array contains non-strings", () => {
    expect(() =>
      requireStringArray(
        { done_when: ["valid", 123] },
        "done_when",
        "set_goal",
      ),
    ).toThrow(ValidationError);
  });

  it("requireStringArray throws when field is not an array", () => {
    expect(() =>
      requireStringArray(
        { done_when: "not-an-array" },
        "done_when",
        "set_goal",
      ),
    ).toThrow(ValidationError);
  });

  it("requireStringArray returns value when valid", () => {
    const value = requireStringArray(
      { done_when: ["tests pass", "reviewed"] },
      "done_when",
      "set_goal",
    );
    expect(value).toEqual(["tests pass", "reviewed"]);
  });

  // Simulate the handler's catch block for validation errors
  it("handler-style catch produces error response for validation failures", () => {
    try {
      requireString({}, "content", "memory_save");
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
        'memory_save requires a "content" string argument',
      );
    }
  });
});

// =========================================================================
// Tool-specific validation scenarios
// =========================================================================
describe("tool-specific required argument validation", () => {
  it("memory_search requires query", () => {
    expect(() => requireString({}, "query", "memory_search")).toThrow(
      'memory_search requires a "query" string argument',
    );
  });

  it("memory_save requires content and type", () => {
    expect(() => requireString({}, "content", "memory_save")).toThrow(
      'memory_save requires a "content" string argument',
    );
    expect(() => requireString({}, "type", "memory_save")).toThrow(
      'memory_save requires a "type" string argument',
    );
  });

  it("log_dead_end requires summary, approach_tried, blocker", () => {
    expect(() => requireString({}, "summary", "log_dead_end")).toThrow(
      'log_dead_end requires a "summary" string argument',
    );
    expect(() => requireString({}, "approach_tried", "log_dead_end")).toThrow(
      'log_dead_end requires a "approach_tried" string argument',
    );
    expect(() => requireString({}, "blocker", "log_dead_end")).toThrow(
      'log_dead_end requires a "blocker" string argument',
    );
  });

  it("check_dead_ends requires approach", () => {
    expect(() => requireString({}, "approach", "check_dead_ends")).toThrow(
      'check_dead_ends requires a "approach" string argument',
    );
  });

  it("memory_recall requires topic", () => {
    expect(() => requireString({}, "topic", "memory_recall")).toThrow(
      'memory_recall requires a "topic" string argument',
    );
  });

  it("add_constraint requires rule, type, severity", () => {
    expect(() => requireString({}, "rule", "add_constraint")).toThrow(
      'add_constraint requires a "rule" string argument',
    );
    expect(() => requireString({}, "type", "add_constraint")).toThrow(
      'add_constraint requires a "type" string argument',
    );
    expect(() => requireString({}, "severity", "add_constraint")).toThrow(
      'add_constraint requires a "severity" string argument',
    );
  });

  it("set_goal requires intent and done_when array", () => {
    expect(() => requireString({}, "intent", "set_goal")).toThrow(
      'set_goal requires a "intent" string argument',
    );
    expect(() => requireStringArray({}, "done_when", "set_goal")).toThrow(
      'set_goal requires a "done_when" array of strings',
    );
  });

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

  it("save_insight requires content", () => {
    expect(() => requireString({}, "content", "save_insight")).toThrow(
      'save_insight requires a "content" string argument',
    );
  });
});

// =========================================================================
// Edge cases and integration scenarios
// =========================================================================
describe("edge cases", () => {
  it("memory_save with empty tags defaults to []", () => {
    const id = insertMemory(db, PROJECT, "decision", "No tags provided");
    const memories = getMemoriesByProject(db, PROJECT);
    expect(memories[0].tags).toEqual([]);
  });

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

  it("get_insights with no since or date defaults to today", () => {
    // Insert insight with today's date
    const today = new Date().toISOString().slice(0, 10);
    insertInsight(db, PROJECT, "Today insight", "decision");

    // The handler logic: if no since and no date, use today
    const insights = getInsightsByDate(db, PROJECT, today);
    expect(insights).toHaveLength(1);
    expect(insights[0].content).toBe("Today insight");
  });

  it("jaccardSimilarity returns 1 for identical strings", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
  });

  it("jaccardSimilarity returns 0 for completely different strings", () => {
    expect(jaccardSimilarity("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });

  it("jaccardSimilarity is case-insensitive", () => {
    expect(jaccardSimilarity("Hello World", "hello world")).toBe(1);
  });

  it("multiple projects do not interfere", () => {
    insertMemory(db, "/proj-a", "decision", "Decision for A");
    insertMemory(db, "/proj-b", "decision", "Decision for B");
    insertDeadEnd(db, "/proj-a", "DE-A", "Tried A", "Failed A");
    insertConstraint(db, "/proj-b", "Rule B", "security", "must");

    expect(getMemoriesByProject(db, "/proj-a")).toHaveLength(1);
    expect(getMemoriesByProject(db, "/proj-b")).toHaveLength(1);
    expect(getDeadEndsByProject(db, "/proj-a")).toHaveLength(1);
    expect(getDeadEndsByProject(db, "/proj-b")).toHaveLength(0);
    expect(getConstraintsByProject(db, "/proj-a")).toHaveLength(0);
    expect(getConstraintsByProject(db, "/proj-b")).toHaveLength(1);
  });
});
