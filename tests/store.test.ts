import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import {
  initSchema,
  insertMemory, getMemory, getMemoriesByProject, updateMemoryStatus,
  updateMemoryConfidence, incrementAccessCount, deleteMemory,
  insertDeadEnd, getDeadEnd, getDeadEndsByProject, resolveDeadEnd,
  insertConstraint, getConstraint, getConstraintsByProject,
  insertGoal, getGoal, getActiveGoal, updateGoalStatus,
  insertCheckpoint, getCheckpoint, getLatestCheckpoint,
  insertInsight, getInsight, getInsightsByProject,
  insertDailySummary, getDailySummary,
  insertExtractionLog, getLastExtraction,
  countByType, countAll, listProjects, deleteProjectData, deleteAllData,
} from '../src/store.js';

let db: Database;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  initSchema(db);
});

describe('memories CRUD', () => {
  it('inserts and retrieves a memory', () => {
    const id = insertMemory(db, '/proj', 'decision', 'Use SQLite', ['db', 'storage']);
    const mem = getMemory(db, id);
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe('Use SQLite');
    expect(mem!.type).toBe('decision');
    expect(mem!.tags).toEqual(['db', 'storage']);
    expect(mem!.confidence).toBe(1.0);
    expect(mem!.access_count).toBe(0);
    expect(mem!.status).toBe('active');
  });

  it('queries by project and type', () => {
    insertMemory(db, '/proj-a', 'decision', 'Decision A');
    insertMemory(db, '/proj-a', 'pattern', 'Pattern A');
    insertMemory(db, '/proj-b', 'decision', 'Decision B');

    const all = getMemoriesByProject(db, '/proj-a');
    expect(all).toHaveLength(2);

    const decisions = getMemoriesByProject(db, '/proj-a', 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].content).toBe('Decision A');
  });

  it('updates status', () => {
    const id = insertMemory(db, '/proj', 'progress', 'WIP');
    updateMemoryStatus(db, id, 'archived');
    const mem = getMemory(db, id);
    expect(mem!.status).toBe('archived');
  });

  it('updates confidence', () => {
    const id = insertMemory(db, '/proj', 'context', 'Some context');
    updateMemoryConfidence(db, id, 0.5);
    const mem = getMemory(db, id);
    expect(mem!.confidence).toBe(0.5);
  });

  it('increments access count', () => {
    const id = insertMemory(db, '/proj', 'pattern', 'Singleton');
    incrementAccessCount(db, id);
    incrementAccessCount(db, id);
    const mem = getMemory(db, id);
    expect(mem!.access_count).toBe(2);
  });

  it('deletes a memory', () => {
    const id = insertMemory(db, '/proj', 'gotcha', 'Watch out');
    deleteMemory(db, id);
    expect(getMemory(db, id)).toBeNull();
  });

  it('filters by status', () => {
    insertMemory(db, '/proj', 'decision', 'Active one');
    const id2 = insertMemory(db, '/proj', 'decision', 'Archived one');
    updateMemoryStatus(db, id2, 'archived');

    const active = getMemoriesByProject(db, '/proj', undefined, 'active');
    expect(active).toHaveLength(1);
    expect(active[0].content).toBe('Active one');
  });

  it('JSON round-trips tags', () => {
    const id = insertMemory(db, '/proj', 'architecture', 'Layered', ['layer', 'arch', 'clean']);
    const mem = getMemory(db, id);
    expect(mem!.tags).toEqual(['layer', 'arch', 'clean']);
    expect(Array.isArray(mem!.tags)).toBe(true);
  });
});

describe('dead_ends CRUD', () => {
  it('inserts and retrieves', () => {
    const id = insertDeadEnd(db, '/proj', 'Redis caching', 'Tried Redis', 'Overkill for single user', 'When multi-user');
    const de = getDeadEnd(db, id);
    expect(de).not.toBeNull();
    expect(de!.summary).toBe('Redis caching');
    expect(de!.approach_tried).toBe('Tried Redis');
    expect(de!.blocker).toBe('Overkill for single user');
    expect(de!.resume_when).toBe('When multi-user');
    expect(de!.resolved).toBe(false);
  });

  it('queries by project', () => {
    insertDeadEnd(db, '/proj-a', 'Attempt 1', 'Tried X', 'Failed');
    insertDeadEnd(db, '/proj-b', 'Attempt 2', 'Tried Y', 'Failed');
    const results = getDeadEndsByProject(db, '/proj-a');
    expect(results).toHaveLength(1);
  });

  it('resolves a dead end', () => {
    const id = insertDeadEnd(db, '/proj', 'Bug', 'Old approach', 'Blocked');
    resolveDeadEnd(db, id);
    const de = getDeadEnd(db, id);
    expect(de!.resolved).toBe(true);
  });
});

describe('constraints CRUD', () => {
  it('inserts and retrieves', () => {
    const id = insertConstraint(db, '/proj', 'No secrets in git', 'security', 'must', 'global', 'audit');
    const c = getConstraint(db, id);
    expect(c).not.toBeNull();
    expect(c!.rule).toBe('No secrets in git');
    expect(c!.type).toBe('security');
    expect(c!.severity).toBe('must');
  });

  it('queries by project', () => {
    insertConstraint(db, '/proj', 'Rule 1', 'security', 'must');
    insertConstraint(db, '/proj', 'Rule 2', 'convention', 'should');
    const results = getConstraintsByProject(db, '/proj');
    expect(results).toHaveLength(2);
  });
});

describe('goals CRUD', () => {
  it('inserts and retrieves with JSON done_when', () => {
    const doneWhen = ['Task A done', 'Task B done'];
    const id = insertGoal(db, '/proj', 'Ship v1', doneWhen);
    const goal = getGoal(db, id);
    expect(goal).not.toBeNull();
    expect(goal!.intent).toBe('Ship v1');
    expect(goal!.done_when).toEqual(doneWhen);
    expect(goal!.status).toBe('active');
  });

  it('gets active goal', () => {
    insertGoal(db, '/proj', 'Goal 1', ['done']);
    const id2 = insertGoal(db, '/proj', 'Goal 2', ['done']);
    const active = getActiveGoal(db, '/proj');
    expect(active).not.toBeNull();
    expect(active!.id).toBe(id2);
  });

  it('updates goal status', () => {
    const id = insertGoal(db, '/proj', 'Goal', ['done']);
    updateGoalStatus(db, id, 'completed');
    const goal = getGoal(db, id);
    expect(goal!.status).toBe('completed');
  });

  it('no active goal returns null', () => {
    expect(getActiveGoal(db, '/proj')).toBeNull();
  });
});

describe('checkpoints CRUD', () => {
  it('inserts and retrieves with JSON uncommitted_files', () => {
    const id = insertCheckpoint(db, '/proj', 'sess-1', 'Working on auth', 'Auth module', 'Add tests', {
      branch: 'main',
      decisionsMade: 'JWT over sessions',
      blockers: 'None',
      uncommittedFiles: ['src/auth.ts', 'src/middleware.ts'],
    });
    const cp = getCheckpoint(db, id);
    expect(cp).not.toBeNull();
    expect(cp!.what_was_built).toBe('Auth module');
    expect(cp!.uncommitted_files).toEqual(['src/auth.ts', 'src/middleware.ts']);
  });

  it('gets latest checkpoint', () => {
    insertCheckpoint(db, '/proj', 'sess-1', 'State 1', 'Built 1', 'Next 1');
    insertCheckpoint(db, '/proj', 'sess-2', 'State 2', 'Built 2', 'Next 2');
    const latest = getLatestCheckpoint(db, '/proj');
    expect(latest).not.toBeNull();
    expect(latest!.session_id).toBe('sess-2');
  });

  it('no checkpoint returns null', () => {
    expect(getLatestCheckpoint(db, '/proj')).toBeNull();
  });
});

describe('insights CRUD', () => {
  it('inserts and retrieves', () => {
    const id = insertInsight(db, '/proj', 'Haiku is fast enough', 'architecture', 'Testing models');
    const ins = getInsight(db, id);
    expect(ins).not.toBeNull();
    expect(ins!.content).toBe('Haiku is fast enough');
    expect(ins!.category).toBe('architecture');
  });

  it('queries by project and category', () => {
    insertInsight(db, '/proj', 'Insight 1', 'decision');
    insertInsight(db, '/proj', 'Insight 2', 'workflow');
    const decisions = getInsightsByProject(db, '/proj', 'decision');
    expect(decisions).toHaveLength(1);
  });
});

describe('daily_summaries CRUD', () => {
  it('inserts and retrieves with JSON summary', () => {
    const summary = { highlights: ['Shipped auth'], blockers: [] };
    insertDailySummary(db, '/proj', '2026-03-22', summary);
    const ds = getDailySummary(db, '/proj', '2026-03-22');
    expect(ds).not.toBeNull();
    expect(ds!.summary).toEqual(summary);
  });

  it('returns null for missing date', () => {
    expect(getDailySummary(db, '/proj', '2026-01-01')).toBeNull();
  });
});

describe('extraction_log CRUD', () => {
  it('inserts and retrieves last extraction', () => {
    insertExtractionLog(db, '/proj', 'sess-1', 'Stop', 3, 5);
    insertExtractionLog(db, '/proj', 'sess-1', 'SessionEnd', 2, 1);
    const last = getLastExtraction(db, '/proj', 'sess-1');
    expect(last).not.toBeNull();
    expect(last!.event_type).toBe('SessionEnd');
    expect(last!.chunks_processed).toBe(2);
  });

  it('returns null when no extractions', () => {
    expect(getLastExtraction(db, '/proj')).toBeNull();
  });
});

describe('aggregate queries', () => {
  it('counts by type', () => {
    insertMemory(db, '/proj', 'decision', 'D1');
    insertMemory(db, '/proj', 'decision', 'D2');
    insertMemory(db, '/proj', 'pattern', 'P1');
    const counts = countByType(db, '/proj');
    expect(counts.decision).toBe(2);
    expect(counts.pattern).toBe(1);
  });

  it('counts all tables', () => {
    insertMemory(db, '/proj', 'decision', 'D1');
    insertDeadEnd(db, '/proj', 'DE1', 'Tried', 'Blocked');
    insertConstraint(db, '/proj', 'Rule', 'security', 'must');
    const counts = countAll(db, '/proj');
    expect(counts.memories).toBe(1);
    expect(counts.dead_ends).toBe(1);
    expect(counts.constraints).toBe(1);
  });

  it('lists projects', () => {
    insertMemory(db, '/proj-a', 'decision', 'D1');
    insertMemory(db, '/proj-a', 'pattern', 'P1');
    insertMemory(db, '/proj-b', 'decision', 'D2');
    const projects = listProjects(db);
    expect(projects).toHaveLength(2);
    expect(projects[0].project_path).toBe('/proj-a');
    expect(projects[0].memory_count).toBe(2);
  });
});

describe('cross-project isolation', () => {
  it('memories are isolated by project', () => {
    insertMemory(db, '/proj-a', 'decision', 'A decision');
    insertMemory(db, '/proj-b', 'decision', 'B decision');
    expect(getMemoriesByProject(db, '/proj-a')).toHaveLength(1);
    expect(getMemoriesByProject(db, '/proj-b')).toHaveLength(1);
  });

  it('deleteProjectData only affects target project', () => {
    insertMemory(db, '/proj-a', 'decision', 'Keep');
    insertMemory(db, '/proj-b', 'decision', 'Delete');
    insertDeadEnd(db, '/proj-b', 'DE', 'Tried', 'Blocked');
    deleteProjectData(db, '/proj-b');
    expect(getMemoriesByProject(db, '/proj-a')).toHaveLength(1);
    expect(getMemoriesByProject(db, '/proj-b')).toHaveLength(0);
    expect(getDeadEndsByProject(db, '/proj-b')).toHaveLength(0);
  });

  it('deleteAllData clears everything', () => {
    insertMemory(db, '/proj-a', 'decision', 'D1');
    insertMemory(db, '/proj-b', 'decision', 'D2');
    deleteAllData(db);
    expect(countAll(db).memories).toBe(0);
  });
});
