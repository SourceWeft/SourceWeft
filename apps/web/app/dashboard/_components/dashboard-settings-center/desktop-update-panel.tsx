"use client";
import { useEffect, useState } from "react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  desktopUpdates,
  type DesktopUpdateState,
  type UpdatePreferences,
} from "../../../../lib/desktop-bridge";

const labels: Record<string, string> = {
  idle: "Ready to check",
  checking: "Checking for updates…",
  upToDate: "You are up to date",
  waitingForStable:
    "Waiting for a newer stable release; your app will not be downgraded",
  available: "An update is available",
  downloading: "Downloading in the background…",
  verifying: "Verifying update…",
  ready: "Ready to install",
  preparing: "Saving your work…",
  waitingForIdle: "Waiting for local work to finish…",
  installing: "Installing…",
  distributionPaused: "Updates paused by the publisher",
  withdrawn: "This update was withdrawn",
  channelUnavailable: "No update has been published to this channel",
  failed: "Update could not be completed",
};
export function DesktopUpdatePanel() {
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
      aria-label="Software update"
    >
      <div>
        <h3 className="text-sm font-medium">Software update</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Settings apply to this computer’s current OS user, across SourceWeft
          accounts.
        </p>
      </div>
      {state?.preferences && (
        <div className="space-y-3 text-sm">
          <label className="flex items-center justify-between gap-4">
            Update channel
            <select
              className="rounded-md border border-input bg-background px-2 py-1"
              value={state.preferences.channel}
              disabled={busy}
              onChange={(e) =>
                preference({ channel: e.target.value as "stable" | "preview" })
              }
            >
              <option value="stable">Stable</option>
              <option value="preview">Preview + stable</option>
            </select>
          </label>
          {state.preferences.channel === "preview" && (
            <p className="text-xs text-muted-foreground">
              Includes release candidates and stable releases. Preview versions
              may be less reliable.
            </p>
          )}
          <label className="flex items-center justify-between gap-4">
            Check automatically
            <input
              type="checkbox"
              checked={state.preferences.autoCheck}
              disabled={pending || (busy && state.status !== "downloading")}
              onChange={(e) => preference({ autoCheck: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-4">
            Download automatically
            <input
              type="checkbox"
              checked={state.preferences.autoDownload}
              disabled={pending || (busy && state.status !== "downloading")}
              onChange={(e) => preference({ autoDownload: e.target.checked })}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Downloads run while the app is open. Installation always needs your
            confirmation.
          </p>
        </div>
      )}
      <div aria-live="polite" className="space-y-2 text-sm">
        <p>
          {state
            ? (labels[state.status] ?? state.status)
            : "Loading update settings…"}
          {state?.version ? ` · ${state.version}` : ""}
        </p>
        {state?.status === "downloading" && (
          <>
            <progress
              className="w-full"
              max={state.totalBytes ?? undefined}
              value={state.totalBytes ? state.downloadedBytes : undefined}
            />
            <p className="text-xs text-muted-foreground">
              {(state.downloadedBytes / 1048576).toFixed(1)} MiB downloaded
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
            Last checked: {new Date(state.lastChecked * 1000).toLocaleString()}
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
          Check for updates
        </Button>
        {state?.candidateId && state.status === "available" && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() => desktopUpdates.download(state.candidateId!))
            }
          >
            Download update
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
            Install and restart
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
            Cancel download
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
              Remind me tomorrow
            </Button>
          )}
      </div>
    </section>
  );
}
