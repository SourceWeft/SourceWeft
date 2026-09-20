"use client";
import { authClient } from "../../../../lib/auth-client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
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
export function LocalHostPanel() {
  const t = useTranslations("dashboardSettings");
  const userId = authClient.useSession().data?.user.id;
  const [dataOwner, setDataOwner] = useState<string | null>(null);
  const [status, setStatus] = useState<LocalHostStatus | null>(null);
  const [device, setDevice] = useState<LocalDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!desktopBridge.isAvailable() || !userId) return;
    let active = true;
    const refresh = async () => {
      try {
        const native = await ensureLocalHostSession(userId);
        const [state, list] = await Promise.all([
          desktopBridge.localHostStatus(),
          localRequest<{ devices: LocalDevice[] }>(
            "/v1/local-devices",
            undefined,
            { localProof: true },
          ),
        ]);
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
          setStatus(state);
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
            : status?.deviceId
              ? t("localHost.statusConnecting")
              : t("localHost.statusSettingUp")}
        </p>
      </div>
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
