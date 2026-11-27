import { authClient } from "@/lib/auth-client";
import { trackConnectorConnected } from "@/lib/analytics-events";
import { formatDisplayDate } from "@/lib/i18n/format";

import { useLocale as useDisplayLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import {
  HttpClientError,
  type ConnectorActivityItem,
  type ConnectorSelectionSpec,
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
import type { LoginFlowStartInput } from "./add-login-flow-dialog";
import { connectorCatalog } from "./catalog";
import {
  gmailConfigForMode,
  parseGmailUsageMode,
  type GmailUsageMode,
} from "./gmail-mode";
import {
  formatConnectorSchedule,
  getConnectorReadinessFromConfig,
} from "./components";
import { type ManageConnectorsTab } from "./manage-dialog";
import type {
  ConnectorAccountItem,
  ConnectorCatalogItem,
  ConnectorItem,
  ConnectorManifestInfo,
  ConnectorReadinessState,
  ConnectorWebhookConfig,
  ConnectorWebhookEventItem,
  CredentialAddInput,
  CredentialCheckInput,
  CredentialCheckResult,
  FeedCheckResult,
  ForumAddInput,
  ForumCheckInput,
  ForumCheckResult,
  GenericCredentialAddInput,
  GenericCredentialCheckInput,
  GhostAddInput,
  GhostCheckInput,
  GhostCheckResult,
  SiteAddInput,
  SiteCheckInput,
  SiteCheckResult,
} from "./types";
import {
  GHOST_CONNECTOR_TYPE,
  GHOST_CREDENTIAL_USERNAME,
} from "./ghost-site-url";
import {
  WORDPRESS_CONNECTOR_TYPE,
  WORDPRESS_LOGIN_CONNECTOR_TYPE,
} from "./wordpress-site-url";

/** A catalog type whose add flow collects a stored credential: a username and
 * app password (WebDAV) or a library ID and API key (Zotero) or a Content API key (Ghost). Both the add
 * card and the reconnect path branch on this; reconnecting replaces the
 * credential in place. */
function isCredentialConnectorType(connectorType: string): boolean {
  const addMode = connectorCatalog.find(
    (item) => item.id === connectorType,
  )?.addMode;
  return addMode === "credential" || addMode === "api_key";
}

/** True when a credential check or create input came from a dialog that
 * supplies its own connector type, config and credential (Zotero). The WebDAV
 * dialog sends its endpoint, username and password instead. */
function isGenericCredentialInput(
  input: CredentialCheckInput | CredentialAddInput,
): input is GenericCredentialCheckInput | GenericCredentialAddInput {
  return "connectorType" in input;
}

/** A catalog type whose add/reconnect flow is a server-driven browser login
 * (Nextcloud). Both the add card and the reconnect path branch on this; there
 * is no password dialog for these connectors. */
function isLoginFlowConnectorType(connectorType: string): boolean {
  return (
    connectorCatalog.find((item) => item.id === connectorType)?.addMode ===
    "login_flow"
  );
}

/** The WebDAV add input carries no connector type, so its handlers default to
 * this one. */
const WEBDAV_CONNECTOR_TYPE = "webdav";

const CONNECTOR_OAUTH_URL_PARAMS = [
  "connector_oauth",
  "connector_type",
  "account_id",
  "workspace_id",
  "error",
  "gmail_mode",
] as const;

const WORKSPACE_CONNECTORS_CACHE_BUCKET = "connectors";

/** The selection spec of every manifest that declares one, keyed by type. A
 * connector type without a `selection` descriptor is absent, so a lookup
 * returns undefined (it has no shared selection UI). */
function selectionSpecsFromManifests(
  manifests: ReadonlyArray<{
    type: string;
    selection?: ConnectorSelectionSpec;
  }>,
): Record<string, ConnectorSelectionSpec> {
  const byType: Record<string, ConnectorSelectionSpec> = {};
  for (const manifest of manifests) {
    if (manifest.selection) byType[manifest.type] = manifest.selection;
  }
  return byType;
}

/**
 * The selection specs of a successful manifest load, tagged with the workspace
 * and actor they belong to. Mirrors how `availableManifests` is keyed: the
 * specs are visible only for the current workspace and actor, so they never
 * leak across a workspace or actor switch. `loaded` records that a manifest
 * load has succeeded for this workspace/actor — an empty `byType` with
 * `loaded: true` means "no type declares a selection", not "not loaded yet".
 */
type SelectionSpecsSnapshot = {
  workspaceId: string | null;
  actorId: string | undefined;
  loaded: boolean;
  byType: Record<string, ConnectorSelectionSpec>;
};

const EMPTY_SELECTION_SPECS: SelectionSpecsSnapshot = {
  workspaceId: null,
  actorId: undefined,
  loaded: false,
  byType: {},
};

const EMPTY_SELECTION_SPEC_MAP: Record<string, ConnectorSelectionSpec> = {};

function selectionSpecsMatch(
  snapshot: SelectionSpecsSnapshot,
  workspaceId: string | null,
  actorId: string | undefined,
): boolean {
  return snapshot.workspaceId === workspaceId && snapshot.actorId === actorId;
}

/**
 * The open login-flow (Nextcloud) dialog. `add` opens the full form; `reconnect`
 * seeds the fixed server and connector name from the connector being
 * reconnected and runs the flow with its `connectorId` (no form, no password).
 */
export type LoginFlowDialogState = {
  mode: "add" | "reconnect";
  connectorType: string;
  connectorId?: string;
  serverUrl?: string;
  connectorName?: string;
};

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
    gmailMode:
      connectorType === "gmail"
        ? parseGmailUsageMode(url.searchParams.get("gmail_mode"))
        : undefined,
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

type ConnectorManifestItem = Awaited<
  ReturnType<typeof connectorsClient.listManifests>
>["items"][number];

function deriveConnectorManifestInfo(
  manifest: ConnectorManifestItem,
): ConnectorManifestInfo {
  return {
    supportsIndexing: manifest.sync.resources.length > 0,
    broker: manifest.auth.kind === "brokered" ? manifest.auth.broker : null,
  };
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
  const { data: session } = authClient.useSession();
  const actorId = session?.user?.id;
  const actorIdRef = useRef(actorId);
  actorIdRef.current = actorId;
  const connectorCacheBucket = `${WORKSPACE_CONNECTORS_CACHE_BUCKET}:${actorId ?? "anonymous"}`;
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
  const [availableManifests, setAvailableManifests] = useState<{
    actorId: string | undefined;
    types: string[];
    infoByType: Record<string, ConnectorManifestInfo>;
  }>({ actorId: undefined, types: [], infoByType: {} });
  const availableConnectorTypes =
    availableManifests.actorId === actorId ? availableManifests.types : [];
  const [selectionSpecsSnapshot, setSelectionSpecsSnapshot] =
    useState<SelectionSpecsSnapshot>(EMPTY_SELECTION_SPECS);
  // Mirrors the state so a just-authorised connect can read the latest specs
  // even from inside a callback that closed over an earlier render's state
  // (for example when a fresh manifest fetch fails and we fall back to it).
  // Kept in step with the state by `applySelectionSpecs` below.
  const selectionSpecsSnapshotRef = useRef<SelectionSpecsSnapshot>(
    EMPTY_SELECTION_SPECS,
  );
  const applySelectionSpecs = useCallback(
    (snapshot: SelectionSpecsSnapshot) => {
      selectionSpecsSnapshotRef.current = snapshot;
      setSelectionSpecsSnapshot(snapshot);
    },
    [],
  );
  // The specs the settings UI consumes: the loaded map only when it belongs to
  // the current workspace and actor (so a failed refresh keeps them, while a
  // workspace or actor switch hides them until the new context loads).
  const selectionSpecByType = selectionSpecsMatch(
    selectionSpecsSnapshot,
    workspaceId ?? null,
    actorId,
  )
    ? selectionSpecsSnapshot.byType
    : EMPTY_SELECTION_SPEC_MAP;
  const connectorManifestInfoByType =
    availableManifests.actorId === actorId ? availableManifests.infoByType : {};
  // `ensureConnector` and `handleConnectConnector` read this inside async
  // callbacks that can outlive the render that created them (an OAuth return
  // is handled by an effect that fires before `refreshConnectors()`'s
  // manifest fetch resolves). A ref always reads the latest value; the
  // closed-over `connectorManifestInfoByType` above would stay pinned to
  // whatever it was when that particular callback instance was created.
  const connectorManifestInfoByTypeRef = useRef(connectorManifestInfoByType);
  connectorManifestInfoByTypeRef.current = connectorManifestInfoByType;
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
  // The credential connector whose rotate ("reconnect") dialog is open, or null.
  const [rotateCredentialConnector, setRotateCredentialConnector] =
    useState<ConnectorItem | null>(null);
  // The in-progress login-flow (Nextcloud) dialog: an `add` (new connector) or a
  // `reconnect` (existing connector, credential rotated in place), or null when
  // closed. The server/name are seeded from the connector for a reconnect; the
  // flow id and login URL never leave the dialog's own state.
  const [loginFlowState, setLoginFlowState] =
    useState<LoginFlowDialogState | null>(null);
  const loginFlowStateRef = useRef<LoginFlowDialogState | null>(null);
  loginFlowStateRef.current = loginFlowState;
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
      setAvailableManifests({ actorId, types: [], infoByType: {} });
      applySelectionSpecs(EMPTY_SELECTION_SPECS);
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
      if (
        currentWorkspaceIdRef.current !== activeWorkspaceId ||
        actorIdRef.current !== actorId
      ) {
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
      const infoByType: Record<string, ConnectorManifestInfo> = {};
      for (const manifest of manifests.items) {
        infoByType[manifest.type] = deriveConnectorManifestInfo(manifest);
      }
      setAvailableManifests({
        actorId,
        types: manifests.items.map((manifest) => manifest.type),
        infoByType,
      });
      applySelectionSpecs({
        workspaceId: activeWorkspaceId,
        actorId,
        loaded: true,
        byType: selectionSpecsFromManifests(manifests.items),
      });
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
      if (
        currentWorkspaceIdRef.current !== activeWorkspaceId ||
        actorIdRef.current !== actorId
      ) {
        return;
      }
      setConnectorWebhookConfigsById(nextWebhookConfigs);
      setConnectorWebhookEventsById(nextWebhookEvents);
      setCachedWorkspaceHubValue<WorkspaceConnectorsCacheValue>(
        connectorCacheBucket,
        activeWorkspaceId,
        {
          accounts: accounts.items,
          connectors: uiConnectors,
          webhookConfigsById: nextWebhookConfigs,
          webhookEventsById: nextWebhookEvents,
        },
      );
    } catch (error) {
      if (actorIdRef.current !== actorId) return;
      setAvailableManifests({ actorId, types: [], infoByType: {} });
      // A failed refresh keeps the last good selection specs (state and ref):
      // the settings list and any open picker depend on them, and a refresh
      // runs after every save and sync. They are cleared only when the
      // workspace or actor changes (the keyed read above hides them then).
      setConnectorsLoadingError(
        getErrorMessage(error, t("toasts.connectors.loadFailed")),
      );
    } finally {
      if (
        currentWorkspaceIdRef.current === activeWorkspaceId &&
        actorIdRef.current === actorId
      ) {
        setIsLoadingConnectors(false);
      }
    }
  }, [
    actorId,
    applySelectionSpecs,
    connectorCacheBucket,
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
      connectorCacheBucket,
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
  }, [refreshConnectors, workspaceId, connectorCacheBucket]);

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
    (item: ConnectorCatalogItem, gmailMode: GmailUsageMode = "tools") => {
      if (!workspaceId) {
        toast.error(t("toasts.connectors.noWorkspace"));
        return;
      }

      const startUrl = new URL(
        "/dashboard/connectors/oauth/start",
        window.location.origin,
      );
      startUrl.searchParams.set("workspace_id", workspaceId);
      startUrl.searchParams.set("connector_type", item.id);
      startUrl.searchParams.set("mode", "redirect");
      const returnTo = new URL(window.location.href);
      // A tools-only Gmail (no sync resources in its manifest, e.g. a
      // Composio-brokered deployment) has nothing to choose a mode for: the
      // connector it creates below always takes the tools-only config, so no
      // `gmail_mode` is carried through the redirect.
      if (
        item.id === "gmail" &&
        connectorManifestInfoByTypeRef.current.gmail?.supportsIndexing !== false
      ) {
        returnTo.searchParams.set("gmail_mode", gmailMode);
      }
      startUrl.searchParams.set("return_to", returnTo.toString());

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
      options: {
        silentMissingAccount?: boolean;
        gmailMode?: GmailUsageMode;
      } = {},
    ) => {
      if (!workspaceId) {
        return null;
      }
      let knownConnectors = connectors;
      // Which connector types declare a shared selection UI, and whether that
      // is known at all. Deciding a new connector's initial config and whether
      // to open settings turns on this; an empty map from a *failed* load is
      // "unknown", not "this type has no selection" (see the snapshot's
      // `loaded`). Specs from another workspace/actor do not count.
      const snapshotActorId = actorIdRef.current;
      const currentSnapshot = selectionSpecsMatch(
        selectionSpecsSnapshotRef.current,
        workspaceId,
        snapshotActorId,
      )
        ? selectionSpecsSnapshotRef.current
        : null;
      let knownSelectionSpecByType = currentSnapshot?.byType ?? {};
      let selectionCapabilityKnown = currentSnapshot?.loaded ?? false;
      // What the just-fetched manifests say about Gmail, for the create path
      // below: `undefined` until that fetch answers, `null` when it answered
      // without a Gmail manifest.
      let freshGmailManifestInfo: ConnectorManifestInfo | null | undefined;
      let manifestFetchError: unknown = null;
      if (accountId) {
        // An authorization just completed. After the provider redirects back
        // this runs before the connector list and manifests have loaded, so
        // read them itself: deciding from the empty state would take an
        // existing connector for a first connection, or miss the selection
        // spec that a just-registered type declares.
        //
        // The connector list is required — its failure is the auth failure.
        try {
          const fresh = await connectorsClient.list(workspaceId, {
            includeDisabled: true,
          });
          knownConnectors = fresh.items.map((connector) =>
            mapConnectorToUi(connector, t, displayLocale),
          );
        } catch (error) {
          setConnectorWaiting(item.id, false);
          toast.error(
            getErrorMessage(
              error,
              t("toasts.connectors.authFailed", { name: item.name }),
            ),
          );
          return null;
        }
        // The manifest fetch decides selection config. A transient failure
        // falls back to the specs already in state, but only when a manifest
        // load has succeeded before (manifestsLoadedRef); otherwise the
        // capability is genuinely unknown and the create path must stop rather
        // than guess.
        try {
          const manifests = await connectorsClient.listManifests(workspaceId);
          const byType = selectionSpecsFromManifests(manifests.items);
          knownSelectionSpecByType = byType;
          selectionCapabilityKnown = true;
          const gmailManifest = manifests.items.find(
            (entry) => entry.type === "gmail",
          );
          freshGmailManifestInfo = gmailManifest
            ? deriveConnectorManifestInfo(gmailManifest)
            : null;
          // Apply the fresh specs to both state and ref so the settings list
          // (state) and any later fallback (ref) see them.
          applySelectionSpecs({
            workspaceId,
            actorId: actorIdRef.current,
            loaded: true,
            byType,
          });
        } catch (error) {
          manifestFetchError = error;
          const snapshot = selectionSpecsSnapshotRef.current;
          if (
            selectionSpecsMatch(snapshot, workspaceId, actorIdRef.current) &&
            snapshot.loaded
          ) {
            knownSelectionSpecByType = snapshot.byType;
            selectionCapabilityKnown = true;
          } else {
            selectionCapabilityKnown = false;
          }
        }
      }
      const current = knownConnectors.find(
        (connector) =>
          connector.raw.connectorType === item.id &&
          connector.status !== "disabled",
      );
      if (current) {
        // The polling fallback passes silentMissingAccount; only a completed
        // authorization the user is watching reports a reconnect.
        const isReconnect = Boolean(accountId) && !options.silentMissingAccount;
        if (isReconnect && current.raw.oauthAccountId === accountId) {
          // Same provider account: the stored authorization was refreshed in
          // place, so the connector, its settings and its content are intact.
          try {
            if (current.status === "error") {
              await connectorsClient.update(workspaceId, current.id, {
                status: "active",
              });
            }
            clearConnectorReadiness(current.id);
            await refreshConnectors();
            toast.success(
              t("toasts.connectors.reconnected", { name: item.name }),
            );
            return current;
          } catch (error) {
            toast.error(
              getErrorMessage(error, t("toasts.connectors.updateFailed")),
            );
            return null;
          } finally {
            setConnectorWaiting(item.id, false);
          }
        }
        if (
          isReconnect &&
          accountId &&
          current.raw.oauthAccountId &&
          item.id !== "gmail"
        ) {
          // A different provider account cannot take over this connector: its
          // selection and indexed content belong to the original account. Drop
          // the authorization that was just stored so it does not linger.
          setConnectorWaiting(item.id, false);
          toast.error(
            t("toasts.connectors.reconnectWrongAccount", { name: item.name }),
          );
          try {
            await connectorsClient.deleteAccount(workspaceId, accountId);
          } catch {
            // The authorization is unused either way; the refusal above stands.
          }
          await refreshConnectors();
          return null;
        }
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
            if (
              error instanceof HttpClientError &&
              error.code === "CONNECTOR_OAUTH_ACCOUNT_MISMATCH"
            ) {
              // Refused because it is a different provider account; drop the
              // authorization that was just stored so it does not linger.
              try {
                await connectorsClient.deleteAccount(workspaceId, accountId);
              } catch {
                // The authorization is unused either way.
              }
              await refreshConnectors();
            }
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

          // A connector type with a selection spec is configured through the
          // shared selection list, exactly as Dropbox is. The three types
          // below have their own config, so their creation does not depend on
          // whether the manifests are known.
          if (
            item.id !== "notion" &&
            item.id !== "gmail" &&
            item.id !== "google_drive"
          ) {
            if (!selectionCapabilityKnown) {
              // Authorization succeeded but we could not load the manifests, so
              // we cannot tell whether this type is configured through a
              // selection list. Do not create and do not report success; ask
              // the person to connect again. The IIFE's finally clears the
              // waiting state, as it does for the other early returns here.
              toast.error(
                t("toasts.connectors.setupIncomplete", { name: item.name }),
              );
              return null;
            }
            if (!knownSelectionSpecByType[item.id]) {
              toast.info(
                t("toasts.connectors.connectedConfigureNext", {
                  name: item.name,
                }),
              );
              await refreshConnectors();
              return null;
            }
          }
          const hasSelectionSpec = Boolean(knownSelectionSpecByType[item.id]);

          // Periodic indexing stays keyed on the explicit type list: a
          // tools-only selection connector has nothing to index on a schedule.
          const periodicIndexingEnabled =
            item.id === "notion" ||
            item.id === "google_drive" ||
            item.id === "dropbox";
          // A tools-only Gmail manifest (no sync resources, e.g. a
          // Composio-brokered deployment) accepts only `liveSearchEnabled` in
          // its config; indexing fields would be rejected by validation. The
          // manifests fetched above, right after the authorization, decide;
          // if that fetch failed, the manifests already loaded for this actor
          // do. Never guess in either direction: with neither answer, throw
          // into the catch below, the same error path any other failed
          // connector creation already uses, instead of creating the connector
          // with an unconfirmed config.
          let gmailSupportsIndexing = true;
          if (item.id === "gmail") {
            if (freshGmailManifestInfo !== undefined) {
              gmailSupportsIndexing =
                freshGmailManifestInfo?.supportsIndexing ?? true;
            } else {
              const cachedGmailInfo =
                connectorManifestInfoByTypeRef.current.gmail;
              if (!cachedGmailInfo) {
                throw (
                  manifestFetchError ??
                  new Error(t("toasts.connectors.loadFailed"))
                );
              }
              gmailSupportsIndexing = cachedGmailInfo.supportsIndexing;
            }
          }
          const effectiveGmailMode =
            item.id === "gmail" && gmailSupportsIndexing
              ? (options.gmailMode ?? "tools")
              : "tools";
          const created = await connectorsClient.create(workspaceId, {
            connectorType: item.id,
            name: account.displayName || item.name,
            oauthAccountId: account.id,
            configJson:
              item.id === "gmail"
                ? gmailSupportsIndexing
                  ? gmailConfigForMode(effectiveGmailMode)
                  : { liveSearchEnabled: true }
                : item.id === "google_drive"
                  ? { fileIds: [] }
                  : hasSelectionSpec
                    ? { items: [] }
                    : { includePages: true },
            periodicIndexingEnabled,
            ...(periodicIndexingEnabled
              ? { indexingFrequencyMinutes: 360 }
              : {}),
          });
          trackConnectorConnected({
            connectorType: item.id,
            gmailMode: item.id === "gmail" ? effectiveGmailMode : undefined,
          });
          if (item.id === "google_drive" || hasSelectionSpec) {
            // No files are selected yet, so there is nothing to sync; open
            // settings so the admin can pick files from the Files section.
            await refreshConnectors();
            const mapped = mapConnectorToUi(
              created.connector,
              t,
              displayLocale,
            );
            openConnectorSettings(mapped);
            toast.success(
              t("toasts.connectors.connectedFallback", { name: item.name }),
            );
            return mapped;
          }
          if (item.id === "gmail") {
            await refreshConnectors();
            const mapped = mapConnectorToUi(
              created.connector,
              t,
              displayLocale,
            );
            if (effectiveGmailMode !== "tools") {
              openConnectorSettings(mapped);
            }
            toast.success(
              t("toasts.connectors.connectedFallback", { name: item.name }),
            );
            return mapped;
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
      applySelectionSpecs,
      clearConnectorReadiness,
      connectors,
      markConnectorNotReady,
      openConnectorSettings,
      refreshConnectors,
      trackConnectorSyncRun,
      trackManualConnectorSync,
      workspaceId,
      t,
      displayLocale,
    ],
  );

  const handleAddLoginFlow = useCallback((item: ConnectorCatalogItem) => {
    setLoginFlowState({ mode: "add", connectorType: item.id });
  }, []);

  const handleReconnectConnector = useCallback(
    (connector: ConnectorItem) => {
      const connectorType = connector.raw.connectorType;
      // A login-flow connector (Nextcloud) reconnects by running the SAME
      // server-driven browser login again, keyed to its connectorId: the backend
      // rotates the credential in place. There is no password dialog; the server
      // and name are fixed to the existing connector.
      if (isLoginFlowConnectorType(connectorType)) {
        const config = connector.raw.configJson;
        const serverUrl =
          typeof config.server === "string" && config.server
            ? config.server
            : typeof config.endpoint === "string"
              ? config.endpoint
              : "";
        setLoginFlowState({
          mode: "reconnect",
          connectorType,
          connectorId: connector.id,
          serverUrl,
          connectorName: connector.name,
        });
        return;
      }
      // A credential connector (WebDAV) has no OAuth flow: reconnecting means
      // replacing the stored username and app password, so open the rotate
      // dialog instead of starting an authorization.
      if (isCredentialConnectorType(connectorType)) {
        setRotateCredentialConnector(connector);
        return;
      }
      const item = connectorCatalog.find(
        (candidate) => candidate.id === connectorType,
      );
      if (!item) {
        toast.error(t("toasts.connectors.settingsUnavailable"));
        return;
      }
      handleConnectConnector(item);
    },
    [handleConnectConnector, t],
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
      if (!item) {
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
        void ensureConnector(item, message.accountId, {
          gmailMode: message.gmailMode,
        });
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
        if (!item) {
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

  const handleCheckFeed = useCallback(
    async (feedUrl: string): Promise<FeedCheckResult> => {
      if (!workspaceId) {
        toast.error(t("toasts.connectors.noWorkspace"));
        return {
          ready: false,
          reason: "no_workspace",
          message: "",
          title: null,
          itemCount: null,
        };
      }
      const result = await connectorsClient.checkConfig(workspaceId, {
        connectorType: "rss",
        configJson: { feedUrl },
      });
      const title = result.metadata?.title;
      const itemCount = result.metadata?.itemCount;
      return {
        ready: result.ready,
        reason: result.reason ?? "",
        message: result.message ?? "",
        title: typeof title === "string" && title.trim() ? title : null,
        itemCount: typeof itemCount === "number" ? itemCount : null,
      };
    },
    [workspaceId, t],
  );

  // Rejects on any create failure (including the 409 duplicate) so the add
  // dialog stays open and shows the reason; a failed first-sync start does not
  // reject, because the connector exists by then and the sync path reports it.
  const handleAddFeed = useCallback(
    async (input: { name: string; feedUrl: string }) => {
      if (!workspaceId) {
        const message = t("toasts.connectors.noWorkspace");
        toast.error(message);
        throw new Error(message);
      }
      const created = await connectorsClient.create(workspaceId, {
        connectorType: "rss",
        name: input.name,
        configJson: { feedUrl: input.feedUrl },
        periodicIndexingEnabled: true,
        indexingFrequencyMinutes: 360,
      });
      trackConnectorConnected({ connectorType: "rss" });
      await refreshConnectors();
      toast.success(
        t("toasts.connectors.connectedFallback", {
          name: created.connector.name,
        }),
      );
      await handleSyncConnector(
        mapConnectorToUi(created.connector, t, displayLocale),
      );
    },
    [displayLocale, handleSyncConnector, refreshConnectors, workspaceId, t],
  );

  // Pre-create readiness check for a connector that needs no credential and
  // brings its own type and config (Discourse). A reachable forum with nothing
  // chosen yet answers `selection_required`, which is passed through as it is.
  const handleCheckForum = useCallback(
    async (input: ForumCheckInput): Promise<ForumCheckResult> => {
      if (!workspaceId) {
        toast.error(t("toasts.connectors.noWorkspace"));
        return { ready: false, reason: "no_workspace", message: "" };
      }
      const result = await connectorsClient.checkConfig(workspaceId, {
        connectorType: input.connectorType,
        configJson: input.configJson,
      });
      return {
        ready: result.ready,
        reason: result.reason ?? "",
        message: result.message ?? "",
      };
    },
    [workspaceId, t],
  );

  // Rejects on any create failure (including the 409 duplicate) so the add
  // dialog stays open and shows the reason. The new connector has no
  // categories or topics selected yet, so there is nothing to sync: its
  // settings open on the selection picker instead, and the card reads
  // "choose categories or topics" until a selection is saved.
  const handleAddForum = useCallback(
    async (input: ForumAddInput) => {
      if (!workspaceId) {
        const message = t("toasts.connectors.noWorkspace");
        toast.error(message);
        throw new Error(message);
      }
      const created = await connectorsClient.create(workspaceId, {
        connectorType: input.connectorType,
        name: input.name,
        configJson: input.configJson,
        periodicIndexingEnabled: input.periodicIndexingEnabled,
        indexingFrequencyMinutes: 360,
      });
      trackConnectorConnected({ connectorType: input.connectorType });
      await refreshConnectors();
      markConnectorNotReady(
        created.connector.id,
        "selection_required",
        t("connectors.discourse.readiness.selection_required"),
      );
      openConnectorSettings(
        mapConnectorToUi(created.connector, t, displayLocale),
      );
      toast.success(
        t("toasts.connectors.connectedFallback", {
          name: created.connector.name,
        }),
      );
    },
    [
      displayLocale,
      markConnectorNotReady,
      openConnectorSettings,
      refreshConnectors,
      workspaceId,
      t,
    ],
  );

  // Pre-create readiness check for a WordPress site. The access choice decides
  // the connector type and whether the Application Password travels with the
  // request; the secret is only in the request body, never cached here. An
  // empty selection is ready (it means every published post and page), so a
  // reachable site answers `ready: true`.
  const handleCheckSite = useCallback(
    async (input: SiteCheckInput): Promise<SiteCheckResult> => {
      if (!workspaceId) {
        toast.error(t("toasts.connectors.noWorkspace"));
        return { ready: false, reason: "no_workspace", message: "" };
      }
      const result = await connectorsClient.checkConfig(
        workspaceId,
        input.access === "login"
          ? {
              connectorType: WORDPRESS_LOGIN_CONNECTOR_TYPE,
              configJson: {
                siteUrl: input.siteUrl,
                items: [],
                includeUnpublished: input.includeUnpublished,
              },
              credential: {
                username: input.credential.username,
                secret: input.credential.secret,
              },
            }
          : {
              connectorType: WORDPRESS_CONNECTOR_TYPE,
              configJson: { siteUrl: input.siteUrl, items: [] },
            },
      );
      return {
        ready: result.ready,
        reason: result.reason ?? "",
        message: result.message ?? "",
      };
    },
    [workspaceId, t],
  );

  // Create a WordPress connector. The public choice creates `wordpress` with no
  // credential; the login choice creates `wordpress_login` with the Application
  // Password and the drafts/private flag. Creating a connector never indexes
  // anything: an empty selection means every published post and page (up to the
  // cap), but a sync that large must be a deliberate choice, so — like the
  // Discourse add flow — this opens the new connector's settings (the selection
  // browser) and leaves the first sync to the member's own "Sync now". The
  // "Sync automatically" choice still only sets scheduled periodic syncs. Rejects
  // on any create failure so the dialog stays open and shows the reason.
  const handleAddSite = useCallback(
    async (input: SiteAddInput) => {
      if (!workspaceId) {
        const message = t("toasts.connectors.noWorkspace");
        toast.error(message);
        throw new Error(message);
      }
      const connectorType =
        input.access === "login"
          ? WORDPRESS_LOGIN_CONNECTOR_TYPE
          : WORDPRESS_CONNECTOR_TYPE;
      const created = await connectorsClient.create(workspaceId, {
        connectorType,
        name: input.name,
        ...(input.access === "login"
          ? {
              configJson: {
                siteUrl: input.siteUrl,
                items: [],
                includeUnpublished: input.includeUnpublished,
              },
              credential: {
                username: input.credential.username,
                secret: input.credential.secret,
              },
            }
          : { configJson: { siteUrl: input.siteUrl, items: [] } }),
        periodicIndexingEnabled: input.periodicIndexingEnabled,
        indexingFrequencyMinutes: 360,
      });
      trackConnectorConnected({ connectorType });
      await refreshConnectors();
      openConnectorSettings(
        mapConnectorToUi(created.connector, t, displayLocale),
      );
      toast.success(
        t("toasts.connectors.connectedFallback", {
          name: created.connector.name,
        }),
      );
    },
    [displayLocale, openConnectorSettings, refreshConnectors, workspaceId, t],
  );

  // Pre-create readiness check for a Ghost site: the API URL and the Content
  // API key go to the check endpoint in the request body only (never a URL or
  // a cache), with an empty selection (it means every published post and page).
  const handleCheckGhost = useCallback(
    async (input: GhostCheckInput): Promise<GhostCheckResult> => {
      if (!workspaceId) {
        toast.error(t("toasts.connectors.noWorkspace"));
        return { ready: false, reason: "no_workspace", message: "" };
      }
      const result = await connectorsClient.checkConfig(workspaceId, {
        connectorType: GHOST_CONNECTOR_TYPE,
        configJson: { siteUrl: input.siteUrl, items: [] },
        credential: {
          username: GHOST_CREDENTIAL_USERNAME,
          secret: input.secret,
        },
      });
      return {
        ready: result.ready,
        reason: result.reason ?? "",
        message: result.message ?? "",
      };
    },
    [workspaceId, t],
  );

  // Create a Ghost connector with the Content API key as its credential.
  // Creating a connector never indexes anything: an empty selection means every
  // published post and page (up to the cap), a sync that large must be a
  // deliberate choice, so — like the WordPress add flow — this opens the new
  // connector's settings (the selection browser) and leaves the first sync to
  // the member's own "Sync now". "Sync automatically" only schedules future
  // syncs. Rejects on any create failure (a second connector for the same site
  // is a 409) so the dialog stays open and shows the reason.
  const handleAddGhost = useCallback(
    async (input: GhostAddInput) => {
      if (!workspaceId) {
        const message = t("toasts.connectors.noWorkspace");
        toast.error(message);
        throw new Error(message);
      }
      const created = await connectorsClient.create(workspaceId, {
        connectorType: GHOST_CONNECTOR_TYPE,
        name: input.name,
        configJson: { siteUrl: input.siteUrl, items: [] },
        credential: {
          username: GHOST_CREDENTIAL_USERNAME,
          secret: input.secret,
        },
        periodicIndexingEnabled: input.periodicIndexingEnabled,
        indexingFrequencyMinutes: 360,
      });
      trackConnectorConnected({ connectorType: GHOST_CONNECTOR_TYPE });
      await refreshConnectors();
      openConnectorSettings(
        mapConnectorToUi(created.connector, t, displayLocale),
      );
      toast.success(
        t("toasts.connectors.connectedFallback", {
          name: created.connector.name,
        }),
      );
    },
    [displayLocale, openConnectorSettings, refreshConnectors, workspaceId, t],
  );

  // Pre-create readiness check for a credential connector. A WebDAV input runs
  // the adapter's check against the whole-endpoint root; a generic input (the
  // Zotero dialog) brings its own connector type, config and credential. It
  // stores nothing; the secret travels in the request body only and is never
  // cached here.
  const handleCheckCredential = useCallback(
    async (input: CredentialCheckInput): Promise<CredentialCheckResult> => {
      if (!workspaceId) {
        toast.error(t("toasts.connectors.noWorkspace"));
        return { ready: false, reason: "no_workspace", message: "" };
      }
      const result = await connectorsClient.checkConfig(
        workspaceId,
        isGenericCredentialInput(input)
          ? {
              connectorType: input.connectorType,
              configJson: input.configJson,
              credential: {
                username: input.credential.username,
                secret: input.credential.secret,
              },
            }
          : {
              connectorType: WEBDAV_CONNECTOR_TYPE,
              configJson: { endpoint: input.endpoint, roots: ["/"] },
              credential: { username: input.username, secret: input.secret },
            },
      );
      return {
        ready: result.ready,
        reason: result.reason ?? "",
        message: result.message ?? "",
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
    },
    [workspaceId, t],
  );

  // Rejects on any create failure (duplicate, credential not allowed, invalid
  // endpoint) so the add dialog stays open and shows the reason; a failed
  // first-sync start does not reject because the connector exists by then.
  const handleAddCredential = useCallback(
    async (input: CredentialAddInput) => {
      if (!workspaceId) {
        const message = t("toasts.connectors.noWorkspace");
        toast.error(message);
        throw new Error(message);
      }
      const connectorType = isGenericCredentialInput(input)
        ? input.connectorType
        : WEBDAV_CONNECTOR_TYPE;
      const created = await connectorsClient.create(workspaceId, {
        connectorType,
        name: input.name,
        ...(isGenericCredentialInput(input)
          ? {
              configJson: input.configJson,
              credential: {
                username: input.credential.username,
                secret: input.credential.secret,
              },
            }
          : {
              configJson: { endpoint: input.endpoint, roots: input.roots },
              credential: { username: input.username, secret: input.secret },
            }),
        // Scheduled reconciliation is opt-in: default off unless the member
        // ticked "Sync automatically" in the add dialog.
        periodicIndexingEnabled: input.periodicIndexingEnabled,
        indexingFrequencyMinutes: 360,
      });
      trackConnectorConnected({ connectorType });
      await refreshConnectors();
      toast.success(
        t("toasts.connectors.connectedFallback", {
          name: created.connector.name,
        }),
      );
      await handleSyncConnector(
        mapConnectorToUi(created.connector, t, displayLocale),
      );
    },
    [displayLocale, handleSyncConnector, refreshConnectors, workspaceId, t],
  );

  // Replace a credential connector's stored username and app password in place
  // (the reconnect path). Rejects on failure so the rotate dialog keeps the
  // field and shows the reason; the secret is held only in that dialog.
  const handleRotateCredential = useCallback(
    async (
      connector: ConnectorItem,
      input: { username: string; secret: string },
    ) => {
      if (!workspaceId) {
        const message = t("toasts.connectors.noWorkspace");
        toast.error(message);
        throw new Error(message);
      }
      await connectorsClient.rotateCredential(workspaceId, connector.id, {
        username: input.username,
        secret: input.secret,
      });
      setRotateCredentialConnector(null);
      await refreshConnectors();
      if (connectorSettingsConnectorId === connector.id) {
        await refreshConnectorSettingsActivity(connector.id);
      }
      toast.success(
        t("toasts.connectors.reconnected", { name: connector.name }),
      );
    },
    [
      connectorSettingsConnectorId,
      refreshConnectorSettingsActivity,
      refreshConnectors,
      workspaceId,
      t,
    ],
  );

  // Start a login flow for the open dialog (Nextcloud). The connector type comes
  // from the dialog state, and a reconnect adds its connectorId. Only the
  // returned flowId and loginUrl travel back, and they stay inside the dialog.
  const handleStartLoginFlow = useCallback(
    async (input: LoginFlowStartInput) => {
      const state = loginFlowStateRef.current;
      if (!workspaceId || !state) {
        throw new Error(t("toasts.connectors.noWorkspace"));
      }
      return connectorsClient.startCredentialFlow(
        workspaceId,
        state.connectorType,
        {
          serverUrl: input.serverUrl,
          name: input.name,
          ...(input.roots ? { roots: input.roots } : {}),
          ...(input.periodicIndexingEnabled !== undefined
            ? { periodicIndexingEnabled: input.periodicIndexingEnabled }
            : {}),
          ...(state.connectorId ? { connectorId: state.connectorId } : {}),
        },
      );
    },
    [workspaceId, t],
  );

  const handlePollLoginFlow = useCallback(
    async (flowId: string) => {
      const state = loginFlowStateRef.current;
      if (!workspaceId || !state) {
        throw new Error(t("toasts.connectors.noWorkspace"));
      }
      return connectorsClient.pollCredentialFlow(
        workspaceId,
        state.connectorType,
        { flowId },
      );
    },
    [workspaceId, t],
  );

  // Best-effort cancel of the server-side flow; failures are swallowed so the
  // dialog always closes.
  const handleCancelLoginFlow = useCallback(
    async (flowId: string) => {
      const state = loginFlowStateRef.current;
      if (!workspaceId || !state) return;
      try {
        await connectorsClient.cancelCredentialFlow(
          workspaceId,
          state.connectorType,
          flowId,
        );
      } catch {
        // The flow expires on its own if the cancel does not land.
      }
    },
    [workspaceId],
  );

  // The flow reached `connected`: the backend has created (add) or rotated
  // (reconnect) the connector. Refresh the list; for a new connector trigger the
  // first sync exactly as the WebDAV add flow does.
  const handleLoginFlowConnected = useCallback(
    async (connector: SourceConnector) => {
      const state = loginFlowStateRef.current;
      // The connector's own name, as the WebDAV add and rotate paths report it.
      const name = connector.name;
      trackConnectorConnected({ connectorType: connector.connectorType });
      clearConnectorReadiness(connector.id);
      await refreshConnectors();
      if (state?.mode === "reconnect") {
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
        toast.success(t("toasts.connectors.reconnected", { name }));
        return;
      }
      toast.success(t("toasts.connectors.connectedFallback", { name }));
      await handleSyncConnector(mapConnectorToUi(connector, t, displayLocale));
    },
    [
      clearConnectorReadiness,
      connectorSettingsConnectorId,
      displayLocale,
      handleSyncConnector,
      refreshConnectorSettingsActivity,
      refreshConnectors,
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
    ): Promise<boolean> => {
      if (!workspaceId) return false;

      setConnectorBusy(connector.id, true);
      try {
        await connectorsClient.update(workspaceId, connector.id, input);
        toast.success(t("toasts.connectors.settingsSaved"));
        await refreshConnectors();
        if (connectorSettingsConnectorId === connector.id) {
          await refreshConnectorSettingsActivity(connector.id);
        }
        return true;
      } catch (error) {
        toast.error(
          getErrorMessage(error, t("toasts.connectors.settingsSaveFailed")),
        );
        return false;
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
    selectionSpecByType,
    connectorManifestInfoByType,
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
    handleReconnectConnector,
    handleCreateConnector,
    handleCancelConnector,
    handleCopyWebhook,
    handleSyncConnector,
    handleCheckFeed,
    handleAddFeed,
    handleCheckForum,
    handleAddForum,
    handleCheckSite,
    handleAddSite,
    handleCheckGhost,
    handleAddGhost,
    handleCheckCredential,
    handleAddCredential,
    rotateCredentialConnector,
    setRotateCredentialConnector,
    handleRotateCredential,
    loginFlowState,
    setLoginFlowState,
    handleAddLoginFlow,
    handleStartLoginFlow,
    handlePollLoginFlow,
    handleCancelLoginFlow,
    handleLoginFlowConnected,
    handleToggleConnectorStatus,
    handleSaveConnectorSettings,
    handleConfirmDisconnectConnector,
  };
}
