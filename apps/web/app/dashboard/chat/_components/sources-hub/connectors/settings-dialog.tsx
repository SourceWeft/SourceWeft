import { useEffect, useState } from "react";
import {
  Copy,
  Link2,
  Loader2,
  Play,
  Power,
  PowerOff,
  RotateCcw,
  Settings2,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";

import type { ConnectorActivityItem, SourceConnector } from "@sourceweft/sdk";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { Separator } from "@sourceweft/ui-web/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";

import { TypeBadge } from "../type-badge";
import { ActivityList } from "./activity";
import {
  connectorCatalog,
  connectorSyncFrequencyOptions,
  connectorSyncFrequencyPresetValues,
} from "./catalog";
import {
  ConnectorLogo,
  disabledConnectorIconButtonClass,
  formatConnectorReadinessSummary,
  formatConnectorSchedule,
  getConnectorAccountLabel,
  getConnectorDisplayName,
  getConnectorReadinessFromConfig,
} from "./components";
import type {
  ConnectorItem,
  ConnectorReadinessState,
  ConnectorWebhookConfig,
} from "./types";

export type ConnectorSettingsTab =
  | "overview"
  | "configuration"
  | "sync"
  | "actions"
  | "webhooks"
  | "danger";

function getConnectorFrequencyFormState(connector: SourceConnector) {
  if (!connector.periodicIndexingEnabled) {
    return {
      frequencyValue: "manual",
      customFrequencyMinutes:
        connector.indexingFrequencyMinutes?.toString() ?? "360",
    };
  }

  const minutes = connector.indexingFrequencyMinutes ?? 360;
  const value = minutes.toString();
  if (connectorSyncFrequencyPresetValues.has(value)) {
    return {
      frequencyValue: value,
      customFrequencyMinutes: value,
    };
  }
  return {
    frequencyValue: "custom",
    customFrequencyMinutes: value,
  };
}

export function ConnectorSettingsDialog({
  activity,
  activityError,
  connector,
  connectorBusyById,
  connectorReadinessById,
  isLoadingActivity,
  onCopyWebhook,
  onDisconnect,
  onOpenChange,
  onSaveSettings,
  onSyncConnector,
  onToggleStatus,
  open,
  webhookConfig,
}: {
  activity: ConnectorActivityItem[];
  activityError: string | null;
  connector: ConnectorItem | null;
  connectorBusyById: Record<string, boolean>;
  connectorReadinessById: Record<string, ConnectorReadinessState>;
  isLoadingActivity: boolean;
  onCopyWebhook: (value: string) => void;
  onDisconnect: (connector: ConnectorItem) => void;
  onOpenChange: (open: boolean) => void;
  onSaveSettings: (
    connector: ConnectorItem,
    input: {
      name: string;
      periodicIndexingEnabled: boolean;
      indexingFrequencyMinutes: number | null;
    },
  ) => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleStatus: (connector: ConnectorItem) => void;
  open: boolean;
  webhookConfig: ConnectorWebhookConfig | null;
}) {
  const [tab, setTab] = useState<ConnectorSettingsTab>("overview");
  const connectorType = connector?.raw.connectorType ?? "connector";
  const catalogItem =
    connectorCatalog.find((item) => item.id === connectorType) ?? null;
  const providerName = connector
    ? getConnectorDisplayName(connector)
    : connectorType;
  const isBusy = connector ? Boolean(connectorBusyById[connector.id]) : false;
  const readiness = connector
    ? (connectorReadinessById[connector.id] ??
      getConnectorReadinessFromConfig(connector.raw))
    : null;
  const latestActivity = activity[0] ?? null;
  const latestSuccessfulSync = activity.find(
    (item) => item.kind === "sync" && item.status === "succeeded",
  );
  const overviewStatus = connector?.raw.lastError
    ? "Needs attention"
    : (formatConnectorReadinessSummary(readiness) ?? connector?.status);
  const statusToggleLabel =
    connector?.status === "disabled"
      ? "Enable"
      : connector?.status === "paused"
        ? "Resume"
        : "Pause";
  const StatusToggleIcon =
    connector?.status === "disabled" || connector?.status === "paused"
      ? Play
      : PowerOff;
  const initialFrequencyState = connector
    ? getConnectorFrequencyFormState(connector.raw)
    : { frequencyValue: "manual", customFrequencyMinutes: "360" };
  const [settingsName, setSettingsName] = useState(connector?.name ?? "");
  const [frequencyValue, setFrequencyValue] = useState(
    initialFrequencyState.frequencyValue,
  );
  const [customFrequencyMinutes, setCustomFrequencyMinutes] = useState(
    initialFrequencyState.customFrequencyMinutes,
  );
  const canUsePeriodicSync = catalogItem?.isIndexable ?? true;
  const isSavingSettings = isBusy;

  useEffect(() => {
    if (open) {
      setTab("overview");
    }
  }, [open, connector?.id]);

  useEffect(() => {
    if (!connector) return;
    const next = getConnectorFrequencyFormState(connector.raw);
    setSettingsName(connector.name);
    setFrequencyValue(next.frequencyValue);
    setCustomFrequencyMinutes(next.customFrequencyMinutes);
  }, [connector]);

  if (!connector) {
    return null;
  }

  const parsedCustomFrequency = Number(customFrequencyMinutes);
  const hasValidCustomFrequency =
    Number.isInteger(parsedCustomFrequency) && parsedCustomFrequency > 0;
  const isSettingsValid =
    settingsName.trim().length > 0 &&
    (frequencyValue !== "custom" || hasValidCustomFrequency);
  const settingsChanged =
    settingsName.trim() !== connector.name ||
    (frequencyValue === "manual" && connector.raw.periodicIndexingEnabled) ||
    (frequencyValue !== "manual" &&
      (!connector.raw.periodicIndexingEnabled ||
        (frequencyValue === "custom"
          ? parsedCustomFrequency
          : Number(frequencyValue)) !==
          connector.raw.indexingFrequencyMinutes));

  function handleSaveSettings() {
    const currentConnector = connector;
    if (!currentConnector) {
      return;
    }
    if (!isSettingsValid) {
      toast.error("Enter a connector name and a positive sync interval.");
      return;
    }
    if (!canUsePeriodicSync && frequencyValue !== "manual") {
      toast.error("This connector cannot use periodic sync.");
      return;
    }
    const periodicIndexingEnabled = frequencyValue !== "manual";
    const indexingFrequencyMinutes = periodicIndexingEnabled
      ? frequencyValue === "custom"
        ? parsedCustomFrequency
        : Number(frequencyValue)
      : null;
    onSaveSettings(currentConnector, {
      name: settingsName.trim(),
      periodicIndexingEnabled,
      indexingFrequencyMinutes,
    });
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid h-[min(860px,calc(100svh-1rem))] w-[min(960px,calc(100vw-1rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b px-4 py-3 pr-11 text-left sm:px-5 sm:py-4 sm:pr-12">
          <div className="flex min-w-0 items-start gap-3">
            <ConnectorLogo
              active={connector.status === "active"}
              icon={catalogItem?.icon ?? Link2}
              label={providerName}
              logoIconName={catalogItem?.logoIconName}
              logoIconTone={catalogItem?.logoIconTone}
              logoSrc={catalogItem?.logoSrc}
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <DialogTitle className="truncate text-lg sm:text-xl">
                  {providerName}
                </DialogTitle>
                {catalogItem ? (
                  <TypeBadge
                    label={catalogItem.isIndexable ? "Indexable" : "Search API"}
                  />
                ) : null}
              </div>
              <DialogDescription className="mt-1 text-xs leading-5 sm:text-sm">
                Connector settings, execution history, and provider events.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <Tabs
          className="min-h-0 gap-0"
          onValueChange={(value) => setTab(value as ConnectorSettingsTab)}
          value={tab}
        >
          <div className="border-b px-4 py-2 sm:px-5">
            <div className="sm:hidden">
              <Select
                onValueChange={(value) => setTab(value as ConnectorSettingsTab)}
                value={tab}
              >
                <SelectTrigger className="w-full" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="overview">Overview</SelectItem>
                  <SelectItem value="configuration">Configuration</SelectItem>
                  <SelectItem value="sync">Sync History</SelectItem>
                  <SelectItem value="actions">Actions</SelectItem>
                  <SelectItem value="webhooks">Webhooks</SelectItem>
                  <SelectItem value="danger">Danger Zone</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ScrollArea className="hidden sm:block">
              <TabsList className="w-max" variant="line">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="configuration">Configuration</TabsTrigger>
                <TabsTrigger value="sync">Sync History</TabsTrigger>
                <TabsTrigger value="actions">Actions</TabsTrigger>
                <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
                <TabsTrigger value="danger">Danger Zone</TabsTrigger>
              </TabsList>
            </ScrollArea>
          </div>

          <ScrollArea className="min-h-0">
            <div className="px-4 py-4 sm:px-5">
              <TabsContent className="m-0 space-y-4" value="overview">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">Status</p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {overviewStatus}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      Last successful sync
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {latestSuccessfulSync
                        ? new Date(
                            latestSuccessfulSync.createdAt,
                          ).toLocaleString()
                        : "Never"}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      Latest run
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {latestActivity
                        ? `${latestActivity.kind} · ${latestActivity.status}`
                        : "No activity"}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      Next scheduled
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {connector.raw.nextScheduledAt
                        ? new Date(
                            connector.raw.nextScheduledAt,
                          ).toLocaleString()
                        : "Not scheduled"}
                    </p>
                  </div>
                </div>
                {readiness ? (
                  <Alert>
                    <AlertDescription>{readiness.message}</AlertDescription>
                  </Alert>
                ) : null}
                {connector.raw.lastError ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {connector.raw.lastError}
                    </AlertDescription>
                  </Alert>
                ) : null}
                <ActivityList
                  description="Most recent connector execution records across syncs, actions, and webhooks."
                  emptyTitle="No connector activity yet."
                  items={activity}
                  kind="all"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0 space-y-4" value="configuration">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-medium text-foreground">
                      General
                    </p>
                    <div className="mt-3 space-y-3">
                      <label className="block space-y-1.5">
                        <span className="text-[10px] font-medium text-muted-foreground">
                          Name
                        </span>
                        <Input
                          className="h-8 text-xs"
                          disabled={isSavingSettings}
                          onChange={(event) =>
                            setSettingsName(event.target.value)
                          }
                          value={settingsName}
                        />
                      </label>
                      <label className="block space-y-1.5">
                        <span className="text-[10px] font-medium text-muted-foreground">
                          Sync schedule
                        </span>
                        <Select
                          disabled={!canUsePeriodicSync || isSavingSettings}
                          onValueChange={setFrequencyValue}
                          value={frequencyValue}
                        >
                          <SelectTrigger className="h-8 w-full text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {connectorSyncFrequencyOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                      {frequencyValue === "custom" ? (
                        <label className="block space-y-1.5">
                          <span className="text-[10px] font-medium text-muted-foreground">
                            Custom interval minutes
                          </span>
                          <Input
                            className="h-8 text-xs"
                            disabled={isSavingSettings}
                            min={1}
                            onChange={(event) =>
                              setCustomFrequencyMinutes(event.target.value)
                            }
                            type="number"
                            value={customFrequencyMinutes}
                          />
                        </label>
                      ) : null}
                      {!canUsePeriodicSync ? (
                        <p className="text-[10px] leading-4 text-muted-foreground">
                          Non-indexable search connectors cannot run periodic
                          indexing.
                        </p>
                      ) : null}
                      <Button
                        disabled={
                          isSavingSettings ||
                          !settingsChanged ||
                          !isSettingsValid
                        }
                        onClick={handleSaveSettings}
                        size="xs"
                        type="button"
                        variant="outline"
                      >
                        {isSavingSettings ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Settings2 className="size-3.5" />
                        )}
                        Save settings
                      </Button>
                    </div>
                    <dl className="mt-3 space-y-1 border-t pt-3 text-xs text-muted-foreground">
                      <div className="flex justify-between gap-3">
                        <dt>Schedule</dt>
                        <dd className="truncate text-foreground">
                          {formatConnectorSchedule(connector.raw)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Provider</dt>
                        <dd className="truncate text-foreground">
                          {providerName}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Connection</dt>
                        <dd className="truncate text-foreground">
                          {getConnectorAccountLabel(connector) ??
                            "Default connection"}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Account ID</dt>
                        <dd className="truncate text-foreground">
                          {connector.raw.oauthAccountId ?? "None"}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-medium text-foreground">
                      Capabilities
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {catalogItem ? (
                        <>
                          <TypeBadge
                            label={
                              catalogItem.isIndexable
                                ? "Indexable source"
                                : "Non-indexable search"
                            }
                          />
                          {catalogItem.supportsPeriodicSync ? (
                            <TypeBadge label="Periodic sync" />
                          ) : null}
                          {catalogItem.supportsActions ? (
                            <TypeBadge label="Actions" />
                          ) : null}
                          {catalogItem.supportsWebhook ? (
                            <TypeBadge label="Webhooks" />
                          ) : null}
                        </>
                      ) : (
                        <TypeBadge label="Connector" />
                      )}
                    </div>
                  </div>
                </div>
                {catalogItem?.supportsWebhook && webhookConfig ? (
                  <div className="rounded-lg border bg-muted/20 p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1 font-medium text-foreground">
                        <Webhook className="size-3.5" />
                        {providerName} webhook URL
                      </span>
                      {!webhookConfig.isConfigured ? (
                        <Badge variant="outline">needs public HTTPS</Badge>
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
                    {catalogItem?.webhookSupportNote ? (
                      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                        {catalogItem.webhookSupportNote} Events are recorded in
                        Webhooks and Activity.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </TabsContent>

              <TabsContent className="m-0" value="sync">
                <ActivityList
                  description="Manual, scheduled, webhook, backfill, and skipped sync attempts."
                  emptyTitle="No sync runs yet."
                  items={activity}
                  kind="sync"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0" value="actions">
                <ActivityList
                  description="Approved connector writes, updates, deletes, comments, and file uploads."
                  emptyTitle="No connector actions yet."
                  items={activity}
                  kind="action"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0" value="webhooks">
                <ActivityList
                  description="Provider events received from connector webhooks."
                  emptyTitle="No webhook events yet."
                  items={activity}
                  kind="webhook"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0 space-y-3" value="danger">
                <Alert variant="destructive">
                  <AlertDescription>
                    Remove stops this connector from syncing. Indexed sources
                    are kept unless you remove them separately.
                  </AlertDescription>
                </Alert>
                <Separator />
                <div className="flex flex-wrap gap-2">
                  <Button
                    className={disabledConnectorIconButtonClass}
                    disabled={connector.status === "disabled" || isBusy}
                    onClick={() => onSyncConnector(connector)}
                    size="sm"
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
                    size="sm"
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
                    size="sm"
                    title={`Remove ${providerName}`}
                    type="button"
                    variant="destructive"
                  >
                    <Power className="size-3.5" />
                    Remove
                  </Button>
                </div>
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
