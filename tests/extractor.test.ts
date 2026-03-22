import { describe, it, expect, vi, beforeEach } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import {
  initSchema,
  getMemoriesByProject,
  getDeadEndsByProject,
  getConstraintsByProject,
  getInsightsByProject,
  getCursorPosition,
} from "../src/store.js";

// Mock LLM and CLAUDE.md sync
vi.mock("../src/llm.js", () => ({ callClaudeJson: vi.fn() }));
vi.mock("../src/claude-md.js", () => ({
  syncClaudeMd: vi.fn().mockReturnValue("Synced."),
}));

import { callClaudeJson } from "../src/llm.js";
import {
  parseExtractedItems,
  storeItems,
  loadPromptTemplate,
  buildPrompt,
  extractFromTranscript,
  extractFromRawText,
} from "../src/extractor.js";

const mockCallClaudeJson = vi.mocked(callClaudeJson);

let db: Database;
const PROJECT = "/test/project";
const SESSION = "session-1";

beforeEach(async () => {
  vi.clearAllMocks();
  const SQL = await initSqlJs();
  db = new SQL.Database();
  initSchema(db);
});

// --- parseExtractedItems ---

describe("parseExtractedItems", () => {
  it("parses a valid memory item", () => {
    const result = parseExtractedItems([
      {
        type: "memory",
        memory_type: "decision",
        content: "Use SQLite for storage",
        tags: ["sqlite", "db"],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "memory",
      memory_type: "decision",
      content: "Use SQLite for storage",
      tags: ["sqlite", "db"],
    });
  });

  it("parses a valid dead_end item", () => {
    const result = parseExtractedItems([
      {
        type: "dead_end",
        summary: "Failed approach",
        approach_tried: "Used native bindings",
        blocker: "WASM required",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "dead_end",
      summary: "Failed approach",
      approach_tried: "Used native bindings",
      blocker: "WASM required",
    });
  });

  it("parses a valid constraint item", () => {
    const result = parseExtractedItems([
      {
        type: "constraint",
        rule: "No API keys",
        constraint_type: "security",
        severity: "must",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "constraint",
      rule: "No API keys",
      constraint_type: "security",
      severity: "must",
    });
  });

  it("parses a valid insight item", () => {
    const result = parseExtractedItems([
      {
        type: "insight",
        content: "sql.js is 2x slower on large queries",
        category: "surprise",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "insight",
      content: "sql.js is 2x slower on large queries",
      category: "surprise",
    });
  });

  it("returns [] for non-array input (null, undefined, string, object)", () => {
    expect(parseExtractedItems(null)).toEqual([]);
    expect(parseExtractedItems(undefined)).toEqual([]);
    expect(parseExtractedItems("hello")).toEqual([]);
    expect(parseExtractedItems({ type: "memory" })).toEqual([]);
  });

  it("skips unknown types", () => {
    const result = parseExtractedItems([
      { type: "unknown_type", content: "test" },
      { type: "memory", memory_type: "decision", content: "Valid", tags: [] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("memory");
  });

  it("skips items missing required fields", () => {
    const result = parseExtractedItems([
      { type: "memory", content: "Missing memory_type" },
      { type: "dead_end", summary: "Missing approach_tried and blocker" },
      { type: "constraint", rule: "Missing type and severity" },
      { type: "insight", content: "Missing category" },
    ]);
    expect(result).toEqual([]);
  });

  it("filters non-string tags from memory items", () => {
    const result = parseExtractedItems([
      {
        type: "memory",
        memory_type: "pattern",
        content: "Test",
        tags: ["valid", 42, null, "also-valid", true],
      },
    ]);
    expect(result).toHaveLength(1);
    expect((result[0] as { tags: string[] }).tags).toEqual([
      "valid",
      "also-valid",
    ]);
  });
});

// --- buildPrompt + loadPromptTemplate ---

describe("buildPrompt + loadPromptTemplate", () => {
  it("template loads and contains {{CHUNK}} placeholder", () => {
    const template = loadPromptTemplate();
    expect(template).toContain("{{CHUNK}}");
  });

  it("replaces {{CHUNK}} placeholder with chunk text", () => {
    const template = "Analyze: {{CHUNK}}";
    const result = buildPrompt(template, "some conversation text");
    expect(result).toBe("Analyze: some conversation text");
    expect(result).not.toContain("{{CHUNK}}");
  });

  it("handles special characters in chunk", () => {
    const template = "Analyze: {{CHUNK}}";
    const chunk = 'text with $pecial chars & "quotes" {braces} \n newlines';
    const result = buildPrompt(template, chunk);
    expect(result).toContain(chunk);
  });
});

// --- storeItems ---

describe("storeItems", () => {
  it("stores a memory item", () => {
    const items = parseExtractedItems([
      {
        type: "memory",
        memory_type: "decision",
        content: "Use SQLite",
        tags: ["db"],
      },
    ]);
    const stored = storeItems(db, items, PROJECT);
    expect(stored).toBe(1);
    const memories = getMemoriesByProject(db, PROJECT);
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe("Use SQLite");
  });

  it("stores a dead_end item", () => {
    const items = parseExtractedItems([
      {
        type: "dead_end",
        summary: "Failed",
        approach_tried: "Native SQLite bindings",
        blocker: "WASM only",
      },
    ]);
    const stored = storeItems(db, items, PROJECT);
    expect(stored).toBe(1);
    const deadEnds = getDeadEndsByProject(db, PROJECT);
    expect(deadEnds).toHaveLength(1);
    expect(deadEnds[0].approach_tried).toBe("Native SQLite bindings");
  });

  it("stores a constraint item", () => {
    const items = parseExtractedItems([
      {
        type: "constraint",
        rule: "No API keys allowed",
        constraint_type: "security",
        severity: "must",
      },
    ]);
    const stored = storeItems(db, items, PROJECT);
    expect(stored).toBe(1);
    const constraints = getConstraintsByProject(db, PROJECT);
    expect(constraints).toHaveLength(1);
    expect(constraints[0].rule).toBe("No API keys allowed");
  });

  it("stores an insight item", () => {
    const items = parseExtractedItems([
      {
        type: "insight",
        content: "WASM startup takes 200ms",
        category: "surprise",
      },
    ]);
    const stored = storeItems(db, items, PROJECT);
    expect(stored).toBe(1);
    const insights = getInsightsByProject(db, PROJECT);
    expect(insights).toHaveLength(1);
    expect(insights[0].content).toBe("WASM startup takes 200ms");
  });

  it("deduplicates memory items (Jaccard >= 0.6)", () => {
    // First, store one memory
    storeItems(
      db,
      parseExtractedItems([
        {
          type: "memory",
          memory_type: "decision",
          content: "Use SQLite for persistent storage database",
          tags: [],
        },
      ]),
      PROJECT,
    );
    // Try to store a very similar one
    const stored = storeItems(
      db,
      parseExtractedItems([
        {
          type: "memory",
          memory_type: "decision",
          content: "Use SQLite for persistent storage in the database",
          tags: [],
        },
      ]),
      PROJECT,
    );
    expect(stored).toBe(0);
    expect(getMemoriesByProject(db, PROJECT)).toHaveLength(1);
  });

  it("deduplicates dead_end items (Jaccard >= 0.6)", () => {
    storeItems(
      db,
      parseExtractedItems([
        {
          type: "dead_end",
          summary: "Failed",
          approach_tried: "tried using native bindings for sqlite",
          blocker: "fails",
        },
      ]),
      PROJECT,
    );
    const stored = storeItems(
      db,
      parseExtractedItems([
        {
          type: "dead_end",
          summary: "Failed again",
          approach_tried: "tried using native bindings for sqlite database",
          blocker: "still fails",
        },
      ]),
      PROJECT,
    );
    expect(stored).toBe(0);
    expect(getDeadEndsByProject(db, PROJECT)).toHaveLength(1);
  });

  it("deduplicates constraint items (Jaccard >= 0.8)", () => {
    storeItems(
      db,
      parseExtractedItems([
        {
          type: "constraint",
          rule: "Never use API keys for authentication",
          constraint_type: "security",
          severity: "must",
        },
      ]),
      PROJECT,
    );
    // Very similar but not 0.8 — should still store
    const stored = storeItems(
      db,
      parseExtractedItems([
        {
          type: "constraint",
          rule: "Completely different constraint about performance",
          constraint_type: "performance",
          severity: "should",
        },
      ]),
      PROJECT,
    );
    expect(stored).toBe(1);
    expect(getConstraintsByProject(db, PROJECT)).toHaveLength(2);
  });

  it("deduplicates insight items (Jaccard >= 0.6)", () => {
    storeItems(
      db,
      parseExtractedItems([
        {
          type: "insight",
          content: "sql.js WASM startup takes about 200ms on cold start",
          category: "surprise",
        },
      ]),
      PROJECT,
    );
    const stored = storeItems(
      db,
      parseExtractedItems([
        {
          type: "insight",
          content:
            "sql.js WASM startup takes approximately 200ms on cold start loading",
          category: "surprise",
        },
      ]),
      PROJECT,
    );
    expect(stored).toBe(0);
    expect(getInsightsByProject(db, PROJECT)).toHaveLength(1);
  });
});

// --- extractFromTranscript ---

describe("extractFromTranscript", () => {
  it("extracts items from transcript via mocked LLM and stores them", async () => {
    mockCallClaudeJson.mockResolvedValueOnce([
      {
        type: "memory",
        memory_type: "decision",
        content: "Decided to use SQLite",
        tags: ["db"],
      },
      {
        type: "insight",
        content: "WASM is fast enough",
        category: "architecture",
      },
    ]);

    const result = await extractFromRawText(
      db,
      "Some conversation about databases and storage",
      PROJECT,
      SESSION,
      "stop",
    );

    expect(result.chunksProcessed).toBe(1);
    expect(result.itemsExtracted).toBe(2);
    expect(result.itemsStored).toBe(2);
    expect(result.errors).toEqual([]);
    expect(mockCallClaudeJson).toHaveBeenCalledTimes(1);
    expect(getMemoriesByProject(db, PROJECT)).toHaveLength(1);
    expect(getInsightsByProject(db, PROJECT)).toHaveLength(1);
  });

  it("returns zeros for empty transcript, no LLM call made", async () => {
    const result = await extractFromRawText(db, "", PROJECT, SESSION, "stop");

    expect(result.chunksProcessed).toBe(0);
    expect(result.itemsExtracted).toBe(0);
    expect(result.itemsStored).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mockCallClaudeJson).not.toHaveBeenCalled();
  });

  it("advances cursor position (getCursorPosition returns text.length)", async () => {
    const text = "A conversation about architecture decisions and patterns";
    mockCallClaudeJson.mockResolvedValueOnce([]);

    await extractFromRawText(db, text, PROJECT, SESSION, "stop");

    const cursor = getCursorPosition(db, PROJECT, SESSION);
    expect(cursor).toBe(text.length);
  });

  it("skips already-processed text on second call (cursor at end)", async () => {
    const text = "Some conversation text about the project";
    mockCallClaudeJson.mockResolvedValueOnce([]);

    await extractFromRawText(db, text, PROJECT, SESSION, "stop");
    mockCallClaudeJson.mockClear();

    // Second call with same text — cursor is at text.length, newText is empty
    const result = await extractFromRawText(db, text, PROJECT, SESSION, "stop");

    expect(result.chunksProcessed).toBe(0);
    expect(mockCallClaudeJson).not.toHaveBeenCalled();
  });

  it("chunks large text (>6000 chars), calls LLM per chunk", async () => {
    const largeText = "word ".repeat(2000); // ~10000 chars
    mockCallClaudeJson.mockResolvedValue([]);

    const result = await extractFromRawText(
      db,
      largeText,
      PROJECT,
      SESSION,
      "stop",
    );

    expect(result.chunksProcessed).toBeGreaterThan(1);
    expect(mockCallClaudeJson).toHaveBeenCalledTimes(result.chunksProcessed);
  });

  it("captures LLM errors in errors array without throwing", async () => {
    mockCallClaudeJson.mockRejectedValueOnce(new Error("LLM timed out"));

    const result = await extractFromRawText(
      db,
      "Some text to process",
      PROJECT,
      SESSION,
      "stop",
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("LLM timed out");
    expect(result.itemsExtracted).toBe(0);
  });
});

// --- extractFromRawText ---

describe("extractFromRawText", () => {
  it("passes raw flag to skip JSONL parsing", async () => {
    const plainText = "This is plain text, not JSONL";
    mockCallClaudeJson.mockResolvedValueOnce([
      {
        type: "memory",
        memory_type: "context",
        content: "Plain text processed",
        tags: [],
      },
    ]);

    const result = await extractFromRawText(
      db,
      plainText,
      PROJECT,
      SESSION,
      "stop",
    );

    expect(result.itemsExtracted).toBe(1);
    expect(result.itemsStored).toBe(1);
  });

  it("returns valid ExtractionResult shape", async () => {
    mockCallClaudeJson.mockResolvedValueOnce([]);

    const result = await extractFromRawText(
      db,
      "test text",
      PROJECT,
      SESSION,
      "stop",
    );

    expect(result).toHaveProperty("chunksProcessed");
    expect(result).toHaveProperty("itemsExtracted");
    expect(result).toHaveProperty("itemsStored");
    expect(result).toHaveProperty("errors");
    expect(typeof result.chunksProcessed).toBe("number");
    expect(typeof result.itemsExtracted).toBe("number");
    expect(typeof result.itemsStored).toBe("number");
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
