import { Command } from "commander";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  statSync,
  readdirSync,
  unlinkSync,
  rmSync,
} from "fs";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
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

  // Merge hooks without clobbering other tools' hooks
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const memoriaHookEntries: Record<string, unknown> = {
    Stop: {
      matcher: "",
      hooks: [
        { type: "command", command: "memoria-solo extract --event stop" },
      ],
    },
    PreCompact: {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: "memoria-solo extract --event precompact",
        },
      ],
    },
    SessionEnd: {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: "memoria-solo extract --event session-end --consolidate",
        },
      ],
    },
  };

  for (const [event, entry] of Object.entries(memoriaHookEntries)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    // Remove any old memoria-solo entries, then add the current one
    const filtered = existing.filter((e: unknown) => {
      const entry = e as Record<string, unknown>;
      const h = entry.hooks as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(h)) return true;
      return !h.some(
        (hook) =>
          typeof hook.command === "string" &&
          hook.command.includes("memoria-solo"),
      );
    });
    filtered.push(entry);
    hooks[event] = filtered;
  }
  settings.hooks = hooks;

  // Register MCP server
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  mcpServers["memoria-solo"] = {
    command: "npx",
    args: ["-y", "memoria-solo", "serve"],
  };
  settings.mcpServers = mcpServers;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  const dbPath = getDefaultDbPath();
  await initDatabase(dbPath);

  const cmdResult = installCommands();

  console.error(`Setup complete.`);
  console.error(`  Database: ${dbPath}`);
  console.error(`  Hooks: ${settingsPath}`);
  console.error(`  MCP server: registered`);
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

// --- Uninstall command ---

export async function handleUninstall(opts: {
  keepData?: boolean;
  force?: boolean;
}): Promise<void> {
  // 1. Remove hooks from settings.json
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings.hooks && typeof settings.hooks === "object") {
        for (const event of Object.keys(settings.hooks)) {
          const entries = settings.hooks[event];
          if (Array.isArray(entries)) {
            settings.hooks[event] = entries.filter(
              (entry: Record<string, unknown>) => {
                const hooks = entry.hooks as
                  | Array<Record<string, unknown>>
                  | undefined;
                if (!Array.isArray(hooks)) return true;
                return !hooks.some(
                  (h) =>
                    typeof h.command === "string" &&
                    h.command.includes("memoria-solo"),
                );
              },
            );
            if (settings.hooks[event].length === 0) {
              delete settings.hooks[event];
            }
          }
        }
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }

        // Remove MCP server registration
        if (
          settings.mcpServers &&
          typeof settings.mcpServers === "object" &&
          (settings.mcpServers as Record<string, unknown>)["memoria-solo"]
        ) {
          delete (settings.mcpServers as Record<string, unknown>)[
            "memoria-solo"
          ];
          if (Object.keys(settings.mcpServers).length === 0) {
            delete settings.mcpServers;
          }
          console.error("  Removed MCP server from settings.json");
        }

        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        console.error("  Removed hooks from settings.json");
      }
    } catch {
      console.error("  Warning: could not parse settings.json");
    }
  }

  // 2. Remove memo-* command files
  const commandsDir = path.join(os.homedir(), ".claude", "commands");
  let commandsRemoved = 0;
  if (existsSync(commandsDir)) {
    const files = readdirSync(commandsDir).filter(
      (f) => f.startsWith("memo-") && f.endsWith(".md"),
    );
    for (const file of files) {
      unlinkSync(path.join(commandsDir, file));
      commandsRemoved++;
    }
  }
  console.error(`  Removed ${commandsRemoved} slash commands`);

  // 3. Optionally remove database
  const dbDir = path.join(os.homedir(), ".memoria-solo");
  if (!opts.keepData && existsSync(dbDir)) {
    if (!opts.force) {
      const answer = await askConfirmation(
        "  Delete database (~/.memoria-solo)? This cannot be undone. [y/N] ",
      );
      if (answer.toLowerCase() !== "y") {
        console.error("  Kept database.");
        console.error("Uninstall complete (database preserved).");
        return;
      }
    }
    rmSync(dbDir, { recursive: true });
    console.error("  Deleted database");
  } else if (opts.keepData) {
    console.error("  Kept database (--keep-data)");
  }

  console.error(
    "Uninstall complete. Run 'npm uninstall -g memoria-solo' to remove the binary.",
  );
}

// --- Extract command ---

export async function handleExtract(opts: {
  event: string;
  consolidate?: boolean;
  project?: string;
  transcript?: string;
  session?: string;
}): Promise<void> {
  // --transcript mode: read file directly (used by background process)
  if (opts.transcript) {
    if (!existsSync(opts.transcript)) {
      console.error(`Transcript file not found: ${opts.transcript}`);
      return;
    }
    const transcript = readFileSync(opts.transcript, "utf-8");
    if (!transcript.trim()) {
      console.error("Empty transcript, nothing to extract.");
      return;
    }
    const projectPath = opts.project ?? process.cwd();
    const sessionId = opts.session ?? `cli-${Date.now()}`;
    const dbPath = getDefaultDbPath();
    const db = await initDatabase(dbPath);

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
    return;
  }

  // Stdin mode: read hook metadata or raw transcript
  if (process.stdin.isTTY) {
    console.error("No piped input detected. Pipe a transcript via stdin.");
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const stdinData = Buffer.concat(chunks).toString("utf-8");

  if (!stdinData.trim()) {
    console.error("Empty transcript, nothing to extract.");
    return;
  }

  // Detect Claude Code hook metadata JSON (has transcript_path field)
  try {
    const hookMeta = JSON.parse(stdinData.trim());
    if (hookMeta.transcript_path) {
      // Spawn detached background process and return immediately
      const args = [
        "extract",
        "--event",
        opts.event,
        "--transcript",
        hookMeta.transcript_path,
      ];
      if (hookMeta.session_id) args.push("--session", hookMeta.session_id);
      args.push("--project", opts.project ?? hookMeta.cwd ?? process.cwd());
      if (opts.consolidate) args.push("--consolidate");

      const child = spawn("memoria-solo", args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return;
    }
  } catch {
    // Not JSON — treat stdin as raw transcript (backwards compatible)
  }

  // Raw transcript piped via stdin
  const dbPath = getDefaultDbPath();
  const db = await initDatabase(dbPath);
  const sessionId = process.env.CLAUDE_SESSION_ID ?? `cli-${Date.now()}`;
  const projectPath = opts.project ?? process.cwd();

  const result = await extractFromTranscript(
    db,
    stdinData,
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

const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
);

const program = new Command();

program
  .name("memoria-solo")
  .description("Persistent memory for Claude Code sessions")
  .version(pkg.version);

program
  .command("serve")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    await import("./index.js");
  });

program
  .command("setup")
  .description("Install hooks and initialize database")
  .action(() => handleSetup());

program
  .command("uninstall")
  .description("Remove hooks, slash commands, and optionally the database")
  .option("--keep-data", "Keep the database (~/.memoria-solo)")
  .option("--force", "Skip confirmation for database deletion")
  .action((opts) => handleUninstall(opts));

program
  .command("extract")
  .description("Extract memories from piped transcript")
  .requiredOption(
    "--event <type>",
    "Event type (stop, precompact, session-end)",
  )
  .option("--consolidate", "Run consolidation after extraction")
  .option("--project <path>", "Project path (default: cwd)")
  .option("--transcript <path>", "Read transcript from file (skips stdin)")
  .option("--session <id>", "Session ID (default: from hook metadata or env)")
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
