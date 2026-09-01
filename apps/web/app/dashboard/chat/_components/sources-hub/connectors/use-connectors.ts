import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  HttpClientError,
  type ConnectorActivityItem,
  type SourceConnector,
} from "@sourceweft/sdk";
import { connectorsClient } from "../../../../../../lib/sdk";
import {
  CONNECTOR_OAUTH_CHANNEL,
  CONNECTOR_OAUTH_STORAGE_KEY,
  parseConnectorOAuthCompletionMessage,
  type ConnectorOAuthCompletionMessage,
} from "../../../../connectors/oauth/_components/oauth-messaging";
import type { SourceItem } from "../../source-types";
import { getErrorMessage, isConnectorAlreadyHandledError } from "../lib/errors";
import {
  getCachedWorkspaceHubValue,
  setCachedWorkspaceHubValue,
} from "../workspace-hub-cache";
import { connectorCatalog } from "./catalog";
import {
  formatConnectorSchedule,
  getConnectorReadinessFromConfig,
} from "./components";
import { type ManageConnectorsTab } from "./manage-dialog";
import type {
  ConnectorAccountItem,
  ConnectorCatalogItem,
  ConnectorItem,
  ConnectorReadinessState,
  ConnectorWebhookConfig,
  ConnectorWebhookEventItem,
} from "./types";

const CONNECTOR_OAUTH_URL_PARAMS = [
  "connector_oauth",
  "connector_type",
  "account_id",
  "workspace_id",
  "error",
] as const;

const WORKSPACE_CONNECTORS_CACHE_BUCKET = "connectors";

type WorkspaceConnectorsCacheValue = {
  accounts: ConnectorAccountItem[];
  connectors: ConnectorItem[];
  webhookConfigsById: Record<string, ConnectorWebhookConfig | null>;
  webhookEventsById: Record<string, ConnectorWebhookEventItem[]>;
};

export type TrackConnectorSyncRun = (
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

function createConnectorOAuthMessageId(input: {
  workspaceId: string;
  connectorType: string;
  accountId: string | null;
  status: "success" | "error";
}) {
  return [
    "url",
    input.workspaceId,
    input.connectorType,
    input.accountId ?? "none",
    input.status,
  ].join(":");
}

function readConnectorOAuthCompletionFromUrl(): ConnectorOAuthCompletionMessage | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const status = url.searchParams.get("connector_oauth");
  if (status !== "success" && status !== "error") return null;

  const workspaceId = url.searchParams.get("workspace_id") ?? "";
  const connectorType = url.searchParams.get("connector_type") ?? "";
  const accountId = url.searchParams.get("account_id");
  return {
    id: createConnectorOAuthMessageId({
      workspaceId,
      connectorType,
      accountId,
      status,
    }),
    workspaceId,
    connectorType,
    accountId,
    status,
    error:
      status === "error"
        ? (url.searchParams.get("error") ??
          "Connector authorization did not complete.")
        : null,
    createdAt: new Date().toISOString(),
  };
}

function clearConnectorOAuthCompletionFromUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of CONNECTOR_OAUTH_URL_PARAMS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function mapConnectorToUi(connector: SourceConnector): ConnectorItem {
  const lastSync = connector.lastIndexedAt
    ? `Last sync ${new Date(connector.lastIndexedAt).toLocaleString()}`
    : "Never synced";
  const schedule = formatConnectorSchedule(connector);
  return {
    id: connector.id,
    name: connector.name,
    status: connector.status,
    meta: `${connector.connectorType} · ${lastSync} · ${schedule}`,
    raw: connector,
  };
}

export function useConnectors(input: {
  workspaceId?: string | null;
  currentWorkspaceIdRef: { current: string | null | undefined };
  onConnectorsChange?: (connectors: SourceConnector[]) => void;
  trackConnectorSyncRun: TrackConnectorSyncRun;
  refreshSources: () => void | Promise<void>;
  sources: SourceItem[];
  manualConnectorSyncSourcesRef: {
    current: Map<string, { knownSourceIds: Set<string> }>;
  };
}) {
  const {
    workspaceId,
    currentWorkspaceIdRef,
    onConnectorsChange,
    trackConnectorSyncRun,
    refreshSources,
    sources,
    manualConnectorSyncSourcesRef,
  } = input;

  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [connectorAccounts, setConnectorAccounts] = useState<
    ConnectorAccountItem[]
  >([]);
  const [isLoadingConnectors, setIsLoadingConnectors] = useState(false);
  const [connectorsLoadingError, setConnectorsLoadingError] = useState<
    string | null
  >(null);
  const [connectorBusyById, setConnectorBusyById] = useState<
    Record<string, boolean>
  >({});
  const [connectorWaitingByType, setConnectorWaitingByType] = useState<
    Record<string, boolean>
  >({});
  const [isManageConnectorsOpen, setIsManageConnectorsOpen] = useState(false);
  const [manageConnectorsInitialTab, setManageConnectorsInitialTab] =
    useState<ManageConnectorsTab>("all");
  const [connectorReadinessById, setConnectorReadinessById] = useState<
    Record<string, ConnectorReadinessState>
  >({});
  const [pendingDisconnectConnector, setPendingDisconnectConnector] =
    useState<ConnectorItem | null>(null);
  const [disconnectConnectorHardDelete, setDisconnectConnectorHardDelete] =
    useState(false);
  const [connectorWebhookEventsById, setConnectorWebhookEventsById] = useState<
    Record<string, ConnectorWebhookEventItem[]>
  >({});
  const [connectorWebhookConfigsById, setConnectorWebhookConfigsById] =
    useState<Record<string, ConnectorWebhookConfig | null>>({});
  const [connectorSettingsConnectorId, setConnectorSettingsConnectorId] =
    useState<string | null>(null);
  const [connectorSettingsActivity, setConnectorSettingsActivity] = useState<
    ConnectorActivityItem[]
  >([]);
  const [
    isLoadingConnectorSettingsActivity,
    setIsLoadingConnectorSettingsActivity,
  ] = useState(false);
  const [connectorSettingsActivityError, setConnectorSettingsActivityError] =
    useState<string | null>(null);

  const processedConnectorOAuthMessageIdsRef = useRef<Set<string>>(new Set());
  const ensureConnectorPromisesRef = useRef<
    Map<string, Promise<ConnectorItem | null>>
  >(new Map());
  const connectorWaitingStartedAtRef = useRef<Record<string, number>>({});

  const connectorSettingsConnector = useMemo(() => {
    if (!connectorSettingsConnectorId) return null;
    return (
      connectors.find(
        (connector) => connector.id === connectorSettingsConnectorId,
      ) ?? null
    );
  }, [connectorSettingsConnectorId, connectors]);

  const trackManualConnectorSync = useCallback(
    (connectorId: string) => {
      manualConnectorSyncSourcesRef.current.set(connectorId, {
        knownSourceIds: new Set(
          sources
            .filter((source) => source.connectorId === connectorId)
            .map((source) => source.id),
        ),
      });
    },
    [manualConnectorSyncSourcesRef, sources],
  );

  const refreshConnectors = useCallback(async () => {
    if (!workspaceId) {
      setConnectors([]);
      setConnectorAccounts([]);
      setConnectorWebhookEventsById({});
      setConnectorWebhookConfigsById({});
      setConnectorsLoadingError(null);
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingConnectors(true);
    setConnectorsLoadingError(null);
    try {
      const [result, accounts] = await Promise.all([
        connectorsClient.list(activeWorkspaceId, { includeDisabled: true }),
        connectorsClient.listAccounts(activeWorkspaceId),
      ]);
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }
      const uiConnectors = result.items.map(mapConnectorToUi);
      onConnectorsChange?.(result.items);
      setConnectorReadinessById((prev) => {
        const liveIds = new Set(uiConnectors.map((connector) => connector.id));
        let changed = false;
        const next: Record<string, ConnectorReadinessState> = {};
        for (const [id, state] of Object.entries(prev)) {
          if (liveIds.has(id)) {
            next[id] = state;
          } else {
            changed = true;
          }
        }
        for (const connector of uiConnectors) {
          const readiness = getConnectorReadinessFromConfig(connector.raw);
          if (readiness) {
            next[connector.id] = readiness;
            if (prev[connector.id]?.reason !== readiness.reason) {
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
      setConnectors(uiConnectors);
      setConnectorAccounts(accounts.items);
      const webhookConnectors = uiConnectors.filter((connector) => {
        const catalogItem = connectorCatalog.find(
          (item) => item.id === connector.raw.connectorType,
        );
        return connector.status !== "disabled" && catalogItem?.supportsWebhook;
      });
      const webhookResults = await Promise.allSettled(
        webhookConnectors.map(async (connector) => {
          const [webhookConfig, webhookEvents] = await Promise.allSettled([
            connectorsClient.getWebhookConfig(activeWorkspaceId, connector.id),
            connectorsClient.listWebhookEvents(activeWorkspaceId, {
              connectorType: connector.raw.connectorType,
              connectorId: connector.id,
            }),
          ]);
          return {
            connectorId: connector.id,
            webhookConfig:
              webhookConfig.status === "fulfilled" ? webhookConfig.value : null,
            webhookEvents:
              webhookEvents.status === "fulfilled"
                ? webhookEvents.value.items
                : [],
          };
        }),
      );
      const nextWebhookConfigs: Record<string, ConnectorWebhookConfig | null> =
        {};
      const nextWebhookEvents: Record<string, ConnectorWebhookEventItem[]> = {};
      for (const result of webhookResults) {
        if (result.status !== "fulfilled") {
          continue;
        }
        nextWebhookConfigs[result.value.connectorId] =
          result.value.webhookConfig;
        nextWebhookEvents[result.value.connectorId] =
          result.value.webhookEvents;
      }
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }
      setConnectorWebhookConfigsById(nextWebhookConfigs);
      setConnectorWebhookEventsById(nextWebhookEvents);
      setCachedWorkspaceHubValue<WorkspaceConnectorsCacheValue>(
        WORKSPACE_CONNECTORS_CACHE_BUCKET,
        activeWorkspaceId,
        {
          accounts: accounts.items,
          connectors: uiConnectors,
          webhookConfigsById: nextWebhookConfigs,
          webhookEventsById: nextWebhookEvents,
        },
      );
    } catch (error) {
      setConnectorsLoadingError(
        getErrorMessage(error, "Failed to load connectors."),
      );
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoadingConnectors(false);
      }
    }
  }, [currentWorkspaceIdRef, onConnectorsChange, workspaceId]);

  const refreshConnectorSettingsActivity = useCallback(
    async (connectorId?: string | null, options: { silent?: boolean } = {}) => {
      if (!workspaceId || !connectorId) {
        setConnectorSettingsActivity([]);
        setConnectorSettingsActivityError(null);
        setIsLoadingConnectorSettingsActivity(false);
        return;
      }

      if (!options.silent) {
        setIsLoadingConnectorSettingsActivity(true);
      }
      setConnectorSettingsActivityError(null);
      try {
        const result = await connectorsClient.listActivity(
          workspaceId,
          connectorId,
          { kind: "all", limit: 50 },
        );
        setConnectorSettingsActivity(result.items);
      } catch (error) {
        setConnectorSettingsActivity([]);
        setConnectorSettingsActivityError(
          getErrorMessage(error, "Failed to load connector activity."),
        );
      } finally {
        if (!options.silent) {
          setIsLoadingConnectorSettingsActivity(false);
        }
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    if (!workspaceId) {
      void refreshConnectors();
      return;
    }

    const cached = getCachedWorkspaceHubValue<WorkspaceConnectorsCacheValue>(
      WORKSPACE_CONNECTORS_CACHE_BUCKET,
      workspaceId,
    );
    if (cached) {
      setConnectors(cached.connectors);
      setConnectorAccounts(cached.accounts);
      setConnectorWebhookConfigsById(cached.webhookConfigsById);
      setConnectorWebhookEventsById(cached.webhookEventsById);
      setConnectorsLoadingError(null);
      setIsLoadingConnectors(false);
    }
    void refreshConnectors();
  }, [refreshConnectors, workspaceId]);

  useEffect(() => {
    if (!connectorSettingsConnectorId) {
      setConnectorSettingsActivity([]);
      setConnectorSettingsActivityError(null);
      setIsLoadingConnectorSettingsActivity(false);
      return;
    }

    void refreshConnectorSettingsActivity(connectorSettingsConnectorId);
  }, [connectorSettingsConnectorId, refreshConnectorSettingsActivity]);

  useEffect(() => {
    if (!connectorSettingsConnectorId) return;
    const hasLiveActivity = connectorSettingsActivity.some((item) =>
      ["queued", "running", "received"].includes(item.status),
    );
    if (!hasLiveActivity) return;

    const timer = window.setInterval(() => {
      void refreshConnectorSettingsActivity(connectorSettingsConnectorId, {
        silent: true,
      });
    }, 3000);

    return () => window.clearInterval(timer);
  }, [
    connectorSettingsActivity,
    connectorSettingsConnectorId,
    refreshConnectorSettingsActivity,
  ]);

  function setConnectorBusy(id: string, busy: boolean) {
    setConnectorBusyById((prev) => {
      if (busy) return { ...prev, [id]: true };
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function setConnectorWaiting(connectorType: string, waiting: boolean) {
    setConnectorWaitingByType((prev) => {
      if (waiting) {
        if (prev[connectorType]) return prev;
        return { ...prev, [connectorType]: true };
      }
      if (!prev[connectorType]) return prev;
      const next = { ...prev };
      delete next[connectorType];
      return next;
    });
  }

  const openConnectorSettings = useCallback((connector: ConnectorItem) => {
    setConnectorSettingsConnectorId(connector.id);
  }, []);

  const handleOpenConnectorSettingsById = useCallback(
    (connectorId: string) => {
      const connector = connectors.find((item) => item.id === connectorId);
      if (!connector) {
        toast.error("Connector settings are not available yet.");
        return;
      }
      openConnectorSettings(connector);
    },
    [connectors, openConnectorSettings],
  );

  const openManageConnectors = useCallback(
    (tab: ManageConnectorsTab = "all") => {
      setManageConnectorsInitialTab(tab);
      setIsManageConnectorsOpen(true);
    },
    [],
  );

  const markConnectorNotReady = useCallback(
    (connectorId: string, reason: string, message: string) => {
      setConnectorReadinessById((prev) => ({
        ...prev,
        [connectorId]: { reason, message },
      }));
    },
    [],
  );

  const clearConnectorReadiness = useCallback((connectorId: string) => {
    setConnectorReadinessById((prev) => {
      if (!prev[connectorId]) return prev;
      const next = { ...prev };
      delete next[connectorId];
      return next;
    });
  }, []);

  const handleConnectConnector = useCallback(
    (item: ConnectorCatalogItem) => {
      if (!workspaceId) {
        toast.error("No workspace selected yet.");
        return;
      }

      if (item.connectMode !== "oauth_connector") {
        toast.error(`${item.name} is not available for OAuth yet.`);
        return;
      }

      const startUrl = new URL(
        "/dashboard/connectors/oauth/start",
        window.location.origin,
      );
      startUrl.searchParams.set("workspace_id", workspaceId);
      startUrl.searchParams.set("connector_type", item.id);
      startUrl.searchParams.set("mode", "redirect");
      startUrl.searchParams.set("return_to", window.location.href);

      connectorWaitingStartedAtRef.current[item.id] = Date.now();
      setConnectorWaiting(item.id, true);
      openManageConnectors("all");
      toast.info(`Redirecting to ${item.name} authorization.`);
      window.location.assign(startUrl.toString());
    },
    [openManageConnectors, workspaceId],
  );

  const ensureConnector = useCallback(
    async (
      item: ConnectorCatalogItem,
      accountId?: string | null,
      options: { silentMissingAccount?: boolean } = {},
    ) => {
      if (!workspaceId) {
        return null;
      }
      if (item.connectMode !== "oauth_connector") {
        return null;
      }
      const current = connectors.find(
        (connector) =>
          connector.raw.connectorType === item.id &&
          connector.status !== "disabled",
      );
      if (current) {
        clearConnectorReadiness(current.id);
        setConnectorWaiting(item.id, false);
        return current;
      }

      if (item.postOAuthMode !== "auto_create") {
        await refreshConnectors();
        return null;
      }

      if (!accountId) {
        if (!options.silentMissingAccount) {
          toast.error(`Reconnect ${item.name} before creating a connector.`);
        }
        return null;
      }

      const requestKey = `${workspaceId}:${item.id}:${accountId}`;
      const existingRequest =
        ensureConnectorPromisesRef.current.get(requestKey);
      if (existingRequest) {
        return existingRequest;
      }

      const request = (async () => {
        setConnectorWaiting(item.id, true);
        try {
          const accounts = await connectorsClient.listAccounts(workspaceId, {
            connectorType: item.id,
          });
          const account = accounts.items.find((item) => item.id === accountId);
          if (!account) {
            if (!options.silentMissingAccount) {
              toast.error(
                `Reconnect ${item.name} before creating a connector.`,
              );
            }
            return null;
          }

          if (item.id !== "notion") {
            toast.info(`${item.name} is connected. Configure syncing next.`);
            await refreshConnectors();
            return null;
          }

          const created = await connectorsClient.create(workspaceId, {
            connectorType: "notion",
            name: account.displayName || "Notion",
            oauthAccountId: account.id,
            configJson: {
              includePages: true,
            },
            periodicIndexingEnabled: true,
            indexingFrequencyMinutes: 360,
          });
          const syncResult = await connectorsClient.sync(
            workspaceId,
            created.connector.id,
          );
          trackConnectorSyncRun(syncResult.run);
          trackManualConnectorSync(created.connector.id);
          if (syncResult.skipped) {
            markConnectorNotReady(
              created.connector.id,
              syncResult.reason ?? "connector_not_ready",
              syncResult.message ?? "Connector is not ready to sync.",
            );
            toast.info(syncResult.message ?? `${item.name} connected.`);
          } else if (syncResult.alreadyRunning) {
            toast.info(
              syncResult.message ?? `${item.name} sync is already running.`,
            );
          } else {
            clearConnectorReadiness(created.connector.id);
            toast.success(
              `${item.name} connector enabled. Initial sync queued.`,
            );
          }
          await refreshConnectors();
          return mapConnectorToUi(created.connector);
        } catch (error) {
          if (isConnectorAlreadyHandledError(error)) {
            await refreshConnectors();
            toast.success(`${item.name} connector is already connected.`);
            return null;
          }

          if (
            error instanceof HttpClientError &&
            error.code === "CONNECTOR_DISABLED_CONFLICT"
          ) {
            toast.error(
              "A disabled connector with this name already exists. Enable it or delete it before reconnecting.",
            );
          } else {
            toast.error(
              getErrorMessage(
                error,
                `Failed to enable ${item.name} connector.`,
              ),
            );
          }
          return null;
        } finally {
          setConnectorWaiting(item.id, false);
          ensureConnectorPromisesRef.current.delete(requestKey);
        }
      })();

      ensureConnectorPromisesRef.current.set(requestKey, request);
      return request;
    },
    [
      clearConnectorReadiness,
      connectors,
      markConnectorNotReady,
      refreshConnectors,
      trackConnectorSyncRun,
      trackManualConnectorSync,
      workspaceId,
    ],
  );

  const handleCreateConnector = useCallback(
    async (item: ConnectorCatalogItem) => {
      if (!workspaceId) {
        toast.error("No workspace selected yet.");
        return;
      }
      if (item.postOAuthMode === "auto_create") {
        handleConnectConnector(item);
        return;
      }
      await ensureConnector(item);
      openManageConnectors("all");
    },
    [
      ensureConnector,
      handleConnectConnector,
      openManageConnectors,
      workspaceId,
    ],
  );

  const handleConnectorOAuthCompletion = useCallback(
    (message: ConnectorOAuthCompletionMessage) => {
      if (!workspaceId || message.workspaceId !== workspaceId) {
        setConnectorWaiting(message.connectorType, false);
        return;
      }
      if (processedConnectorOAuthMessageIdsRef.current.has(message.id)) return;
      processedConnectorOAuthMessageIdsRef.current.add(message.id);

      const item = connectorCatalog.find(
        (candidate) => candidate.id === message.connectorType,
      );
      if (!item || item.connectMode !== "oauth_connector") {
        setConnectorWaiting(message.connectorType, false);
        return;
      }

      openManageConnectors("all");

      if (message.status === "error") {
        setConnectorWaiting(item.id, false);
        toast.error(message.error || `${item.name} authorization failed.`);
        void refreshConnectors();
        return;
      }

      if (item.postOAuthMode === "auto_create") {
        void ensureConnector(item, message.accountId);
        return;
      }

      setConnectorWaiting(item.id, false);
      toast.success(`${item.name} connected. Configure syncing next.`);
      void refreshConnectors();
    },
    [ensureConnector, openManageConnectors, refreshConnectors, workspaceId],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CONNECTOR_OAUTH_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const message = parseConnectorOAuthCompletionMessage(event.data);
        if (message) handleConnectorOAuthCompletion(message);
      };
    } catch {
      channel = null;
    }

    function handleStorage(event: StorageEvent) {
      if (event.key !== CONNECTOR_OAUTH_STORAGE_KEY || !event.newValue) return;
      try {
        const message = parseConnectorOAuthCompletionMessage(
          JSON.parse(event.newValue) as unknown,
        );
        if (message) handleConnectorOAuthCompletion(message);
      } catch {
        // Ignore malformed cross-tab messages.
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      channel?.close();
    };
  }, [handleConnectorOAuthCompletion]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const message = readConnectorOAuthCompletionFromUrl();
    if (!message) return;
    if (!workspaceId || message.workspaceId !== workspaceId) return;
    clearConnectorOAuthCompletionFromUrl();
    handleConnectorOAuthCompletion(message);
  }, [handleConnectorOAuthCompletion, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const activeWorkspaceId = workspaceId;
    const waitingTypes = Object.keys(connectorWaitingByType).filter(
      (value): value is string => Boolean(value),
    );
    if (waitingTypes.length === 0) return;

    function pollWaitingConnectors() {
      for (const connectorTypeValue of waitingTypes) {
        const connectorType = connectorTypeValue;
        const item = connectorCatalog.find(
          (candidate) => candidate.id === connectorType,
        );
        if (!item || item.connectMode !== "oauth_connector") {
          setConnectorWaiting(connectorType, false);
          continue;
        }
        const waitingStartedAt =
          connectorWaitingStartedAtRef.current[connectorType];
        if (!waitingStartedAt) {
          continue;
        }

        void connectorsClient
          .listAccounts(activeWorkspaceId, { connectorType })
          .then(async (accounts) => {
            const account = accounts.items.find(
              (candidate) =>
                candidate.status === "active" &&
                Date.parse(candidate.createdAt) >= waitingStartedAt,
            );
            if (!account) return;
            if (item.postOAuthMode === "auto_create") {
              await ensureConnector(item, account.id, {
                silentMissingAccount: true,
              });
              return;
            }
            setConnectorWaiting(connectorType, false);
            await refreshConnectors();
          })
          .catch(() => {
            // Polling is a fallback; the visible flow is driven by completion.
          });
      }
    }

    pollWaitingConnectors();
    const timer = window.setInterval(pollWaitingConnectors, 2500);

    return () => window.clearInterval(timer);
  }, [connectorWaitingByType, ensureConnector, refreshConnectors, workspaceId]);

  const handleRequestConnector = useCallback((item: ConnectorCatalogItem) => {
    toast.info(`${item.name} is on the roadmap.`);
  }, []);

  const handleCancelConnector = useCallback((item: ConnectorCatalogItem) => {
    delete connectorWaitingStartedAtRef.current[item.id];
    setConnectorWaiting(item.id, false);
    toast.info(`${item.name} connection canceled.`);
  }, []);

  const handleCopyWebhook = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Webhook URL copied.");
    } catch {
      toast.error("Could not copy webhook URL.");
    }
  }, []);

  const handleSyncConnector = useCallback(
    async (connector: ConnectorItem) => {
      if (!workspaceId) return;

      setConnectorBusy(connector.id, true);
      trackManualConnectorSync(connector.id);
      try {
        const result = await connectorsClient.sync(workspaceId, connector.id);
        trackConnectorSyncRun(result.run);
        if (result.skipped) {
          markConnectorNotReady(
            connector.id,
            result.reason ?? "connector_not_ready",
            result.message ?? "Connector is not ready to sync.",
          );
          toast.info(result.message ?? "Connector sync skipped.");
        } else if (result.alreadyRunning) {
          toast.info(result.message ?? "Connector sync is already running.");
        } else {
          clearConnectorReadiness(connector.id);
          toast.success("Connector sync queued.");
        }
        await refreshConnectors();
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to sync connector."));
      } finally {
        setConnectorBusy(connector.id, false);
      }
    },
    [
      clearConnectorReadiness,
      connectorSettingsConnectorId,
      markConnectorNotReady,
      refreshConnectorSettingsActivity,
      refreshConnectors,
      trackConnectorSyncRun,
      trackManualConnectorSync,
      workspaceId,
    ],
  );

  const handleToggleConnectorStatus = useCallback(
    async (connector: ConnectorItem) => {
      if (!workspaceId) return;
      const nextStatus =
        connector.status === "paused" || connector.status === "disabled"
          ? "active"
          : "paused";
      setConnectorBusy(connector.id, true);
      try {
        await connectorsClient.update(workspaceId, connector.id, {
          status: nextStatus,
        });
        toast.success(
          connector.status === "disabled"
            ? "Connector enabled."
            : nextStatus === "active"
              ? "Connector resumed."
              : "Connector paused.",
        );
        await refreshConnectors();
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to update connector."));
      } finally {
        setConnectorBusy(connector.id, false);
      }
    },
    [
      connectorSettingsConnectorId,
      refreshConnectorSettingsActivity,
      refreshConnectors,
      workspaceId,
    ],
  );

  const handleSaveConnectorSettings = useCallback(
    async (
      connector: ConnectorItem,
      input: {
        name: string;
        periodicIndexingEnabled: boolean;
        indexingFrequencyMinutes: number | null;
      },
    ) => {
      if (!workspaceId) return;

      setConnectorBusy(connector.id, true);
      try {
        await connectorsClient.update(workspaceId, connector.id, input);
        toast.success("Connector settings saved.");
        await refreshConnectors();
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
      } catch (error) {
        toast.error(
          getErrorMessage(error, "Failed to save connector settings."),
        );
      } finally {
        setConnectorBusy(connector.id, false);
      }
    },
    [
      connectorSettingsConnectorId,
      refreshConnectorSettingsActivity,
      refreshConnectors,
      workspaceId,
    ],
  );

  const handleConfirmDisconnectConnector = useCallback(async () => {
    if (!workspaceId || !pendingDisconnectConnector) return;
    const connector = pendingDisconnectConnector;
    setConnectorBusy(connector.id, true);
    try {
      const result = await connectorsClient.delete(workspaceId, connector.id, {
        disable: !disconnectConnectorHardDelete,
      });
      toast.success(
        result.hardDeleted
          ? "Connector, authorization, and indexed content deleted."
          : "Connector disabled. You can enable it again later.",
      );
      setPendingDisconnectConnector(null);
      setDisconnectConnectorHardDelete(false);
      if (connectorSettingsConnectorId === connector.id) {
        setConnectorSettingsConnectorId(null);
      }
      if (result.hardDeleted) {
        await refreshSources();
      }
      await refreshConnectors();
    } catch (error) {
      if (
        error instanceof HttpClientError &&
        error.code === "CONNECTOR_OAUTH_ACCOUNT_IN_USE"
      ) {
        toast.error(
          "This authorization is attached to another connector and cannot be deleted safely.",
        );
      } else {
        toast.error(getErrorMessage(error, "Failed to remove connector."));
      }
    } finally {
      setConnectorBusy(connector.id, false);
    }
  }, [
    connectorSettingsConnectorId,
    disconnectConnectorHardDelete,
    pendingDisconnectConnector,
    refreshConnectors,
    refreshSources,
    workspaceId,
  ]);

  return {
    connectors,
    connectorAccounts,
    isLoadingConnectors,
    connectorsLoadingError,
    connectorBusyById,
    connectorWaitingByType,
    isManageConnectorsOpen,
    setIsManageConnectorsOpen,
    manageConnectorsInitialTab,
    connectorReadinessById,
    pendingDisconnectConnector,
    setPendingDisconnectConnector,
    disconnectConnectorHardDelete,
    setDisconnectConnectorHardDelete,
    connectorWebhookEventsById,
    connectorWebhookConfigsById,
    setConnectorSettingsConnectorId,
    connectorSettingsActivity,
    isLoadingConnectorSettingsActivity,
    connectorSettingsActivityError,
    connectorSettingsConnector,
    refreshConnectors,
    openConnectorSettings,
    handleOpenConnectorSettingsById,
    openManageConnectors,
    handleConnectConnector,
    handleCreateConnector,
    handleRequestConnector,
    handleCancelConnector,
    handleCopyWebhook,
    handleSyncConnector,
    handleToggleConnectorStatus,
    handleSaveConnectorSettings,
    handleConfirmDisconnectConnector,
  };
}
