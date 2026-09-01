import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Copy,
  Link2,
  Loader2,
  Play,
  Power,
  PowerOff,
  RotateCcw,
  Settings2,
  Webhook,
  X,
} from "lucide-react";

import type { SourceConnector } from "@sourceweft/sdk";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  GlobalIcon,
  type GlobalIconName,
  type GlobalIconTone,
} from "@sourceweft/ui-web/components/ui/global-icon";
import { cn } from "@sourceweft/ui-web/lib/utils";

import { RawImage } from "../../../../../_components/raw-image";
import { memoComponent } from "../memo-component";
import { TypeBadge } from "../type-badge";
import { connectorCatalog } from "./catalog";
import type {
  ConnectorAccountItem,
  ConnectorCatalogItem,
  ConnectorCatalogStatus,
  ConnectorCatalogStatusKind,
  ConnectorIcon,
  ConnectorItem,
  ConnectorReadinessState,
  ConnectorWebhookConfig,
  ConnectorWebhookEventItem,
} from "./types";

export const disabledConnectorIconButtonClass =
  "disabled:pointer-events-auto disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground";

const syncReadinessUiByReason: Record<
  string,
  {
    summary: string;
    suppressWebhookSetup?: boolean;
  }
> = {
  notion_no_pages: {
    summary: "Connected · No pages shared",
    suppressWebhookSetup: true,
  },
};

function formatConnectorDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}

export function formatConnectorSchedule(connector: SourceConnector) {
  if (!connector.periodicIndexingEnabled) {
    return "Manual sync";
  }
  const minutes = connector.indexingFrequencyMinutes;
  if (!minutes) {
    return "Auto sync";
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `Auto sync every ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `Auto sync every ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `Auto sync every ${minutes} min`;
}

function statusTone(status: ConnectorCatalogStatusKind) {
  if (status === "active")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "syncing")
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (status === "connected" || status === "available")
    return "border-primary/30 bg-primary/10 text-primary";
  if (status === "needs_setup")
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "error")
    return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border bg-muted/50 text-muted-foreground";
}

function statusIcon(status: ConnectorCatalogStatusKind) {
  if (status === "active") return CheckCircle2;
  if (status === "syncing") return Loader2;
  if (status === "needs_setup") return Webhook;
  if (status === "error") return CircleAlert;
  if (status === "coming_soon") return Clock3;
  return PlugIcon;
}

export function PlugIcon({ className }: { className?: string }) {
  return <Link2 className={className} />;
}

function getConnectorProviderName(connectorType: string) {
  return (
    connectorCatalog.find((item) => item.id === connectorType)?.name ??
    connectorType
  );
}

export function getConnectorDisplayName(connector: ConnectorItem) {
  const providerName = getConnectorProviderName(connector.raw.connectorType);
  const accountLabel = getConnectorAccountLabel(connector);
  return accountLabel ? `${accountLabel} - ${providerName}` : providerName;
}

export function getConnectorAccountLabel(connector: ConnectorItem) {
  const providerName = getConnectorProviderName(connector.raw.connectorType);
  const normalizedProviderName = providerName.toLowerCase();
  const name = connector.name.trim();
  if (!name || name.toLowerCase() === normalizedProviderName) {
    return null;
  }
  const displaySuffix = ` - ${providerName}`;
  if (name.toLowerCase().endsWith(displaySuffix.toLowerCase())) {
    const accountLabel = name.slice(0, -displaySuffix.length).trim();
    return accountLabel || null;
  }
  return name;
}

export function compactConnectorProviderMeta(connector: ConnectorItem) {
  const schedule = formatConnectorSchedule(connector.raw);
  return schedule;
}

function compactConnectorExecutionMeta(connector: ConnectorItem) {
  const providerName = getConnectorProviderName(connector.raw.connectorType);
  const lastSync = connector.raw.lastIndexedAt
    ? `Last sync ${new Date(connector.raw.lastIndexedAt).toLocaleString()}`
    : "Never synced";
  return [providerName, lastSync].filter(Boolean).join(" · ");
}

export function formatConnectorReadinessSummary(
  readiness: ConnectorReadinessState | null,
) {
  if (!readiness) {
    return null;
  }
  return (
    syncReadinessUiByReason[readiness.reason]?.summary ??
    readiness.message ??
    "Connected · Setup required"
  );
}

function shouldSurfaceWebhookSetupStatus(
  readiness: ConnectorReadinessState | null,
) {
  if (!readiness) {
    return true;
  }
  return !syncReadinessUiByReason[readiness.reason]?.suppressWebhookSetup;
}

export function getConnectorReadinessFromConfig(
  connector: SourceConnector,
): ConnectorReadinessState | null {
  const state = connector.configJson.syncReadiness;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const record = state as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason : "";
  const message = typeof record.message === "string" ? record.message : "";
  if (!reason) {
    return null;
  }
  return {
    reason,
    message: message || "Connector is not ready to sync.",
  };
}

export function getCatalogConnector(
  item: ConnectorCatalogItem,
  connectors: ConnectorItem[],
) {
  if (item.connectMode !== "oauth_connector") return null;
  return (
    connectors.find((connector) => connector.raw.connectorType === item.id) ??
    null
  );
}

function getOAuthConnectorStatus(input: {
  connector: ConnectorItem | null;
  hasActiveAccount: boolean;
  isBusy: boolean;
  item: ConnectorCatalogItem;
  readiness?: ConnectorReadinessState | null;
  webhookConfig: ConnectorWebhookConfig | null;
}): ConnectorCatalogStatus {
  if (input.isBusy) {
    return {
      kind: "syncing",
      label: "Syncing",
      detail: "A connector operation is running.",
    };
  }

  const connector = input.connector;
  if (connector) {
    if (connector.status === "disabled") {
      return {
        kind: "needs_setup",
        label: "Disabled",
        detail: "Syncing is disabled. Enable this connector to resume.",
      };
    }
    if (connector.status === "error" || connector.raw.lastError) {
      return {
        kind: "error",
        label: "Error",
        detail: connector.raw.lastError || "Connector needs attention.",
      };
    }
    if (connector.status === "paused") {
      return {
        kind: "needs_setup",
        label: "Paused",
        detail: "Syncing is paused until you resume this connector.",
      };
    }
    if (
      input.item.supportsWebhook &&
      shouldSurfaceWebhookSetupStatus(input.readiness ?? null) &&
      input.webhookConfig &&
      !input.webhookConfig.isConfigured
    ) {
      return {
        kind: "needs_setup",
        label: "Needs setup",
        detail: "Configure a public HTTPS webhook endpoint.",
      };
    }
    return {
      kind: "active",
      label: "Active",
      detail:
        formatConnectorReadinessSummary(input.readiness ?? null) ??
        `Last sync ${formatConnectorDate(connector.raw.lastIndexedAt)}`,
    };
  }

  if (input.hasActiveAccount) {
    return {
      kind: "connected",
      label: "Connected",
      detail:
        input.item.postOAuthMode === "auto_create"
          ? "Authorization exists without an active connector. Reconnect to create a connector."
          : "OAuth is connected. Configure this connector to enable syncing.",
    };
  }

  return {
    kind: "available",
    label: "Available",
    detail: `Ready to connect with ${input.item.name} OAuth.`,
  };
}

export function getCatalogStatus(input: {
  item: ConnectorCatalogItem;
  connectors: ConnectorItem[];
  accounts: ConnectorAccountItem[];
  connectorBusyById: Record<string, boolean>;
  connectorWaitingByType: Record<string, boolean>;
  connectorReadinessById?: Record<string, ConnectorReadinessState>;
  webhookConfigsById: Record<string, ConnectorWebhookConfig | null>;
}): ConnectorCatalogStatus {
  if (input.item.connectMode === "coming_soon") {
    if (input.item.statusKind === "non_indexable") {
      return {
        kind: "coming_soon",
        label: "Search API",
        detail: "Non-indexable connector for live agent search.",
      };
    }
    if (input.item.statusKind === "indexable") {
      return {
        kind: "coming_soon",
        label: "Indexable",
        detail: "Indexable data source connector on the roadmap.",
      };
    }
    return {
      kind: "coming_soon",
      label: "Coming soon",
      detail: input.item.isIndexable
        ? "Indexable data source connector on the roadmap."
        : "Non-indexable connector on the roadmap.",
    };
  }
  const connector = getCatalogConnector(input.item, input.connectors);
  const hasActiveAccount = input.accounts.some(
    (account) =>
      account.connectorType === input.item.id && account.status === "active",
  );
  return getOAuthConnectorStatus({
    connector,
    hasActiveAccount: hasActiveAccount && !connector,
    isBusy: Boolean(
      input.connectorWaitingByType[input.item.id] ||
      (connector && input.connectorBusyById[connector.id]),
    ),
    item: input.item,
    readiness: connector
      ? (input.connectorReadinessById?.[connector.id] ?? null)
      : null,
    webhookConfig: connector
      ? (input.webhookConfigsById[connector.id] ?? null)
      : null,
  });
}

function ConnectorStatusBadge({ status }: { status: ConnectorCatalogStatus }) {
  const Icon = statusIcon(status.kind);
  return (
    <Badge
      className={cn(
        "h-5 max-w-full gap-1 border px-1.5 text-[10px]",
        statusTone(status.kind),
      )}
      variant="outline"
    >
      <Icon
        className={cn("size-3", status.kind === "syncing" && "animate-spin")}
      />
      {status.label}
    </Badge>
  );
}

export function ConnectorLogo({
  icon: Icon,
  logoIconName,
  logoIconTone,
  logoSrc,
  label,
  active,
  className,
}: {
  icon: ConnectorIcon;
  logoIconName?: GlobalIconName;
  logoIconTone?: GlobalIconTone;
  logoSrc?: string;
  label?: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background shadow-xs",
        active && "border-primary/40 bg-primary/5 text-primary",
        className,
      )}
    >
      {logoIconName ? (
        <GlobalIcon
          className="size-6"
          fallbackIconName="tool"
          iconName={logoIconName}
          iconTone={logoIconTone ?? "brand"}
        />
      ) : logoSrc ? (
        <RawImage
          alt=""
          aria-hidden="true"
          className="size-6 object-contain"
          src={logoSrc}
          title={label}
        />
      ) : (
        <Icon className="size-4" />
      )}
    </div>
  );
}

export const ConnectorCatalogCard = memoComponent(
  function ConnectorCatalogCard({
    item,
    status,
    connector,
    onCancelConnector,
    onConfigure,
    onConnectConnector,
    onCreateConnector,
    onDisconnect,
    onRequestConnector,
  }: {
    item: ConnectorCatalogItem;
    status: ConnectorCatalogStatus;
    connector: ConnectorItem | null;
    onCancelConnector: (item: ConnectorCatalogItem) => void;
    onConfigure: () => void;
    onConnectConnector: (item: ConnectorCatalogItem) => void;
    onCreateConnector: (item: ConnectorCatalogItem) => void;
    onDisconnect: (connector: ConnectorItem) => void;
    onRequestConnector: (item: ConnectorCatalogItem) => void;
  }) {
    const isBusy = status.kind === "syncing";
    const cta =
      item.connectMode === "coming_soon"
        ? "Request"
        : isBusy
          ? "Connecting..."
          : connector
            ? "Connected"
            : status.kind === "connected" &&
                item.postOAuthMode !== "auto_create"
              ? "Configure"
              : "Connect";

    function handleAction() {
      if (item.connectMode === "coming_soon") {
        onRequestConnector(item);
        return;
      }
      if (connector) {
        return;
      }
      if (status.kind === "connected" && item.postOAuthMode !== "auto_create") {
        onCreateConnector(item);
        return;
      }
      onConnectConnector(item);
    }

    return (
      <article
        className={cn(
          "group flex min-h-[96px] flex-col justify-between rounded-lg border bg-background p-2.5 shadow-xs transition-colors hover:bg-accent/30",
          status.kind === "error" && "border-destructive/30",
        )}
      >
        <div className="flex items-start gap-2.5">
          <ConnectorLogo
            active={status.kind === "active" || status.kind === "connected"}
            icon={item.icon}
            label={item.name}
            logoIconName={item.logoIconName}
            logoIconTone={item.logoIconTone}
            logoSrc={item.logoSrc}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start justify-between gap-1.5">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-medium text-foreground">
                  {item.name}
                </h4>
                <p className="mt-0.5 line-clamp-1 text-xs leading-5 text-muted-foreground">
                  {item.description}
                </p>
              </div>
              <div className="flex shrink-0 items-start gap-1">
                <div className="hidden max-w-[120px] sm:block">
                  <ConnectorStatusBadge status={status} />
                </div>
                {connector ? (
                  <Button
                    className="size-7 text-destructive opacity-80 hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
                    disabled={isBusy}
                    onClick={() => onDisconnect(connector)}
                    size="icon-xs"
                    title={`Disconnect ${item.name}`}
                    type="button"
                    variant="ghost"
                  >
                    <Power className="size-3.5" />
                    <span className="sr-only">Disconnect {item.name}</span>
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="mt-1.5 hidden flex-wrap gap-1 sm:flex">
              <TypeBadge
                label={item.isIndexable ? "Indexable" : "Search API"}
              />
              {item.capabilities.slice(0, 2).map((capability) => (
                <TypeBadge key={capability} label={capability} />
              ))}
            </div>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="truncate text-[10px] text-muted-foreground">
            {status.detail}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {connector ? (
              <Button
                className="size-7"
                onClick={onConfigure}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <Settings2 className="size-3.5" />
                <span className="sr-only">Configure {item.name}</span>
              </Button>
            ) : null}
            {isBusy ? (
              <Button
                className="h-7 px-2 text-[11px]"
                onClick={() => onCancelConnector(item)}
                size="sm"
                type="button"
                variant="outline"
              >
                <X className="size-3.5" />
                Cancel
              </Button>
            ) : null}
            <Button
              className="shrink-0"
              disabled={isBusy || Boolean(connector)}
              onClick={handleAction}
              size="xs"
              type="button"
              variant={
                connector || status.kind === "coming_soon"
                  ? "outline"
                  : "default"
              }
            >
              {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {cta}
            </Button>
          </div>
        </div>
      </article>
    );
  },
);

export const ActiveConnectorCard = memoComponent(function ActiveConnectorCard({
  connector,
  connectorBusyById,
  connectorReadinessById,
  webhookConfig,
  webhookEvents,
  onCopyWebhook,
  onDisconnect,
  onBackToCatalog,
  onOpenSettings,
  onSyncConnector,
  onToggleStatus,
}: {
  connector: ConnectorItem;
  connectorBusyById: Record<string, boolean>;
  connectorReadinessById: Record<string, ConnectorReadinessState>;
  webhookConfig: ConnectorWebhookConfig | null;
  webhookEvents: ConnectorWebhookEventItem[];
  onCopyWebhook: (value: string) => void;
  onDisconnect: (connector: ConnectorItem) => void;
  onBackToCatalog?: () => void;
  onOpenSettings: (connector: ConnectorItem) => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleStatus: (connector: ConnectorItem) => void;
}) {
  const isBusy = Boolean(connectorBusyById[connector.id]);
  const catalogItem =
    connectorCatalog.find((item) => item.id === connector.raw.connectorType) ??
    connectorCatalog.find((item) => item.id === "notion");
  const icon = catalogItem?.icon ?? Link2;
  const status = getOAuthConnectorStatus({
    connector,
    hasActiveAccount: true,
    isBusy,
    item: catalogItem ?? {
      id: connector.raw.connectorType,
      name: connector.raw.connectorType,
      category: "Knowledge & Docs",
      description: connector.meta,
      capabilities: [],
      connectMode: "oauth_connector",
      postOAuthMode: "configure_required",
      icon: Link2,
      isIndexable: true,
      authKind: "oauth",
      supportsPeriodicSync: true,
      supportsActions: false,
      supportsWebhook: false,
      statusKind: "coming_soon",
    },
    readiness: connectorReadinessById[connector.id] ?? null,
    webhookConfig: catalogItem?.supportsWebhook ? webhookConfig : null,
  });
  const statusToggleLabel =
    connector.status === "disabled"
      ? "Enable"
      : connector.status === "paused"
        ? "Resume"
        : "Pause";
  const StatusToggleIcon =
    connector.status === "disabled" || connector.status === "paused"
      ? Play
      : PowerOff;
  const providerName = getConnectorDisplayName(connector);

  return (
    <article className="rounded-lg border bg-background p-2.5 shadow-xs">
      {onBackToCatalog ? (
        <div className="mb-2">
          <Button
            className="h-7 px-2 text-[11px]"
            onClick={onBackToCatalog}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft className="size-3.5" />
            Back to catalog
          </Button>
        </div>
      ) : null}
      <div className="flex items-start gap-2.5">
        <ConnectorLogo
          active={connector.status === "active"}
          icon={icon}
          label={providerName}
          logoIconName={catalogItem?.logoIconName}
          logoIconTone={catalogItem?.logoIconTone}
          logoSrc={catalogItem?.logoSrc}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h4 className="min-w-0">
                <button
                  className="block max-w-full truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => onOpenSettings(connector)}
                  title={`Open ${providerName} settings`}
                  type="button"
                >
                  {providerName}
                </button>
              </h4>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {compactConnectorExecutionMeta(connector)}
              </p>
            </div>
            <div className="hidden shrink-0 sm:block">
              <ConnectorStatusBadge status={status} />
            </div>
            <Button
              className="size-7 shrink-0"
              onClick={() => onOpenSettings(connector)}
              size="icon-xs"
              title={`Open ${providerName} settings`}
              type="button"
              variant="ghost"
            >
              <Settings2 className="size-3.5" />
              <span className="sr-only">Open {providerName} settings</span>
            </Button>
          </div>
          {connector.raw.lastError ? (
            <Alert className="mt-3" variant="destructive">
              <AlertDescription>{connector.raw.lastError}</AlertDescription>
            </Alert>
          ) : null}
          {catalogItem?.supportsWebhook && webhookConfig ? (
            <div className="mt-3 rounded-lg border bg-muted/25 p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <Webhook className="size-3.5" />
                  Webhook URL
                </span>
                {!webhookConfig.isConfigured ? (
                  <Badge
                    className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
                    variant="outline"
                  >
                    local
                  </Badge>
                ) : null}
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1 text-[10px] text-muted-foreground">
                  {webhookConfig.webhookUrl}
                </code>
                <Button
                  className="size-7"
                  onClick={() => onCopyWebhook(webhookConfig.webhookUrl)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Copy className="size-3.5" />
                  <span className="sr-only">Copy webhook URL</span>
                </Button>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                Add this URL in {providerName} connection settings after OAuth
                is complete. Provider webhooks require public HTTPS.
              </p>
              {catalogItem?.webhookSupportNote ? (
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  {catalogItem.webhookSupportNote}
                </p>
              ) : null}
              {webhookEvents.length > 0 ? (
                <div className="mt-2 space-y-1 border-t pt-2">
                  {webhookEvents.slice(0, 3).map((event) => (
                    <div
                      className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
                      key={event.id}
                    >
                      <span className="truncate">{event.eventType}</span>
                      <span className="shrink-0">{event.status}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button
          className={disabledConnectorIconButtonClass}
          disabled={connector.status === "disabled" || isBusy}
          onClick={() => onSyncConnector(connector)}
          size="xs"
          title={
            connector.status === "paused"
              ? `Sync paused ${providerName} manually`
              : connector.status === "disabled"
                ? `${providerName} is disabled`
                : `Sync ${providerName}`
          }
          type="button"
          variant="outline"
        >
          {isBusy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          Sync now
        </Button>
        <Button
          className={disabledConnectorIconButtonClass}
          disabled={isBusy}
          onClick={() => onToggleStatus(connector)}
          size="xs"
          title={`${statusToggleLabel} ${providerName}`}
          type="button"
          variant="outline"
        >
          <StatusToggleIcon className="size-3.5" />
          {statusToggleLabel}
        </Button>
        <Button
          className={disabledConnectorIconButtonClass}
          disabled={isBusy}
          onClick={() => onDisconnect(connector)}
          size="xs"
          title={`Remove ${providerName}`}
          type="button"
          variant="ghost"
        >
          <Power className="size-3.5" />
          Remove
        </Button>
      </div>
    </article>
  );
});
