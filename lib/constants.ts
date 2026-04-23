// Shared constants.

export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  designing: "Designing matrix",
  generating_personas: "Generating personas",
  running: "Running swarm",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled"
};

export const CAMPAIGN_STATUS_COLORS: Record<string, string> = {
  queued: "bg-white/10 text-white",
  designing: "bg-accent/20 text-accent",
  generating_personas: "bg-accent/20 text-accent",
  running: "bg-accent/20 text-accent",
  completed: "bg-emerald-500/20 text-emerald-300",
  failed: "bg-red-500/20 text-red-300",
  cancelled: "bg-zinc-500/20 text-zinc-300"
};

export const RUN_OUTCOME_COLORS: Record<string, string> = {
  // Original MVP `runs.outcome` enum (pass/fail/partial/skipped/error).
  pass: "bg-emerald-500/30 border-emerald-400/50",
  fail: "bg-red-500/30 border-red-400/50",
  partial: "bg-amber-500/30 border-amber-400/50",
  skipped: "bg-zinc-500/20 border-zinc-400/30",
  error: "bg-fuchsia-500/30 border-fuchsia-400/50",
  // STS `lifecycle_results.status` enum (passed/failed/running + shared).
  passed: "bg-emerald-500/30 border-emerald-400/50",
  failed: "bg-red-500/30 border-red-400/50",
  running: "bg-blue-500/30 border-blue-400/50"
};

// Ordered list for consistent filter UI and aggregate counters.
export const LIFECYCLE_STATUSES = [
  "passed",
  "failed",
  "partial",
  "running",
  "skipped",
  "error"
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

// MVP sizing caps — keep cheap until billing is wired.
export const MAX_ROWS_PER_MATRIX = 5;
export const MAX_COLUMNS_PER_MATRIX = 6;
export const MAX_RUNS_PER_CAMPAIGN = MAX_ROWS_PER_MATRIX * MAX_COLUMNS_PER_MATRIX;
