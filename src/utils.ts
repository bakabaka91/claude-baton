import type { Database } from "sql.js";
import type { Memory } from "./types.js";
import { mkdirSync, existsSync } from "fs";

// --- Jaccard similarity ---

export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersectionSize = 0;
  for (const word of setA) {
    if (setB.has(word)) intersectionSize++;
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

// --- LIKE escape helper ---

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

// --- Memory search ---

export function searchMemories(
  db: Database,
  query: string,
  project?: string,
  type?: string,
): Memory[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const likeClauses = words.map(() => "content LIKE ? ESCAPE '\\'");
  let sql = `SELECT * FROM memories WHERE status = 'active' AND (${likeClauses.join(" OR ")})`;
  const params: unknown[] = words.map((w) => `%${escapeLike(w)}%`);
  if (project) {
    sql += " AND project_path = ?";
    params.push(project);
  }
  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }
  sql += " ORDER BY access_count DESC, created_at DESC LIMIT 20";

  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: Memory[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push({
      ...row,
      tags: JSON.parse(row.tags as string),
      confidence: row.confidence as number,
      access_count: row.access_count as number,
    } as Memory);
  }
  stmt.free();
  return results;
}

// --- Duplicate check ---

export function checkDuplicate(
  db: Database,
  content: string,
  project: string,
  threshold: number = 0.6,
): Memory | null {
  const stmt = db.prepare(
    "SELECT * FROM memories WHERE project_path = ? AND status = 'active'",
  );
  stmt.bind([project]);
  let bestMatch: Memory | null = null;
  let bestScore = 0;

  while (stmt.step()) {
    const row = stmt.getAsObject();
    const score = jaccardSimilarity(content, row.content as string);
    if (score >= threshold && score > bestScore) {
      bestScore = score;
      bestMatch = {
        ...row,
        tags: JSON.parse(row.tags as string),
        confidence: row.confidence as number,
        access_count: row.access_count as number,
      } as Memory;
    }
  }
  stmt.free();
  return bestMatch;
}

// --- Text chunking ---

export function chunkText(
  text: string,
  maxSize: number = 6000,
  overlap: number = 500,
): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + maxSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlap;
  }

  return chunks;
}

// --- Transcript parsing ---

function extractText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

interface TranscriptLine {
  type: string;
  message?: {
    content: string | Array<{ type: string; text?: string }>;
    tool_calls?: Array<{ name: string }>;
  };
}

export function parseTranscript(jsonl: string): string {
  const lines = jsonl.trim().split("\n").filter(Boolean);
  const summary: string[] = [];

  for (const line of lines) {
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === "human" && parsed.message) {
      summary.push(`USER: ${extractText(parsed.message.content)}`);
    } else if (parsed.type === "assistant" && parsed.message) {
      const text = extractText(parsed.message.content);
      if (text) summary.push(`ASSISTANT: ${text}`);
      if (parsed.message.tool_calls) {
        for (const tc of parsed.message.tool_calls) {
          summary.push(`  [tool: ${tc.name}]`);
        }
      }
    }
  }

  return summary.join("\n");
}

// --- Path helpers ---

export function getProjectPath(): string {
  return process.cwd();
}

export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}
