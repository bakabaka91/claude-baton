# Extraction Pipeline Patterns

## Session transcript format

Claude Code sessions are stored as JSONL at:
`~/.claude/projects/{encoded-path}/{session-id}.jsonl`

Each line is a JSON object with conversation turns:
```json
{"type":"human","message":{"content":"fix the auth bug"}}
{"type":"assistant","message":{"content":"I'll look at...","tool_calls":[...]}}
{"type":"tool_result","tool_use_id":"...","content":"..."}
```

## Readable summary extraction

Parse JSONL into a readable summary for the LLM:

```typescript
function parseTranscript(jsonl: string): string {
  const lines = jsonl
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const summary: string[] = [];

  for (const line of lines) {
    if (line.type === 'human') {
      summary.push(`USER: ${extractText(line.message.content)}`);
    } else if (line.type === 'assistant') {
      const text = extractText(line.message.content);
      if (text) summary.push(`ASSISTANT: ${text}`);
      if (line.message.tool_calls) {
        for (const tc of line.message.tool_calls) {
          summary.push(`  [tool: ${tc.name}]`);
        }
      }
    }
  }

  return summary.join('\n');
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
```

## Chunking strategy

```typescript
function chunk(text: string, maxSize: number = 6000, overlap: number = 500): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + maxSize, text.length);
    chunks.push(text.slice(start, end));
    start = end - overlap;
  }

  return chunks;
}
```

## Extraction prompt structure

The extraction prompt (`prompts/extract.txt`) asks the LLM to identify structured memories:

```
Given this session transcript chunk, extract structured memories:

{{CHUNK}}

Return a JSON array. Each item must have one of these types:
- memory: { type: "memory", memory_type: "architecture|decision|pattern|gotcha|progress|context", content: string, tags: string[] }
- dead_end: { type: "dead_end", summary: string, approach_tried: string, blocker: string }
- constraint: { type: "constraint", rule: string, constraint_type: "security|performance|compliance|convention", severity: "must|should|prefer" }
- insight: { type: "insight", content: string, category: "decision|workflow|architecture|surprise|cost" }

Only extract items that represent lasting knowledge. Skip ephemeral details like "reading file X" or "running tests".
Return [] if nothing worth extracting.
```

## Cursor tracking

Track where in the transcript we've already processed:

```typescript
interface ExtractionCursor {
  session_id: string;
  bytes_processed: number;
  last_extraction_at: string;
}

// Store in extraction_log table
// On each extraction: read from bytes_processed offset, not from beginning
```

## Deduplication (Jaccard similarity)

```typescript
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// Before inserting a new memory, check existing:
// if jaccardSimilarity(newContent, existingContent) > 0.6 → skip or merge
```

## Key rules
1. **Idempotent** — same transcript processed twice → no new records
2. **Cursor-based** — never re-process already-extracted content
3. **Defensive parsing** — LLM may return invalid JSON, handle gracefully
4. **Skip ephemera** — tool calls, file reads, test output are not memories
5. **Haiku for extraction** — fast and cheap, good enough for structured extraction
6. **Overlap prevents loss** — 500 char overlap ensures no context lost at chunk boundaries
