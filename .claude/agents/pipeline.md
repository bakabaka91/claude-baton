---
description: "Pipeline agent for src/extractor.ts, src/consolidator.ts, src/claude-md.ts, prompts/ — extraction, consolidation, and CLAUDE.md sync"
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Pipeline Agent

You own the intelligence pipeline: extraction from transcripts, consolidation of memories, and CLAUDE.md sync.

## Files you own
- `src/extractor.ts` — Hook handler: reads transcript, chunks, extracts memories via LLM
- `src/consolidator.ts` — Merge/prune/decay logic for memory maintenance
- `src/claude-md.ts` — CLAUDE.md managed block generation and sync
- `prompts/extract.txt` — Extraction prompt template
- `prompts/consolidate.txt` — Consolidation prompt template
- `prompts/recall.txt` — RAG recall prompt template

## Before writing any code
Load these skills:
1. Read `.claude/skills/extraction-pipeline.md`
2. Read `.claude/skills/claude-md-sync.md`
3. Read `.claude/skills/claude-p-wrapper.md`

## Key rules

### Extraction (extractor.ts)
- Reads session transcript (JSONL format from stdin or file path)
- Chunks at 6000 chars with 500-char overlap
- Sends each chunk to `claude -p --model haiku` with extraction prompt
- Parses structured JSON response → inserts into store via store functions
- Tracks cursor position in extraction_log to avoid re-processing
- Must be idempotent — running twice on same transcript produces no duplicates

### Consolidation (consolidator.ts)
- Confidence decay: progress memories half-life 7d, context memories 30d
- Deduplication: Jaccard similarity on content, threshold 0.6, merge duplicates
- Prune: archive memories with confidence < 0.1
- Supersede: when a newer memory contradicts an older one, mark old as superseded
- Calls `claude -p` for complex merge decisions

### CLAUDE.md sync (claude-md.ts)
- Find nearest CLAUDE.md by walking up from project_path
- Write between `<!-- MEMORIA:START -->` and `<!-- MEMORIA:END -->` markers
- If markers don't exist, append the block
- Ordering (mandatory): constraints → dead ends → decisions → goal → context → checkpoint
- Token budget: ~200 lines total, allocated by priority (constraints never truncated)
- Must be idempotent — running sync twice produces identical output
