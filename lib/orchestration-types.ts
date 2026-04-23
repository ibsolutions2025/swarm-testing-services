// Shape of orchestration_events rows flowing through
// /api/test-results/orchestration into the Operations tab.

export type OrchestrationSource =
  | "swarm-drain"
  | "swarm-create"
  | "sts-scanner";

export type OrchestrationEventType =
  | "scan"
  | "decision"
  | "dispatch"
  | "skip"
  | "error";

export interface OrchestrationEvent {
  id: string;
  project_id: string;
  ran_at: string;
  cycle_id: string;
  source: OrchestrationSource | string;
  event_type: OrchestrationEventType | string;
  persona?: string | null;
  job_id?: number | null;
  directive?: string | null;
  reasoning?: string | null;
  tx_hash?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface OrchestrationResponse {
  events: OrchestrationEvent[];
  table_missing?: boolean;
}
