import { Command } from "commander";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  statSync,
  lstatSync,
  readdirSync,
  unlinkSync,
  symlinkSync,
  rmSync,
} from "fs";
import { execSync } from "child_process";
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
  getLatestCheckpoint,
  getAllCheckpoints,
  getAllDailySummaries,
  deleteProjectData,
  deleteAllData,
} from "./store.js";
import { ensureDir, formatSize, normalizeProjectPath } from "./utils.js";
import { callClaudeJson } from "./llm.js";

// --- Auto-checkpoint (PreCompact hook handler) ---

interface AutoCheckpointResult {
  what_was_built: string;
  current_state: string;
  next_steps: string;
  decisions_made: string;
  blockers: string;
  plan_reference: string | null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPromptTemplate(name: string): string {
  return readFileSync(path.join(__dirname, "..", "prompts", name), "utf-8");
}

function gitCmd(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

export async function handleAutoCheckpoint(): Promise<void> {
  try {
    // Read hook metadata from stdin
    let stdinData = "";
    try {
      stdinData = readFileSync(0, "utf-8");
    } catch {
      console.error("[claude-baton] No stdin data, skipping auto-checkpoint");
      return;
    }

    let transcriptPath: string | undefined;
    try {
      const hookInput = JSON.parse(stdinData);
      // Claude Code PreCompact hook sends flat JSON with transcript_path at top level
      transcriptPath = hookInput?.transcript_path;
    } catch {
      console.error(
        "[claude-baton] Could not parse hook metadata, skipping auto-checkpoint",
      );
      return;
    }

    if (!transcriptPath || !existsSync(transcriptPath)) {
      console.error(
        "[claude-baton] Transcript not found, skipping auto-checkpoint",
      );
      return;
    }

    // Read and truncate transcript
    const fullTranscript = readFileSync(transcriptPath, "utf-8");
    const MAX_CHARS = 50000;
    const transcript =
      fullTranscript.length > MAX_CHARS
        ? fullTranscript.slice(-MAX_CHARS)
        : fullTranscript;

    // Gather git state
    const branch = gitCmd("git branch --show-current");
    const status = gitCmd("git status --short");
    const log = gitCmd("git log --oneline -10");

    // Initialize DB and fetch previous checkpoint for chaining
    const dbPath = getDefaultDbPath();
    const db = await initDatabase(dbPath);
    const projectPath = normalizeProjectPath(process.cwd());

    const prevCheckpoint = getLatestCheckpoint(db, projectPath);

    // Compute git diff since last checkpoint
    let gitDiffSinceCheckpoint = "";
    if (prevCheckpoint?.git_snapshot) {
      const topCommitHash = prevCheckpoint.git_snapshot
        .split("\n")[0]
        ?.split(" ")[0];
      if (topCommitHash) {
        gitDiffSinceCheckpoint = gitCmd(
          `git diff --stat ${topCommitHash}..HEAD`,
        );
      }
    }

    // Build previous checkpoint context
    let prevContext = "No previous checkpoint exists for this project.";
    if (prevCheckpoint) {
      prevContext = [
        `What was built: ${prevCheckpoint.what_was_built}`,
        `Current state: ${prevCheckpoint.current_state}`,
        `Next steps: ${prevCheckpoint.next_steps}`,
        prevCheckpoint.decisions_made
          ? `Decisions: ${prevCheckpoint.decisions_made}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
    }

    // Build prompt with three sections
    const template = readPromptTemplate("auto_checkpoint.txt");
    const prompt = template
      .replace("{{PREVIOUS_CHECKPOINT}}", prevContext)
      .replace(
        "{{GIT_DIFF}}",
        gitDiffSinceCheckpoint || "No file changes since last checkpoint.",
      )
      .replace("{{TRANSCRIPT}}", transcript);

    // Call LLM
    const result = await callClaudeJson<AutoCheckpointResult>(
      prompt,
      "sonnet",
      60000,
    );

    // Save checkpoint
    const sessionId = new Date().toISOString();

    const uncommittedFiles = status
      ? status.split("\n").map((l) => l.trim())
      : [];

    insertCheckpoint(
      db,
      projectPath,
      sessionId,
      result.current_state || "Unknown",
      result.what_was_built || "Unknown",
      result.next_steps || "Unknown",
      {
        branch: branch || undefined,
        decisionsMade: result.decisions_made || undefined,
        blockers: result.blockers || undefined,
        uncommittedFiles,
        gitSnapshot: log || undefined,
        planReference: result.plan_reference || undefined,
        source: "auto",
      },
      dbPath,
    );

    console.error("[claude-baton] Auto-checkpoint saved before compaction");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[claude-baton] Auto-checkpoint failed: ${msg}`);
    // Exit gracefully — don't block compaction
  }
}

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
      console.error(
        "Error: could not parse ~/.claude/settings.json. Fix the file manually and re-run setup.",
      );
      return;
    }
  }

  // Register MCP server via `claude mcp add` (the correct way for Claude Code
  // to discover servers). Uses --scope user for cross-project availability.
  const serverScript = path.resolve(__dirname, "..", "bin", "claude-baton.js");
  try {
    // Remove first (idempotent) then add — avoids "already exists" errors
    execSync("claude mcp remove claude-baton -s user 2>/dev/null || true", {
      encoding: "utf-8",
      timeout: 10000,
    });
    execSync(
      `claude mcp add -s user claude-baton -- node ${serverScript} serve`,
      { encoding: "utf-8", timeout: 10000 },
    );
    console.error("  Registered MCP server (user scope)");
  } catch {
    console.error(
      "  Warning: could not register MCP server via 'claude mcp add'.",
    );
    console.error(
      "  Ensure Claude Code CLI is installed. You can manually run:",
    );
    console.error(
      `  claude mcp add -s user claude-baton -- node ${serverScript} serve`,
    );
  }

  // Clean up legacy mcpServers from settings.json if present
  if (
    settings.mcpServers &&
    typeof settings.mcpServers === "object" &&
    (settings.mcpServers as Record<string, unknown>)["claude-baton"]
  ) {
    delete (settings.mcpServers as Record<string, unknown>)["claude-baton"];
    if (
      Object.keys(settings.mcpServers as Record<string, unknown>).length === 0
    ) {
      delete settings.mcpServers;
    }
  }

  // Register PreCompact hook (idempotent — skip if already present)
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const preCompactHooks = (hooks.PreCompact ?? []) as Array<
    Record<string, unknown>
  >;
  const hasBatonHook = preCompactHooks.some(
    (h) =>
      Array.isArray(h.hooks) &&
      (h.hooks as Array<Record<string, string>>).some((hook) =>
        hook.command?.includes("claude-baton"),
      ),
  );
  if (!hasBatonHook) {
    const autoCheckpointBin = path.resolve(
      __dirname,
      "..",
      "bin",
      "claude-baton.js",
    );
    preCompactHooks.push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: `node ${autoCheckpointBin} auto-checkpoint`,
        },
      ],
    });
    hooks.PreCompact = preCompactHooks;
    settings.hooks = hooks;
    console.error("  Registered PreCompact hook");
  }

  // Register allowed tools for frictionless slash commands (idempotent)
  // Bash patterns use legacy allowedTools (still works for Bash tools)
  const BATON_BASH_TOOLS = [
    "Bash(git status*)",
    "Bash(git log*)",
    "Bash(git diff*)",
    "Bash(git branch*)",
    "Bash(node *claude-baton*)",
  ];
  const allowedTools = (settings.allowedTools ?? []) as string[];
  let toolsAdded = 0;
  for (const tool of BATON_BASH_TOOLS) {
    if (!allowedTools.includes(tool)) {
      allowedTools.push(tool);
      toolsAdded++;
    }
  }
  if (toolsAdded > 0) {
    settings.allowedTools = allowedTools;
  }

  // MCP tools use permissions.allow (required for MCP tool auto-approval)
  const BATON_MCP_TOOLS = [
    "mcp__claude-baton__save_checkpoint",
    "mcp__claude-baton__get_checkpoint",
    "mcp__claude-baton__list_checkpoints",
    "mcp__claude-baton__daily_summary",
  ];
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const allowList = (permissions.allow ?? []) as string[];
  let mcpToolsAdded = 0;
  for (const tool of BATON_MCP_TOOLS) {
    if (!allowList.includes(tool)) {
      allowList.push(tool);
      mcpToolsAdded++;
    }
  }
  if (mcpToolsAdded > 0) {
    permissions.allow = allowList;
    settings.permissions = permissions;
  }

  if (toolsAdded + mcpToolsAdded > 0) {
    console.error(`  Registered ${toolsAdded + mcpToolsAdded} allowed tools`);
  }

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

export function installCommands(): { installed: number; skipped: number } {
  const sourceDir = path.join(__dirname, "..", "commands");
  const targetDir = path.join(os.homedir(), ".claude", "commands");
  ensureDir(targetDir);

  let installed = 0;
  let skipped = 0;

  const files = readdirSync(sourceDir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const targetPath = path.join(targetDir, file);
    const sourcePath = path.join(sourceDir, file);
    const name = file.replace(".md", "");

    let isSymlink = false;
    try {
      isSymlink = lstatSync(targetPath).isSymbolicLink();
    } catch {
      // File doesn't exist
    }

    if (isSymlink) {
      // Our symlink — update to point to current package version
      unlinkSync(targetPath);
      symlinkSync(sourcePath, targetPath);
      console.error(`  Updated /${name}`);
      installed++;
    } else if (existsSync(targetPath)) {
      // Regular file from old install — don't overwrite
      console.error(
        `  Skipping ${name} -- already exists (run uninstall first to upgrade)`,
      );
      skipped++;
    } else {
      // Fresh install — create symlink
      symlinkSync(sourcePath, targetPath);
      console.error(`  Linked /${name}`);
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
  // 1. Remove MCP server via claude CLI + clean up settings.json
  try {
    execSync("claude mcp remove claude-baton -s user 2>/dev/null || true", {
      encoding: "utf-8",
      timeout: 10000,
    });
    console.error("  Removed MCP server");
  } catch {
    console.error("  Warning: could not remove MCP server via CLI");
  }

  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

      // Remove legacy MCP server from settings.json if present
      if (
        settings.mcpServers &&
        typeof settings.mcpServers === "object" &&
        (settings.mcpServers as Record<string, unknown>)["claude-baton"]
      ) {
        delete (settings.mcpServers as Record<string, unknown>)["claude-baton"];
        if (Object.keys(settings.mcpServers).length === 0) {
          delete settings.mcpServers;
        }
      }

      // Remove PreCompact hook
      if (
        settings.hooks &&
        typeof settings.hooks === "object" &&
        (settings.hooks as Record<string, unknown>).PreCompact
      ) {
        const hooksObj = settings.hooks as Record<string, unknown>;
        const preCompact = hooksObj.PreCompact as Array<
          Record<string, unknown>
        >;
        const filtered = preCompact.filter(
          (h) =>
            !Array.isArray(h.hooks) ||
            !(h.hooks as Array<Record<string, string>>).some((hook) =>
              hook.command?.includes("claude-baton"),
            ),
        );
        if (filtered.length === 0) {
          delete hooksObj.PreCompact;
        } else {
          hooksObj.PreCompact = filtered;
        }
        if (Object.keys(hooksObj).length === 0) {
          delete settings.hooks;
        }
        console.error("  Removed PreCompact hook");
      }

      // Remove allowed tools (bash patterns)
      if (Array.isArray(settings.allowedTools)) {
        const BATON_BASH_PATTERNS = [
          "Bash(git status*)",
          "Bash(git log*)",
          "Bash(git diff*)",
          "Bash(git branch*)",
          "Bash(git -C *status*)",
          "Bash(git -C *log*)",
          "Bash(git -C *diff*)",
          "Bash(git -C *branch*)",
          "Bash(node *claude-baton*)",
        ];
        // Note: git -C patterns kept in uninstall to clean up from older installs
        settings.allowedTools = (settings.allowedTools as string[]).filter(
          (t) => !BATON_BASH_PATTERNS.includes(t),
        );
        if ((settings.allowedTools as string[]).length === 0) {
          delete settings.allowedTools;
        }
        console.error("  Removed allowed tools");
      }

      // Remove MCP tool permissions
      if (
        settings.permissions &&
        typeof settings.permissions === "object" &&
        Array.isArray((settings.permissions as Record<string, unknown>).allow)
      ) {
        const perms = settings.permissions as Record<string, unknown>;
        const BATON_MCP_PATTERNS = [
          "mcp__claude-baton__save_checkpoint",
          "mcp__claude-baton__get_checkpoint",
          "mcp__claude-baton__list_checkpoints",
          "mcp__claude-baton__daily_summary",
        ];
        perms.allow = (perms.allow as string[]).filter(
          (t) => !BATON_MCP_PATTERNS.includes(t),
        );
        if ((perms.allow as string[]).length === 0) {
          delete perms.allow;
        }
        if (Object.keys(perms).length === 0) {
          delete settings.permissions;
        }
        console.error("  Removed MCP tool permissions");
      }

      // Clean up legacy MCP entries from allowedTools (from older versions)
      if (Array.isArray(settings.allowedTools)) {
        settings.allowedTools = (settings.allowedTools as string[]).filter(
          (t) => !t.startsWith("mcp__claude-baton__"),
        );
        if ((settings.allowedTools as string[]).length === 0) {
          delete settings.allowedTools;
        }
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
  const dbDir = path.join(os.homedir(), ".claude-baton");
  if (!opts.keepData && existsSync(dbDir)) {
    if (!opts.force) {
      const answer = await askConfirmation(
        "  Delete database (~/.claude-baton)? This cannot be undone. [y/N] ",
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
    "Uninstall complete. Run 'npm uninstall -g claude-baton' to remove the binary.",
  );
}

// --- Status command ---

export async function handleStatus(opts: { project?: string }): Promise<void> {
  const dbPath = getDefaultDbPath();
  if (!existsSync(dbPath)) {
    console.error("No database found. Run 'claude-baton setup' first.");
    return;
  }

  const db = await initDatabase(dbPath);
  const projectPath = opts.project ?? normalizeProjectPath(process.cwd());
  const counts = countAll(db, projectPath);
  const dbSize = statSync(dbPath).size;
  const llmCalls = counts.auto_checkpoints + counts.daily_summaries;

  console.log(`Project: ${projectPath}`);
  console.log(`Database: ${dbPath} (${formatSize(dbSize)})`);
  console.log();
  console.log("Counts:");
  console.log(`  checkpoints: ${counts.checkpoints} (${counts.checkpoints - counts.auto_checkpoints} manual, ${counts.auto_checkpoints} auto)`);
  console.log(`  daily_summaries: ${counts.daily_summaries}`);
  console.log();
  console.log(`LLM calls (claude -p): ${llmCalls} (${counts.auto_checkpoints} auto-checkpoints + ${counts.daily_summaries} EOD summaries)`);
}

// --- Projects command ---

export async function handleProjects(): Promise<void> {
  const dbPath = getDefaultDbPath();
  if (!existsSync(dbPath)) {
    console.error("No database found. Run 'claude-baton setup' first.");
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
    console.error("No database found. Run 'claude-baton setup' first.");
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
  let skipped = 0;

  if (Array.isArray(data.checkpoints)) {
    for (const cp of data.checkpoints) {
      if (
        !cp.project_path ||
        !cp.session_id ||
        !cp.current_state ||
        !cp.what_was_built ||
        !cp.next_steps
      ) {
        skipped++;
        continue;
      }
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
  console.error(
    `Imported ${imported} items.${skipped ? ` Skipped ${skipped} malformed.` : ""}`,
  );
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
  .name("claude-baton")
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
  .command("auto-checkpoint")
  .description("Auto-save checkpoint (called by PreCompact hook)")
  .action(() => handleAutoCheckpoint());

program
  .command("uninstall")
  .description("Remove MCP server, slash commands, and optionally the database")
  .option("--keep-data", "Keep the database (~/.claude-baton)")
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
