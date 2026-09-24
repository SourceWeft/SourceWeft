import { formatDisplayDate } from "@/lib/i18n/format";

import { useLocale as useDisplayLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

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
    // A localized fallback is applied at the display site
    // (`toasts.connectors.authFailed`) when no provider error message is present.
    error: status === "error" ? (url.searchParams.get("error") ?? "") : null,
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

function mapConnectorToUi(
  connector: SourceConnector,
  t: ReturnType<typeof useTranslations>,
  displayLocale: string,
): ConnectorItem {
  const lastSync = connector.lastIndexedAt
    ? t("connectors.lastSync", {
        date: formatDisplayDate(
          new Date(connector.lastIndexedAt),
          displayLocale,
        ),
      })
    : t("connectors.neverSynced");
  const schedule = formatConnectorSchedule(connector, t);
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
  const displayLocale = useDisplayLocale();
  const {
    workspaceId,
    currentWorkspaceIdRef,
    onConnectorsChange,
    trackConnectorSyncRun,
    refreshSources,
    sources,
    manualConnectorSyncSourcesRef,
  } = input;

  const t = useTranslations("dashboardSourcesHub");
  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [availableConnectorTypes, setAvailableConnectorTypes] = useState<
    string[]
  >([]);
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
      setAvailableConnectorTypes([]);
      setConnectorWebhookEventsById({});
      setConnectorWebhookConfigsById({});
      setConnectorsLoadingError(null);
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingConnectors(true);
    setConnectorsLoadingError(null);
    try {
      const [result, accounts, manifests] = await Promise.all([
        connectorsClient.list(activeWorkspaceId, { includeDisabled: true }),
        connectorsClient.listAccounts(activeWorkspaceId),
        connectorsClient.listManifests(activeWorkspaceId),
      ]);
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }
      const uiConnectors = result.items.map((connector) =>
        mapConnectorToUi(connector, t, displayLocale),
      );
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
          const readiness = getConnectorReadinessFromConfig(connector.raw, t);
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
      setAvailableConnectorTypes(
        manifests.items.map((manifest) => manifest.type),
      );
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
        getErrorMessage(error, t("toasts.connectors.loadFailed")),
      );
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoadingConnectors(false);
      }
    }
  }, [
    currentWorkspaceIdRef,
    onConnectorsChange,
    workspaceId,
    t,
    displayLocale,
  ]);

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
          getErrorMessage(error, t("toasts.connectors.activityLoadFailed")),
        );
      } finally {
        if (!options.silent) {
          setIsLoadingConnectorSettingsActivity(false);
        }
      }
    },
    [workspaceId, t],
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
        toast.error(t("toasts.connectors.settingsUnavailable"));
        return;
      }
      openConnectorSettings(connector);
    },
    [connectors, openConnectorSettings, t],
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
        toast.error(t("toasts.connectors.noWorkspace"));
        return;
      }

      if (item.connectMode !== "oauth_connector") {
        toast.error(
          t("toasts.connectors.notAvailableOAuth", { name: item.name }),
        );
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
      toast.info(t("toasts.connectors.redirecting", { name: item.name }));
      window.location.assign(startUrl.toString());
    },
    [openManageConnectors, workspaceId, t],
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
        if (
          item.id === "gmail" &&
          accountId &&
          current.raw.oauthAccountId !== accountId
        ) {
          try {
            const updated = await connectorsClient.update(
              workspaceId,
              current.id,
              {
                oauthAccountId: accountId,
                status: "active",
              },
            );
            await refreshConnectors();
            toast.success(
              t("toasts.connectors.connectedFallback", { name: item.name }),
            );
            return mapConnectorToUi(updated.connector, t, displayLocale);
          } catch (error) {
            toast.error(
              getErrorMessage(
                error,
                t("toasts.connectors.authFailed", { name: item.name }),
              ),
            );
            return null;
          }
        }
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
          toast.error(
            t("toasts.connectors.reconnectFirst", { name: item.name }),
          );
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
                t("toasts.connectors.reconnectFirst", { name: item.name }),
              );
            }
            return null;
          }

          if (item.id !== "notion" && item.id !== "gmail") {
            toast.info(
              t("toasts.connectors.connectedConfigureNext", {
                name: item.name,
              }),
            );
            await refreshConnectors();
            return null;
          }

          const created = await connectorsClient.create(workspaceId, {
            connectorType: item.id,
            name: account.displayName || item.name,
            oauthAccountId: account.id,
            configJson:
              item.id === "gmail"
                ? {
                    liveSearchEnabled: true,
                    indexingEnabled: false,
                    labelIds: [],
                    maxMessages: 500,
                  }
                : { includePages: true },
            periodicIndexingEnabled: item.id === "notion",
            ...(item.id === "notion" ? { indexingFrequencyMinutes: 360 } : {}),
          });
          if (item.id === "gmail") {
            await refreshConnectors();
            toast.success(
              t("toasts.connectors.connectedFallback", { name: item.name }),
            );
            return mapConnectorToUi(created.connector, t, displayLocale);
          }
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
              syncResult.message ?? t("connectors.readinessNotReady"),
            );
            toast.info(
              syncResult.message ??
                t("toasts.connectors.connectedFallback", { name: item.name }),
            );
          } else if (syncResult.alreadyRunning) {
            toast.info(
              syncResult.message ??
                t("toasts.connectors.syncAlreadyRunningNamed", {
                  name: item.name,
                }),
            );
          } else {
            clearConnectorReadiness(created.connector.id);
            toast.success(
              t("toasts.connectors.enabledInitialSync", { name: item.name }),
            );
          }
          await refreshConnectors();
          return mapConnectorToUi(created.connector, t, displayLocale);
        } catch (error) {
          if (isConnectorAlreadyHandledError(error)) {
            await refreshConnectors();
            toast.success(
              t("toasts.connectors.alreadyConnected", { name: item.name }),
            );
            return null;
          }

          if (
            error instanceof HttpClientError &&
            error.code === "CONNECTOR_DISABLED_CONFLICT"
          ) {
            toast.error(t("toasts.connectors.disabledConflict"));
          } else {
            toast.error(
              getErrorMessage(
                error,
                t("toasts.connectors.enableFailed", { name: item.name }),
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
      t,
      displayLocale,
    ],
  );

  const handleCreateConnector = useCallback(
    async (item: ConnectorCatalogItem) => {
      if (!workspaceId) {
        toast.error(t("toasts.connectors.noWorkspace"));
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
      t,
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
        toast.error(
          message.error ||
            t("toasts.connectors.authFailed", { name: item.name }),
        );
        void refreshConnectors();
        return;
      }

      if (item.postOAuthMode === "auto_create") {
        void ensureConnector(item, message.accountId);
        return;
      }

      setConnectorWaiting(item.id, false);
      toast.success(
        t("toasts.connectors.connectedConfigureDone", { name: item.name }),
      );
      void refreshConnectors();
    },
    [ensureConnector, openManageConnectors, refreshConnectors, workspaceId, t],
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

  const handleRequestConnector = useCallback(
    (item: ConnectorCatalogItem) => {
      toast.info(t("toasts.connectors.onRoadmap", { name: item.name }));
    },
    [t],
  );

  const handleCancelConnector = useCallback(
    (item: ConnectorCatalogItem) => {
      delete connectorWaitingStartedAtRef.current[item.id];
      setConnectorWaiting(item.id, false);
      toast.info(
        t("toasts.connectors.connectionCanceled", { name: item.name }),
      );
    },
    [t],
  );

  const handleCopyWebhook = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast.success(t("toasts.connectors.webhookCopied"));
      } catch {
        toast.error(t("toasts.connectors.webhookCopyFailed"));
      }
    },
    [t],
  );

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
            result.message ?? t("connectors.readinessNotReady"),
          );
          toast.info(result.message ?? t("toasts.connectors.syncSkipped"));
        } else if (result.alreadyRunning) {
          toast.info(
            result.message ?? t("toasts.connectors.syncAlreadyRunning"),
          );
        } else {
          clearConnectorReadiness(connector.id);
          toast.success(t("toasts.connectors.syncQueued"));
        }
        await refreshConnectors();
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
      } catch (error) {
        toast.error(getErrorMessage(error, t("toasts.connectors.syncFailed")));
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
      t,
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
            ? t("toasts.connectors.enabled")
            : nextStatus === "active"
              ? t("toasts.connectors.resumed")
              : t("toasts.connectors.paused"),
        );
        await refreshConnectors();
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
      } catch (error) {
        toast.error(
          getErrorMessage(error, t("toasts.connectors.updateFailed")),
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
      t,
    ],
  );

  const handleSaveConnectorSettings = useCallback(
    async (
      connector: ConnectorItem,
      input: {
        name: string;
        periodicIndexingEnabled: boolean;
        indexingFrequencyMinutes: number | null;
        configJson?: Record<string, unknown>;
      },
    ) => {
      if (!workspaceId) return;

      setConnectorBusy(connector.id, true);
      try {
        await connectorsClient.update(workspaceId, connector.id, input);
        toast.success(t("toasts.connectors.settingsSaved"));
        await refreshConnectors();
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
      } catch (error) {
        toast.error(
          getErrorMessage(error, t("toasts.connectors.settingsSaveFailed")),
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
      t,
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
          ? t("toasts.connectors.deletedAll")
          : t("toasts.connectors.disabledCanReenable"),
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
        toast.error(t("toasts.connectors.oauthAccountInUse"));
      } else {
        toast.error(
          getErrorMessage(error, t("toasts.connectors.removeFailed")),
        );
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
    t,
  ]);

  return {
    connectors,
    availableConnectorTypes,
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
