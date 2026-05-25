export const ACTIVE_SYNC_RUN_POLL_MS = 2000;
export const SYNC_RUN_COOLDOWN_POLL_MS = 5000;
export const IDLE_SYNC_RUN_POLL_MS = 60000;
export const HIDDEN_SYNC_RUN_POLL_MS = 60000;
export const MAX_SYNC_RUN_ERROR_POLL_MS = 30000;

export const SYNC_RUN_LEADER_ELECTION_MS = 250;
export const SYNC_RUN_LEADER_CHECK_MS = 3000;
export const SYNC_RUN_LEADER_HEARTBEAT_MS = 2000;
export const SYNC_RUN_LEADER_STALE_MS = 5000;
export const CONNECTOR_SYNC_RUN_CHANNEL_PREFIX =
  "sourceweft:connector-sync-runs";

export type ConnectorSyncRunPollMode =
  | "active"
  | "cooldown"
  | "error"
  | "hidden"
  | "idle";

export type ConnectorSyncRunPollState = {
  errorCount: number;
  hasActiveRuns: boolean;
  isVisible: boolean;
  needsCooldownConfirmation: boolean;
};

export type ConnectorSyncRunPollDecision = {
  delayMs: number;
  mode: ConnectorSyncRunPollMode;
};

export function getConnectorSyncRunErrorDelay(errorCount: number) {
  if (errorCount <= 1) return 5000;
  if (errorCount === 2) return 10000;
  return MAX_SYNC_RUN_ERROR_POLL_MS;
}

export function getConnectorSyncRunPollDecision(
  state: ConnectorSyncRunPollState,
): ConnectorSyncRunPollDecision {
  if (!state.isVisible) {
    return { delayMs: HIDDEN_SYNC_RUN_POLL_MS, mode: "hidden" };
  }
  if (state.errorCount > 0) {
    return {
      delayMs: getConnectorSyncRunErrorDelay(state.errorCount),
      mode: "error",
    };
  }
  if (state.hasActiveRuns) {
    return { delayMs: ACTIVE_SYNC_RUN_POLL_MS, mode: "active" };
  }
  if (state.needsCooldownConfirmation) {
    return { delayMs: SYNC_RUN_COOLDOWN_POLL_MS, mode: "cooldown" };
  }
  return { delayMs: IDLE_SYNC_RUN_POLL_MS, mode: "idle" };
}

export type ConnectorSyncRunLeaderCandidate = {
  id: string;
  lastSeenAt: number;
  visible: boolean;
};

export function selectConnectorSyncRunLeader(
  candidates: ConnectorSyncRunLeaderCandidate[],
  now: number,
  staleMs = SYNC_RUN_LEADER_STALE_MS,
) {
  return candidates
    .filter(
      (candidate) =>
        candidate.visible && now - candidate.lastSeenAt <= staleMs,
    )
    .map((candidate) => candidate.id)
    .sort()
    .at(0);
}
