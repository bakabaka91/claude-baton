import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "sql.js";
import type {
  MemoryType,
  ConstraintType,
  ConstraintSeverity,
  InsightCategory,
} from "./types.js";
import {
  initDatabase,
  getDefaultDbPath,
  insertMemory,
  getMemoriesByProject,
  insertDeadEnd,
  getDeadEndsByProject,
  insertConstraint,
  getConstraintsByProject,
  insertGoal,
  getActiveGoal,
  updateGoalStatus,
  insertCheckpoint,
  getLatestCheckpoint,
  getCheckpoint,
  getInsightsSince,
  insertInsight,
  countByType,
  countAll,
  insertDailySummary,
  incrementAccessCount,
  getCheckpointsByDate,
  getInsightsByDate,
  getMemoriesByDate,
  getExtractionLogsByDate,
} from "./store.js";
import { searchMemories, checkDuplicate, jaccardSimilarity } from "./utils.js";
import { syncClaudeMd } from "./claude-md.js";
import { callClaude, callClaudeJson } from "./llm.js";
import { consolidate as runConsolidate } from "./consolidator.js";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database;
let dbPath: string;

/** Stable fallback session ID — generated once at module load, not per call. */
const fallbackSessionId = `session-${Date.now()}`;

/** Build an MCP error response with a descriptive message. */
function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

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

/**
 * Validate that a required argument is a non-empty array of strings.
 * Returns the validated array, or throws with a descriptive message.
 */
function requireStringArray(
  args: Record<string, unknown> | undefined,
  field: string,
  toolName: string,
): string[] {
  const value = args?.[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((v) => typeof v === "string")
  ) {
    throw new ValidationError(
      `${toolName} requires a "${field}" array of strings`,
    );
  }
  return value as string[];
}

/** Sentinel error class for argument validation — caught in the handler to return toolError. */
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const server = new Server(
  { name: "memoria-solo", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_search",
      description: "Search across all memory types",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
          type: {
            type: "string",
            enum: [
              "architecture",
              "decision",
              "pattern",
              "gotcha",
              "progress",
              "context",
            ],
          },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_save",
      description: "Manually save a memory",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            enum: [
              "architecture",
              "decision",
              "pattern",
              "gotcha",
              "progress",
              "context",
            ],
          },
          content: { type: "string", description: "Memory content" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags",
          },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
        required: ["type", "content"],
      },
    },
    {
      name: "memory_stats",
      description: "Memory counts by type/project, last extraction time",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
      },
    },
    {
      name: "log_dead_end",
      description: "Record a failed approach so it is not retried",
      inputSchema: {
        type: "object" as const,
        properties: {
          summary: { type: "string", description: "Brief summary" },
          approach_tried: { type: "string", description: "What was attempted" },
          blocker: { type: "string", description: "Why it failed" },
          resume_when: { type: "string", description: "Conditions to revisit" },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
        required: ["summary", "approach_tried", "blocker"],
      },
    },
    {
      name: "check_dead_ends",
      description: "Check if an approach was already tried and failed",
      inputSchema: {
        type: "object" as const,
        properties: {
          approach: { type: "string", description: "Approach to check" },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
        required: ["approach"],
      },
    },
    {
      name: "memory_recall",
      description:
        "RAG-style synthesized recall on a topic using stored memories",
      inputSchema: {
        type: "object" as const,
        properties: {
          topic: {
            type: "string",
            description: "Topic to recall information about",
          },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
        required: ["topic"],
      },
    },
    {
      name: "add_constraint",
      description: "Add a project rule/constraint",
      inputSchema: {
        type: "object" as const,
        properties: {
          rule: { type: "string", description: "The constraint rule" },
          type: {
            type: "string",
            enum: ["security", "performance", "compliance", "convention"],
          },
          severity: { type: "string", enum: ["must", "should", "prefer"] },
          scope: { type: "string", description: "Scope of the constraint" },
          source: {
            type: "string",
            description: "Where this constraint came from",
          },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
        required: ["rule", "type", "severity"],
      },
    },
    {
      name: "get_constraints",
      description: "List active constraints for a project",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
      },
    },
    {
      name: "set_goal",
      description:
        "Set current sprint/task goal (pauses any existing active goal)",
      inputSchema: {
        type: "object" as const,
        properties: {
          intent: { type: "string", description: "Goal intent" },
          done_when: {
            type: "array",
            items: { type: "string" },
            description: "Completion criteria",
          },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
        required: ["intent", "done_when"],
      },
    },
    {
      name: "get_goal",
      description: "Get the active goal for a project",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
      },
    },
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
      name: "save_insight",
      description: "Capture a real-time insight",
      inputSchema: {
        type: "object" as const,
        properties: {
          content: { type: "string", description: "Insight content" },
          category: {
            type: "string",
            enum: ["decision", "workflow", "architecture", "surprise", "cost"],
          },
          context: { type: "string", description: "Optional context" },
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "get_insights",
      description: "Fetch insights filtered by time or date",
      inputSchema: {
        type: "object" as const,
        properties: {
          since: {
            type: "string",
            description:
              "ISO timestamp — returns insights created at or after this time",
          },
          date: {
            type: "string",
            description: "YYYY-MM-DD — returns insights for that date",
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
    {
      name: "consolidate",
      description: "Manually trigger memory merge/prune/decay",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project path (defaults to cwd)",
          },
        },
      },
    },
    {
      name: "sync_claude_md",
      description: "Manually refresh CLAUDE.md managed block",
      inputSchema: {
        type: "object" as const,
        properties: {
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
  const projectPath = (args?.project as string) ?? process.cwd();

  try {
    switch (name) {
      case "memory_search": {
        const query = requireString(
          args as Record<string, unknown>,
          "query",
          "memory_search",
        );
        const results = searchMemories(
          db,
          query,
          projectPath,
          args?.type as string,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      }

      case "memory_save": {
        const a = args as Record<string, unknown>;
        const content = requireString(a, "content", "memory_save");
        const memType = requireString(a, "type", "memory_save") as MemoryType;
        const existing = checkDuplicate(db, content, projectPath);
        if (existing) {
          return {
            content: [
              {
                type: "text",
                text: `Duplicate detected (similarity > 0.6). Existing memory: ${existing.id}`,
              },
            ],
          };
        }
        const id = insertMemory(
          db,
          projectPath,
          memType,
          content,
          (a?.tags as string[]) ?? [],
          1.0,
          dbPath,
        );
        return { content: [{ type: "text", text: `Memory saved: ${id}` }] };
      }

      case "memory_stats": {
        const byType = countByType(db, projectPath);
        const totals = countAll(db, projectPath);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ by_type: byType, totals }, null, 2),
            },
          ],
        };
      }

      case "log_dead_end": {
        const a = args as Record<string, unknown>;
        const summary = requireString(a, "summary", "log_dead_end");
        const approachTried = requireString(
          a,
          "approach_tried",
          "log_dead_end",
        );
        const blocker = requireString(a, "blocker", "log_dead_end");
        const id = insertDeadEnd(
          db,
          projectPath,
          summary,
          approachTried,
          blocker,
          a?.resume_when as string | undefined,
          dbPath,
        );
        return { content: [{ type: "text", text: `Dead end logged: ${id}` }] };
      }

      case "check_dead_ends": {
        const approach = requireString(
          args as Record<string, unknown>,
          "approach",
          "check_dead_ends",
        );
        const deadEnds = getDeadEndsByProject(db, projectPath);
        const matches = deadEnds
          .filter((de) => !de.resolved)
          .map((de) => ({
            ...de,
            similarity: jaccardSimilarity(approach, de.approach_tried),
          }))
          .filter((de) => de.similarity > 0.3)
          .sort((a, b) => b.similarity - a.similarity);

        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No similar dead ends found. Approach appears safe to try.",
              },
            ],
          };
        }
        const warnings = matches.map(
          (m) =>
            `WARNING (${(m.similarity * 100).toFixed(0)}% similar): "${m.summary}" — ${m.blocker}${m.resume_when ? ` (resume when: ${m.resume_when})` : ""}`,
        );
        return { content: [{ type: "text", text: warnings.join("\n") }] };
      }

      case "memory_recall": {
        const topic = requireString(
          args as Record<string, unknown>,
          "topic",
          "memory_recall",
        );

        // Gather relevant memories
        const memories = searchMemories(db, topic, projectPath);
        const deadEnds = getDeadEndsByProject(db, projectPath)
          .filter((de) => !de.resolved)
          .filter((de) => jaccardSimilarity(topic, de.summary) > 0.2);
        const constraints = getConstraintsByProject(db, projectPath);

        if (
          memories.length === 0 &&
          deadEnds.length === 0 &&
          constraints.length === 0
        ) {
          return {
            content: [
              { type: "text", text: "No memories found for this topic." },
            ],
          };
        }

        // Build context for the recall prompt
        const contextParts: string[] = [];
        if (memories.length > 0) {
          contextParts.push(
            "MEMORIES:\n" +
              memories.map((m) => `- [${m.type}] ${m.content}`).join("\n"),
          );
        }
        if (deadEnds.length > 0) {
          contextParts.push(
            "DEAD ENDS:\n" +
              deadEnds.map((de) => `- ${de.summary}: ${de.blocker}`).join("\n"),
          );
        }
        if (constraints.length > 0) {
          contextParts.push(
            "CONSTRAINTS:\n" +
              constraints.map((c) => `- [${c.severity}] ${c.rule}`).join("\n"),
          );
        }

        const recallTemplate = readFileSync(
          path.join(__dirname, "..", "prompts", "recall.txt"),
          "utf-8",
        );
        const recallPrompt = recallTemplate
          .replace("{{TOPIC}}", topic)
          .replace("{{MEMORIES}}", contextParts.join("\n\n"));

        const synthesis = await callClaude(recallPrompt, "haiku", 30000);

        // Track access for retrieved memories
        for (const m of memories) {
          incrementAccessCount(db, m.id, dbPath);
        }

        return { content: [{ type: "text", text: synthesis }] };
      }

      case "add_constraint": {
        const a = args as Record<string, unknown>;
        const rule = requireString(a, "rule", "add_constraint");
        const constraintType = requireString(
          a,
          "type",
          "add_constraint",
        ) as ConstraintType;
        const severity = requireString(
          a,
          "severity",
          "add_constraint",
        ) as ConstraintSeverity;
        const id = insertConstraint(
          db,
          projectPath,
          rule,
          constraintType,
          severity,
          a?.scope as string | undefined,
          a?.source as string | undefined,
          dbPath,
        );
        return { content: [{ type: "text", text: `Constraint added: ${id}` }] };
      }

      case "get_constraints": {
        const constraints = getConstraintsByProject(db, projectPath);
        return {
          content: [
            { type: "text", text: JSON.stringify(constraints, null, 2) },
          ],
        };
      }

      case "set_goal": {
        const a = args as Record<string, unknown>;
        const intent = requireString(a, "intent", "set_goal");
        const doneWhen = requireStringArray(a, "done_when", "set_goal");
        const existing = getActiveGoal(db, projectPath);
        if (existing) {
          updateGoalStatus(db, existing.id, "paused", dbPath);
        }
        const id = insertGoal(db, projectPath, intent, doneWhen, dbPath);
        return {
          content: [
            {
              type: "text",
              text: `Goal set: ${id}${existing ? ` (paused previous: ${existing.id})` : ""}`,
            },
          ],
        };
      }

      case "get_goal": {
        const goal = getActiveGoal(db, projectPath);
        if (!goal)
          return { content: [{ type: "text", text: "No active goal" }] };
        return {
          content: [{ type: "text", text: JSON.stringify(goal, null, 2) }],
        };
      }

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

      case "save_insight": {
        const a = args as Record<string, unknown>;
        const insightContent = requireString(a, "content", "save_insight");
        const id = insertInsight(
          db,
          projectPath,
          insightContent,
          ((a?.category as string) ?? "surprise") as InsightCategory,
          a?.context as string | undefined,
          dbPath,
        );
        return { content: [{ type: "text", text: `Insight saved: ${id}` }] };
      }

      case "get_insights": {
        const since = args?.since as string | undefined;
        const insightDate = args?.date as string | undefined;
        let insights;
        if (since) {
          insights = getInsightsSince(db, projectPath, since);
        } else {
          const d = insightDate ?? new Date().toISOString().slice(0, 10);
          insights = getInsightsByDate(db, projectPath, d);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(insights, null, 2) }],
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

        // Gather activity for the date
        const checkpoints = getCheckpointsByDate(db, projectPath, date);
        const insights = getInsightsByDate(db, projectPath, date);
        const memories = getMemoriesByDate(db, projectPath, date);
        const extractionLogs = getExtractionLogsByDate(db, projectPath, date);

        if (
          checkpoints.length === 0 &&
          insights.length === 0 &&
          memories.length === 0 &&
          extractionLogs.length === 0
        ) {
          return {
            content: [{ type: "text", text: `No activity found for ${date}` }],
          };
        }

        // Build activity context
        const activityParts: string[] = [];
        if (checkpoints.length > 0) {
          activityParts.push(
            "CHECKPOINTS:\n" +
              checkpoints
                .map(
                  (cp) =>
                    `- [${cp.created_at}] Built: ${cp.what_was_built} | State: ${cp.current_state} | Next: ${cp.next_steps}`,
                )
                .join("\n"),
          );
        }
        if (insights.length > 0) {
          activityParts.push(
            "INSIGHTS:\n" +
              insights
                .map(
                  (ins) =>
                    `- [${ins.category}] ${ins.content}${ins.context ? ` (${ins.context})` : ""}`,
                )
                .join("\n"),
          );
        }
        if (memories.length > 0) {
          activityParts.push(
            "MEMORIES CREATED:\n" +
              memories.map((m) => `- [${m.type}] ${m.content}`).join("\n"),
          );
        }
        if (extractionLogs.length > 0) {
          activityParts.push(
            "EXTRACTION LOGS:\n" +
              extractionLogs
                .map(
                  (log) =>
                    `- [${log.event_type}] ${log.chunks_processed} chunks, ${log.memories_extracted} memories extracted`,
                )
                .join("\n"),
          );
        }

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

      case "consolidate": {
        const result = await runConsolidate(db, projectPath, {
          dbPath,
          model: "haiku",
          syncMd: true,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "sync_claude_md": {
        const result = syncClaudeMd(db, projectPath);
        return { content: [{ type: "text", text: result }] };
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
