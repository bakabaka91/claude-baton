import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Database } from 'sql.js';
import type { MemoryType, ConstraintType, ConstraintSeverity, InsightCategory } from './types.js';
import {
  initDatabase, getDefaultDbPath,
  insertMemory, getMemoriesByProject,
  insertDeadEnd, getDeadEndsByProject,
  insertConstraint, getConstraintsByProject,
  insertGoal, getActiveGoal, updateGoalStatus,
  insertCheckpoint, getLatestCheckpoint,
  insertInsight,
  countByType, countAll,
  insertDailySummary,
} from './store.js';
import { searchMemories, checkDuplicate, jaccardSimilarity } from './utils.js';

let db: Database;
let dbPath: string;

const server = new Server(
  { name: 'memoria-solo', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_search',
      description: 'Search across all memory types',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query' },
          project: { type: 'string', description: 'Project path (defaults to cwd)' },
          type: { type: 'string', enum: ['architecture', 'decision', 'pattern', 'gotcha', 'progress', 'context'] },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_save',
      description: 'Manually save a memory',
      inputSchema: {
        type: 'object' as const,
        properties: {
          type: { type: 'string', enum: ['architecture', 'decision', 'pattern', 'gotcha', 'progress', 'context'] },
          content: { type: 'string', description: 'Memory content' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        },
        required: ['type', 'content'],
      },
    },
    {
      name: 'memory_stats',
      description: 'Memory counts by type/project, last extraction time',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'log_dead_end',
      description: 'Record a failed approach so it is not retried',
      inputSchema: {
        type: 'object' as const,
        properties: {
          summary: { type: 'string', description: 'Brief summary' },
          approach_tried: { type: 'string', description: 'What was attempted' },
          blocker: { type: 'string', description: 'Why it failed' },
          resume_when: { type: 'string', description: 'Conditions to revisit' },
        },
        required: ['summary', 'approach_tried', 'blocker'],
      },
    },
    {
      name: 'check_dead_ends',
      description: 'Check if an approach was already tried and failed',
      inputSchema: {
        type: 'object' as const,
        properties: {
          approach: { type: 'string', description: 'Approach to check' },
        },
        required: ['approach'],
      },
    },
    {
      name: 'memory_recall',
      description: 'RAG-style synthesized recall on a topic using stored memories',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string', description: 'Topic to recall information about' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'add_constraint',
      description: 'Add a project rule/constraint',
      inputSchema: {
        type: 'object' as const,
        properties: {
          rule: { type: 'string', description: 'The constraint rule' },
          type: { type: 'string', enum: ['security', 'performance', 'compliance', 'convention'] },
          severity: { type: 'string', enum: ['must', 'should', 'prefer'] },
          scope: { type: 'string', description: 'Scope of the constraint' },
          source: { type: 'string', description: 'Where this constraint came from' },
        },
        required: ['rule', 'type', 'severity'],
      },
    },
    {
      name: 'get_constraints',
      description: 'List active constraints for a project',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: { type: 'string', description: 'Project path (defaults to cwd)' },
        },
      },
    },
    {
      name: 'set_goal',
      description: 'Set current sprint/task goal (pauses any existing active goal)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          intent: { type: 'string', description: 'Goal intent' },
          done_when: { type: 'array', items: { type: 'string' }, description: 'Completion criteria' },
        },
        required: ['intent', 'done_when'],
      },
    },
    {
      name: 'get_goal',
      description: 'Get the active goal for a project',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: { type: 'string', description: 'Project path (defaults to cwd)' },
        },
      },
    },
    {
      name: 'save_checkpoint',
      description: 'Save session state before context loss',
      inputSchema: {
        type: 'object' as const,
        properties: {
          what_was_built: { type: 'string' },
          current_state: { type: 'string' },
          next_steps: { type: 'string' },
          decisions: { type: 'string' },
          blockers: { type: 'string' },
        },
        required: ['what_was_built', 'current_state', 'next_steps'],
      },
    },
    {
      name: 'get_checkpoint',
      description: 'Retrieve latest checkpoint for resumption',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: { type: 'string', description: 'Project path (defaults to cwd)' },
        },
      },
    },
    {
      name: 'save_insight',
      description: 'Capture a real-time insight',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'Insight content' },
          category: { type: 'string', enum: ['decision', 'workflow', 'architecture', 'surprise', 'cost'] },
          context: { type: 'string', description: 'Optional context' },
        },
        required: ['content'],
      },
    },
    {
      name: 'daily_summary',
      description: 'Generate EOD summary from the day\'s activity',
      inputSchema: {
        type: 'object' as const,
        properties: {
          date: { type: 'string', description: 'Date (YYYY-MM-DD, defaults to today)' },
        },
      },
    },
    {
      name: 'consolidate',
      description: 'Manually trigger memory merge/prune/decay',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'sync_claude_md',
      description: 'Manually refresh CLAUDE.md managed block',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const projectPath = (args?.project as string) ?? process.cwd();

  try {
    switch (name) {
      case 'memory_search': {
        const results = searchMemories(db, args!.query as string, projectPath, args?.type as string);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      }

      case 'memory_save': {
        const content = args!.content as string;
        const existing = checkDuplicate(db, content, projectPath);
        if (existing) {
          return { content: [{ type: 'text', text: `Duplicate detected (similarity > 0.6). Existing memory: ${existing.id}` }] };
        }
        const id = insertMemory(db, projectPath, args!.type as MemoryType, content, (args?.tags as string[]) ?? [], 1.0, dbPath);
        return { content: [{ type: 'text', text: `Memory saved: ${id}` }] };
      }

      case 'memory_stats': {
        const byType = countByType(db, projectPath);
        const totals = countAll(db, projectPath);
        return { content: [{ type: 'text', text: JSON.stringify({ by_type: byType, totals }, null, 2) }] };
      }

      case 'log_dead_end': {
        const id = insertDeadEnd(
          db, projectPath,
          args!.summary as string,
          args!.approach_tried as string,
          args!.blocker as string,
          args?.resume_when as string | undefined,
          dbPath,
        );
        return { content: [{ type: 'text', text: `Dead end logged: ${id}` }] };
      }

      case 'check_dead_ends': {
        const approach = args!.approach as string;
        const deadEnds = getDeadEndsByProject(db, projectPath);
        const matches = deadEnds
          .filter(de => !de.resolved)
          .map(de => ({ ...de, similarity: jaccardSimilarity(approach, de.approach_tried) }))
          .filter(de => de.similarity > 0.3)
          .sort((a, b) => b.similarity - a.similarity);

        if (matches.length === 0) {
          return { content: [{ type: 'text', text: 'No similar dead ends found. Approach appears safe to try.' }] };
        }
        const warnings = matches.map(m =>
          `WARNING (${(m.similarity * 100).toFixed(0)}% similar): "${m.summary}" — ${m.blocker}${m.resume_when ? ` (resume when: ${m.resume_when})` : ''}`
        );
        return { content: [{ type: 'text', text: warnings.join('\n') }] };
      }

      case 'memory_recall': {
        return { content: [{ type: 'text', text: 'Not yet implemented' }] };
      }

      case 'add_constraint': {
        const id = insertConstraint(
          db, projectPath,
          args!.rule as string,
          args!.type as ConstraintType,
          args!.severity as ConstraintSeverity,
          args?.scope as string | undefined,
          args?.source as string | undefined,
          dbPath,
        );
        return { content: [{ type: 'text', text: `Constraint added: ${id}` }] };
      }

      case 'get_constraints': {
        const constraints = getConstraintsByProject(db, projectPath);
        return { content: [{ type: 'text', text: JSON.stringify(constraints, null, 2) }] };
      }

      case 'set_goal': {
        const existing = getActiveGoal(db, projectPath);
        if (existing) {
          updateGoalStatus(db, existing.id, 'paused', dbPath);
        }
        const id = insertGoal(db, projectPath, args!.intent as string, args!.done_when as string[], dbPath);
        return { content: [{ type: 'text', text: `Goal set: ${id}${existing ? ` (paused previous: ${existing.id})` : ''}` }] };
      }

      case 'get_goal': {
        const goal = getActiveGoal(db, projectPath);
        if (!goal) return { content: [{ type: 'text', text: 'No active goal' }] };
        return { content: [{ type: 'text', text: JSON.stringify(goal, null, 2) }] };
      }

      case 'save_checkpoint': {
        const sessionId = process.env.CLAUDE_SESSION_ID ?? `session-${Date.now()}`;
        const id = insertCheckpoint(
          db, projectPath, sessionId,
          args!.current_state as string,
          args!.what_was_built as string,
          args!.next_steps as string,
          {
            decisionsMade: args?.decisions as string | undefined,
            blockers: args?.blockers as string | undefined,
          },
          dbPath,
        );
        return { content: [{ type: 'text', text: `Checkpoint saved: ${id}` }] };
      }

      case 'get_checkpoint': {
        const cp = getLatestCheckpoint(db, projectPath);
        if (!cp) return { content: [{ type: 'text', text: 'No checkpoint found' }] };
        return { content: [{ type: 'text', text: JSON.stringify(cp, null, 2) }] };
      }

      case 'save_insight': {
        const id = insertInsight(
          db, projectPath,
          args!.content as string,
          ((args?.category as string) ?? 'surprise') as InsightCategory,
          args?.context as string | undefined,
          dbPath,
        );
        return { content: [{ type: 'text', text: `Insight saved: ${id}` }] };
      }

      case 'daily_summary': {
        return { content: [{ type: 'text', text: 'Not yet implemented' }] };
      }

      case 'consolidate': {
        return { content: [{ type: 'text', text: 'Not yet implemented' }] };
      }

      case 'sync_claude_md': {
        return { content: [{ type: 'text', text: 'Not yet implemented' }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Tool error (${name}):`, msg);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  dbPath = getDefaultDbPath();
  db = await initDatabase(dbPath);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
