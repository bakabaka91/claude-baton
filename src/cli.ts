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
import path from "path";
import os from "os";
import { createInterface } from "readline";
import type { Database } from "sql.js";
import {
  initDatabase,
  getDefaultDbPath,
  saveDatabase,
  countAll,
  listProjects,
  insertCheckpoint,
  getAllCheckpoints,
  getAllDailySummaries,
  deleteProjectData,
  deleteAllData,
} from "./store.js";
import { ensureDir } from "./utils.js";

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
  // 1. Remove MCP server from settings.json
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

      // Remove MCP server registration
      if (
        settings.mcpServers &&
        typeof settings.mcpServers === "object" &&
        (settings.mcpServers as Record<string, unknown>)["memoria-solo"]
      ) {
        delete (settings.mcpServers as Record<string, unknown>)["memoria-solo"];
        if (Object.keys(settings.mcpServers).length === 0) {
          delete settings.mcpServers;
        }
        console.error("  Removed MCP server from settings.json");
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
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
  const dbSize = statSync(dbPath).size;

  console.log(`Project: ${projectPath}`);
  console.log(`Database: ${dbPath} (${(dbSize / 1024).toFixed(1)} KB)`);
  console.log();
  console.log("Counts:");
  for (const [key, value] of Object.entries(counts)) {
    console.log(`  ${key}: ${value}`);
  }
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
    console.log("No projects with checkpoints yet.");
    return;
  }

  for (const p of projects) {
    console.log(`${p.project_path} (${p.checkpoint_count} checkpoints)`);
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
    version: 2,
    exported_at: new Date().toISOString(),
    checkpoints: getAllCheckpoints(db, projectPath),
    daily_summaries: getAllDailySummaries(db, projectPath),
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
          gitSnapshot: cp.git_snapshot,
        },
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
  .description("Session lifecycle management for Claude Code")
  .version(pkg.version);

program
  .command("serve")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    await import("./index.js");
  });

program
  .command("setup")
  .description("Register MCP server and initialize database")
  .action(() => handleSetup());

program
  .command("uninstall")
  .description("Remove MCP server, slash commands, and optionally the database")
  .option("--keep-data", "Keep the database (~/.memoria-solo)")
  .option("--force", "Skip confirmation for database deletion")
  .action((opts) => handleUninstall(opts));

program
  .command("status")
  .description("Show checkpoint counts and status")
  .option("--project <path>", "Project path (default: cwd)")
  .action((opts) => handleStatus(opts));

program
  .command("projects")
  .description("List projects with checkpoints")
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
