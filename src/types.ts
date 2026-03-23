// Memory types
export type MemoryType =
  | "architecture"
  | "decision"
  | "pattern"
  | "gotcha"
  | "progress"
  | "context";
export type MemoryStatus = "active" | "archived" | "superseded";

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

// Dead end types
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

// Constraint types
export type ConstraintType =
  | "security"
  | "performance"
  | "compliance"
  | "convention";
export type ConstraintSeverity = "must" | "should" | "prefer";

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

// Goal types
export type GoalStatus = "active" | "completed" | "paused";

export interface Goal {
  id: string;
  project_path: string;
  intent: string;
  done_when: string[];
  status: GoalStatus;
  created_at: string;
  updated_at: string;
}

// Checkpoint types
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

// Insight types
export type InsightCategory =
  | "decision"
  | "workflow"
  | "architecture"
  | "surprise"
  | "cost";

export interface Insight {
  id: string;
  project_path: string;
  content: string;
  context: string | null;
  category: InsightCategory;
  created_at: string;
}

// Daily summary types
export interface DailySummary {
  id: string;
  project_path: string;
  date: string;
  summary: Record<string, unknown>;
  created_at: string;
}

// Extraction log types
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

// Discriminated union for extracted items
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
