import { useCallback, useEffect, useRef } from "react";

import { connectorsClient, contentClient } from "../../../../../lib/sdk";
import type { SourceItem } from "../source-types";
import { mapSourcesToUi } from "./source-mapping";
import {
  ACTIVE_SYNC_RUN_POLL_MS,
  CONNECTOR_SYNC_RUN_CHANNEL_PREFIX,
  SYNC_RUN_LEADER_CHECK_MS,
  SYNC_RUN_LEADER_ELECTION_MS,
  SYNC_RUN_LEADER_HEARTBEAT_MS,
  type ActiveConnectorSyncRun,
  type ConnectorSyncRunLeaderCandidate,
  getConnectorSyncRunPollDecision,
  planConnectorSyncRunResult,
  selectConnectorSyncRunLeader,
} from "./sync-run-polling";

/**
 * Injectable timer + clock surface for the polling engine. Defaults to the real
 * `window` timers and `Date.now`; tests pass a fake to drive the engine
 * deterministically.
 */
export type SyncRunScheduler = {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  now: () => number;
};

const defaultScheduler: SyncRunScheduler = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id),
  now: () => Date.now(),
};

type WorkspaceConnectorSyncRunsResult = Awaited<
  ReturnType<typeof connectorsClient.listWorkspaceSyncRuns>
>;

type ConnectorSyncRunBroadcastMessage =
  | {
      type: "hello" | "leader-heartbeat";
      tabId: string;
      visible: boolean;
      sentAt: number;
    }
  | {
      type: "sync-runs-result";
      tabId: string;
      sentAt: number;
      result: WorkspaceConnectorSyncRunsResult;
    }
  | {
      type: "sync-runs-wake";
      tabId: string;
      sentAt: number;
    };

export function isDocumentVisible() {
  return typeof document === "undefined"
    ? true
    : document.visibilityState !== "hidden";
}

function createSourcesHubTabId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function parseConnectorSyncRunBroadcastMessage(
  value: unknown,
): ConnectorSyncRunBroadcastMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<ConnectorSyncRunBroadcastMessage>;
  if (typeof message.type !== "string" || typeof message.tabId !== "string") {
    return null;
  }
  if (
    message.type !== "hello" &&
    message.type !== "leader-heartbeat" &&
    message.type !== "sync-runs-result" &&
    message.type !== "sync-runs-wake"
  ) {
    return null;
  }
  return value as ConnectorSyncRunBroadcastMessage;
}

export function useConnectorSyncRuns(input: {
  workspaceId: string | null | undefined;
  isPollingTab: boolean;
  mergeIncrementalSources: (mapped: SourceItem[]) => void;
  replaceConnectorSources: (
    batches: Array<{ connectorId: string; items: SourceItem[] }>,
  ) => void;
  refreshConnectors: () => void | Promise<void>;
  /** Omit to use real `window` timers + `Date.now`. */
  scheduler?: SyncRunScheduler;
  /**
   * Builds the cross-tab coordination channel. Return `null` to fully disable
   * cross-tab leader election (the engine then always acts as leader). Omit to
   * use the real `BroadcastChannel`.
   */
  channelFactory?: (name: string) => BroadcastChannel | null;
}): {
  trackConnectorSyncRun: (
    run:
      | {
          id: string;
          connectorId: string;
          discoveredCount: number;
          indexedCount: number;
          failedCount: number;
        }
      | null
      | undefined,
  ) => void;
} {
  const {
    workspaceId,
    isPollingTab,
    mergeIncrementalSources,
    replaceConnectorSources,
    refreshConnectors,
  } = input;

  // Injected timer/channel surfaces are held in refs so changing them never
  // re-runs the polling effect; the effect and callbacks read `.current`.
  const schedulerRef = useRef<SyncRunScheduler>(
    input.scheduler ?? defaultScheduler,
  );
  schedulerRef.current = input.scheduler ?? defaultScheduler;
  const channelFactoryRef = useRef<
    ((name: string) => BroadcastChannel | null) | undefined
  >(input.channelFactory);
  channelFactoryRef.current = input.channelFactory;

  const activeSyncRunsRef = useRef<Map<string, ActiveConnectorSyncRun>>(
    new Map(),
  );
  const syncRunPollTimerRef = useRef<number | null>(null);
  const syncRunLeaderTimerRef = useRef<number | null>(null);
  const syncRunHeartbeatTimerRef = useRef<number | null>(null);
  const syncRunPollInFlightRef = useRef(false);
  const syncRunPollErrorCountRef = useRef(0);
  const syncRunNeedsCooldownConfirmationRef = useRef(false);
  const syncRunPollStoppedRef = useRef(false);
  const syncRunLeaderCandidatesRef = useRef<
    Map<string, ConnectorSyncRunLeaderCandidate>
  >(new Map());
  const syncRunIsLeaderRef = useRef(false);
  const syncRunChannelRef = useRef<BroadcastChannel | null>(null);
  const requestSyncRunPollRef = useRef<((delayMs?: number) => void) | null>(
    null,
  );
  const sourcesHubTabIdRef = useRef<string | null>(null);
  if (sourcesHubTabIdRef.current === null) {
    sourcesHubTabIdRef.current = createSourcesHubTabId();
  }

  const trackConnectorSyncRun = useCallback(
    (
      run:
        | {
            id: string;
            connectorId: string;
            discoveredCount: number;
            indexedCount: number;
            failedCount: number;
          }
        | null
        | undefined,
    ) => {
      if (!run) {
        return;
      }
      activeSyncRunsRef.current.set(run.id, {
        connectorId: run.connectorId,
        discoveredCount: run.discoveredCount,
        indexedCount: run.indexedCount,
        failedCount: run.failedCount,
        lastSourceUpdatedAt: null,
        hasFinalRefreshed: false,
      });
      syncRunNeedsCooldownConfirmationRef.current = false;
      syncRunPollErrorCountRef.current = 0;
      requestSyncRunPollRef.current?.(0);
      const tabId = sourcesHubTabIdRef.current ?? createSourcesHubTabId();
      sourcesHubTabIdRef.current = tabId;
      syncRunChannelRef.current?.postMessage({
        type: "sync-runs-wake",
        tabId,
        sentAt: schedulerRef.current.now(),
      } satisfies ConnectorSyncRunBroadcastMessage);
    },
    [],
  );

  useEffect(() => {
    const scheduler = schedulerRef.current;
    const channelFactory = channelFactoryRef.current;
    if (!workspaceId) {
      activeSyncRunsRef.current.clear();
      syncRunNeedsCooldownConfirmationRef.current = false;
      syncRunPollErrorCountRef.current = 0;
      return;
    }

    const activeWorkspaceId = workspaceId;
    const tabId = sourcesHubTabIdRef.current ?? createSourcesHubTabId();
    sourcesHubTabIdRef.current = tabId;
    const leaderCandidates = syncRunLeaderCandidatesRef.current;
    let cancelled = false;
    syncRunPollStoppedRef.current = false;

    function clearPollTimer() {
      if (syncRunPollTimerRef.current !== null) {
        scheduler.clearTimeout(syncRunPollTimerRef.current);
        syncRunPollTimerRef.current = null;
      }
    }

    function clearHeartbeatTimer() {
      if (syncRunHeartbeatTimerRef.current !== null) {
        scheduler.clearInterval(syncRunHeartbeatTimerRef.current);
        syncRunHeartbeatTimerRef.current = null;
      }
    }

    function postSyncRunMessage(message: ConnectorSyncRunBroadcastMessage) {
      syncRunChannelRef.current?.postMessage(message);
    }

    function updateSelfLeaderCandidate() {
      leaderCandidates.set(tabId, {
        id: tabId,
        lastSeenAt: scheduler.now(),
        visible: isDocumentVisible() && isPollingTab,
      });
    }

    function startLeaderHeartbeat() {
      if (syncRunHeartbeatTimerRef.current !== null) {
        return;
      }
      postSyncRunMessage({
        type: "leader-heartbeat",
        tabId,
        visible: isDocumentVisible(),
        sentAt: scheduler.now(),
      });
      syncRunHeartbeatTimerRef.current = scheduler.setInterval(() => {
        if (cancelled || !syncRunIsLeaderRef.current || !isDocumentVisible()) {
          return;
        }
        postSyncRunMessage({
          type: "leader-heartbeat",
          tabId,
          visible: true,
          sentAt: scheduler.now(),
        });
      }, SYNC_RUN_LEADER_HEARTBEAT_MS);
    }

    function setSyncRunLeader(value: boolean) {
      if (syncRunIsLeaderRef.current === value) {
        return;
      }
      syncRunIsLeaderRef.current = value;
      if (value) {
        startLeaderHeartbeat();
        requestSyncRunPollRef.current?.(0);
      } else {
        clearHeartbeatTimer();
      }
    }

    function electSyncRunLeader() {
      updateSelfLeaderCandidate();
      const leaderId = selectConnectorSyncRunLeader(
        Array.from(leaderCandidates.values()),
        scheduler.now(),
      );
      setSyncRunLeader(leaderId === tabId);
    }

    function requestSyncRunPoll(delayMs = 0) {
      if (
        cancelled ||
        syncRunPollStoppedRef.current ||
        !isPollingTab ||
        (syncRunChannelRef.current && !syncRunIsLeaderRef.current)
      ) {
        return;
      }
      clearPollTimer();
      syncRunPollTimerRef.current = scheduler.setTimeout(() => {
        syncRunPollTimerRef.current = null;
        void pollActiveSyncRuns();
      }, delayMs);
    }

    requestSyncRunPollRef.current = requestSyncRunPoll;

    function scheduleNextSyncRunPoll() {
      const decision = getConnectorSyncRunPollDecision({
        errorCount: syncRunPollErrorCountRef.current,
        hasActiveRuns: activeSyncRunsRef.current.size > 0,
        isVisible: isDocumentVisible(),
        needsCooldownConfirmation: syncRunNeedsCooldownConfirmationRef.current,
      });
      requestSyncRunPoll(decision.delayMs);
    }

    async function handleSyncRunResult(
      result: WorkspaceConnectorSyncRunsResult,
    ) {
      if (cancelled) {
        return;
      }

      // Pure decision core: what to fetch, which runs completed, which
      // connectors to final-refresh, and the next cooldown state.
      const plan = planConnectorSyncRunResult(
        result.items,
        activeSyncRunsRef.current,
      );
      activeSyncRunsRef.current = plan.nextTracked;

      const incrementalRequests = plan.incrementalTargets.map((target) =>
        contentClient
          .listSources(activeWorkspaceId, {
            view: "tree",
            connectorId: target.connectorId,
            syncRunId: target.runId,
            ...(target.updatedAfter
              ? { updatedAfter: target.updatedAfter }
              : {}),
          })
          .then((sourcesResult) => {
            const mapped = mapSourcesToUi(sourcesResult.items);
            const newestUpdatedAt = sourcesResult.items
              .map((item) => item.updatedAt)
              .filter(Boolean)
              .sort()
              .at(-1);
            const current = activeSyncRunsRef.current.get(target.runId);
            if (current && newestUpdatedAt) {
              activeSyncRunsRef.current.set(target.runId, {
                ...current,
                lastSourceUpdatedAt: newestUpdatedAt,
              });
            }
            return mapped;
          })
          .catch((): SourceItem[] => []),
      );

      if (incrementalRequests.length > 0) {
        const batches = await Promise.all(incrementalRequests);
        if (!cancelled) {
          mergeIncrementalSources(batches.flat());
        }
      }

      if (plan.completedRunIds.length > 0) {
        const finalRefreshes = plan.finalRefreshConnectorIds.map(
          (connectorId) =>
            contentClient
              .listSources(activeWorkspaceId, {
                view: "tree",
                connectorId,
              })
              .then((sourcesResult) => ({
                connectorId,
                items: mapSourcesToUi(sourcesResult.items),
              }))
              .catch(() => ({ connectorId, items: [] as SourceItem[] })),
        );
        for (const runId of plan.completedRunIds) {
          const tracked = activeSyncRunsRef.current.get(runId);
          if (tracked) {
            activeSyncRunsRef.current.set(runId, {
              ...tracked,
              hasFinalRefreshed: true,
            });
          }
        }
        if (finalRefreshes.length > 0) {
          const batches = await Promise.all(finalRefreshes);
          if (!cancelled) {
            replaceConnectorSources(batches);
          }
        }
        for (const runId of plan.completedRunIds) {
          activeSyncRunsRef.current.delete(runId);
        }
        if (!cancelled) {
          void refreshConnectors();
        }
      }

      syncRunNeedsCooldownConfirmationRef.current =
        plan.needsCooldownConfirmation;
    }

    async function pollActiveSyncRuns() {
      if (cancelled || !isPollingTab || syncRunPollStoppedRef.current) {
        return;
      }
      if (!isDocumentVisible()) {
        scheduleNextSyncRunPoll();
        return;
      }
      if (syncRunChannelRef.current && !syncRunIsLeaderRef.current) {
        return;
      }
      if (syncRunPollInFlightRef.current) {
        requestSyncRunPoll(ACTIVE_SYNC_RUN_POLL_MS);
        return;
      }

      syncRunPollInFlightRef.current = true;
      try {
        const result = await connectorsClient.listWorkspaceSyncRuns(
          activeWorkspaceId,
          {
            status: "active",
          },
        );
        if (cancelled) {
          return;
        }
        syncRunPollErrorCountRef.current = 0;
        postSyncRunMessage({
          type: "sync-runs-result",
          tabId,
          sentAt: scheduler.now(),
          result,
        });
        await handleSyncRunResult(result);
      } catch {
        syncRunPollErrorCountRef.current += 1;
        // The regular connector/source refresh surfaces visible errors.
      } finally {
        syncRunPollInFlightRef.current = false;
        if (!cancelled) {
          scheduleNextSyncRunPoll();
        }
      }
    }

    if (!isPollingTab) {
      return () => {
        requestSyncRunPollRef.current = null;
      };
    }

    function handleVisibilityChange() {
      updateSelfLeaderCandidate();
      postSyncRunMessage({
        type: "hello",
        tabId,
        visible: isDocumentVisible(),
        sentAt: scheduler.now(),
      });
      electSyncRunLeader();
      if (!isDocumentVisible()) {
        clearPollTimer();
        setSyncRunLeader(false);
        return;
      }
      if (syncRunIsLeaderRef.current) {
        requestSyncRunPoll(0);
      }
    }

    const channelName = `${CONNECTOR_SYNC_RUN_CHANNEL_PREFIX}:${activeWorkspaceId}`;
    const channel = channelFactory
      ? channelFactory(channelName)
      : typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(channelName)
        : null;

    if (channel) {
      try {
        syncRunChannelRef.current = channel;
        channel.onmessage = (event: MessageEvent) => {
          const message = parseConnectorSyncRunBroadcastMessage(event.data);
          if (!message || message.tabId === tabId) {
            return;
          }
          if (message.type === "hello" || message.type === "leader-heartbeat") {
            leaderCandidates.set(message.tabId, {
              id: message.tabId,
              lastSeenAt: message.sentAt,
              visible: message.visible,
            });
            electSyncRunLeader();
            return;
          }
          if (message.type === "sync-runs-result") {
            syncRunPollErrorCountRef.current = 0;
            void handleSyncRunResult(message.result);
            return;
          }
          if (message.type === "sync-runs-wake") {
            if (syncRunIsLeaderRef.current) {
              requestSyncRunPoll(0);
            }
          }
        };
        updateSelfLeaderCandidate();
        postSyncRunMessage({
          type: "hello",
          tabId,
          visible: isDocumentVisible(),
          sentAt: scheduler.now(),
        });
        const electionTimer = scheduler.setTimeout(() => {
          electSyncRunLeader();
        }, SYNC_RUN_LEADER_ELECTION_MS);
        syncRunLeaderTimerRef.current = scheduler.setInterval(() => {
          electSyncRunLeader();
        }, SYNC_RUN_LEADER_CHECK_MS);
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", handleVisibilityChange);
        }
        return () => {
          cancelled = true;
          syncRunPollStoppedRef.current = true;
          scheduler.clearTimeout(electionTimer);
          clearPollTimer();
          clearHeartbeatTimer();
          if (syncRunLeaderTimerRef.current !== null) {
            scheduler.clearInterval(syncRunLeaderTimerRef.current);
            syncRunLeaderTimerRef.current = null;
          }
          if (typeof document !== "undefined") {
            document.removeEventListener(
              "visibilitychange",
              handleVisibilityChange,
            );
          }
          channel.close();
          syncRunChannelRef.current = null;
          syncRunIsLeaderRef.current = false;
          leaderCandidates.clear();
          if (requestSyncRunPollRef.current === requestSyncRunPoll) {
            requestSyncRunPollRef.current = null;
          }
        };
      } catch {
        syncRunChannelRef.current = null;
      }
    }

    syncRunIsLeaderRef.current = true;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    requestSyncRunPoll(0);
    return () => {
      cancelled = true;
      syncRunPollStoppedRef.current = true;
      clearPollTimer();
      clearHeartbeatTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
      syncRunIsLeaderRef.current = false;
      if (requestSyncRunPollRef.current === requestSyncRunPoll) {
        requestSyncRunPollRef.current = null;
      }
    };
  }, [
    isPollingTab,
    mergeIncrementalSources,
    replaceConnectorSources,
    refreshConnectors,
    workspaceId,
  ]);

  return { trackConnectorSyncRun };
}
