import { describe, it, expect, beforeEach, vi } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import {
  initSchema, insertConstraint, insertDeadEnd,
  insertMemory, insertGoal, insertCheckpoint,
} from '../src/store.js';
import { generateBlock, findClaudeMd, writeBlock, syncClaudeMd } from '../src/claude-md.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

let db: Database;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  initSchema(db);
});

describe('generateBlock', () => {
  it('generates empty string when no data', () => {
    const block = generateBlock(db, '/proj');
    expect(block).toBe('');
  });

  it('includes constraints with severity labels', () => {
    insertConstraint(db, '/proj', 'No secrets in git', 'security', 'must', undefined, 'audit');
    insertConstraint(db, '/proj', 'Use parameterized queries', 'convention', 'should');
    const block = generateBlock(db, '/proj');
    expect(block).toContain('## Constraints');
    expect(block).toContain('[MUST] No secrets in git (source: audit)');
    expect(block).toContain('[SHOULD] Use parameterized queries');
  });

  it('includes unresolved dead ends with dates', () => {
    insertDeadEnd(db, '/proj', 'Redis caching', 'Tried Redis', 'Overkill');
    const block = generateBlock(db, '/proj');
    expect(block).toContain('## Dead Ends');
    expect(block).toContain('Redis caching');
  });

  it('excludes resolved dead ends', () => {
    const id = insertDeadEnd(db, '/proj', 'Old approach', 'Tried X', 'Failed');
    db.run('UPDATE dead_ends SET resolved = 1 WHERE id = ?', [id]);
    const block = generateBlock(db, '/proj');
    expect(block).not.toContain('Old approach');
  });

  it('includes decisions', () => {
    insertMemory(db, '/proj', 'decision', 'Use SQLite via sql.js');
    const block = generateBlock(db, '/proj');
    expect(block).toContain('## Key Decisions');
    expect(block).toContain('Use SQLite via sql.js');
  });

  it('includes active goal with checkboxes', () => {
    insertGoal(db, '/proj', 'Ship v1', ['All tools working', 'Tests pass']);
    const block = generateBlock(db, '/proj');
    expect(block).toContain('## Active Goal');
    expect(block).toContain('**Intent:** Ship v1');
    expect(block).toContain('- [ ] All tools working');
    expect(block).toContain('- [ ] Tests pass');
  });

  it('includes recent context memories', () => {
    insertMemory(db, '/proj', 'pattern', 'DI for store functions');
    insertMemory(db, '/proj', 'gotcha', 'Must free sql.js statements');
    const block = generateBlock(db, '/proj');
    expect(block).toContain('## Recent Context');
    expect(block).toContain('pattern: DI for store functions');
    expect(block).toContain('gotcha: Must free sql.js statements');
  });

  it('includes last checkpoint', () => {
    insertCheckpoint(db, '/proj', 'sess-1', 'Working state', 'Auth module', 'Add tests', { blockers: 'None' });
    const block = generateBlock(db, '/proj');
    expect(block).toContain('## Last Checkpoint');
    expect(block).toContain('**Built:** Auth module');
    expect(block).toContain('**Next:** Add tests');
  });

  it('respects section ordering: constraints before dead ends before decisions', () => {
    insertConstraint(db, '/proj', 'Rule 1', 'security', 'must');
    insertDeadEnd(db, '/proj', 'Bad approach', 'Tried X', 'Failed');
    insertMemory(db, '/proj', 'decision', 'Use Y');
    insertGoal(db, '/proj', 'Goal', ['Done']);
    insertMemory(db, '/proj', 'pattern', 'Pattern X');
    insertCheckpoint(db, '/proj', 'sess', 'State', 'Built', 'Next');

    const block = generateBlock(db, '/proj');
    const constraintsIdx = block.indexOf('## Constraints');
    const deadEndsIdx = block.indexOf('## Dead Ends');
    const decisionsIdx = block.indexOf('## Key Decisions');
    const goalIdx = block.indexOf('## Active Goal');
    const contextIdx = block.indexOf('## Recent Context');
    const checkpointIdx = block.indexOf('## Last Checkpoint');

    expect(constraintsIdx).toBeLessThan(deadEndsIdx);
    expect(deadEndsIdx).toBeLessThan(decisionsIdx);
    expect(decisionsIdx).toBeLessThan(goalIdx);
    expect(goalIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(checkpointIdx);
  });
});

describe('writeBlock', () => {
  it('replaces existing markers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-test-'));
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, `# Project\n\n<!-- MEMORIA:START -->\nOld content\n<!-- MEMORIA:END -->\n\nMore stuff\n`);

    writeBlock(filePath, '## New Content\n- item');

    const result = fs.readFileSync(filePath, 'utf-8');
    expect(result).toContain('## New Content');
    expect(result).not.toContain('Old content');
    expect(result).toContain('More stuff');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('appends when no markers exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-test-'));
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, '# Project\n\nExisting content\n');

    writeBlock(filePath, '## New Block\n- item');

    const result = fs.readFileSync(filePath, 'utf-8');
    expect(result).toContain('# Project');
    expect(result).toContain('Existing content');
    expect(result).toContain('<!-- MEMORIA:START -->');
    expect(result).toContain('## New Block');
    expect(result).toContain('<!-- MEMORIA:END -->');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('is idempotent — same block written twice produces same output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-test-'));
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, '# Project\n');

    writeBlock(filePath, '## Block\n- item');
    const first = fs.readFileSync(filePath, 'utf-8');

    writeBlock(filePath, '## Block\n- item');
    const second = fs.readFileSync(filePath, 'utf-8');

    expect(first).toBe(second);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('syncClaudeMd', () => {
  it('creates CLAUDE.md when none exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-test-'));
    insertConstraint(db, tmpDir, 'Rule 1', 'security', 'must');

    const result = syncClaudeMd(db, tmpDir);
    expect(result).toContain('Created');

    const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('<!-- MEMORIA:START -->');
    expect(content).toContain('[MUST] Rule 1');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns message when no data', () => {
    const result = syncClaudeMd(db, '/nonexistent/proj');
    expect(result).toContain('empty');
  });
});
