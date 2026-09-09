"use client";
import { useEffect, useState } from "react";
import {
  LOCAL_TARGET_KEY,
  localRequest,
  type LocalDevice,
} from "../../../../lib/local-execution";

type ExecutionInfo = {
  executionTarget: { kind: "cloud" } | { kind: "local"; deviceId: string };
  target: { deviceId: string; name: string; online: boolean } | null;
};

/** Selection exists only before creation. Existing local and cloud conversations show immutable status. */
export function LocalExecutionSelector({
  workspaceId,
  threadId,
}: {
  workspaceId: string | null | undefined;
  threadId?: string;
}) {
  const [devices, setDevices] = useState<LocalDevice[]>([]);
  const [selected, setSelected] = useState("");
  const [info, setInfo] = useState<ExecutionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setInfo(null);
    setError(null);
    const refresh = async () => {
      try {
        if (threadId) {
          if (!workspaceId) return;
          const value = await localRequest<ExecutionInfo>(
            `/v1/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/local-execution`,
          );
          if (live) {
            setInfo(value);
            setError(null);
          }
        } else {
          const value = await localRequest<{ devices: LocalDevice[] }>(
            "/v1/local-devices",
          );
          if (live) {
            setDevices(value.devices);
            setSelected(sessionStorage.getItem(LOCAL_TARGET_KEY) ?? "");
            setError(null);
          }
        }
      } catch (error) {
        if (live)
          setError(error instanceof Error ? error.message : String(error));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [workspaceId, threadId]);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-1.5 text-xs text-muted-foreground">
      {threadId ? (
        <>
          <span>执行位置</span>
          <span
            role="status"
            data-testid="thread-execution-location"
            className="text-foreground"
          >
            {!info
              ? error
                ? "执行信息不可用"
                : "正在读取…"
              : info.executionTarget.kind === "cloud"
                ? "云端"
                : `${info.target?.name ?? "本地电脑"} · 自动工作空间${info.target?.online ? "" : "（离线）"}`}
          </span>
          {info && <span>此对话已固定，切换环境请新建对话</span>}
        </>
      ) : (
        <>
          <label htmlFor="local-execution-target">执行位置</label>
          <select
            id="local-execution-target"
            aria-label="执行位置"
            className="max-w-64 rounded border border-border bg-background px-2 py-1 text-foreground"
            value={selected}
            onChange={(event) => {
              sessionStorage.setItem(LOCAL_TARGET_KEY, event.target.value);
              setSelected(event.target.value);
            }}
          >
            <option value="">云端</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} · 自动工作空间{device.online ? "" : "（离线）"}
              </option>
            ))}
          </select>
          <span>创建后不可更改</span>
        </>
      )}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
