import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { initSchema, insertMemory } from '../src/store.js';
import {
  jaccardSimilarity, searchMemories, checkDuplicate,
  chunkText, parseTranscript,
} from '../src/utils.js';

let db: Database;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  initSchema(db);
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(jaccardSimilarity('hello world', 'foo bar')).toBe(0);
  });

  it('returns correct ratio for partial overlap', () => {
    const score = jaccardSimilarity('hello world foo', 'hello world bar');
    // intersection: {hello, world} = 2, union: {hello, world, foo, bar} = 4
    expect(score).toBe(0.5);
  });

  it('is case-insensitive', () => {
    expect(jaccardSimilarity('Hello World', 'hello world')).toBe(1);
  });

  it('returns 1 for two empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(1);
  });

  it('returns 0 when one string is empty', () => {
    expect(jaccardSimilarity('hello', '')).toBe(0);
  });
});

describe('searchMemories', () => {
  it('finds memories by content substring', () => {
    insertMemory(db, '/proj', 'decision', 'Use SQLite for storage');
    insertMemory(db, '/proj', 'pattern', 'Singleton pattern');
    const results = searchMemories(db, 'SQLite');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Use SQLite for storage');
  });

  it('filters by project', () => {
    insertMemory(db, '/proj-a', 'decision', 'Use SQLite');
    insertMemory(db, '/proj-b', 'decision', 'Use SQLite too');
    const results = searchMemories(db, 'SQLite', '/proj-a');
    expect(results).toHaveLength(1);
  });

  it('filters by type', () => {
    insertMemory(db, '/proj', 'decision', 'Use SQLite');
    insertMemory(db, '/proj', 'pattern', 'SQLite patterns');
    const results = searchMemories(db, 'SQLite', undefined, 'pattern');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('pattern');
  });

  it('returns empty for no matches', () => {
    insertMemory(db, '/proj', 'decision', 'Use SQLite');
    expect(searchMemories(db, 'Redis')).toHaveLength(0);
  });

  it('excludes archived memories', () => {
    const id = insertMemory(db, '/proj', 'decision', 'Use SQLite');
    db.run("UPDATE memories SET status = 'archived' WHERE id = ?", [id]);
    expect(searchMemories(db, 'SQLite')).toHaveLength(0);
  });
});

describe('checkDuplicate', () => {
  it('finds duplicate above threshold', () => {
    insertMemory(db, '/proj', 'decision', 'Use SQLite for persistent storage');
    const dup = checkDuplicate(db, 'Use SQLite for persistent data storage', '/proj', 0.6);
    expect(dup).not.toBeNull();
  });

  it('returns null below threshold', () => {
    insertMemory(db, '/proj', 'decision', 'Use SQLite for persistent storage');
    const dup = checkDuplicate(db, 'Something completely different and unrelated', '/proj', 0.6);
    expect(dup).toBeNull();
  });

  it('isolates by project', () => {
    insertMemory(db, '/proj-a', 'decision', 'Use SQLite for storage');
    const dup = checkDuplicate(db, 'Use SQLite for storage', '/proj-b', 0.6);
    expect(dup).toBeNull();
  });

  it('ignores archived memories', () => {
    const id = insertMemory(db, '/proj', 'decision', 'Use SQLite for storage');
    db.run("UPDATE memories SET status = 'archived' WHERE id = ?", [id]);
    const dup = checkDuplicate(db, 'Use SQLite for storage', '/proj', 0.6);
    expect(dup).toBeNull();
  });

  it('returns best match when multiple exist', () => {
    insertMemory(db, '/proj', 'decision', 'Completely unrelated topic about testing');
    insertMemory(db, '/proj', 'decision', 'Use SQLite for persistent storage across sessions');
    const dup = checkDuplicate(db, 'Use SQLite for persistent storage', '/proj', 0.4);
    expect(dup).not.toBeNull();
    expect(dup!.content).toContain('persistent storage');
  });
});

describe('chunkText', () => {
  it('returns single chunk for short text', () => {
    const chunks = chunkText('Hello world', 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Hello world');
  });

  it('splits long text with overlap', () => {
    const text = 'A'.repeat(150);
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk is 100 chars
    expect(chunks[0]).toHaveLength(100);
    // Overlap means second chunk starts at 80
    expect(chunks[1].length).toBeLessThanOrEqual(100);
  });

  it('handles exact boundary', () => {
    const text = 'A'.repeat(100);
    const chunks = chunkText(text, 100);
    expect(chunks).toHaveLength(1);
  });

  it('overlap ensures no content loss', () => {
    const text = 'ABCDEFGHIJ';
    const chunks = chunkText(text, 5, 2);
    // Chunks: [ABCDE, DEFGH, GHIJ]
    const combined = chunks.join('');
    // Every char in original should appear in at least one chunk
    for (const char of text) {
      expect(chunks.some(c => c.includes(char))).toBe(true);
    }
  });
});

describe('parseTranscript', () => {
  it('parses human and assistant messages', () => {
    const jsonl = [
      JSON.stringify({ type: 'human', message: { content: 'Fix the bug' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'Looking at it' } }),
    ].join('\n');
    const result = parseTranscript(jsonl);
    expect(result).toContain('USER: Fix the bug');
    expect(result).toContain('ASSISTANT: Looking at it');
  });

  it('handles array content blocks', () => {
    const jsonl = JSON.stringify({
      type: 'human',
      message: { content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'World' }] },
    });
    const result = parseTranscript(jsonl);
    expect(result).toContain('USER: Hello\nWorld');
  });

  it('includes tool calls', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: { content: 'Checking', tool_calls: [{ name: 'read_file' }] },
    });
    const result = parseTranscript(jsonl);
    expect(result).toContain('[tool: read_file]');
  });

  it('handles invalid JSON lines gracefully', () => {
    const jsonl = 'not json\n' + JSON.stringify({ type: 'human', message: { content: 'Hello' } });
    const result = parseTranscript(jsonl);
    expect(result).toContain('USER: Hello');
  });

  it('returns empty string for empty input', () => {
    expect(parseTranscript('')).toBe('');
  });
});
