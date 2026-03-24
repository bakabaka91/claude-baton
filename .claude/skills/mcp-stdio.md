# MCP stdio Transport Patterns

## Server setup

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'claude-baton', version: '1.0.0' },
  { capabilities: { tools: {} } }
);
```

## Tool registration

```typescript
// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_search',
      description: 'Search across all memory types',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          project: { type: 'string', description: 'Project path (defaults to cwd)' },
          type: {
            type: 'string',
            enum: ['architecture', 'decision', 'pattern', 'gotcha', 'progress', 'context'],
          },
        },
        required: ['query'],
      },
    },
    // ... all 16 tools per PLAN.md
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'memory_search': {
      const results = store.searchMemories(args.query, args.project, args.type);
      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    }
    // ... handle all 16 tools
    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});
```

## Starting the server

```typescript
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server now reads JSON-RPC from stdin and writes to stdout
  // Do NOT write anything else to stdout — it breaks the protocol
}

main().catch((error) => {
  console.error('Server error:', error); // stderr is safe
  process.exit(1);
});
```

## Critical rules
1. **Never write to stdout** except via the MCP transport — console.log breaks the protocol
2. **Use console.error** for all debug/log output (goes to stderr)
3. **Tool handlers must not throw** — catch all errors and return `{ isError: true }`
4. **Return type is always** `{ content: [{ type: 'text', text: string }] }`
5. **stdio transport** is one-shot per process — Claude Code starts/stops the server per session
6. **Input schemas** use JSON Schema format (not zod) in tool definitions — but use zod for runtime validation inside handlers
