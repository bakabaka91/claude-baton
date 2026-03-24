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
  plan_reference: string | null;
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
