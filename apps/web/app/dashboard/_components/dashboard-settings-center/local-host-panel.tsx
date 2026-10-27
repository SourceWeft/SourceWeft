"use client";
import { authClient } from "../../../../lib/auth-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { LocalNetworkMode } from "@sourceweft/sdk";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  desktopBridge,
  type LocalHostStatus,
} from "../../../../lib/desktop-bridge";
import {
  localRequest,
  type LocalDevice,
} from "../../../../lib/local-execution";
import { ensureLocalHostSession } from "../../../../lib/local-host-session";
import { deviceSystemLabel } from "../../../../lib/sandbox-setup";
import { LocalSandboxSetupCard } from "./local-sandbox-setup-card";
export function LocalHostPanel() {
  const t = useTranslations("dashboardSettings");
  const userId = authClient.useSession().data?.user.id;
  const [dataOwner, setDataOwner] = useState<string | null>(null);
  const [status, setStatus] = useState<LocalHostStatus | null>(null);
  const [device, setDevice] = useState<LocalDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  // Every status write carries a sequence number: a poll that started before an install or a
  // setup attempt finished must not overwrite the status read after it.
  const statusSeq = useRef(0);
  // Re-reads the native status after an install or a setup attempt without waiting for the 5s
  // poll. The returned readiness is used only if that read fails.
  const applyReadiness = useCallback(
    async (readiness?: LocalHostStatus["readiness"]) => {
      const seq = ++statusSeq.current;
      try {
        const state = await desktopBridge.localHostStatus();
        if (seq === statusSeq.current) setStatus(state);
      } catch {
        if (readiness && seq === statusSeq.current)
          setStatus((previous) =>
            previous ? { ...previous, readiness } : previous,
          );
      }
    },
    [],
  );
  useEffect(() => {
    if (!desktopBridge.isAvailable() || !userId) return;
    let active = true;
    const refresh = async () => {
      try {
        const seq = ++statusSeq.current;
        const native = await ensureLocalHostSession(userId);
        // Publish the native status before the device list is fetched: a computer that still
        // needs setup must show its setup card even if listing devices fails.
        const state = await desktopBridge.localHostStatus();
        if (active && seq === statusSeq.current) setStatus(state);
        const list = await localRequest<{ devices: LocalDevice[] }>(
          "/v1/local-devices",
          undefined,
          { localProof: true },
        );
        const listFolders = native?.deviceId
          ? await localRequest<{ folders: { id: string; name: string }[] }>(
              `/v1/local-devices/${native.deviceId}/folders`,
              undefined,
              { localProof: true },
            )
          : { folders: [] };
        if (active) {
          setDataOwner(userId);
          setFolders(listFolders.folders);
          setDevice(
            list.devices.find((d) => d.id === native?.deviceId) ?? null,
          );
          setError(null);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [userId]);
  // The network policy is enforced by the sandbox, on every platform, once the host reports it
  // ready. A computer that still needs setup, is unsupported, or reports no readiness (a build
  // without a managed host) is not enforcing it, so no mode is offered as if it applied.
  const enforced = status?.readiness?.state === "ready";
  if (!desktopBridge.isAvailable()) return null;
  if (dataOwner && dataOwner !== userId)
    return (
      <section>
        <h2 className="text-lg font-semibold">{t("localHost.title")}</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          {t("localHost.checkingAccount")}
        </p>
      </section>
    );
  const needsSetup = status?.readiness?.state === "needsSetup";
  const unsupported = status?.readiness?.state === "unsupported";
  const systemLabel = device ? deviceSystemLabel(device) : null;
  const environment = [
    systemLabel && t("localHost.deviceSystem", { system: systemLabel }),
    device?.shell && t("localHost.deviceShell", { shell: device.shell }),
  ].filter(Boolean);
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("localHost.title")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("localHost.description")}
        </p>
        <p role="status" className="mt-3 text-sm">
          {status?.connected
            ? t("localHost.statusOnline")
            : needsSetup
              ? t("localHost.statusNeedsSetup")
              : unsupported
                ? t("localHost.statusUnsupported")
                : status?.deviceId
                  ? t("localHost.statusConnecting")
                  : t("localHost.statusSettingUp")}
        </p>
        {environment.length > 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            {environment.join(" · ")}
          </p>
        )}
      </div>
      <LocalSandboxSetupCard
        readiness={status?.readiness}
        onChanged={applyReadiness}
      />
      <div className="space-y-3 rounded-lg border p-4">
        <h3 className="font-medium">{t("localHost.remoteAccessTitle")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("localHost.remoteAccessDescription")}
        </p>
        <Button
          disabled={busy || !device}
          onClick={async () => {
            if (!device) return;
            setBusy(true);
            setError(null);
            try {
              const value = await localRequest<{ remoteEnabled: boolean }>(
                `/v1/local-devices/${device.id}/policy`,
                { remoteEnabled: !device.remoteEnabled },
                { localProof: true },
              );
              setDevice({ ...device, remoteEnabled: value.remoteEnabled });
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {device?.remoteEnabled
            ? t("localHost.turnOffRemoteAccess")
            : t("localHost.remoteAccessTitle")}
        </Button>
      </div>
      <div className="space-y-3 rounded-lg border p-4">
        <h3 className="font-medium">{t("localHost.networkTitle")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("localHost.networkDescription")}
        </p>
        <select
          aria-label={t("localHost.networkSelectAria")}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          // Until the host reports the sandbox ready the policy is not enforced, so no
          // mode may be offered as if it were.
          disabled={busy || !device || !enforced}
          onChange={async (event) => {
            if (!device || !enforced) return;
            const networkMode = event.target.value as LocalNetworkMode;
            setBusy(true);
            setError(null);
            try {
              // Like the remote-access switch, only this computer may change
              // its own policy: the request carries the native proof.
              const value = await localRequest<{
                networkMode: LocalNetworkMode;
              }>(
                `/v1/local-devices/${device.id}`,
                { networkMode },
                { localProof: true, method: "PATCH" },
              );
              setDevice({ ...device, networkMode: value.networkMode });
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          value={device?.networkMode ?? "ask"}
        >
          <option value="ask">{t("localHost.networkAsk")}</option>
          <option value="open">{t("localHost.networkOpen")}</option>
          <option value="strict">{t("localHost.networkStrict")}</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {enforced
            ? t("localHost.networkHelperEnforced")
            : t("localHost.networkHelperUnenforced")}
        </p>
      </div>
      <div className="space-y-3 rounded-lg border p-4">
        <h3 className="font-medium">{t("localHost.workingDirectoriesTitle")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("localHost.workingDirectoriesDescription")}
        </p>
        {folders.map((folder) => (
          <div key={folder.id} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm">
              {folder.name}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (!device) return;
                setBusy(true);
                setError(null);
                try {
                  await localRequest(
                    `/v1/local-devices/${device.id}/folders/${folder.id}/revoke`,
                    {},
                    { localProof: true },
                  );
                  setFolders((items) =>
                    items.filter((item) => item.id !== folder.id),
                  );
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("localHost.removeAccess")}
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          disabled={busy || !device}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const challenge = await localRequest<{
                ticket: string;
                userId: string;
              }>("/v1/local-devices/enroll", {});
              const folder = await desktopBridge.chooseLocalFolder(
                challenge.ticket,
                challenge.userId,
              );
              setFolders((items) => [...items, folder]);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("localHost.addFolder")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
