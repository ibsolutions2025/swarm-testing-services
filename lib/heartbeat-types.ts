// Shape of system_heartbeats rows flowing through
// /api/test-results/heartbeats into the Operations tab.

export type HeartbeatComponent =
  | "swarm-drain"
  | "swarm-create"
  | "sts-scanner";

export interface Heartbeat {
  id: string;
  project_id: string;
  component: string;
  ran_at: string;
  outcome: string | null;
  actions_count: number | null;
  note: string | null;
  meta: Record<string, unknown> | null;
}

export interface HeartbeatComponentState {
  last: Heartbeat | null;
  count24h: number;
}

export interface HeartbeatsResponse {
  components: Record<HeartbeatComponent, HeartbeatComponentState>;
  table_missing?: boolean;
}

// Expected cadence in seconds per component — drives the green/amber/red
// health coloring in the HeartbeatCard.
export const EXPECTED_CADENCE_SEC: Record<HeartbeatComponent, number> = {
  "swarm-drain": 5 * 60,
  "swarm-create": 15 * 60,
  "sts-scanner": 15 * 60
};

export const HEARTBEAT_COMPONENTS: HeartbeatComponent[] = [
  "swarm-drain",
  "swarm-create",
  "sts-scanner"
];
