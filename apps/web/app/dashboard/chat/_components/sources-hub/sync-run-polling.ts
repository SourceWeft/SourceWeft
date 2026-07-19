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

export const SOURCE_SYNC_UPDATED_AFTER_OVERLAP_MS = 1000;

export type ActiveConnectorSyncRun = {
  connectorId: string;
  discoveredCount: number;
  indexedCount: number;
  failedCount: number;
  lastSourceUpdatedAt: string | null;
  hasFinalRefreshed: boolean;
};

/**
 * When re-fetching a connector's sources incrementally we ask for everything
 * updated after the newest source we have already seen, minus a small overlap
 * so a source updated in the same millisecond as the watermark is not skipped.
 */
export function getIncrementalUpdatedAfter(
  value: string | null,
  overlapMs = SOURCE_SYNC_UPDATED_AFTER_OVERLAP_MS,
) {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(Math.max(0, timestamp - overlapMs)).toISOString();
}

export type ConnectorSyncRunResultItem = {
  id: string;
  connectorId: string | null;
  discoveredCount: number;
  indexedCount: number;
  failedCount: number;
};

export type ConnectorSyncRunPlan = {
  /** Tracked map after ingesting the poll's counts and registering new runs. */
  nextTracked: Map<string, ActiveConnectorSyncRun>;
  /** Runs whose sources should be re-fetched incrementally this poll. */
  incrementalTargets: Array<{
    runId: string;
    connectorId: string;
    updatedAfter: string | undefined;
  }>;
  /** Tracked runs that are no longer active and have not been finalised yet. */
  completedRunIds: string[];
  /** Connectors whose full source tree should be re-fetched (run finished). */
  finalRefreshConnectorIds: string[];
  /** Whether the next poll should confirm the connectors have cooled down. */
  needsCooldownConfirmation: boolean;
};

/**
 * Pure decision core of the connector sync-run poll handler: given a poll
 * result and the currently-tracked runs, decide what to fetch, which runs
 * completed, which connectors need a final refresh, and the next cooldown
 * state. All I/O (listing sources, merging, refreshing connectors, advancing
 * watermarks) stays in the hook.
 */
export function planConnectorSyncRunResult(
  items: ConnectorSyncRunResultItem[],
  tracked: ReadonlyMap<string, ActiveConnectorSyncRun>,
  overlapMs = SOURCE_SYNC_UPDATED_AFTER_OVERLAP_MS,
): ConnectorSyncRunPlan {
  const activeRunIds = new Set(items.map((run) => run.id));
  const nextTracked = new Map(tracked);
  const incrementalTargets: ConnectorSyncRunPlan["incrementalTargets"] = [];

  for (const run of items) {
    const connectorId = run.connectorId;
    if (!connectorId) {
      continue;
    }
    const prior = nextTracked.get(run.id) ?? {
      connectorId,
      discoveredCount: 0,
      indexedCount: 0,
      failedCount: 0,
      lastSourceUpdatedAt: null,
      hasFinalRefreshed: false,
    };
    const countsChanged =
      run.discoveredCount !== prior.discoveredCount ||
      run.indexedCount !== prior.indexedCount ||
      run.failedCount !== prior.failedCount;
    nextTracked.set(run.id, {
      ...prior,
      connectorId,
      discoveredCount: run.discoveredCount,
      indexedCount: run.indexedCount,
      failedCount: run.failedCount,
    });

    if (!countsChanged && prior.lastSourceUpdatedAt !== null) {
      continue;
    }
    incrementalTargets.push({
      runId: run.id,
      connectorId,
      updatedAfter: getIncrementalUpdatedAfter(prior.lastSourceUpdatedAt, overlapMs),
    });
  }

  const completedEntries = Array.from(nextTracked.entries()).filter(
    ([runId, entry]) => !activeRunIds.has(runId) && !entry.hasFinalRefreshed,
  );
  const completedRunIds = completedEntries.map(([runId]) => runId);

  const completedConnectorIds = new Set(
    completedEntries
      .map(([, entry]) => entry.connectorId)
      .filter((connectorId): connectorId is string => Boolean(connectorId)),
  );
  const activeConnectorIds = new Set(
    items
      .map((run) => run.connectorId)
      .filter((connectorId): connectorId is string => Boolean(connectorId)),
  );
  const finalRefreshConnectorIds = Array.from(completedConnectorIds).filter(
    (connectorId) => !activeConnectorIds.has(connectorId),
  );

  const needsCooldownConfirmation =
    items.length === 0 && completedRunIds.length > 0;

  return {
    nextTracked,
    incrementalTargets,
    completedRunIds,
    finalRefreshConnectorIds,
    needsCooldownConfirmation,
  };
}
