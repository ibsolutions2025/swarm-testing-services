// Shared types for lifecycle_results rows flowing from STS Supabase
// through /api/test-results/lifecycle into the Matrix and Transactions
// tabs. Mirrors supabase/migrations/0002_sts_ownership.sql.

import type { LifecycleStatus } from "./constants";

export interface LifecycleStep {
  step: number;
  name: string;
  status: string;
  duration_ms?: number;
  details?: Record<string, unknown>;
  assertions?: Array<{ check: string; passed: boolean }>;
  error?: { message: string; context: string };
}

export interface LifecycleWallets {
  employer?: { address: string; name?: string };
  workers?: Array<{ address: string; name?: string }>;
  validators?: Array<{ address: string; name?: string }>;
  actor_map?: Record<string, unknown>;
}

export interface AgentWalletsFlat {
  poster?: string;
  worker?: string;
  validator?: string;
  actor_map?: Record<string, unknown>;
}

export interface LifecycleResult {
  id: string;
  project_id: string;
  run_id: string;
  config_key: string;
  scenario_key: string;
  status: LifecycleStatus;
  steps: LifecycleStep[];
  wallets?: LifecycleWallets | null;
  // Scanner writes agent_wallets as a flat object; some older rows may
  // have it as a JSONB array of wallet strings. Accept both.
  agent_wallets?: AgentWalletsFlat | string[] | null;
  job_id?: string | null;
  onchain_job_id?: number | null;
  started_at: string;
  completed_at?: string | null;
  duration_ms?: number | null;
  error_message?: string | null;
  current_step?: string | null;
  step_audits?: unknown;
  cell_audit?: unknown;
  created_at?: string;
  updated_at?: string;
}

export interface LifecycleListResponse {
  results: LifecycleResult[];
  matrix: {
    configs: string[];
    scenarios: string[];
    cells: Record<
      string,
      {
        status: string;
        jobCount: number;
        passedCount: number;
        latestJobId: number | null;
      }
    >;
  };
  meta: {
    count: number;
    limit: number;
    projectId: string;
    filters?: Record<string, unknown>;
    note?: string;
  };
  table_missing?: boolean;
}
