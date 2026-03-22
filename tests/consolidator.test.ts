import { describe, it, expect, vi, beforeEach } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import {
  initSchema,
  insertMemory,
  getMemory,
  getMemoriesByProject,
} from "../src/store.js";
import type { MemoryType } from "../src/types.js";

// Mock LLM and CLAUDE.md sync
vi.mock("../src/llm.js", () => ({ callClaudeJson: vi.fn() }));
vi.mock("../src/claude-md.js", () => ({
  syncClaudeMd: vi.fn().mockReturnValue("Synced."),
}));

import { callClaudeJson } from "../src/llm.js";
import {
  applyDecay,
  deduplicateMemories,
  parseConsolidateActions,
  applyConsolidateActions,
  llmConsolidate,
  consolidate,
  DECAY_CONFIG,
  ARCHIVE_THRESHOLD,
  DEDUP_THRESHOLD,
  CONSOLIDATION_THRESHOLD,
  TYPE_CONSOLIDATION_THRESHOLD,
} from "../src/consolidator.js";

const mockCallClaudeJson = vi.mocked(callClaudeJson);

let db: Database;
const PROJECT = "/test/project";

beforeEach(async () => {
  vi.clearAllMocks();
  const SQL = await initSqlJs();
  db = new SQL.Database();
  initSchema(db);
});

/** Insert a memory and backdate its updated_at via direct SQL. */
function insertMemoryWithDate(
  db: Database,
  project: string,
  type: MemoryType,
  content: string,
  updatedAt: string,
): string {
  const id = insertMemory(db, project, type, content);
  db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [updatedAt, id]);
  return id;
}

// --- constants ---

describe("constants", () => {
  it("verifies threshold and decay config values", () => {
    expect(ARCHIVE_THRESHOLD).toBe(0.3);
    expect(DEDUP_THRESHOLD).toBe(0.6);
    expect(CONSOLIDATION_THRESHOLD).toBe(50);
    expect(TYPE_CONSOLIDATION_THRESHOLD).toBe(10);
    expect(DECAY_CONFIG.progress.periodDays).toBe(7);
    expect(DECAY_CONFIG.context.periodDays).toBe(30);
  });
});

// --- applyDecay ---

describe("applyDecay", () => {
  it("no decay for recent memories", () => {
    insertMemory(db, PROJECT, "progress", "Recent progress");
    insertMemory(db, PROJECT, "context", "Recent context");

    const result = applyDecay(db, PROJECT);

    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
  });

  it("decays progress after 7d (confidence * 0.9^periods)", () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const id = insertMemoryWithDate(
      db,
      PROJECT,
      "progress",
      "Old progress",
      eightDaysAgo,
    );

    const result = applyDecay(db, PROJECT);

    expect(result.decayed).toBe(1);
    const mem = getMemory(db, id);
    expect(mem!.confidence).toBeCloseTo(0.9, 5); // 1.0 * 0.9^1
    expect(mem!.status).toBe("active");
  });

  it("decays context after 30d (confidence * 0.9^periods)", () => {
    const thirtyFiveDaysAgo = new Date(
      Date.now() - 35 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const id = insertMemoryWithDate(
      db,
      PROJECT,
      "context",
      "Old context",
      thirtyFiveDaysAgo,
    );

    const result = applyDecay(db, PROJECT);

    expect(result.decayed).toBe(1);
    const mem = getMemory(db, id);
    expect(mem!.confidence).toBeCloseTo(0.9, 5); // 1.0 * 0.9^1
  });

  it("archives when confidence drops below 0.3", () => {
    // 0.9^22 ≈ 0.098 < 0.3 — need 22 periods = 154 days for progress
    const longAgo = new Date(
      Date.now() - 155 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const id = insertMemoryWithDate(
      db,
      PROJECT,
      "progress",
      "Very old progress",
      longAgo,
    );

    const result = applyDecay(db, PROJECT);

    expect(result.archived).toBe(1);
    const mem = getMemory(db, id);
    expect(mem!.status).toBe("archived");
  });

  it("applies multiple periods (21d = 3 periods for progress)", () => {
    const twentyTwoDaysAgo = new Date(
      Date.now() - 22 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const id = insertMemoryWithDate(
      db,
      PROJECT,
      "progress",
      "Three-period progress",
      twentyTwoDaysAgo,
    );

    applyDecay(db, PROJECT);

    const mem = getMemory(db, id);
    expect(mem!.confidence).toBeCloseTo(Math.pow(0.9, 3), 5); // 0.729
  });

  it("does NOT decay decision/architecture/pattern/gotcha types", () => {
    const longAgo = new Date(
      Date.now() - 100 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const types: MemoryType[] = [
      "decision",
      "architecture",
      "pattern",
      "gotcha",
    ];
    const ids: string[] = [];
    for (const type of types) {
      ids.push(
        insertMemoryWithDate(db, PROJECT, type, `${type} memory`, longAgo),
      );
    }

    const result = applyDecay(db, PROJECT);

    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
    for (const id of ids) {
      const mem = getMemory(db, id);
      expect(mem!.confidence).toBe(1.0);
      expect(mem!.status).toBe("active");
    }
  });

  it("only decays active memories (skips archived)", () => {
    const longAgo = new Date(
      Date.now() - 100 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const id = insertMemoryWithDate(
      db,
      PROJECT,
      "progress",
      "Already archived",
      longAgo,
    );
    // Archive it manually
    db.run("UPDATE memories SET status = 'archived' WHERE id = ?", [id]);

    const result = applyDecay(db, PROJECT);

    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
  });
});

// --- deduplicateMemories ---

describe("deduplicateMemories", () => {
  it("deduplicates similar memories (Jaccard >= 0.6)", () => {
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

    const count = deduplicateMemories(db, PROJECT);

    expect(count).toBe(1);
    const active = getMemoriesByProject(db, PROJECT, undefined, "active");
    expect(active).toHaveLength(1);
  });

  it("keeps higher access_count; tiebreaks by newer created_at", () => {
    const id1 = insertMemory(
      db,
      PROJECT,
      "decision",
      "Use SQLite for persistent storage database layer",
    );
    const id2 = insertMemory(
      db,
      PROJECT,
      "decision",
      "Use SQLite for persistent storage in the database layer",
    );
    // Give id2 a higher access_count
    db.run("UPDATE memories SET access_count = 5 WHERE id = ?", [id2]);

    deduplicateMemories(db, PROJECT);

    const active = getMemoriesByProject(db, PROJECT, undefined, "active");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(id2);
  });

  it("does not deduplicate dissimilar content", () => {
    insertMemory(db, PROJECT, "decision", "Use SQLite for the database");
    insertMemory(
      db,
      PROJECT,
      "pattern",
      "React components should be functional",
    );

    const count = deduplicateMemories(db, PROJECT);

    expect(count).toBe(0);
    const active = getMemoriesByProject(db, PROJECT, undefined, "active");
    expect(active).toHaveLength(2);
  });

  it("sets supersedes_id on loser via direct SQL", () => {
    const id1 = insertMemory(
      db,
      PROJECT,
      "decision",
      "Use SQLite for persistent storage database layer",
    );
    const id2 = insertMemory(
      db,
      PROJECT,
      "decision",
      "Use SQLite for persistent storage in the database layer",
    );
    // Make id1 the keeper
    db.run("UPDATE memories SET access_count = 10 WHERE id = ?", [id1]);

    deduplicateMemories(db, PROJECT);

    const loser = getMemory(db, id2);
    expect(loser!.status).toBe("superseded");
    expect(loser!.supersedes_id).toBe(id1);
  });

  it("handles empty project gracefully", () => {
    const count = deduplicateMemories(db, PROJECT);
    expect(count).toBe(0);
  });

  it("handles single memory gracefully", () => {
    insertMemory(db, PROJECT, "decision", "Only one memory here");
    const count = deduplicateMemories(db, PROJECT);
    expect(count).toBe(0);
  });
});

// --- parseConsolidateActions ---

describe("parseConsolidateActions", () => {
  it("parses keep action", () => {
    const result = parseConsolidateActions([{ action: "keep", ids: ["id1"] }]);
    expect(result).toEqual([{ action: "keep", ids: ["id1"] }]);
  });

  it("parses merge action with merged_content", () => {
    const result = parseConsolidateActions([
      {
        action: "merge",
        ids: ["id1", "id2"],
        merged_content: "Combined memory",
      },
    ]);
    expect(result).toEqual([
      {
        action: "merge",
        ids: ["id1", "id2"],
        merged_content: "Combined memory",
      },
    ]);
  });

  it("parses drop action with reason", () => {
    const result = parseConsolidateActions([
      { action: "drop", ids: ["id1"], reason: "outdated" },
    ]);
    expect(result).toEqual([
      { action: "drop", ids: ["id1"], reason: "outdated" },
    ]);
  });

  it("rejects merge with <2 ids or missing merged_content", () => {
    const result = parseConsolidateActions([
      { action: "merge", ids: ["id1"], merged_content: "Only one id" },
      { action: "merge", ids: ["id1", "id2"] }, // missing merged_content
    ]);
    expect(result).toEqual([]);
  });

  it("returns [] for non-array input", () => {
    expect(parseConsolidateActions(null)).toEqual([]);
    expect(parseConsolidateActions(undefined)).toEqual([]);
    expect(parseConsolidateActions("hello")).toEqual([]);
    expect(parseConsolidateActions({ action: "keep" })).toEqual([]);
  });

  it("filters out items with missing action or empty ids", () => {
    const result = parseConsolidateActions([
      { ids: ["id1"] }, // missing action
      { action: "keep", ids: [] }, // empty ids
      { action: "keep", ids: ["id1"] }, // valid
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ action: "keep", ids: ["id1"] });
  });
});

// --- applyConsolidateActions ---

describe("applyConsolidateActions", () => {
  it("keep is no-op", () => {
    const id = insertMemory(db, PROJECT, "decision", "Keep this");
    const result = applyConsolidateActions(
      db,
      [{ action: "keep", ids: [id] }],
      PROJECT,
    );

    expect(result.merged).toBe(0);
    expect(result.archived).toBe(0);
    const mem = getMemory(db, id);
    expect(mem!.status).toBe("active");
  });

  it("merge: archives sources, inserts new with union tags + confidence 1.0", () => {
    const id1 = insertMemory(db, PROJECT, "decision", "Decision part A", [
      "tag-a",
    ]);
    const id2 = insertMemory(db, PROJECT, "decision", "Decision part B", [
      "tag-b",
    ]);

    const result = applyConsolidateActions(
      db,
      [
        {
          action: "merge",
          ids: [id1, id2],
          merged_content: "Combined decision A and B",
        },
      ],
      PROJECT,
    );

    expect(result.merged).toBe(1);
    expect(result.archived).toBe(2);

    // Source memories should be archived
    expect(getMemory(db, id1)!.status).toBe("archived");
    expect(getMemory(db, id2)!.status).toBe("archived");

    // New merged memory should exist
    const active = getMemoriesByProject(db, PROJECT, undefined, "active");
    expect(active).toHaveLength(1);
    expect(active[0].content).toBe("Combined decision A and B");
    expect(active[0].confidence).toBe(1.0);
    expect(active[0].tags.sort()).toEqual(["tag-a", "tag-b"]);
  });

  it("drop: archives memories", () => {
    const id = insertMemory(db, PROJECT, "progress", "Outdated progress");

    const result = applyConsolidateActions(
      db,
      [{ action: "drop", ids: [id], reason: "outdated" }],
      PROJECT,
    );

    expect(result.archived).toBe(1);
    expect(getMemory(db, id)!.status).toBe("archived");
  });

  it("preserves type from source memories", () => {
    const id1 = insertMemory(db, PROJECT, "pattern", "Pattern A");
    const id2 = insertMemory(db, PROJECT, "pattern", "Pattern B");

    applyConsolidateActions(
      db,
      [
        {
          action: "merge",
          ids: [id1, id2],
          merged_content: "Merged pattern",
        },
      ],
      PROJECT,
    );

    const active = getMemoriesByProject(db, PROJECT, undefined, "active");
    expect(active).toHaveLength(1);
    expect(active[0].type).toBe("pattern");
  });

  it("collects/deduplicates tags across sources", () => {
    const id1 = insertMemory(db, PROJECT, "decision", "Dec A", [
      "shared",
      "tag-a",
    ]);
    const id2 = insertMemory(db, PROJECT, "decision", "Dec B", [
      "shared",
      "tag-b",
    ]);

    applyConsolidateActions(
      db,
      [
        {
          action: "merge",
          ids: [id1, id2],
          merged_content: "Merged",
        },
      ],
      PROJECT,
    );

    const active = getMemoriesByProject(db, PROJECT, undefined, "active");
    expect(active).toHaveLength(1);
    expect(active[0].tags.sort()).toEqual(["shared", "tag-a", "tag-b"]);
  });
});

// --- llmConsolidate ---

describe("llmConsolidate", () => {
  it("skips when <= 50 active memories", async () => {
    // Insert only 10 memories
    for (let i = 0; i < 10; i++) {
      insertMemory(db, PROJECT, "decision", `Memory ${i}`);
    }

    const result = await llmConsolidate(db, PROJECT, "haiku");

    expect(result.merged).toBe(0);
    expect(result.archived).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mockCallClaudeJson).not.toHaveBeenCalled();
  });

  it("skips types with <= 10 memories", async () => {
    // Insert 51 memories total but spread across types so none exceed 10
    const types: MemoryType[] = [
      "decision",
      "architecture",
      "pattern",
      "gotcha",
      "progress",
      "context",
    ];
    for (let i = 0; i < 51; i++) {
      insertMemory(db, PROJECT, types[i % types.length], `Memory ${i}`);
    }

    const result = await llmConsolidate(db, PROJECT, "haiku");

    expect(result.merged).toBe(0);
    expect(result.archived).toBe(0);
    expect(mockCallClaudeJson).not.toHaveBeenCalled();
  });

  it("processes types above threshold, returns merged/archived counts", async () => {
    // Insert 51 memories, all same type so it exceeds both thresholds
    for (let i = 0; i < 51; i++) {
      insertMemory(db, PROJECT, "decision", `Decision memory number ${i}`);
    }

    mockCallClaudeJson.mockResolvedValueOnce([
      { action: "keep", ids: ["dummy"] },
    ]);

    const result = await llmConsolidate(db, PROJECT, "haiku");

    expect(mockCallClaudeJson).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
  });

  it("captures LLM errors without throwing", async () => {
    for (let i = 0; i < 51; i++) {
      insertMemory(db, PROJECT, "decision", `Decision memory ${i}`);
    }

    mockCallClaudeJson.mockRejectedValueOnce(new Error("LLM timeout"));

    const result = await llmConsolidate(db, PROJECT, "haiku");

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("LLM timeout");
    expect(result.errors[0]).toContain("decision");
  });
});

// --- consolidate ---

describe("consolidate", () => {
  it("runs all 3 steps (decay + dedup + LLM)", async () => {
    // Insert a decayable progress memory (old)
    const longAgo = new Date(
      Date.now() - 15 * 24 * 60 * 60 * 1000,
    ).toISOString();
    insertMemoryWithDate(db, PROJECT, "progress", "Old progress", longAgo);

    // Insert duplicates for dedup
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

    const result = await consolidate(db, PROJECT);

    expect(result.decayed).toBe(1); // progress memory decayed
    expect(result.deduplicated).toBe(1); // one pair deduped
    expect(result.errors).toEqual([]);
  });

  it("returns zeros for empty project", async () => {
    const result = await consolidate(db, PROJECT);

    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
    expect(result.deduplicated).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("aggregates archived from decay + LLM", async () => {
    // Insert an archivable progress memory (very old)
    const longAgo = new Date(
      Date.now() - 200 * 24 * 60 * 60 * 1000,
    ).toISOString();
    insertMemoryWithDate(
      db,
      PROJECT,
      "progress",
      "Ancient progress note",
      longAgo,
    );

    const result = await consolidate(db, PROJECT);

    // Should archive from decay (confidence < 0.3 for very old progress)
    expect(result.archived).toBeGreaterThanOrEqual(1);
  });

  it("passes model option to callClaudeJson", async () => {
    // Need 51+ memories of one type to trigger LLM consolidation.
    // Each memory needs enough unique words so Jaccard < 0.6 between any pair.
    for (let i = 0; i < 51; i++) {
      // 6 unique words per memory, no overlap between memories
      const words = [];
      for (let w = 0; w < 6; w++) {
        words.push(`w${i}x${w}`);
      }
      insertMemory(db, PROJECT, "decision", words.join(" "));
    }

    mockCallClaudeJson.mockResolvedValueOnce([]);

    await consolidate(db, PROJECT, { model: "sonnet" });

    expect(mockCallClaudeJson).toHaveBeenCalledWith(
      expect.any(String),
      "sonnet",
      60000,
    );
  });
});
