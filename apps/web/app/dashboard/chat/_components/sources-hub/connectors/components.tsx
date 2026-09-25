import { formatDisplayDate } from "@/lib/i18n/format";

import { useLocale as useDisplayLocale } from "next-intl";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  CirclePause,
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

import { useTranslations } from "next-intl";

import type { ConnectorSyncBlock, SourceConnector } from "@sourceweft/sdk";
import { useBillingAvailable } from "@/lib/billing-edition/capabilities";
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

/** Translator handed to the connector formatting helpers (see repo convention). */
type ConnectorT = ReturnType<typeof useTranslations>;

const syncReadinessUiByReason: Record<
  string,
  {
    summaryKey: string;
    suppressWebhookSetup?: boolean;
  }
> = {
  notion_no_pages: {
    summaryKey: "connectors.readinessNoPages",
    suppressWebhookSetup: true,
  },
};

function formatConnectorDate(
  value: string | null,
  t: ConnectorT,
  displayLocale: string,
) {
  return value
    ? formatDisplayDate(new Date(value), displayLocale)
    : t("connectors.never");
}

export function formatConnectorSchedule(
  connector: SourceConnector,
  t: ConnectorT,
) {
  if (!connector.periodicIndexingEnabled) {
    return t("connectors.schedule.manual");
  }
  const minutes = connector.indexingFrequencyMinutes;
  if (!minutes) {
    return t("connectors.schedule.auto");
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return t("connectors.schedule.everyDays", { count: days });
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return t("connectors.schedule.everyHours", { count: hours });
  }
  return t("connectors.schedule.everyMinutes", { count: minutes });
}

function statusTone(status: ConnectorCatalogStatusKind) {
  if (status === "active")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "syncing")
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (status === "connected" || status === "available")
    return "border-primary/30 bg-primary/10 text-primary";
  if (status === "needs_setup" || status === "blocked")
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "error")
    return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border bg-muted/50 text-muted-foreground";
}

function statusIcon(status: ConnectorCatalogStatusKind) {
  if (status === "active") return CheckCircle2;
  if (status === "syncing") return Loader2;
  if (status === "needs_setup") return Webhook;
  if (status === "blocked") return CirclePause;
  if (status === "error") return CircleAlert;
  return PlugIcon;
}

/** Why the platform paused this connector's syncs, in the user's terms. */
export function formatConnectorSyncBlock(
  block: ConnectorSyncBlock,
  t: ConnectorT,
) {
  return block.reason === "PAGES_LIMIT_EXCEEDED"
    ? t("connectors.syncBlock.pagesLimit", { count: block.indexedCount })
    : t("connectors.syncBlock.ownerUnavailable");
}

/**
 * A platform pause (quota, no billable owner) is a warning, not an error: the
 * connector is healthy and resumes on its own once the cause is resolved.
 */
export function ConnectorSyncBlockAlert({
  block,
  className,
}: {
  block: ConnectorSyncBlock;
  className?: string;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const billingAvailable = useBillingAvailable();
  return (
    <Alert
      className={cn(
        "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
        className,
      )}
    >
      <CirclePause className="size-4" />
      <AlertDescription className="text-inherit">
        <span>{formatConnectorSyncBlock(block, t)}</span>
        {block.reason === "PAGES_LIMIT_EXCEEDED" && billingAvailable ? (
          <Link
            className="font-medium underline underline-offset-2"
            href="/dashboard/billing"
          >
            {t("connectors.syncBlock.manageBilling")}
          </Link>
        ) : null}
      </AlertDescription>
    </Alert>
  );
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

export function compactConnectorProviderMeta(
  connector: ConnectorItem,
  t: ConnectorT,
) {
  const schedule = formatConnectorSchedule(connector.raw, t);
  return schedule;
}

function compactConnectorExecutionMeta(
  connector: ConnectorItem,
  t: ConnectorT,
  displayLocale: string,
) {
  const providerName = getConnectorProviderName(connector.raw.connectorType);
  const lastSync = connector.raw.lastIndexedAt
    ? t("connectors.lastSync", {
        date: formatDisplayDate(
          new Date(connector.raw.lastIndexedAt),
          displayLocale,
        ),
      })
    : t("connectors.neverSynced");
  return [providerName, lastSync].filter(Boolean).join(" · ");
}

export function formatConnectorReadinessSummary(
  readiness: ConnectorReadinessState | null,
  t: ConnectorT,
) {
  if (!readiness) {
    return null;
  }
  const summaryKey = syncReadinessUiByReason[readiness.reason]?.summaryKey;
  if (summaryKey) {
    return t(summaryKey);
  }
  return readiness.message ?? t("connectors.readinessSetupRequired");
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
  t: ConnectorT,
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
    message: message || t("connectors.readinessNotReady"),
  };
}

export function getCatalogConnector(
  item: ConnectorCatalogItem,
  connectors: ConnectorItem[],
) {
  return (
    connectors.find((connector) => connector.raw.connectorType === item.id) ??
    null
  );
}

function getOAuthConnectorStatus(
  input: {
    connector: ConnectorItem | null;
    hasActiveAccount: boolean;
    isBusy: boolean;
    item: ConnectorCatalogItem;
    readiness?: ConnectorReadinessState | null;
    webhookConfig: ConnectorWebhookConfig | null;
    t: ConnectorT;
  },
  displayLocale: string,
): ConnectorCatalogStatus {
  const t = input.t;
  if (input.isBusy) {
    return {
      kind: "syncing",
      label: t("connectors.status.syncing"),
      detail: t("connectors.detail.syncing"),
    };
  }

  const connector = input.connector;
  if (connector) {
    if (connector.status === "disabled") {
      return {
        kind: "needs_setup",
        label: t("connectors.status.disabled"),
        detail: t("connectors.detail.disabled"),
      };
    }
    if (connector.status === "error" || connector.raw.lastError) {
      return {
        kind: "error",
        label: t("connectors.status.error"),
        detail:
          connector.raw.lastError || t("connectors.detail.needsAttention"),
      };
    }
    if (connector.status === "paused") {
      return {
        kind: "needs_setup",
        label: t("connectors.status.paused"),
        detail: t("connectors.detail.paused"),
      };
    }
    if (connector.raw.syncBlock) {
      return {
        kind: "blocked",
        label: t("connectors.status.blocked"),
        detail: formatConnectorSyncBlock(connector.raw.syncBlock, t),
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
        label: t("connectors.status.needs_setup"),
        detail: t("connectors.detail.needsSetupWebhook"),
      };
    }
    return {
      kind: "active",
      label: t("connectors.status.active"),
      detail:
        formatConnectorReadinessSummary(input.readiness ?? null, t) ??
        t("connectors.detail.lastSync", {
          date: formatConnectorDate(
            connector.raw.lastIndexedAt,
            t,
            displayLocale,
          ),
        }),
    };
  }

  if (input.hasActiveAccount) {
    return {
      kind: "connected",
      label: t("connectors.status.connected"),
      detail:
        input.item.postOAuthMode === "auto_create"
          ? t("connectors.detail.connectedAutoCreate")
          : t("connectors.detail.connectedConfigure"),
    };
  }

  return {
    kind: "available",
    label: t("connectors.status.available"),
    detail: t("connectors.detail.available", { name: input.item.name }),
  };
}

export function getCatalogStatus(
  input: {
    item: ConnectorCatalogItem;
    connectors: ConnectorItem[];
    accounts: ConnectorAccountItem[];
    connectorBusyById: Record<string, boolean>;
    connectorWaitingByType: Record<string, boolean>;
    connectorReadinessById?: Record<string, ConnectorReadinessState>;
    webhookConfigsById: Record<string, ConnectorWebhookConfig | null>;
    t: ConnectorT;
  },
  displayLocale: string,
): ConnectorCatalogStatus {
  const t = input.t;
  const connector = getCatalogConnector(input.item, input.connectors);
  const hasActiveAccount = input.accounts.some(
    (account) =>
      account.connectorType === input.item.id && account.status === "active",
  );
  return getOAuthConnectorStatus(
    {
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
      t,
    },
    displayLocale,
  );
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
  }: {
    item: ConnectorCatalogItem;
    status: ConnectorCatalogStatus;
    connector: ConnectorItem | null;
    onCancelConnector: (item: ConnectorCatalogItem) => void;
    onConfigure: () => void;
    onConnectConnector: (item: ConnectorCatalogItem) => void;
    onCreateConnector: (item: ConnectorCatalogItem) => void;
    onDisconnect: (connector: ConnectorItem) => void;
  }) {
    const t = useTranslations("dashboardSourcesHub");
    const isBusy = status.kind === "syncing";
    const cta = isBusy
      ? t("connectors.cta.connecting")
      : connector
        ? t("connectors.cta.connected")
        : status.kind === "connected" && item.postOAuthMode !== "auto_create"
          ? t("connectors.cta.configure")
          : t("connectors.cta.connect");

    function handleAction() {
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
                    title={t("connectors.disconnect", { name: item.name })}
                    type="button"
                    variant="ghost"
                  >
                    <Power className="size-3.5" />
                    <span className="sr-only">
                      {t("connectors.disconnect", { name: item.name })}
                    </span>
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="mt-1.5 hidden flex-wrap gap-1 sm:flex">
              <TypeBadge
                label={
                  item.isIndexable
                    ? t("connectors.type.indexable")
                    : t("connectors.type.searchApi")
                }
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
                <span className="sr-only">
                  {t("connectors.configure", { name: item.name })}
                </span>
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
                {t("connectors.cancel")}
              </Button>
            ) : null}
            <Button
              className="shrink-0"
              disabled={isBusy || Boolean(connector)}
              onClick={handleAction}
              size="xs"
              type="button"
              variant={connector ? "outline" : "default"}
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
  const displayLocale = useDisplayLocale();
  const t = useTranslations("dashboardSourcesHub");
  const isBusy = Boolean(connectorBusyById[connector.id]);
  const catalogItem =
    connectorCatalog.find((item) => item.id === connector.raw.connectorType) ??
    connectorCatalog.find((item) => item.id === "notion");
  const icon = catalogItem?.icon ?? Link2;
  const status = getOAuthConnectorStatus(
    {
      connector,
      hasActiveAccount: true,
      isBusy,
      item: catalogItem ?? {
        id: connector.raw.connectorType,
        name: connector.raw.connectorType,
        category: "Knowledge & Docs",
        description: connector.meta,
        capabilities: [],
        postOAuthMode: "configure_required",
        icon: Link2,
        isIndexable: true,
        supportsPeriodicSync: true,
        supportsActions: false,
        supportsWebhook: false,
      },
      readiness: connectorReadinessById[connector.id] ?? null,
      webhookConfig: catalogItem?.supportsWebhook ? webhookConfig : null,
      t,
    },
    displayLocale,
  );
  const statusToggleLabel =
    connector.status === "disabled"
      ? t("connectors.enableShort")
      : connector.status === "paused"
        ? t("connectors.resumeShort")
        : t("connectors.pauseShort");
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
            {t("connectors.backToCatalog")}
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
                  title={t("connectors.openSettings", { name: providerName })}
                  type="button"
                >
                  {providerName}
                </button>
              </h4>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {compactConnectorExecutionMeta(connector, t, displayLocale)}
              </p>
            </div>
            <div className="hidden shrink-0 sm:block">
              <ConnectorStatusBadge status={status} />
            </div>
            <Button
              className="size-7 shrink-0"
              onClick={() => onOpenSettings(connector)}
              size="icon-xs"
              title={t("connectors.openSettings", { name: providerName })}
              type="button"
              variant="ghost"
            >
              <Settings2 className="size-3.5" />
              <span className="sr-only">
                {t("connectors.openSettings", { name: providerName })}
              </span>
            </Button>
          </div>
          {connector.raw.lastError ? (
            <Alert className="mt-3" variant="destructive">
              <AlertDescription>{connector.raw.lastError}</AlertDescription>
            </Alert>
          ) : null}
          {connector.raw.syncBlock ? (
            <ConnectorSyncBlockAlert
              block={connector.raw.syncBlock}
              className="mt-3"
            />
          ) : null}
          {catalogItem?.supportsWebhook && webhookConfig ? (
            <div className="mt-3 rounded-lg border bg-muted/25 p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <Webhook className="size-3.5" />
                  {t("connectors.webhookUrl")}
                </span>
                {!webhookConfig.isConfigured ? (
                  <Badge
                    className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
                    variant="outline"
                  >
                    {t("connectors.webhookLocal")}
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
                  <span className="sr-only">{t("connectors.copyWebhook")}</span>
                </Button>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                {t("connectors.webhookNote", { name: providerName })}
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
              ? t("connectors.syncPausedManual", { name: providerName })
              : connector.status === "disabled"
                ? t("connectors.isDisabled", { name: providerName })
                : t("connectors.sync", { name: providerName })
          }
          type="button"
          variant="outline"
        >
          {isBusy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          {t("connectors.syncNow")}
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
          title={t("connectors.removeAria", { name: providerName })}
          type="button"
          variant="ghost"
        >
          <Power className="size-3.5" />
          {t("connectors.removeShort")}
        </Button>
      </div>
    </article>
  );
});
