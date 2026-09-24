import { formatDisplayDate } from "@/lib/i18n/format";

import { useLocale as useDisplayLocale } from "next-intl";
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
import { useTranslations } from "next-intl";

import type { ConnectorActivityItem, SourceConnector } from "@sourceweft/sdk";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
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
import { connectorsClient } from "../../../../../../lib/sdk";
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
  "overview" | "configuration" | "sync" | "actions" | "webhooks" | "danger";

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
      configJson?: Record<string, unknown>;
    },
  ) => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleStatus: (connector: ConnectorItem) => void;
  open: boolean;
  webhookConfig: ConnectorWebhookConfig | null;
}) {
  const displayLocale = useDisplayLocale();
  const t = useTranslations("dashboardSourcesHub");
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
      getConnectorReadinessFromConfig(connector.raw, t))
    : null;
  const latestActivity = activity[0] ?? null;
  const latestSuccessfulSync = activity.find(
    (item) => item.kind === "sync" && item.status === "succeeded",
  );
  const overviewStatus = connector?.raw.lastError
    ? t("connectors.overview.needsAttention")
    : (formatConnectorReadinessSummary(readiness, t) ??
      (connector
        ? t(`connectors.statusLabel.${connector.status}`)
        : undefined));
  const statusToggleLabel =
    connector?.status === "disabled"
      ? t("connectors.enableShort")
      : connector?.status === "paused"
        ? t("connectors.resumeShort")
        : t("connectors.pauseShort");
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
  const [gmailLiveSearch, setGmailLiveSearch] = useState(true);
  const [gmailIndexing, setGmailIndexing] = useState(false);
  const [gmailLabelIds, setGmailLabelIds] = useState<string[]>([]);
  const [gmailAfter, setGmailAfter] = useState("");
  const [gmailMaxMessages, setGmailMaxMessages] = useState("500");
  const [gmailLabels, setGmailLabels] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [gmailLabelsError, setGmailLabelsError] = useState<string | null>(null);
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
    setGmailLiveSearch(connector.raw.configJson.liveSearchEnabled !== false);
    setGmailIndexing(connector.raw.configJson.indexingEnabled === true);
    setGmailLabelIds(
      Array.isArray(connector.raw.configJson.labelIds)
        ? connector.raw.configJson.labelIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [],
    );
    setGmailAfter(
      typeof connector.raw.configJson.after === "string"
        ? connector.raw.configJson.after
        : "",
    );
    setGmailMaxMessages(
      typeof connector.raw.configJson.maxMessages === "number"
        ? String(connector.raw.configJson.maxMessages)
        : "500",
    );
  }, [connector]);

  useEffect(() => {
    if (!open || !connector || connector.raw.connectorType !== "gmail") return;
    let active = true;
    connectorsClient
      .listGmailLabels(connector.raw.workspaceId, connector.id)
      .then((result) => {
        if (active) {
          setGmailLabels(result.labels);
          setGmailLabelsError(null);
        }
      })
      .catch(() => {
        if (active) setGmailLabelsError(t("connectors.gmail.labelsLoadFailed"));
      });
    return () => {
      active = false;
    };
  }, [open, connector, t]);

  if (!connector) {
    return null;
  }

  const parsedCustomFrequency = Number(customFrequencyMinutes);
  const minFrequency = connector.raw.connectorType === "gmail" ? 60 : 1;
  const hasValidCustomFrequency =
    Number.isInteger(parsedCustomFrequency) &&
    parsedCustomFrequency >= minFrequency;
  const parsedGmailLimit = Number(gmailMaxMessages);
  const validGmailLimit =
    Number.isInteger(parsedGmailLimit) &&
    parsedGmailLimit >= 1 &&
    parsedGmailLimit <= 10000;
  const validGmailScope =
    !gmailIndexing ||
    (gmailLabelIds.length > 0 &&
      gmailAfter.length > 0 &&
      Number.isFinite(Date.parse(gmailAfter)));
  const isSettingsValid =
    settingsName.trim().length > 0 &&
    (frequencyValue !== "custom" || hasValidCustomFrequency) &&
    (connector.raw.connectorType !== "gmail" || validGmailLimit) &&
    (connector.raw.connectorType !== "gmail" || validGmailScope) &&
    (connector.raw.connectorType !== "gmail" ||
      gmailIndexing ||
      frequencyValue === "manual");
  const gmailConfig = {
    ...connector.raw.configJson,
    liveSearchEnabled: gmailLiveSearch,
    indexingEnabled: gmailIndexing,
    labelIds: gmailLabelIds,
    maxMessages: parsedGmailLimit,
    ...(gmailAfter ? { after: gmailAfter } : {}),
  };
  if (!gmailAfter) delete gmailConfig.after;
  const gmailChanged =
    connector.raw.connectorType === "gmail" &&
    JSON.stringify(gmailConfig) !== JSON.stringify(connector.raw.configJson);
  const settingsChanged =
    gmailChanged ||
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
    if (currentConnector.raw.connectorType === "gmail" && !validGmailScope) {
      toast.error(t("connectors.gmail.scopeRequired"));
      return;
    }
    if (!isSettingsValid) {
      toast.error(t("connectors.config.saveError"));
      return;
    }
    if (!canUsePeriodicSync && frequencyValue !== "manual") {
      toast.error(t("connectors.config.cannotPeriodic"));
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
      ...(connector.raw.connectorType === "gmail"
        ? { configJson: gmailConfig }
        : {}),
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
                    label={
                      catalogItem.isIndexable
                        ? t("connectors.type.indexable")
                        : t("connectors.type.searchApi")
                    }
                  />
                ) : null}
              </div>
              <DialogDescription className="mt-1 text-xs leading-5 sm:text-sm">
                {t("connectors.settingsDescription")}
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
                  <SelectItem value="overview">
                    {t("connectors.settingsTab.overview")}
                  </SelectItem>
                  <SelectItem value="configuration">
                    {t("connectors.settingsTab.configuration")}
                  </SelectItem>
                  <SelectItem value="sync">
                    {t("connectors.settingsTab.sync")}
                  </SelectItem>
                  <SelectItem value="actions">
                    {t("connectors.settingsTab.actions")}
                  </SelectItem>
                  <SelectItem value="webhooks">
                    {t("connectors.settingsTab.webhooks")}
                  </SelectItem>
                  <SelectItem value="danger">
                    {t("connectors.settingsTab.danger")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ScrollArea className="hidden sm:block">
              <TabsList className="w-max" variant="line">
                <TabsTrigger value="overview">
                  {t("connectors.settingsTab.overview")}
                </TabsTrigger>
                <TabsTrigger value="configuration">
                  {t("connectors.settingsTab.configuration")}
                </TabsTrigger>
                <TabsTrigger value="sync">
                  {t("connectors.settingsTab.sync")}
                </TabsTrigger>
                <TabsTrigger value="actions">
                  {t("connectors.settingsTab.actions")}
                </TabsTrigger>
                <TabsTrigger value="webhooks">
                  {t("connectors.settingsTab.webhooks")}
                </TabsTrigger>
                <TabsTrigger value="danger">
                  {t("connectors.settingsTab.danger")}
                </TabsTrigger>
              </TabsList>
            </ScrollArea>
          </div>

          <ScrollArea className="min-h-0">
            <div className="px-4 py-4 sm:px-5">
              <TabsContent className="m-0 space-y-4" value="overview">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      {t("connectors.overview.status")}
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {overviewStatus}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      {t("connectors.overview.lastSuccessfulSync")}
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {latestSuccessfulSync
                        ? formatDisplayDate(
                            new Date(
                              latestSuccessfulSync.finishedAt ??
                                latestSuccessfulSync.createdAt,
                            ),
                            displayLocale,
                          )
                        : t("connectors.overview.never")}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      {t("connectors.overview.latestRun")}
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {latestActivity
                        ? t("connectors.overview.latestRunValue", {
                            kind: latestActivity.kind,
                            status: latestActivity.status,
                          })
                        : t("connectors.overview.noActivity")}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      {t("connectors.overview.nextScheduled")}
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {connector.raw.nextScheduledAt
                        ? formatDisplayDate(
                            new Date(connector.raw.nextScheduledAt),
                            displayLocale,
                          )
                        : t("connectors.overview.notScheduled")}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground">
                      {t("connectors.overview.lastScheduledAttempt")}
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {connector.raw.scheduleStatus?.lastAttemptAt
                        ? formatDisplayDate(
                            new Date(
                              connector.raw.scheduleStatus.lastAttemptAt,
                            ),
                            displayLocale,
                          )
                        : t("connectors.overview.never")}
                    </p>
                  </div>
                  {connector.raw.scheduleStatus?.retryAt ? (
                    <div className="rounded-lg border bg-muted/20 p-3">
                      <p className="text-[10px] text-muted-foreground">
                        {t("connectors.overview.nextRetry")}
                      </p>
                      <p className="mt-1 text-sm font-medium text-foreground">
                        {formatDisplayDate(
                          new Date(connector.raw.scheduleStatus.retryAt),
                          displayLocale,
                        )}
                      </p>
                    </div>
                  ) : null}
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
                  description={t("connectors.overview.activityDescription")}
                  emptyTitle={t("connectors.overview.activityEmpty")}
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
                      {t("connectors.config.general")}
                    </p>
                    <div className="mt-3 space-y-3">
                      <label className="block space-y-1.5">
                        <span className="text-[10px] font-medium text-muted-foreground">
                          {t("connectors.config.name")}
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
                          {t("connectors.config.syncSchedule")}
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
                            {connectorSyncFrequencyOptions
                              .filter(
                                (option) =>
                                  option.value !== "15" || minFrequency <= 15,
                              )
                              .map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {t(`connectors.frequency.${option.value}`)}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </label>
                      {frequencyValue === "custom" ? (
                        <label className="block space-y-1.5">
                          <span className="text-[10px] font-medium text-muted-foreground">
                            {t("connectors.config.customIntervalMinutes")}
                          </span>
                          <Input
                            className="h-8 text-xs"
                            disabled={isSavingSettings}
                            min={minFrequency}
                            onChange={(event) =>
                              setCustomFrequencyMinutes(event.target.value)
                            }
                            type="number"
                            value={customFrequencyMinutes}
                          />
                        </label>
                      ) : null}
                      {connector.raw.connectorType === "gmail" ? (
                        <div className="space-y-3 rounded-md border p-3">
                          <label className="flex items-center gap-2 text-xs">
                            <Checkbox
                              checked={gmailLiveSearch}
                              disabled={isSavingSettings}
                              onCheckedChange={(checked) =>
                                setGmailLiveSearch(checked === true)
                              }
                            />
                            {t("connectors.gmail.liveSearch")}
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <Checkbox
                              checked={gmailIndexing}
                              disabled={isSavingSettings}
                              onCheckedChange={(checked) => {
                                setGmailIndexing(checked === true);
                                if (checked !== true)
                                  setFrequencyValue("manual");
                              }}
                            />
                            {t("connectors.gmail.indexMail")}
                          </label>
                          <p className="text-[10px] leading-4 text-muted-foreground">
                            {t("connectors.gmail.indexNotice")}
                          </p>
                          {gmailIndexing ? (
                            <>
                              {!validGmailScope ? (
                                <p className="text-xs text-destructive">
                                  {t("connectors.gmail.scopeRequired")}
                                </p>
                              ) : null}
                              <label className="block space-y-1.5 text-xs">
                                <span>{t("connectors.gmail.after")}</span>
                                <Input
                                  disabled={isSavingSettings}
                                  onChange={(event) =>
                                    setGmailAfter(event.target.value)
                                  }
                                  type="date"
                                  value={gmailAfter}
                                />
                              </label>
                              <label className="block space-y-1.5 text-xs">
                                <span>{t("connectors.gmail.maxMessages")}</span>
                                <Input
                                  disabled={isSavingSettings}
                                  max={10000}
                                  min={1}
                                  onChange={(event) =>
                                    setGmailMaxMessages(event.target.value)
                                  }
                                  type="number"
                                  value={gmailMaxMessages}
                                />
                              </label>
                              <div className="space-y-1.5 text-xs">
                                <p>{t("connectors.gmail.labels")}</p>
                                <p className="text-[10px] text-muted-foreground">
                                  {t("connectors.gmail.labelsNote")}
                                </p>
                                {gmailLabelsError ? (
                                  <p className="text-destructive">
                                    {gmailLabelsError}
                                  </p>
                                ) : null}
                                {gmailLabels.map((label) => (
                                  <label
                                    className="flex items-center gap-2"
                                    key={label.id}
                                  >
                                    <Checkbox
                                      checked={gmailLabelIds.includes(label.id)}
                                      disabled={isSavingSettings}
                                      onCheckedChange={(checked) =>
                                        setGmailLabelIds((previous) =>
                                          checked === true
                                            ? [
                                                ...new Set([
                                                  ...previous,
                                                  label.id,
                                                ]),
                                              ]
                                            : previous.filter(
                                                (id) => id !== label.id,
                                              ),
                                        )
                                      }
                                    />
                                    {label.name}
                                  </label>
                                ))}
                              </div>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                      {!canUsePeriodicSync ? (
                        <p className="text-[10px] leading-4 text-muted-foreground">
                          {t("connectors.config.nonIndexableNote")}
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
                        {t("connectors.config.saveSettings")}
                      </Button>
                    </div>
                    <dl className="mt-3 space-y-1 border-t pt-3 text-xs text-muted-foreground">
                      <div className="flex justify-between gap-3">
                        <dt>{t("connectors.config.schedule")}</dt>
                        <dd className="truncate text-foreground">
                          {formatConnectorSchedule(connector.raw, t)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>{t("connectors.config.provider")}</dt>
                        <dd className="truncate text-foreground">
                          {providerName}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>{t("connectors.config.connection")}</dt>
                        <dd className="truncate text-foreground">
                          {getConnectorAccountLabel(connector) ??
                            t("connectors.config.defaultConnection")}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>{t("connectors.config.accountId")}</dt>
                        <dd className="truncate text-foreground">
                          {connector.raw.oauthAccountId ??
                            t("connectors.config.none")}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-medium text-foreground">
                      {t("connectors.config.capabilities")}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {catalogItem ? (
                        <>
                          <TypeBadge
                            label={
                              catalogItem.isIndexable
                                ? t("connectors.config.indexableSource")
                                : t("connectors.config.nonIndexableSearch")
                            }
                          />
                          {catalogItem.supportsPeriodicSync ? (
                            <TypeBadge
                              label={t("connectors.config.periodicSync")}
                            />
                          ) : null}
                          {catalogItem.supportsActions ? (
                            <TypeBadge label={t("connectors.config.actions")} />
                          ) : null}
                          {catalogItem.supportsWebhook ? (
                            <TypeBadge
                              label={t("connectors.config.webhooks")}
                            />
                          ) : null}
                        </>
                      ) : (
                        <TypeBadge label={t("connectors.config.connector")} />
                      )}
                    </div>
                  </div>
                </div>
                {catalogItem?.supportsWebhook && webhookConfig ? (
                  <div className="rounded-lg border bg-muted/20 p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1 font-medium text-foreground">
                        <Webhook className="size-3.5" />
                        {t("connectors.config.webhookUrlLabel", {
                          name: providerName,
                        })}
                      </span>
                      {!webhookConfig.isConfigured ? (
                        <Badge variant="outline">
                          {t("connectors.config.needsPublicHttps")}
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
                        <span className="sr-only">
                          {t("connectors.copyWebhook")}
                        </span>
                      </Button>
                    </div>
                    {catalogItem?.webhookSupportNote ? (
                      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                        {t("connectors.config.webhookNoteSuffix", {
                          note: catalogItem.webhookSupportNote,
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </TabsContent>

              <TabsContent className="m-0" value="sync">
                <ActivityList
                  description={t("connectors.syncHistory.description")}
                  emptyTitle={t("connectors.syncHistory.empty")}
                  items={activity}
                  kind="sync"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0" value="actions">
                <ActivityList
                  description={t("connectors.actionsHistory.description")}
                  emptyTitle={t("connectors.actionsHistory.empty")}
                  items={activity}
                  kind="action"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0" value="webhooks">
                <ActivityList
                  description={t("connectors.webhooksHistory.description")}
                  emptyTitle={t("connectors.webhooksHistory.empty")}
                  items={activity}
                  kind="webhook"
                  loading={isLoadingActivity}
                  loadingError={activityError}
                />
              </TabsContent>

              <TabsContent className="m-0 space-y-3" value="danger">
                <Alert variant="destructive">
                  <AlertDescription>
                    {t("connectors.danger.note")}
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
                        ? t("connectors.syncPausedManual", {
                            name: providerName,
                          })
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
                    title={t("connectors.removeAria", { name: providerName })}
                    type="button"
                    variant="destructive"
                  >
                    <Power className="size-3.5" />
                    {t("connectors.removeShort")}
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
