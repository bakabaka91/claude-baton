import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { Database } from "sql.js";
import {
  getConstraintsByProject,
  getDeadEndsByProject,
  getMemoriesByProject,
  getActiveGoal,
  getLatestCheckpoint,
} from "./store.js";

const START_MARKER = "<!-- MEMORIA:START -->";
const END_MARKER = "<!-- MEMORIA:END -->";
const MAX_LINES = 200;

const SEVERITY_LABELS: Record<string, string> = {
  must: "MUST",
  should: "SHOULD",
  prefer: "PREFER",
};

export function findClaudeMd(projectPath: string): string | null {
  let dir = projectPath;
  while (true) {
    const candidate = path.join(dir, "CLAUDE.md");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function generateBlock(db: Database, projectPath: string): string {
  const sections: string[] = [];

  // 1. Constraints (never truncated)
  const constraints = getConstraintsByProject(db, projectPath);
  if (constraints.length > 0) {
    const lines = constraints.map(
      (c) =>
        `- [${SEVERITY_LABELS[c.severity] ?? c.severity.toUpperCase()}] ${c.rule}${c.source ? ` (source: ${c.source})` : ""}`,
    );
    sections.push(`## Constraints\n${lines.join("\n")}`);
  }

  // 2. Dead Ends (never truncated)
  const deadEnds = getDeadEndsByProject(db, projectPath).filter(
    (de) => !de.resolved,
  );
  if (deadEnds.length > 0) {
    const lines = deadEnds.map((de) => {
      const date = de.created_at ? ` (${de.created_at.split("T")[0]})` : "";
      return `- ${de.summary} — ${de.blocker}${date}`;
    });
    sections.push(`## Dead Ends\n${lines.join("\n")}`);
  }

  // 3. Key Decisions
  const decisions = getMemoriesByProject(db, projectPath, "decision", "active");
  if (decisions.length > 0) {
    const lines = decisions.map((d) => `- ${d.content}`);
    sections.push(`## Key Decisions\n${lines.join("\n")}`);
  }

  // 4. Active Goal
  const goal = getActiveGoal(db, projectPath);
  if (goal) {
    const criteria = goal.done_when.map((dw) => `- [ ] ${dw}`).join("\n");
    sections.push(`## Active Goal\n**Intent:** ${goal.intent}\n${criteria}`);
  }

  // 5. Recent Context (patterns, gotchas, progress, context, architecture)
  const contextTypes = [
    "pattern",
    "gotcha",
    "progress",
    "context",
    "architecture",
  ] as const;
  const contextMemories = contextTypes.flatMap((t) =>
    getMemoriesByProject(db, projectPath, t, "active"),
  );
  if (contextMemories.length > 0) {
    const lines = contextMemories.map((m) => `- ${m.type}: ${m.content}`);
    sections.push(`## Recent Context\n${lines.join("\n")}`);
  }

  // 6. Last Checkpoint
  const checkpoint = getLatestCheckpoint(db, projectPath);
  if (checkpoint) {
    const cpLines = [
      `- **Built:** ${checkpoint.what_was_built}`,
      `- **Next:** ${checkpoint.next_steps}`,
    ];
    if (checkpoint.blockers)
      cpLines.push(`- **Blockers:** ${checkpoint.blockers}`);
    sections.push(`## Last Checkpoint\n${cpLines.join("\n")}`);
  }

  let block = sections.join("\n\n");

  // Apply token budget — truncate bottom-up
  const lineCount = block.split("\n").length;
  if (lineCount > MAX_LINES) {
    block = truncateBlock(sections);
  }

  return block;
}

function truncateBlock(sections: string[]): string {
  const result = [...sections];

  // Truncate checkpoint to 3 lines
  const cpIdx = result.findIndex((s) => s.startsWith("## Last Checkpoint"));
  if (cpIdx !== -1) {
    const lines = result[cpIdx].split("\n");
    result[cpIdx] = lines.slice(0, 4).join("\n"); // header + 3 lines
  }

  if (totalLines(result) > MAX_LINES) {
    // Truncate context to 5 items
    const ctxIdx = result.findIndex((s) => s.startsWith("## Recent Context"));
    if (ctxIdx !== -1) {
      const lines = result[ctxIdx].split("\n");
      result[ctxIdx] = lines.slice(0, 6).join("\n"); // header + 5 lines
    }
  }

  if (totalLines(result) > MAX_LINES) {
    // Truncate decisions to 10 items
    const decIdx = result.findIndex((s) => s.startsWith("## Key Decisions"));
    if (decIdx !== -1) {
      const lines = result[decIdx].split("\n");
      result[decIdx] = lines.slice(0, 11).join("\n"); // header + 10 lines
    }
  }

  // Never truncate constraints or dead ends
  return result.join("\n\n");
}

function totalLines(sections: string[]): number {
  return sections.join("\n\n").split("\n").length;
}

/**
 * Format the full managed block string (markers + content).
 * Single source of truth for the block format used by both
 * initial file creation and subsequent updates.
 */
function formatManagedBlock(block: string): string {
  return START_MARKER + "\n" + block + "\n" + END_MARKER + "\n";
}

/**
 * Remove any orphaned START or END markers from content.
 */
function stripOrphanedMarkers(content: string): string {
  return content
    .split("\n")
    .filter(
      (line) => line.trim() !== START_MARKER && line.trim() !== END_MARKER,
    )
    .join("\n");
}

export function writeBlock(filePath: string, block: string): void {
  let content = readFileSync(filePath, "utf-8");

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  const bothExist = startIdx !== -1 && endIdx !== -1;
  const validOrder = bothExist && endIdx > startIdx;

  if (bothExist && validOrder) {
    // Replace existing block between markers
    content =
      content.slice(0, startIdx) +
      formatManagedBlock(block) +
      content.slice(endIdx + END_MARKER.length).replace(/^\n/, "");
  } else {
    // Either no markers, orphaned single marker, or wrong order.
    // Strip any orphaned markers before appending.
    if (startIdx !== -1 || endIdx !== -1) {
      content = stripOrphanedMarkers(content);
    }
    // Ensure consistent trailing whitespace before the block
    content = content.replace(/\n*$/, "");
    content += "\n\n" + formatManagedBlock(block);
  }

  writeFileSync(filePath, content);
}

export function syncClaudeMd(db: Database, projectPath: string): string {
  const block = generateBlock(db, projectPath);

  if (!block.trim()) {
    return "No data to sync — managed block would be empty.";
  }

  let filePath = findClaudeMd(projectPath);

  if (!filePath) {
    filePath = path.join(projectPath, "CLAUDE.md");
    writeFileSync(filePath, formatManagedBlock(block));
    return `Created ${filePath} with managed block.`;
  }

  writeBlock(filePath, block);
  return `Synced managed block in ${filePath}.`;
}
