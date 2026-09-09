"use client";
import { useEffect, useState } from "react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  desktopBridge,
  type LocalHostStatus,
} from "../../../../lib/desktop-bridge";
import {
  localRequest,
  LOCAL_TARGET_KEY,
} from "../../../../lib/local-execution";

export function LocalHostPanel() {
  const [status, setStatus] = useState<LocalHostStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!desktopBridge.isAvailable()) return;
    let active = true;
    const refresh = () =>
      desktopBridge
        .localHostStatus()
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch((error) => {
          if (active) setError(String(error));
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  if (!desktopBridge.isAvailable()) return null;
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">本机</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          在这台 Mac 执行文件与命令任务。未选择文件夹时自动创建对话工作空间。
        </p>
      </div>
      <div className="rounded-lg border p-4 space-y-3">
        <h3 className="font-medium">允许其他设备连接</h3>
        <p className="text-sm text-muted-foreground">
          开启后，同账号的 Web 或手机可选择这台电脑，在同一个对话中继续执行。
        </p>
        <p className="text-sm" role="status">
          {status?.connected
            ? "已连接 · 本地执行可用"
            : status?.deviceId
              ? "正在连接…"
              : "未开启"}
        </p>
        <Button
          disabled={
            busy || !status || Boolean(status.deviceId && !status.connected)
          }
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              if (status?.connected) {
                await desktopBridge.disconnectLocalHost();
                sessionStorage.removeItem(LOCAL_TARGET_KEY);
              } else {
                const { ticket } = await localRequest<{ ticket: string }>(
                  "/v1/local-devices/enroll",
                  {},
                );
                const result = await desktopBridge.enableLocalHost(ticket);
                if (result.deviceId)
                  sessionStorage.setItem(LOCAL_TARGET_KEY, result.deviceId);
              }
              setStatus(await desktopBridge.localHostStatus());
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {status?.connected ? "断开本机连接" : "允许连接"}
        </Button>
      </div>
      {(error || status?.connectionError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || status?.connectionError}
        </p>
      )}
    </section>
  );
}
