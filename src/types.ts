/** Classification of memory content. */
export type MemoryType =
  | "architecture"
  | "decision"
  | "pattern"
  | "gotcha"
  | "progress"
  | "context";
/** Lifecycle status of a memory record. */
export type MemoryStatus = "active" | "archived" | "superseded";

/** A stored memory extracted from a Claude Code session. */
export interface Memory {
  id: string;
  project_path: string;
  type: MemoryType;
  content: string;
  tags: string[];
  confidence: number;
  access_count: number;
  status: MemoryStatus;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A failed approach recorded to avoid repeating mistakes. */
export interface DeadEnd {
  id: string;
  project_path: string;
  summary: string;
  approach_tried: string;
  blocker: string;
  resume_when: string | null;
  resolved: boolean;
  created_at: string;
}

/** Category of a project constraint. */
export type ConstraintType =
  | "security"
  | "performance"
  | "compliance"
  | "convention";
/** How strictly a constraint must be followed. */
export type ConstraintSeverity = "must" | "should" | "prefer";

/** A project rule or invariant that must be respected. */
export interface Constraint {
  id: string;
  project_path: string;
  rule: string;
  type: ConstraintType;
  severity: ConstraintSeverity;
  scope: string | null;
  source: string | null;
  created_at: string;
}

/** Tracking status of a goal. */
export type GoalStatus = "active" | "completed" | "paused";

/** A high-level objective with measurable completion criteria. */
export interface Goal {
  id: string;
  project_path: string;
  intent: string;
  done_when: string[];
  status: GoalStatus;
  created_at: string;
  updated_at: string;
}

/** A snapshot of session state saved before /compact or /clear. */
export interface Checkpoint {
  id: string;
  project_path: string;
  session_id: string;
  branch: string | null;
  current_state: string;
  what_was_built: string;
  next_steps: string;
  decisions_made: string | null;
  blockers: string | null;
  uncommitted_files: string[];
  git_snapshot: string | null;
  created_at: string;
}

/** Category of a captured insight. */
export type InsightCategory =
  | "decision"
  | "workflow"
  | "architecture"
  | "surprise"
  | "cost";

/** A real-time observation or lesson learned during development. */
export interface Insight {
  id: string;
  project_path: string;
  content: string;
  context: string | null;
  category: InsightCategory;
  created_at: string;
}

/** An aggregated end-of-day summary of project activity. */
export interface DailySummary {
  id: string;
  project_path: string;
  date: string;
  summary: Record<string, unknown>;
  created_at: string;
}

/** A log entry recording a memory extraction run against a session transcript. */
export interface ExtractionLog {
  id: string;
  project_path: string;
  session_id: string;
  event_type: string;
  chunks_processed: number;
  memories_extracted: number;
  bytes_processed: number;
  created_at: string;
}

/** Discriminated union of items extracted from a session transcript. */
export type ExtractedItem =
  | {
      type: "memory";
      memory_type: MemoryType;
      content: string;
      tags: string[];
    }
  | {
      type: "dead_end";
      summary: string;
      approach_tried: string;
      blocker: string;
    }
  | {
      type: "constraint";
      rule: string;
      constraint_type: ConstraintType;
      severity: ConstraintSeverity;
    }
  | {
      type: "insight";
      content: string;
      category: InsightCategory;
    };
