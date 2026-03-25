import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "sql.js";
import {
  initDatabase,
  getDefaultDbPath,
  insertCheckpoint,
  getLatestCheckpoint,
  getCheckpoint,
  getCheckpointsByDate,
  insertDailySummary,
} from "./store.js";
import { callClaudeJson } from "./llm.js";
import { normalizeProjectPath } from "./utils.js";
import { readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
);

let db: Database;
let dbPath: string;
let lastDbMtime = 0;

/** Reload the database from disk if the file has been modified externally. */
async function reloadDbIfChanged(): Promise<void> {
  try {
    const mtimeMs = statSync(dbPath).mtimeMs;
    if (mtimeMs > lastDbMtime) {
      db = await initDatabase(dbPath);
      lastDbMtime = mtimeMs;
    }
  } catch {
    // File doesn't exist or stat failed — keep current db as-is
  }
}

/** Stable fallback session ID — generated once at module load, not per call. */
const fallbackSessionId = `session-${Date.now()}`;

/**
 * Validate that a required string argument is present and is a string.
 * Returns the validated string, or throws with a descriptive message.
 */
function requireString(
  args: Record<string, unknown> | undefined,
  field: string,
  toolName: string,
): string {
  const value = args?.[field];
  if (!value || typeof value !== "string") {
    throw new ValidationError(
      `${toolName} requires a "${field}" string argument`,
    );
  }
  return value;
}

/** Sentinel error class for argument validation — caught in the handler to return toolError. */
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const server = new Server(
  { name: "claude-baton", version: pkg.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "save_checkpoint",
      description: "Save session state before context loss",
      inputSchema: {
        type: "object" as const,
        properties: {
          what_was_built: { type: "string" },
          current_state: { type: "string" },
          next_steps: { type: "string" },
          decisions: { type: "string" },
          blockers: { type: "string" },
          branch: {
            type: "string",
            description: "Current git branch name",
          },
          uncommitted_files: {
            type: "array",
            items: { type: "string" },
            description: "Output of git status --short",
          },
          git_snapshot: {
            type: "string",
            description: "Recent commits, e.g. output of git log --oneline -10",
          },
          plan_reference: {
            type: "string",
            description:
              "Reference to active plan document and section, e.g. 'docs/plan.md Phase 2 Step 3'",
          },
          source: {
            type: "string",
            enum: ["manual", "auto"],
            description: "Checkpoint source. Defaults to manual.",
          },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
        required: ["what_was_built", "current_state", "next_steps"],
      },
    },
    {
      name: "get_checkpoint",
      description: "Retrieve a checkpoint by ID, or the latest for the project",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description:
              "Checkpoint ID to fetch; if omitted, returns the latest",
          },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
      },
    },
    {
      name: "list_checkpoints",
      description: "List all checkpoints for a date",
      inputSchema: {
        type: "object" as const,
        properties: {
          date: {
            type: "string",
            description: "YYYY-MM-DD (defaults to today)",
          },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
      },
    },
    {
      name: "daily_summary",
      description: "Generate EOD summary from the day's activity",
      inputSchema: {
        type: "object" as const,
        properties: {
          date: {
            type: "string",
            description: "Date (YYYY-MM-DD, defaults to today)",
          },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const projectPath = (args?.project as string) ?? normalizeProjectPath(process.cwd());

  await reloadDbIfChanged();

  try {
    switch (name) {
      case "save_checkpoint": {
        const a = args as Record<string, unknown>;
        const whatWasBuilt = requireString(
          a,
          "what_was_built",
          "save_checkpoint",
        );
        const currentState = requireString(
          a,
          "current_state",
          "save_checkpoint",
        );
        const nextSteps = requireString(a, "next_steps", "save_checkpoint");
        const sessionId = process.env.CLAUDE_SESSION_ID ?? fallbackSessionId;
        const id = insertCheckpoint(
          db,
          projectPath,
          sessionId,
          currentState,
          whatWasBuilt,
          nextSteps,
          {
            branch: a?.branch as string | undefined,
            decisionsMade: a?.decisions as string | undefined,
            blockers: a?.blockers as string | undefined,
            uncommittedFiles: a?.uncommitted_files as string[] | undefined,
            gitSnapshot: a?.git_snapshot as string | undefined,
            planReference: a?.plan_reference as string | undefined,
            source: (a?.source as "manual" | "auto" | undefined) ?? "manual",
          },
          dbPath,
        );
        return { content: [{ type: "text", text: `Checkpoint saved: ${id}` }] };
      }

      case "get_checkpoint": {
        const cpId = args?.id as string | undefined;
        const cp = cpId
          ? getCheckpoint(db, cpId)
          : getLatestCheckpoint(db, projectPath);
        if (!cp)
          return { content: [{ type: "text", text: "No checkpoint found" }] };
        return {
          content: [{ type: "text", text: JSON.stringify(cp, null, 2) }],
        };
      }

      case "list_checkpoints": {
        const cpDate =
          (args?.date as string) ?? new Date().toISOString().slice(0, 10);
        const cps = getCheckpointsByDate(db, projectPath, cpDate);
        const summary = cps.map((cp) => ({
          id: cp.id,
          created_at: cp.created_at,
          what_was_built: cp.what_was_built,
          branch: cp.branch,
          current_state: cp.current_state,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        };
      }

      case "daily_summary": {
        const date =
          (args?.date as string) ?? new Date().toISOString().slice(0, 10);
        const checkpoints = getCheckpointsByDate(db, projectPath, date);

        if (checkpoints.length === 0) {
          return {
            content: [{ type: "text", text: `No activity found for ${date}` }],
          };
        }

        const activityParts: string[] = [];
        activityParts.push(
          "CHECKPOINTS:\n" +
            checkpoints
              .map(
                (cp) =>
                  `- [${cp.created_at}] Built: ${cp.what_was_built} | State: ${cp.current_state} | Next: ${cp.next_steps}`,
              )
              .join("\n"),
        );

        const summaryTemplate = readFileSync(
          path.join(__dirname, "..", "prompts", "daily_summary.txt"),
          "utf-8",
        );
        const summaryPrompt = summaryTemplate
          .replace("{{DATE}}", date)
          .replace("{{ACTIVITY}}", activityParts.join("\n\n"));

        const summaryResult = await callClaudeJson<Record<string, unknown>>(
          summaryPrompt,
          "haiku",
          30000,
        );

        insertDailySummary(db, projectPath, date, summaryResult, dbPath);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summaryResult, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Tool error (${name}):`, msg);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

async function main() {
  dbPath = getDefaultDbPath();
  db = await initDatabase(dbPath);
  try {
    lastDbMtime = statSync(dbPath).mtimeMs;
  } catch {
    // File may not exist yet if initDatabase created it in-memory only
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
