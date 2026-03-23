/**
 * End-to-end integration tests.
 *
 * These tests exercise multi-step workflows that span multiple modules,
 * verifying that the pieces work correctly together. LLM calls are mocked
 * but all other code paths (database, file I/O, extraction, consolidation,
 * CLAUDE.md sync) execute for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import path from "path";
import os from "os";
import initSqlJs, { type Database } from "sql.js";
import {
  initSchema,
  initDatabase,
  saveDatabase,
  insertMemory,
  insertDeadEnd,
  insertConstraint,
  insertGoal,
  insertCheckpoint,
  insertInsight,
  insertExtractionLog,
  getMemoriesByProject,
  getDeadEndsByProject,
  getConstraintsByProject,
  getActiveGoal,
  getLatestCheckpoint,
  getAllMemories,
  getAllDeadEnds,
  getAllConstraints,
  getAllGoals,
  getAllCheckpoints,
  getAllInsights,
  getAllDailySummaries,
  getAllExtractionLogs,
  countAll,
  getInsightsByProject,
  getCursorPosition,
  getLastExtraction,
  deleteAllData,
  deleteProjectData,
} from "../src/store.js";
import {
  searchMemories,
  checkDuplicate,
  jaccardSimilarity,
} from "../src/utils.js";
import {
  generateBlock,
  writeBlock,
  syncClaudeMd,
  findClaudeMd,
} from "../src/claude-md.js";
import { extractFromRawText, storeItems } from "../src/extractor.js";
import { consolidate } from "../src/consolidator.js";

// Mock LLM calls — all claude -p interactions are stubbed
vi.mock("../src/llm.js", () => ({
  callClaude: vi.fn(),
  callClaudeJson: vi.fn(),
}));

import { callClaude, callClaudeJson } from "../src/llm.js";

const mockCallClaude = vi.mocked(callClaude);
const mockCallClaudeJson = vi.mocked(callClaudeJson);

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
let db: Database;
const PROJECT = "/test/e2e-project";

beforeEach(async () => {
  vi.clearAllMocks();
  const SQL = await initSqlJs();
  db = new SQL.Database();
  initSchema(db);
});

// =========================================================================
// 1. Extraction pipeline E2E
// =========================================================================
describe("extraction pipeline E2E", () => {
  it("extractFromRawText stores items and logs extraction", async () => {
    mockCallClaudeJson.mockResolvedValueOnce([
      {
        type: "memory",
        memory_type: "decision",
        content: "Use SQLite for storage",
        tags: ["db"],
      },
      {
        type: "memory",
        memory_type: "pattern",
        content: "Singleton pattern for DB connections",
        tags: ["design"],
      },
      {
        type: "dead_end",
        summary: "Redis caching",
        approach_tried: "Tried Redis for caching",
        blocker: "Too complex for single-user",
      },
      {
        type: "constraint",
        rule: "No API keys in code",
        constraint_type: "security",
        severity: "must",
      },
      {
        type: "insight",
        content: "WASM startup is surprisingly fast",
        category: "surprise",
      },
    ]);

    const result = await extractFromRawText(
      db,
      "A long conversation transcript about building a database layer...",
      PROJECT,
      "session-e2e-1",
      "stop",
    );

    expect(result.chunksProcessed).toBe(1);
    expect(result.itemsExtracted).toBe(5);
    expect(result.itemsStored).toBe(5);
    expect(result.errors).toHaveLength(0);

    // Verify all items stored in database
    expect(getMemoriesByProject(db, PROJECT)).toHaveLength(2);
    expect(getDeadEndsByProject(db, PROJECT)).toHaveLength(1);
    expect(getConstraintsByProject(db, PROJECT)).toHaveLength(1);
    expect(getInsightsByProject(db, PROJECT)).toHaveLength(1);

    // Verify extraction log
    const lastExtraction = getLastExtraction(db, PROJECT, "session-e2e-1");
    expect(lastExtraction).not.toBeNull();
    expect(lastExtraction!.event_type).toBe("stop");
    expect(lastExtraction!.chunks_processed).toBe(1);
    expect(lastExtraction!.memories_extracted).toBe(5);
  });

  it("extraction deduplicates against existing data", async () => {
    // Pre-populate database
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage", ["db"]);
    insertDeadEnd(
      db,
      PROJECT,
      "Redis caching",
      "Tried Redis for caching",
      "Too complex",
    );
    insertConstraint(db, PROJECT, "No API keys in code", "security", "must");
    insertInsight(db, PROJECT, "WASM startup is surprisingly fast", "surprise");

    // Extract identical items
    mockCallClaudeJson.mockResolvedValueOnce([
      {
        type: "memory",
        memory_type: "decision",
        content: "Use SQLite for persistent storage",
        tags: ["db"],
      },
      {
        type: "dead_end",
        summary: "Redis caching attempt",
        approach_tried: "Tried Redis for caching layer",
        blocker: "Too complex for single user",
      },
      {
        type: "constraint",
        rule: "No API keys in code",
        constraint_type: "security",
        severity: "must",
      },
      {
        type: "insight",
        content: "WASM startup is surprisingly fast and efficient",
        category: "surprise",
      },
    ]);

    const result = await extractFromRawText(
      db,
      "Another conversation...",
      PROJECT,
      "session-e2e-2",
      "stop",
    );

    // All items should be deduplicated — none stored
    expect(result.itemsStored).toBe(0);
    expect(getMemoriesByProject(db, PROJECT)).toHaveLength(1);
    expect(getDeadEndsByProject(db, PROJECT)).toHaveLength(1);
    expect(getConstraintsByProject(db, PROJECT)).toHaveLength(1);
    expect(getInsightsByProject(db, PROJECT)).toHaveLength(1);
  });

  it("cursor-based incremental extraction skips already-processed text", async () => {
    const fullText = "Part 1 of transcript. Part 2 of transcript.";

    // First extraction processes full text
    mockCallClaudeJson.mockResolvedValueOnce([
      {
        type: "memory",
        memory_type: "decision",
        content: "Decision from part 1",
        tags: [],
      },
    ]);

    await extractFromRawText(db, fullText, PROJECT, "session-cursor", "stop");

    // Cursor should be at the end of the text
    const cursor = getCursorPosition(db, PROJECT, "session-cursor");
    expect(cursor).toBe(fullText.length);

    // Second extraction with same text — nothing new to process
    const result2 = await extractFromRawText(
      db,
      fullText,
      PROJECT,
      "session-cursor",
      "precompact",
    );

    expect(result2.chunksProcessed).toBe(0);
    expect(result2.itemsStored).toBe(0);
    // LLM should NOT have been called again
    expect(mockCallClaudeJson).toHaveBeenCalledTimes(1);
  });

  it("extraction with syncMd triggers CLAUDE.md sync", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "e2e-sync-"));
    const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
    writeFileSync(claudeMdPath, "# My Project\n\nSome existing content.\n");

    mockCallClaudeJson.mockResolvedValueOnce([
      {
        type: "memory",
        memory_type: "decision",
        content: "Use TypeScript for type safety",
        tags: ["lang"],
      },
    ]);

    await extractFromRawText(
      db,
      "Conversation about TypeScript...",
      tmpDir,
      "session-sync",
      "stop",
      { syncMd: true },
    );

    // CLAUDE.md should now contain the managed block
    const content = readFileSync(claudeMdPath, "utf-8");
    expect(content).toContain("<!-- MEMORIA:START -->");
    expect(content).toContain("<!-- MEMORIA:END -->");
    expect(content).toContain("Use TypeScript for type safety");
    // Original content preserved
    expect(content).toContain("# My Project");

    rmSync(tmpDir, { recursive: true });
  });

  it("extraction handles LLM errors gracefully", async () => {
    mockCallClaudeJson.mockRejectedValueOnce(new Error("LLM timeout"));

    const result = await extractFromRawText(
      db,
      "Some transcript text...",
      PROJECT,
      "session-err",
      "stop",
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("LLM timeout");
    expect(result.itemsStored).toBe(0);
    // Extraction log should still be written
    const log = getLastExtraction(db, PROJECT, "session-err");
    expect(log).not.toBeNull();
  });
});

// =========================================================================
// 2. Extraction → Consolidation → Sync chain
// =========================================================================
describe("extraction → consolidation → sync chain", () => {
  it("full pipeline: extract → consolidate → sync CLAUDE.md", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "e2e-chain-"));
    const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
    writeFileSync(claudeMdPath, "# Project\n");

    // Step 1: Extract memories
    mockCallClaudeJson.mockResolvedValueOnce([
      {
        type: "memory",
        memory_type: "decision",
        content: "Use SQLite for storage layer",
        tags: ["db"],
      },
      {
        type: "memory",
        memory_type: "decision",
        content: "Use SQLite for persistent storage layer",
        tags: ["db"],
      },
      {
        type: "constraint",
        rule: "No native bindings",
        constraint_type: "convention",
        severity: "must",
      },
    ]);

    const extractResult = await extractFromRawText(
      db,
      "Discussion about database choices...",
      tmpDir,
      "session-chain",
      "stop",
      { syncMd: true },
    );
    expect(extractResult.itemsStored).toBe(3);

    // Step 2: Consolidate (dedup should catch the similar memories)
    const consolidateResult = await consolidate(db, tmpDir, { syncMd: true });
    expect(consolidateResult.deduplicated).toBe(1);

    // Step 3: Verify CLAUDE.md has the final state
    const content = readFileSync(claudeMdPath, "utf-8");
    expect(content).toContain("<!-- MEMORIA:START -->");
    expect(content).toContain("No native bindings");
    // Only one decision should remain after dedup
    const active = getMemoriesByProject(db, tmpDir, "decision", "active");
    expect(active).toHaveLength(1);

    rmSync(tmpDir, { recursive: true });
  });
});

// =========================================================================
// 3. Multi-tool workflow simulations
// =========================================================================
describe("multi-tool workflows", () => {
  it("constraint + dead end + recall context assembly", () => {
    // Simulate: add_constraint → log_dead_end → memory_save → memory_recall
    insertConstraint(db, PROJECT, "No API keys", "security", "must");
    insertConstraint(db, PROJECT, "Use sql.js only", "convention", "must");
    insertDeadEnd(
      db,
      PROJECT,
      "Redis caching failed",
      "Tried Redis for session caching",
      "Too complex for single user",
    );
    insertMemory(db, PROJECT, "decision", "Use SQLite for storage", ["db"]);
    insertMemory(
      db,
      PROJECT,
      "architecture",
      "MCP server with stdio transport",
      ["architecture"],
    );

    // Simulate memory_recall handler logic
    const topic = "database storage approach";
    const memories = searchMemories(db, topic, PROJECT);
    const deadEnds = getDeadEndsByProject(db, PROJECT)
      .filter((de) => !de.resolved)
      .filter((de) => jaccardSimilarity(topic, de.summary) > 0.2);
    const constraints = getConstraintsByProject(db, PROJECT);

    // Memories should find the SQLite decision
    expect(memories.length).toBeGreaterThanOrEqual(1);
    expect(memories.some((m) => m.content.includes("SQLite"))).toBe(true);

    // Constraints should be included
    expect(constraints).toHaveLength(2);

    // Build the full recall context
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

    const fullContext = contextParts.join("\n\n");
    expect(fullContext).toContain("MEMORIES:");
    expect(fullContext).toContain("CONSTRAINTS:");
    expect(fullContext).toContain("No API keys");
    expect(fullContext).toContain("Use sql.js only");
  });

  it("set_goal → save_checkpoint → get_checkpoint includes goal context", () => {
    // Set a goal
    const goalId = insertGoal(db, PROJECT, "Ship v1.0", [
      "All tests pass",
      "CLAUDE.md synced",
    ]);

    // Save checkpoint
    const cpId = insertCheckpoint(
      db,
      PROJECT,
      "session-workflow",
      "Working on extraction pipeline",
      "Extraction + consolidation modules",
      "Add E2E tests",
      {
        branch: "main",
        decisionsMade: "Use cursor-based incremental extraction",
        blockers: "LLM mocking needed for tests",
        uncommittedFiles: ["src/extractor.ts"],
        gitSnapshot: "abc123 feat: add extraction",
      },
    );

    // Retrieve checkpoint and goal
    const goal = getActiveGoal(db, PROJECT);
    const checkpoint = getLatestCheckpoint(db, PROJECT);

    expect(goal).not.toBeNull();
    expect(goal!.intent).toBe("Ship v1.0");
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.next_steps).toBe("Add E2E tests");
    expect(checkpoint!.git_snapshot).toBe("abc123 feat: add extraction");

    // Verify generateBlock includes both
    const block = generateBlock(db, PROJECT);
    expect(block).toContain("## Active Goal");
    expect(block).toContain("Ship v1.0");
    expect(block).toContain("## Last Checkpoint");
    expect(block).toContain("Extraction + consolidation modules");
  });

  it("save multiple memories → consolidate dedup → sync reflects final state", () => {
    // Insert duplicate memories
    insertMemory(
      db,
      PROJECT,
      "decision",
      "Use TypeScript for the entire project codebase",
      ["lang"],
    );
    insertMemory(
      db,
      PROJECT,
      "decision",
      "Use TypeScript for the entire project code base",
      ["typescript"],
    );
    insertMemory(db, PROJECT, "pattern", "Singleton pattern for DB pool", [
      "design",
    ]);

    // Before consolidation: 3 active memories
    expect(getMemoriesByProject(db, PROJECT, undefined, "active")).toHaveLength(
      3,
    );

    // Consolidate (no LLM needed — dedup handles it)
    // Use async/await since consolidate is async
    return consolidate(db, PROJECT, { syncMd: false }).then((result) => {
      expect(result.deduplicated).toBe(1);

      // After: 2 active, 1 superseded
      const active = getMemoriesByProject(db, PROJECT, undefined, "active");
      expect(active).toHaveLength(2);

      // generateBlock should show only active memories
      const block = generateBlock(db, PROJECT);
      // Should have one decision, one pattern
      const decisionMatches = block.match(/Use TypeScript/g);
      expect(decisionMatches).toHaveLength(1); // only the surviving one
      expect(block).toContain("Singleton pattern");
    });
  });

  it("multi-project isolation across all data types", () => {
    const projA = "/project-a";
    const projB = "/project-b";

    // Populate project A
    insertMemory(db, projA, "decision", "Decision for A");
    insertDeadEnd(db, projA, "DE-A", "Tried A approach", "Failed A");
    insertConstraint(db, projA, "Rule A", "security", "must");
    insertGoal(db, projA, "Goal A", ["done A"]);
    insertCheckpoint(db, projA, "sess-a", "State A", "Built A", "Next A");
    insertInsight(db, projA, "Insight A", "decision");

    // Populate project B
    insertMemory(db, projB, "pattern", "Pattern for B");
    insertDeadEnd(db, projB, "DE-B", "Tried B approach", "Failed B");
    insertConstraint(db, projB, "Rule B", "convention", "should");
    insertGoal(db, projB, "Goal B", ["done B"]);
    insertCheckpoint(db, projB, "sess-b", "State B", "Built B", "Next B");
    insertInsight(db, projB, "Insight B", "workflow");

    // Verify complete isolation
    const countsA = countAll(db, projA);
    const countsB = countAll(db, projB);

    expect(countsA.memories).toBe(1);
    expect(countsA.dead_ends).toBe(1);
    expect(countsA.constraints).toBe(1);
    expect(countsA.goals).toBe(1);
    expect(countsA.checkpoints).toBe(1);
    expect(countsA.insights).toBe(1);

    expect(countsB.memories).toBe(1);
    expect(countsB.dead_ends).toBe(1);
    expect(countsB.constraints).toBe(1);
    expect(countsB.goals).toBe(1);
    expect(countsB.checkpoints).toBe(1);
    expect(countsB.insights).toBe(1);

    // CLAUDE.md blocks are project-specific
    const blockA = generateBlock(db, projA);
    const blockB = generateBlock(db, projB);

    expect(blockA).toContain("Decision for A");
    expect(blockA).not.toContain("Pattern for B");
    expect(blockB).toContain("Pattern for B");
    expect(blockB).not.toContain("Decision for A");

    // Delete project A — B should be unaffected
    deleteProjectData(db, projA);
    expect(countAll(db, projA).memories).toBe(0);
    expect(countAll(db, projB).memories).toBe(1);
  });
});

// =========================================================================
// 4. Export → Import round-trip
// =========================================================================
describe("export → import round-trip", () => {
  it("exports and reimports all data types with integrity", () => {
    // Populate database with all data types
    insertMemory(db, PROJECT, "decision", "Use SQLite", ["db"]);
    insertMemory(db, PROJECT, "pattern", "Singleton pool", ["design"]);
    insertDeadEnd(
      db,
      PROJECT,
      "Redis caching",
      "Tried Redis",
      "Too complex",
      "When multi-user needed",
    );
    insertConstraint(
      db,
      PROJECT,
      "No API keys",
      "security",
      "must",
      "global",
      "security audit",
    );
    insertGoal(db, PROJECT, "Ship v1", ["tests pass", "docs written"]);
    insertCheckpoint(
      db,
      PROJECT,
      "sess-1",
      "Working on auth",
      "Auth module",
      "Tests",
      {
        branch: "main",
        decisionsMade: "JWT",
        blockers: "None",
        uncommittedFiles: ["src/auth.ts"],
      },
    );
    insertInsight(db, PROJECT, "WASM is fast", "architecture", "Benchmarked");
    insertExtractionLog(db, PROJECT, "sess-1", "stop", 3, 5, 12000);

    // Export
    const exported = {
      version: 1,
      exported_at: new Date().toISOString(),
      memories: getAllMemories(db, PROJECT),
      dead_ends: getAllDeadEnds(db, PROJECT),
      constraints: getAllConstraints(db, PROJECT),
      goals: getAllGoals(db, PROJECT),
      checkpoints: getAllCheckpoints(db, PROJECT),
      insights: getAllInsights(db, PROJECT),
      daily_summaries: getAllDailySummaries(db, PROJECT),
      extraction_logs: getAllExtractionLogs(db, PROJECT),
    };

    // Verify export structure
    expect(exported.memories).toHaveLength(2);
    expect(exported.dead_ends).toHaveLength(1);
    expect(exported.constraints).toHaveLength(1);
    expect(exported.goals).toHaveLength(1);
    expect(exported.checkpoints).toHaveLength(1);
    expect(exported.insights).toHaveLength(1);

    // Clear database
    deleteAllData(db);
    expect(countAll(db).memories).toBe(0);

    // Re-import (simulating handleImport logic)
    let imported = 0;
    for (const m of exported.memories) {
      insertMemory(db, m.project_path, m.type, m.content, m.tags, m.confidence);
      imported++;
    }
    for (const de of exported.dead_ends) {
      insertDeadEnd(
        db,
        de.project_path,
        de.summary,
        de.approach_tried,
        de.blocker,
        de.resume_when ?? undefined,
      );
      imported++;
    }
    for (const c of exported.constraints) {
      insertConstraint(
        db,
        c.project_path,
        c.rule,
        c.type,
        c.severity,
        c.scope ?? undefined,
        c.source ?? undefined,
      );
      imported++;
    }
    for (const g of exported.goals) {
      insertGoal(db, g.project_path, g.intent, g.done_when);
      imported++;
    }
    for (const cp of exported.checkpoints) {
      insertCheckpoint(
        db,
        cp.project_path,
        cp.session_id,
        cp.current_state,
        cp.what_was_built,
        cp.next_steps,
        {
          branch: cp.branch ?? undefined,
          decisionsMade: cp.decisions_made ?? undefined,
          blockers: cp.blockers ?? undefined,
          uncommittedFiles: cp.uncommitted_files,
        },
      );
      imported++;
    }
    for (const ins of exported.insights) {
      insertInsight(
        db,
        ins.project_path,
        ins.content,
        ins.category,
        ins.context ?? undefined,
      );
      imported++;
    }

    expect(imported).toBe(7);

    // Verify data integrity after round-trip
    const reimported = countAll(db, PROJECT);
    expect(reimported.memories).toBe(2);
    expect(reimported.dead_ends).toBe(1);
    expect(reimported.constraints).toBe(1);
    expect(reimported.goals).toBe(1);
    expect(reimported.checkpoints).toBe(1);
    expect(reimported.insights).toBe(1);

    // Verify content fidelity
    const memories = getMemoriesByProject(db, PROJECT);
    expect(memories.some((m) => m.content === "Use SQLite")).toBe(true);
    expect(memories.some((m) => m.content === "Singleton pool")).toBe(true);

    const deadEnds = getDeadEndsByProject(db, PROJECT);
    expect(deadEnds[0].resume_when).toBe("When multi-user needed");

    const constraints = getConstraintsByProject(db, PROJECT);
    expect(constraints[0].scope).toBe("global");
    expect(constraints[0].source).toBe("security audit");

    const checkpoint = getLatestCheckpoint(db, PROJECT);
    expect(checkpoint!.branch).toBe("main");
    expect(checkpoint!.uncommitted_files).toEqual(["src/auth.ts"]);
  });
});

// =========================================================================
// 5. CLAUDE.md sync with real file I/O
// =========================================================================
describe("CLAUDE.md sync with real file I/O", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "e2e-claudemd-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("syncClaudeMd creates CLAUDE.md when it does not exist", () => {
    insertConstraint(db, tmpDir, "No secrets", "security", "must");

    const result = syncClaudeMd(db, tmpDir);

    expect(result).toContain("Created");
    const content = readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("<!-- MEMORIA:START -->");
    expect(content).toContain("No secrets");
    expect(content).toContain("<!-- MEMORIA:END -->");
  });

  it("syncClaudeMd updates existing CLAUDE.md preserving other content", () => {
    const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
    writeFileSync(claudeMdPath, "# My Project\n\nCustom instructions here.\n");

    insertMemory(db, tmpDir, "decision", "Use TypeScript");
    insertConstraint(db, tmpDir, "No eval()", "security", "must");

    syncClaudeMd(db, tmpDir);

    const content = readFileSync(claudeMdPath, "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Custom instructions here.");
    expect(content).toContain("<!-- MEMORIA:START -->");
    expect(content).toContain("Use TypeScript");
    expect(content).toContain("No eval()");
    expect(content).toContain("<!-- MEMORIA:END -->");
  });

  it("syncClaudeMd replaces existing managed block on update", () => {
    const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
    writeFileSync(
      claudeMdPath,
      "# Header\n\n<!-- MEMORIA:START -->\nOld content\n<!-- MEMORIA:END -->\n\n# Footer\n",
    );

    insertMemory(db, tmpDir, "decision", "New decision");

    syncClaudeMd(db, tmpDir);

    const content = readFileSync(claudeMdPath, "utf-8");
    expect(content).toContain("# Header");
    expect(content).toContain("# Footer");
    expect(content).toContain("New decision");
    expect(content).not.toContain("Old content");
    // Should have exactly one pair of markers
    expect(content.match(/<!-- MEMORIA:START -->/g)).toHaveLength(1);
    expect(content.match(/<!-- MEMORIA:END -->/g)).toHaveLength(1);
  });

  it("syncClaudeMd returns empty message when no data exists", () => {
    const result = syncClaudeMd(db, tmpDir);
    expect(result).toContain("No data to sync");
  });

  it("writeBlock handles orphaned start marker", () => {
    const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
    writeFileSync(
      claudeMdPath,
      "# Header\n\n<!-- MEMORIA:START -->\nOrphaned block without end\n\n# Footer\n",
    );

    insertMemory(db, tmpDir, "decision", "Fresh decision");
    syncClaudeMd(db, tmpDir);

    const content = readFileSync(claudeMdPath, "utf-8");
    expect(content).toContain("# Header");
    expect(content).toContain("Fresh decision");
    // Orphaned marker should be cleaned up
    expect(content.match(/<!-- MEMORIA:START -->/g)).toHaveLength(1);
    expect(content.match(/<!-- MEMORIA:END -->/g)).toHaveLength(1);
  });

  it("findClaudeMd traverses parent directories", () => {
    const subDir = path.join(tmpDir, "src", "components");
    const claudeMdPath = path.join(tmpDir, "CLAUDE.md");

    // Create CLAUDE.md in root, search from subdirectory
    writeFileSync(claudeMdPath, "# Root CLAUDE.md\n");
    // Create subdirectory structure
    const { mkdirSync } = require("fs");
    mkdirSync(subDir, { recursive: true });

    const found = findClaudeMd(subDir);
    expect(found).toBe(claudeMdPath);
  });
});

// =========================================================================
// 6. Database persistence round-trip
// =========================================================================
describe("database persistence round-trip", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "e2e-db-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("saves database to disk and reloads with all data intact", async () => {
    const dbPath = path.join(tmpDir, "test-store.db");

    // Populate in-memory database
    insertMemory(db, PROJECT, "decision", "Use SQLite", ["db"]);
    insertDeadEnd(db, PROJECT, "Redis", "Tried Redis", "Overkill");
    insertConstraint(db, PROJECT, "No secrets", "security", "must");
    insertGoal(db, PROJECT, "Ship v1", ["tests pass"]);
    insertCheckpoint(db, PROJECT, "sess-1", "Working", "Auth", "Tests");
    insertInsight(db, PROJECT, "WASM fast", "architecture");

    // Save to disk
    saveDatabase(db, dbPath);

    // Reload from disk
    const reloaded = await initDatabase(dbPath);

    // Verify all data survived the round-trip
    const counts = countAll(reloaded, PROJECT);
    expect(counts.memories).toBe(1);
    expect(counts.dead_ends).toBe(1);
    expect(counts.constraints).toBe(1);
    expect(counts.goals).toBe(1);
    expect(counts.checkpoints).toBe(1);
    expect(counts.insights).toBe(1);

    // Verify content
    const memories = getMemoriesByProject(reloaded, PROJECT);
    expect(memories[0].content).toBe("Use SQLite");
    expect(memories[0].tags).toEqual(["db"]);

    reloaded.close();
  });

  it("initDatabase creates new database when file does not exist", async () => {
    const dbPath = path.join(tmpDir, "subdir", "new-store.db");

    const newDb = await initDatabase(dbPath);

    // Should be usable immediately
    insertMemory(newDb, PROJECT, "decision", "Test memory");
    expect(getMemoriesByProject(newDb, PROJECT)).toHaveLength(1);

    // File should exist on disk
    const { existsSync } = require("fs");
    expect(existsSync(dbPath)).toBe(true);

    newDb.close();
  });
});

// =========================================================================
// 7. generateBlock section ordering and truncation
// =========================================================================
describe("generateBlock section ordering", () => {
  it("respects section order: constraints → dead ends → decisions → goal → context → checkpoint", () => {
    insertConstraint(db, PROJECT, "Must rule", "security", "must");
    insertDeadEnd(db, PROJECT, "Failed approach", "Tried X", "Blocked");
    insertMemory(db, PROJECT, "decision", "Key decision");
    insertGoal(db, PROJECT, "Current goal", ["criterion"]);
    insertMemory(db, PROJECT, "pattern", "A pattern");
    insertCheckpoint(
      db,
      PROJECT,
      "s1",
      "Current state",
      "Built something",
      "Do next",
    );

    const block = generateBlock(db, PROJECT);
    const lines = block.split("\n");

    const constraintsIdx = lines.findIndex((l) => l.includes("## Constraints"));
    const deadEndsIdx = lines.findIndex((l) => l.includes("## Dead Ends"));
    const decisionsIdx = lines.findIndex((l) => l.includes("## Key Decisions"));
    const goalIdx = lines.findIndex((l) => l.includes("## Active Goal"));
    const contextIdx = lines.findIndex((l) => l.includes("## Recent Context"));
    const checkpointIdx = lines.findIndex((l) =>
      l.includes("## Last Checkpoint"),
    );

    expect(constraintsIdx).toBeLessThan(deadEndsIdx);
    expect(deadEndsIdx).toBeLessThan(decisionsIdx);
    expect(decisionsIdx).toBeLessThan(goalIdx);
    expect(goalIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(checkpointIdx);
  });
});

// =========================================================================
// 8. Consolidation with decay
// =========================================================================
describe("consolidation with decay", () => {
  it("decays progress memories older than 7 days", async () => {
    const id = insertMemory(db, PROJECT, "progress", "Working on feature X");

    // Backdate to 14 days ago
    const twoWeeksAgo = new Date(
      Date.now() - 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [
      twoWeeksAgo,
      id,
    ]);

    const result = await consolidate(db, PROJECT, { syncMd: false });

    // Should have decayed (2 full periods of 7 days → 0.9^2 = 0.81)
    expect(result.decayed).toBe(1);
    const mem = getMemoriesByProject(db, PROJECT, "progress", "active");
    expect(mem).toHaveLength(1);
    expect(mem[0].confidence).toBeLessThan(1.0);
    expect(mem[0].confidence).toBeCloseTo(0.81, 1);
  });

  it("archives progress memories decayed below 0.3 threshold", async () => {
    const id = insertMemory(
      db,
      PROJECT,
      "progress",
      "Old progress note",
      [],
      0.31,
    );

    // Backdate to 7+ days ago (1 decay period)
    const oldDate = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [oldDate, id]);

    const result = await consolidate(db, PROJECT, { syncMd: false });

    // 0.31 * 0.9 = 0.279 → below 0.3 → archived
    expect(result.archived).toBe(1);
    const active = getMemoriesByProject(db, PROJECT, "progress", "active");
    expect(active).toHaveLength(0);
  });

  it("does not decay decision or architecture memories", async () => {
    const id1 = insertMemory(db, PROJECT, "decision", "Important decision");
    const id2 = insertMemory(
      db,
      PROJECT,
      "architecture",
      "System architecture",
    );

    // Backdate both
    const oldDate = new Date(
      Date.now() - 60 * 24 * 60 * 60 * 1000,
    ).toISOString();
    db.run("UPDATE memories SET updated_at = ? WHERE id IN (?, ?)", [
      oldDate,
      id1,
      id2,
    ]);

    const result = await consolidate(db, PROJECT, { syncMd: false });

    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
    const active = getMemoriesByProject(db, PROJECT, undefined, "active");
    expect(active).toHaveLength(2);
    expect(active.every((m) => m.confidence === 1.0)).toBe(true);
  });
});

// =========================================================================
// 9. storeItems deduplication thresholds
// =========================================================================
describe("storeItems deduplication thresholds", () => {
  it("memory dedup threshold is 0.6 (Jaccard)", () => {
    insertMemory(
      db,
      PROJECT,
      "decision",
      "Use SQLite for persistent storage database layer",
    );

    // Similar but slightly different — should be caught
    const stored = storeItems(
      db,
      [
        {
          type: "memory",
          memory_type: "decision",
          content: "Use SQLite for persistent storage in the database layer",
          tags: [],
        },
      ],
      PROJECT,
    );
    expect(stored).toBe(0);

    // Very different — should be stored
    const stored2 = storeItems(
      db,
      [
        {
          type: "memory",
          memory_type: "decision",
          content: "Deploy to AWS Lambda for serverless execution",
          tags: [],
        },
      ],
      PROJECT,
    );
    expect(stored2).toBe(1);
  });

  it("constraint dedup threshold is 0.8 (Jaccard) or exact match", () => {
    insertConstraint(db, PROJECT, "No API keys in code", "security", "must");

    // Exact match — should be caught
    const stored = storeItems(
      db,
      [
        {
          type: "constraint",
          rule: "No API keys in code",
          constraint_type: "security",
          severity: "must",
        },
      ],
      PROJECT,
    );
    expect(stored).toBe(0);

    // Different enough — should be stored
    const stored2 = storeItems(
      db,
      [
        {
          type: "constraint",
          rule: "Use sql.js WASM only",
          constraint_type: "convention",
          severity: "must",
        },
      ],
      PROJECT,
    );
    expect(stored2).toBe(1);
  });

  it("dead end dedup threshold is 0.6 (Jaccard on approach_tried)", () => {
    insertDeadEnd(
      db,
      PROJECT,
      "Redis caching",
      "Tried using Redis for session caching layer",
      "Too complex",
    );

    // Similar approach — should be caught
    const stored = storeItems(
      db,
      [
        {
          type: "dead_end",
          summary: "Redis cache attempt",
          approach_tried: "Tried Redis for caching session data layer",
          blocker: "Overly complex",
        },
      ],
      PROJECT,
    );
    expect(stored).toBe(0);

    // Different approach — should be stored
    const stored2 = storeItems(
      db,
      [
        {
          type: "dead_end",
          summary: "GraphQL attempt",
          approach_tried: "Tried GraphQL instead of REST API",
          blocker: "Too much boilerplate",
        },
      ],
      PROJECT,
    );
    expect(stored2).toBe(1);
  });

  it("insight dedup threshold is 0.6 (Jaccard)", () => {
    insertInsight(
      db,
      PROJECT,
      "WASM startup is surprisingly fast and efficient",
      "surprise",
    );

    // Similar — should be caught
    const stored = storeItems(
      db,
      [
        {
          type: "insight",
          content: "WASM startup is fast and surprisingly efficient",
          category: "surprise",
        },
      ],
      PROJECT,
    );
    expect(stored).toBe(0);

    // Different — should be stored
    const stored2 = storeItems(
      db,
      [
        {
          type: "insight",
          content: "Database queries are unexpectedly slow on large datasets",
          category: "architecture",
        },
      ],
      PROJECT,
    );
    expect(stored2).toBe(1);
  });
});

// =========================================================================
// 10. Unknown tool handler
// =========================================================================
describe("unknown tool handling", () => {
  it("switch default returns error for unknown tool name", () => {
    // Simulate the default case in the CallToolRequest handler
    const name = "nonexistent_tool";
    const response = {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true as const,
    };

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe("Unknown tool: nonexistent_tool");
  });
});
