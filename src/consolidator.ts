import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Database } from "sql.js";
import type { Memory, MemoryType } from "./types.js";
import { callClaudeJson } from "./llm.js";
import { jaccardSimilarity } from "./utils.js";
import {
  getMemoriesByProject,
  updateMemoryStatus,
  updateMemoryConfidence,
  insertMemory,
  saveDatabase,
} from "./store.js";
import { syncClaudeMd } from "./claude-md.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Types ---

export interface ConsolidationResult {
  decayed: number;
  archived: number;
  deduplicated: number;
  merged: number;
  errors: string[];
}

interface ConsolidateAction {
  action: "keep" | "merge" | "drop";
  ids: string[];
  merged_content?: string;
  reason?: string;
}

// --- Decay configuration ---

const DECAY_CONFIG: Record<string, { periodDays: number }> = {
  progress: { periodDays: 7 },
  context: { periodDays: 30 },
};

const ARCHIVE_THRESHOLD = 0.3;
const DEDUP_THRESHOLD = 0.6;
const CONSOLIDATION_THRESHOLD = 50;
const TYPE_CONSOLIDATION_THRESHOLD = 10;

// --- Prompt loading ---

function loadConsolidateTemplate(): string {
  const promptPath = path.join(__dirname, "..", "prompts", "consolidate.txt");
  return readFileSync(promptPath, "utf-8");
}

function buildConsolidatePrompt(template: string, memories: Memory[]): string {
  const slim = memories.map((m) => ({
    id: m.id,
    type: m.type,
    content: m.content,
    confidence: m.confidence,
    access_count: m.access_count,
    created_at: m.created_at,
  }));
  return template.replace("{{MEMORIES}}", JSON.stringify(slim, null, 2));
}

// --- Step 1: Confidence Decay ---

function applyDecay(
  db: Database,
  projectPath: string,
  dbPath?: string,
): { decayed: number; archived: number } {
  const now = Date.now();
  let decayed = 0;
  let archived = 0;

  for (const [type, config] of Object.entries(DECAY_CONFIG)) {
    const memories = getMemoriesByProject(
      db,
      projectPath,
      type as MemoryType,
      "active",
    );

    for (const memory of memories) {
      const updatedAt = new Date(memory.updated_at).getTime();
      const elapsedMs = now - updatedAt;
      const periodMs = config.periodDays * 24 * 60 * 60 * 1000;

      if (elapsedMs < periodMs) continue;

      // Calculate how many full decay periods have elapsed
      const periods = Math.floor(elapsedMs / periodMs);
      const newConfidence = memory.confidence * Math.pow(0.9, periods);

      if (newConfidence < ARCHIVE_THRESHOLD) {
        updateMemoryStatus(db, memory.id, "archived");
        archived++;
      } else if (newConfidence !== memory.confidence) {
        updateMemoryConfidence(db, memory.id, newConfidence);
        decayed++;
      }
    }
  }

  if (dbPath && (decayed > 0 || archived > 0)) {
    saveDatabase(db, dbPath);
  }

  return { decayed, archived };
}

// --- Step 2: Deduplication ---

function deduplicateMemories(
  db: Database,
  projectPath: string,
  dbPath?: string,
): number {
  const active = getMemoriesByProject(db, projectPath, undefined, "active");
  const superseded = new Set<string>();
  let count = 0;

  for (let i = 0; i < active.length; i++) {
    if (superseded.has(active[i].id)) continue;

    for (let j = i + 1; j < active.length; j++) {
      if (superseded.has(active[j].id)) continue;

      const similarity = jaccardSimilarity(
        active[i].content,
        active[j].content,
      );

      if (similarity >= DEDUP_THRESHOLD) {
        // Determine which to keep: higher access_count wins, tiebreak newer created_at
        const keepI =
          active[i].access_count > active[j].access_count ||
          (active[i].access_count === active[j].access_count &&
            active[i].created_at >= active[j].created_at);

        const [keeper, loser] = keepI
          ? [active[i], active[j]]
          : [active[j], active[i]];

        updateMemoryStatus(db, loser.id, "superseded");
        // Record which memory supersedes via a new insert isn't needed;
        // we just mark status. The supersedes_id on the loser isn't settable
        // via updateMemoryStatus, so we use a direct SQL update.
        db.run("UPDATE memories SET supersedes_id = ? WHERE id = ?", [
          keeper.id,
          loser.id,
        ]);

        superseded.add(loser.id);
        count++;
      }
    }
  }

  if (dbPath && count > 0) {
    saveDatabase(db, dbPath);
  }

  return count;
}

// --- Step 3: LLM-assisted consolidation ---

function parseConsolidateActions(raw: unknown): ConsolidateAction[] {
  if (!Array.isArray(raw)) return [];
  const actions: ConsolidateAction[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object" || !("action" in item)) continue;
    if (!Array.isArray(item.ids) || item.ids.length === 0) continue;

    const ids = item.ids.filter((id: unknown) => typeof id === "string");
    if (ids.length === 0) continue;

    switch (item.action) {
      case "keep":
        actions.push({ action: "keep", ids });
        break;
      case "merge":
        if (typeof item.merged_content === "string" && ids.length >= 2) {
          actions.push({
            action: "merge",
            ids,
            merged_content: item.merged_content,
          });
        }
        break;
      case "drop":
        actions.push({
          action: "drop",
          ids,
          reason: typeof item.reason === "string" ? item.reason : undefined,
        });
        break;
    }
  }

  return actions;
}

function applyConsolidateActions(
  db: Database,
  actions: ConsolidateAction[],
  projectPath: string,
  dbPath?: string,
): { merged: number; archived: number } {
  let merged = 0;
  let archived = 0;

  for (const action of actions) {
    switch (action.action) {
      case "keep":
        // No-op
        break;

      case "merge": {
        if (!action.merged_content || action.ids.length < 2) break;

        // Collect tags from all merged memories
        const allTags = new Set<string>();
        let bestType: MemoryType = "context";

        for (const id of action.ids) {
          // Archive the source memories
          updateMemoryStatus(db, id, "archived");
          archived++;
        }

        // Look up source memories (some may have just been archived)
        const mergedSources = [
          ...getMemoriesByProject(db, projectPath),
          ...getMemoriesByProject(db, projectPath, undefined, "archived"),
        ].filter((m) => action.ids.includes(m.id));

        for (const m of mergedSources) {
          bestType = m.type;
          for (const tag of m.tags) allTags.add(tag);
        }

        // Insert the merged memory
        insertMemory(
          db,
          projectPath,
          bestType,
          action.merged_content,
          Array.from(allTags),
          1.0,
        );
        merged++;
        break;
      }

      case "drop":
        for (const id of action.ids) {
          updateMemoryStatus(db, id, "archived");
          archived++;
        }
        break;
    }
  }

  if (dbPath && (merged > 0 || archived > 0)) {
    saveDatabase(db, dbPath);
  }

  return { merged, archived };
}

async function llmConsolidate(
  db: Database,
  projectPath: string,
  model: string,
  dbPath?: string,
): Promise<{ merged: number; archived: number; errors: string[] }> {
  const active = getMemoriesByProject(db, projectPath, undefined, "active");
  const errors: string[] = [];
  let totalMerged = 0;
  let totalArchived = 0;

  if (active.length <= CONSOLIDATION_THRESHOLD) {
    return { merged: 0, archived: 0, errors: [] };
  }

  // Group by type
  const byType = new Map<MemoryType, Memory[]>();
  for (const memory of active) {
    const group = byType.get(memory.type) ?? [];
    group.push(memory);
    byType.set(memory.type, group);
  }

  const template = loadConsolidateTemplate();

  for (const [type, memories] of byType) {
    if (memories.length <= TYPE_CONSOLIDATION_THRESHOLD) continue;

    try {
      const prompt = buildConsolidatePrompt(template, memories);
      const raw = await callClaudeJson<unknown>(prompt, model, 60000);
      const actions = parseConsolidateActions(raw);
      const { merged, archived } = applyConsolidateActions(
        db,
        actions,
        projectPath,
        dbPath,
      );
      totalMerged += merged;
      totalArchived += archived;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Consolidation failed for type "${type}": ${msg}`);
    }
  }

  return { merged: totalMerged, archived: totalArchived, errors };
}

// --- Main entry point ---

export async function consolidate(
  db: Database,
  projectPath: string,
  opts?: { dbPath?: string; model?: string; syncMd?: boolean },
): Promise<ConsolidationResult> {
  const dbPath = opts?.dbPath;
  const model = opts?.model ?? "haiku";
  const errors: string[] = [];

  // Step 1: Confidence decay
  const decay = applyDecay(db, projectPath, dbPath);

  // Step 2: Deduplication
  const deduplicated = deduplicateMemories(db, projectPath, dbPath);

  // Step 3: LLM-assisted consolidation
  const llmResult = await llmConsolidate(db, projectPath, model, dbPath);
  errors.push(...llmResult.errors);

  // Step 4: Sync CLAUDE.md if requested
  if (opts?.syncMd) {
    try {
      syncClaudeMd(db, projectPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`CLAUDE.md sync failed: ${msg}`);
    }
  }

  return {
    decayed: decay.decayed,
    archived: decay.archived + llmResult.archived,
    deduplicated,
    merged: llmResult.merged,
    errors,
  };
}

// Exported for testing
export {
  applyDecay,
  deduplicateMemories,
  llmConsolidate,
  parseConsolidateActions,
  applyConsolidateActions,
  loadConsolidateTemplate,
  buildConsolidatePrompt,
  DECAY_CONFIG,
  ARCHIVE_THRESHOLD,
  DEDUP_THRESHOLD,
  CONSOLIDATION_THRESHOLD,
  TYPE_CONSOLIDATION_THRESHOLD,
};
