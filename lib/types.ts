// Shared types for Swarm Testing Services.
// Mirrors the Supabase schema defined in supabase/migrations/.

export type CampaignStatus =
  | "queued"
  | "designing"
  | "generating_personas"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RunOutcome = "pass" | "fail" | "partial" | "skipped" | "error";

export interface Campaign {
  id: string;
  user_id: string;
  url: string;
  description: string;
  status: CampaignStatus;
  created_at: string;
  updated_at?: string;
  matrix_id?: string | null;
  error?: string | null;
}

export interface Matrix {
  id: string;
  campaign_id: string;
  rows: MatrixRow[];
  columns: MatrixColumn[];
  created_at: string;
}

export interface MatrixRow {
  id: string;
  label: string; // e.g. "Free tier, mobile web"
  config: Record<string, unknown>; // feature-flag / env / tier
}

export interface MatrixColumn {
  id: string;
  label: string; // e.g. "New user signup"
  scenario: string; // longer description of the agentic scenario
  success_criteria: string[];
}

export interface Persona {
  id: string;
  campaign_id: string;
  matrix_row_id: string;
  name: string;
  archetype: string; // "busy-parent", "skeptical-power-user", etc.
  goals: string[];
  biases: string[];
  soul_md: string; // full SOUL.md text — persona's inner monologue + vibe
  created_at: string;
}

export interface Run {
  id: string;
  campaign_id: string;
  matrix_row_id: string;
  matrix_column_id: string;
  persona_id: string;
  outcome: RunOutcome;
  transcript: RunTranscriptTurn[];
  quote: string | null; // one-line failure quote, if any
  duration_ms: number;
  created_at: string;
}

export interface RunTranscriptTurn {
  role: "persona" | "observer" | "system";
  text: string;
  ts: string; // ISO timestamp
}

export interface CampaignResults {
  campaign: Campaign;
  matrix: Matrix | null;
  personas: Persona[];
  runs: Run[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    partial: number;
    error: number;
  };
}

export interface OrchestratorWebhookPayload {
  campaign_id: string;
  phase:
    | "matrix_designed"
    | "personas_generated"
    | "run_completed"
    | "campaign_completed"
    | "campaign_failed";
  data?: unknown;
}
