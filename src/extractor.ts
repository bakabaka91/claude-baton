import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Database } from "sql.js";
import type {
  ExtractedItem,
  MemoryType,
  ConstraintType,
  ConstraintSeverity,
  InsightCategory,
} from "./types.js";
import { callClaudeJson } from "./llm.js";
import {
  parseTranscript,
  chunkText,
  checkDuplicate,
  jaccardSimilarity,
} from "./utils.js";
import {
  insertMemory,
  insertDeadEnd,
  insertConstraint,
  insertInsight,
  insertExtractionLog,
  getDeadEndsByProject,
  getConstraintsByProject,
  getInsightsByProject,
  getCursorPosition,
  saveDatabase,
} from "./store.js";
import { syncClaudeMd } from "./claude-md.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadPromptTemplate(): string {
  const promptPath = path.join(__dirname, "..", "prompts", "extract.txt");
  return readFileSync(promptPath, "utf-8");
}

function buildPrompt(template: string, chunk: string): string {
  return template.replace("{{CHUNK}}", chunk);
}

function parseExtractedItems(raw: unknown): ExtractedItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ExtractedItem[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object" || !("type" in item)) continue;

    // Helper: accept common LLM field name aliases
    const str = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        if (typeof item[k] === "string") return item[k];
      }
      return undefined;
    };

    switch (item.type) {
      case "memory": {
        const content = str("content", "description", "summary");
        const memory_type = str("memory_type");
        if (content && memory_type) {
          items.push({
            type: "memory",
            memory_type: memory_type as MemoryType,
            content,
            tags: Array.isArray(item.tags)
              ? item.tags.filter((t: unknown) => typeof t === "string")
              : [],
          });
        }
        break;
      }
      case "dead_end": {
        const summary = str("summary", "title", "description");
        const approach_tried = str("approach_tried", "approach", "tried");
        const blocker = str("blocker", "reason", "context", "failure");
        if (summary && approach_tried && blocker) {
          items.push({
            type: "dead_end",
            summary,
            approach_tried,
            blocker,
          });
        }
        break;
      }
      case "constraint": {
        const rule = str("rule", "description", "content");
        const constraint_type = str("constraint_type");
        const severity = str("severity");
        if (rule && constraint_type && severity) {
          items.push({
            type: "constraint",
            rule,
            constraint_type: constraint_type as ConstraintType,
            severity: severity as ConstraintSeverity,
          });
        }
        break;
      }
      case "insight": {
        const content = str("content", "description", "summary");
        const category = str("category");
        if (content && category) {
          items.push({
            type: "insight",
            content,
            category: category as InsightCategory,
          });
        }
        break;
      }
    }
  }

  return items;
}

function storeItems(
  db: Database,
  items: ExtractedItem[],
  projectPath: string,
  dbPath?: string,
): number {
  let stored = 0;

  for (const item of items) {
    switch (item.type) {
      case "memory": {
        const duplicate = checkDuplicate(db, item.content, projectPath);
        if (duplicate) continue;
        insertMemory(
          db,
          projectPath,
          item.memory_type,
          item.content,
          item.tags,
        );
        stored++;
        break;
      }
      case "dead_end": {
        const existingDeadEnds = getDeadEndsByProject(db, projectPath);
        const isDupDeadEnd = existingDeadEnds.some(
          (de) =>
            jaccardSimilarity(item.approach_tried, de.approach_tried) >= 0.6,
        );
        if (isDupDeadEnd) continue;
        insertDeadEnd(
          db,
          projectPath,
          item.summary,
          item.approach_tried,
          item.blocker,
        );
        stored++;
        break;
      }
      case "constraint": {
        const existingConstraints = getConstraintsByProject(db, projectPath);
        const isDupConstraint = existingConstraints.some(
          (c) =>
            c.rule === item.rule || jaccardSimilarity(item.rule, c.rule) >= 0.8,
        );
        if (isDupConstraint) continue;
        insertConstraint(
          db,
          projectPath,
          item.rule,
          item.constraint_type,
          item.severity,
        );
        stored++;
        break;
      }
      case "insight": {
        const existingInsights = getInsightsByProject(db, projectPath);
        const isDupInsight = existingInsights.some(
          (ins) => jaccardSimilarity(item.content, ins.content) >= 0.6,
        );
        if (isDupInsight) continue;
        insertInsight(db, projectPath, item.content, item.category);
        stored++;
        break;
      }
    }
  }

  if (dbPath && stored > 0) saveDatabase(db, dbPath);
  return stored;
}

export interface ExtractionResult {
  chunksProcessed: number;
  itemsExtracted: number;
  itemsStored: number;
  errors: string[];
}

interface ExtractOptions {
  dbPath?: string;
  syncMd?: boolean;
  model?: string;
  raw?: boolean;
}

async function extractChunks(
  db: Database,
  chunks: string[],
  template: string,
  projectPath: string,
  model: string,
  dbPath?: string,
): Promise<{ totalExtracted: number; totalStored: number; errors: string[] }> {
  let totalExtracted = 0;
  let totalStored = 0;
  const errors: string[] = [];

  for (const chunk of chunks) {
    const prompt = buildPrompt(template, chunk);
    try {
      const raw = await callClaudeJson<unknown>(prompt, model, 60000);
      if (process.env.MEMORIA_DEBUG) {
        console.error("[DEBUG] LLM raw response:", JSON.stringify(raw));
      }
      const items = parseExtractedItems(raw);
      if (process.env.MEMORIA_DEBUG) {
        console.error(
          "[DEBUG] Parsed items:",
          items.length,
          JSON.stringify(items),
        );
      }
      totalExtracted += items.length;
      totalStored += storeItems(db, items, projectPath, dbPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(msg);
    }
  }

  return { totalExtracted, totalStored, errors };
}

export async function extractFromTranscript(
  db: Database,
  transcript: string,
  projectPath: string,
  sessionId: string,
  eventType: string,
  opts?: ExtractOptions,
): Promise<ExtractionResult> {
  const template = loadPromptTemplate();
  const text = opts?.raw ? transcript : parseTranscript(transcript);

  if (!text.trim()) {
    return {
      chunksProcessed: 0,
      itemsExtracted: 0,
      itemsStored: 0,
      errors: [],
    };
  }

  // Cursor-based incremental processing: skip already-processed text
  const cursorPos = getCursorPosition(db, projectPath, sessionId);
  const newText = text.slice(cursorPos);

  if (!newText.trim()) {
    return {
      chunksProcessed: 0,
      itemsExtracted: 0,
      itemsStored: 0,
      errors: [],
    };
  }

  const chunks = chunkText(newText, 6000, 500);
  const model = opts?.model ?? "haiku";

  const { totalExtracted, totalStored, errors } = await extractChunks(
    db,
    chunks,
    template,
    projectPath,
    model,
    opts?.dbPath,
  );

  // Log extraction with cursor position (text.length = total bytes processed so far)
  insertExtractionLog(
    db,
    projectPath,
    sessionId,
    eventType,
    chunks.length,
    totalStored,
    text.length,
    opts?.dbPath,
  );

  // Sync CLAUDE.md if requested and items were stored
  if (opts?.syncMd && totalStored > 0) {
    try {
      syncClaudeMd(db, projectPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`CLAUDE.md sync failed: ${msg}`);
    }
  }

  return {
    chunksProcessed: chunks.length,
    itemsExtracted: totalExtracted,
    itemsStored: totalStored,
    errors,
  };
}

/**
 * Extract from raw text (skips JSONL transcript parsing).
 * Thin wrapper around extractFromTranscript with raw flag.
 */
export async function extractFromRawText(
  db: Database,
  text: string,
  projectPath: string,
  sessionId: string,
  eventType: string,
  opts?: { dbPath?: string; syncMd?: boolean; model?: string },
): Promise<ExtractionResult> {
  return extractFromTranscript(db, text, projectPath, sessionId, eventType, {
    ...opts,
    raw: true,
  });
}

// Exported for testing
export { parseExtractedItems, storeItems, loadPromptTemplate, buildPrompt };
