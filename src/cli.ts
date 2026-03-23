import { Command } from "commander";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  statSync,
  readdirSync,
} from "fs";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";
import { createInterface } from "readline";
import type { Database } from "sql.js";
import {
  initDatabase,
  getDefaultDbPath,
  saveDatabase,
  countAll,
  getLastExtraction,
  listProjects,
  insertMemory,
  insertDeadEnd,
  insertConstraint,
  insertGoal,
  insertCheckpoint,
  insertInsight,
  getAllMemories,
  getAllDeadEnds,
  getAllConstraints,
  getAllGoals,
  getAllCheckpoints,
  getAllInsights,
  getAllDailySummaries,
  getAllExtractionLogs,
  deleteProjectData,
  deleteAllData,
} from "./store.js";
import { searchMemories, ensureDir } from "./utils.js";
import { extractFromTranscript } from "./extractor.js";
import { consolidate } from "./consolidator.js";

// --- Setup command ---

export async function handleSetup(): Promise<void> {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const settingsDir = path.dirname(settingsPath);
  ensureDir(settingsDir);

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }

  settings.hooks = {
    Stop: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: "memoria-solo extract --event stop",
          },
        ],
      },
    ],
    PreCompact: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: "memoria-solo extract --event precompact",
          },
        ],
      },
    ],
    SessionEnd: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: "memoria-solo extract --event session-end --consolidate",
          },
        ],
      },
    ],
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  const dbPath = getDefaultDbPath();
  await initDatabase(dbPath);

  const cmdResult = installCommands();

  console.error(`Setup complete.`);
  console.error(`  Database: ${dbPath}`);
  console.error(`  Hooks: ${settingsPath}`);
  console.error(
    `  Commands: ${cmdResult.installed} installed, ${cmdResult.skipped} skipped`,
  );
}

// --- Install memo- commands ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function installCommands(): { installed: number; skipped: number } {
  const sourceDir = path.join(__dirname, "..", "commands");
  const targetDir = path.join(os.homedir(), ".claude", "commands");
  ensureDir(targetDir);

  let installed = 0;
  let skipped = 0;

  const files = readdirSync(sourceDir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const targetPath = path.join(targetDir, file);
    if (existsSync(targetPath)) {
      const name = file.replace(".md", "");
      console.error(`  Skipping ${name} -- already exists`);
      skipped++;
    } else {
      copyFileSync(path.join(sourceDir, file), targetPath);
      const name = file.replace(".md", "");
      console.error(`  Installed /${name}`);
      installed++;
    }
  }

  return { installed, skipped };
}

// --- Extract command ---

export async function handleExtract(opts: {
  event: string;
  consolidate?: boolean;
  project?: string;
}): Promise<void> {
  const projectPath = opts.project ?? process.cwd();
  const dbPath = getDefaultDbPath();
  const db = await initDatabase(dbPath);
  const sessionId = process.env.CLAUDE_SESSION_ID ?? `cli-${Date.now()}`;

  // Read transcript from stdin
  let transcript = "";
  if (process.stdin.isTTY) {
    console.error("No piped input detected. Pipe a transcript via stdin.");
    saveDatabase(db, dbPath);
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  transcript = Buffer.concat(chunks).toString("utf-8");

  if (!transcript.trim()) {
    console.error("Empty transcript, nothing to extract.");
    saveDatabase(db, dbPath);
    return;
  }

  const result = await extractFromTranscript(
    db,
    transcript,
    projectPath,
    sessionId,
    opts.event,
    { dbPath, syncMd: true },
  );

  console.error(
    `Extracted: ${result.itemsStored} stored, ${result.chunksProcessed} chunks, ${result.errors.length} errors`,
  );

  if (opts.consolidate) {
    const cResult = await consolidate(db, projectPath, {
      dbPath,
      syncMd: true,
    });
    console.error(
      `Consolidated: ${cResult.merged} merged, ${cResult.archived} archived, ${cResult.deduplicated} deduped, ${cResult.decayed} decayed`,
    );
  }

  saveDatabase(db, dbPath);
}

// --- Status command ---

export async function handleStatus(opts: { project?: string }): Promise<void> {
  const dbPath = getDefaultDbPath();
  if (!existsSync(dbPath)) {
    console.error("No database found. Run 'memoria-solo setup' first.");
    return;
  }

  const db = await initDatabase(dbPath);
  const projectPath = opts.project ?? process.cwd();
  const counts = countAll(db, projectPath);
  const lastExtraction = getLastExtraction(db, projectPath);
  const dbSize = statSync(dbPath).size;

  console.log(`Project: ${projectPath}`);
  console.log(`Database: ${dbPath} (${(dbSize / 1024).toFixed(1)} KB)`);
  console.log();
  console.log("Counts:");
  for (const [key, value] of Object.entries(counts)) {
    console.log(`  ${key}: ${value}`);
  }
  if (lastExtraction) {
    console.log();
    console.log(
      `Last extraction: ${lastExtraction.event_type} at ${lastExtraction.created_at}`,
    );
    console.log(
      `  ${lastExtraction.memories_extracted} memories from ${lastExtraction.chunks_processed} chunks`,
    );
  }
}

// --- Search command ---

export async function handleSearch(
  query: string,
  opts: { project?: string; type?: string },
): Promise<void> {
  const dbPath = getDefaultDbPath();
  if (!existsSync(dbPath)) {
    console.error("No database found. Run 'memoria-solo setup' first.");
    return;
  }

  const db = await initDatabase(dbPath);
  const projectPath = opts.project ?? process.cwd();
  const results = searchMemories(db, query, projectPath, opts.type);

  if (results.length === 0) {
    console.log("No memories found matching your query.");
    return;
  }

  for (const mem of results) {
    console.log(`[${mem.type}] (${mem.confidence.toFixed(2)}) ${mem.content}`);
    if (mem.tags.length > 0) {
      console.log(`  tags: ${mem.tags.join(", ")}`);
    }
  }
  console.log(`\n${results.length} result(s)`);
}

// --- Projects command ---

export async function handleProjects(): Promise<void> {
  const dbPath = getDefaultDbPath();
  if (!existsSync(dbPath)) {
    console.error("No database found. Run 'memoria-solo setup' first.");
    return;
  }

  const db = await initDatabase(dbPath);
  const projects = listProjects(db);

  if (projects.length === 0) {
    console.log("No projects with memories yet.");
    return;
  }

  for (const p of projects) {
    console.log(`${p.project_path} (${p.memory_count} memories)`);
  }
}

// --- Export command ---

export async function handleExport(opts: { project?: string }): Promise<void> {
  const dbPath = getDefaultDbPath();
  if (!existsSync(dbPath)) {
    console.error("No database found. Run 'memoria-solo setup' first.");
    return;
  }

  const db = await initDatabase(dbPath);
  const projectPath = opts.project;

  const data = {
    version: 1,
    exported_at: new Date().toISOString(),
    memories: getAllMemories(db, projectPath),
    dead_ends: getAllDeadEnds(db, projectPath),
    constraints: getAllConstraints(db, projectPath),
    goals: getAllGoals(db, projectPath),
    checkpoints: getAllCheckpoints(db, projectPath),
    insights: getAllInsights(db, projectPath),
    daily_summaries: getAllDailySummaries(db, projectPath),
    extraction_logs: getAllExtractionLogs(db, projectPath),
  };

  console.log(JSON.stringify(data, null, 2));
}

// --- Import command ---

export async function handleImport(file: string): Promise<void> {
  const dbPath = getDefaultDbPath();
  const db = await initDatabase(dbPath);

  let data: Record<string, unknown>;
  try {
    const raw = readFileSync(file, "utf-8");
    data = JSON.parse(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read import file: ${msg}`);
    return;
  }

  let imported = 0;

  if (Array.isArray(data.memories)) {
    for (const m of data.memories) {
      insertMemory(
        db,
        m.project_path,
        m.type,
        m.content,
        m.tags ?? [],
        m.confidence ?? 1.0,
      );
      imported++;
    }
  }

  if (Array.isArray(data.dead_ends)) {
    for (const de of data.dead_ends) {
      insertDeadEnd(
        db,
        de.project_path,
        de.summary,
        de.approach_tried,
        de.blocker,
        de.resume_when,
      );
      imported++;
    }
  }

  if (Array.isArray(data.constraints)) {
    for (const c of data.constraints) {
      insertConstraint(
        db,
        c.project_path,
        c.rule,
        c.type,
        c.severity,
        c.scope,
        c.source,
      );
      imported++;
    }
  }

  if (Array.isArray(data.goals)) {
    for (const g of data.goals) {
      insertGoal(db, g.project_path, g.intent, g.done_when ?? []);
      imported++;
    }
  }

  if (Array.isArray(data.checkpoints)) {
    for (const cp of data.checkpoints) {
      insertCheckpoint(
        db,
        cp.project_path,
        cp.session_id,
        cp.current_state,
        cp.what_was_built,
        cp.next_steps,
        {
          branch: cp.branch,
          decisionsMade: cp.decisions_made,
          blockers: cp.blockers,
          uncommittedFiles: cp.uncommitted_files,
        },
      );
      imported++;
    }
  }

  if (Array.isArray(data.insights)) {
    for (const ins of data.insights) {
      insertInsight(
        db,
        ins.project_path,
        ins.content,
        ins.category,
        ins.context,
      );
      imported++;
    }
  }

  saveDatabase(db, dbPath);
  console.error(`Imported ${imported} items.`);
}

// --- Reset command ---

export async function handleReset(opts: {
  project?: string;
  force?: boolean;
}): Promise<void> {
  const dbPath = getDefaultDbPath();
  if (!existsSync(dbPath)) {
    console.error("No database found. Nothing to reset.");
    return;
  }

  if (!opts.force) {
    const target = opts.project ?? "ALL projects";
    const answer = await askConfirmation(
      `Reset data for ${target}? This cannot be undone. [y/N] `,
    );
    if (answer.toLowerCase() !== "y") {
      console.error("Aborted.");
      return;
    }
  }

  const db = await initDatabase(dbPath);

  if (opts.project) {
    deleteProjectData(db, opts.project, dbPath);
    console.error(`Reset data for project: ${opts.project}`);
  } else {
    deleteAllData(db, dbPath);
    console.error("Reset all data.");
  }
}

function askConfirmation(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// --- CLI program ---

const program = new Command();

program
  .name("memoria-solo")
  .description("Persistent memory for Claude Code sessions")
  .version("1.0.0");

program
  .command("setup")
  .description("Install hooks and initialize database")
  .action(() => handleSetup());

program
  .command("extract")
  .description("Extract memories from piped transcript")
  .requiredOption(
    "--event <type>",
    "Event type (stop, precompact, session-end)",
  )
  .option("--consolidate", "Run consolidation after extraction")
  .option("--project <path>", "Project path (default: cwd)")
  .action((opts) => handleExtract(opts));

program
  .command("status")
  .description("Show memory counts and status")
  .option("--project <path>", "Project path (default: cwd)")
  .action((opts) => handleStatus(opts));

program
  .command("search <query>")
  .description("Search memories")
  .option("--project <path>", "Project path")
  .option("--type <type>", "Filter by memory type")
  .action((query, opts) => handleSearch(query, opts));

program
  .command("projects")
  .description("List projects with memories")
  .action(() => handleProjects());

program
  .command("export")
  .description("Export all data as JSON to stdout")
  .option("--project <path>", "Filter by project path")
  .action((opts) => handleExport(opts));

program
  .command("import <file>")
  .description("Import data from JSON file")
  .action((file) => handleImport(file));

program
  .command("reset")
  .description("Delete all data (or data for a project)")
  .option("--project <path>", "Only reset this project")
  .option("--force", "Skip confirmation")
  .action((opts) => handleReset(opts));

program.parse();
