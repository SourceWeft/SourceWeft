"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  desktopUpdates,
  type DesktopUpdateState,
  type UpdatePreferences,
} from "../../../../lib/desktop-bridge";

const statusKeys = [
  "idle",
  "checking",
  "upToDate",
  "waitingForStable",
  "available",
  "downloading",
  "verifying",
  "ready",
  "preparing",
  "waitingForIdle",
  "installing",
  "distributionPaused",
  "withdrawn",
  "channelUnavailable",
  "failed",
] as const;
function statusLabel(
  t: ReturnType<typeof useTranslations<"dashboardSettings.desktopUpdate">>,
  status: string,
) {
  return (statusKeys as readonly string[]).includes(status)
    ? t(`status.${status as (typeof statusKeys)[number]}`)
    : status;
}
export function DesktopUpdatePanel() {
  const t = useTranslations("dashboardSettings.desktopUpdate");
  const locale = useLocale();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let live = true;
    let stop: (() => Promise<void>) | undefined;
    const receive = (next: DesktopUpdateState) => {
      if (live)
        setState((old) => (!old || next.revision >= old.revision ? next : old));
    };
    void (async () => {
      const unsubscribe = await desktopUpdates.onState(receive);
      if (!live) {
        await unsubscribe();
        return;
      }
      stop = unsubscribe;
      receive(await desktopUpdates.state());
    })().catch((e) => {
      if (live) setError(String(e));
    });
    return () => {
      live = false;
      if (stop) void stop();
    };
  }, []);
  const run = async (work: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await work();
      const next = await desktopUpdates.state();
      setState((old) => (!old || next.revision >= old.revision ? next : old));
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };
  const busy =
    pending ||
    [
      "checking",
      "downloading",
      "verifying",
      "preparing",
      "waitingForIdle",
      "installing",
    ].includes(state?.status ?? "");
  const preference = (patch: Partial<UpdatePreferences>) => {
    if (state?.preferences)
      void run(() =>
        desktopUpdates.preferences({ ...state.preferences!, ...patch }),
      );
  };
  return (
    <section
      className="space-y-4 rounded-lg border border-border p-4"
      aria-label={t("title")}
    >
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("description")}
        </p>
      </div>
      {state?.preferences && (
        <div className="space-y-3 text-sm">
          <label className="flex items-center justify-between gap-4">
            {t("channel")}
            <select
              className="rounded-md border border-input bg-background px-2 py-1"
              value={state.preferences.channel}
              disabled={busy}
              onChange={(e) =>
                preference({ channel: e.target.value as "stable" | "preview" })
              }
            >
              <option value="stable">{t("channelStable")}</option>
              <option value="preview">{t("channelPreview")}</option>
            </select>
          </label>
          {state.preferences.channel === "preview" && (
            <p className="text-xs text-muted-foreground">
              {t("channelPreviewHint")}
            </p>
          )}
          <label className="flex items-center justify-between gap-4">
            {t("autoCheck")}
            <input
              type="checkbox"
              checked={state.preferences.autoCheck}
              disabled={pending || (busy && state.status !== "downloading")}
              onChange={(e) => preference({ autoCheck: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-4">
            {t("autoDownload")}
            <input
              type="checkbox"
              checked={state.preferences.autoDownload}
              disabled={pending || (busy && state.status !== "downloading")}
              onChange={(e) => preference({ autoDownload: e.target.checked })}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {t("autoDownloadHint")}
          </p>
        </div>
      )}
      <div aria-live="polite" className="space-y-2 text-sm">
        <p>
          {!state
            ? t("loading")
            : state.version
              ? t("statusWithVersion", {
                  status: statusLabel(t, state.status),
                  version: state.version,
                })
              : statusLabel(t, state.status)}
        </p>
        {state?.status === "downloading" && (
          <>
            <progress
              className="w-full"
              max={state.totalBytes ?? undefined}
              value={state.totalBytes ? state.downloadedBytes : undefined}
            />
            <p className="text-xs text-muted-foreground">
              {t("downloaded", {
                size: (state.downloadedBytes / 1048576).toFixed(1),
              })}
            </p>
          </>
        )}
        {state?.notes && (
          <p className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {state.notes}
          </p>
        )}
        {(error || state?.error) && (
          <p role="alert" className="break-words text-xs text-destructive">
            {error ?? state?.error}
          </p>
        )}
        {state?.lastChecked && (
          <p className="text-xs text-muted-foreground">
            {t("lastChecked", {
              date: new Date(state.lastChecked * 1000).toLocaleString(locale),
            })}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run(desktopUpdates.check)}
        >
          {t("check")}
        </Button>
        {state?.candidateId && state.status === "available" && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() => desktopUpdates.download(state.candidateId!))
            }
          >
            {t("download")}
          </Button>
        )}
        {state?.candidateId && state.status === "ready" && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() => desktopUpdates.install(state.candidateId!))
            }
          >
            {t("install")}
          </Button>
        )}
        {state?.operationId && state.status === "downloading" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run(() => desktopUpdates.cancelDownload(state.operationId!))
            }
          >
            {t("cancelDownload")}
          </Button>
        )}
        {state?.candidateId &&
          ["available", "ready"].includes(state.status) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(() => desktopUpdates.snooze(state.candidateId!))
              }
            >
              {t("snooze")}
            </Button>
          )}
      </div>
    </section>
  );
}
