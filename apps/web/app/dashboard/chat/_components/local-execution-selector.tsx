"use client";
import { useEffect, useState } from "react";
import {
  LOCAL_TARGET_KEY,
  localRequest,
  type LocalDevice,
  type ExecutionInfo,
  LOCAL_DIRECTORY_KEY,
  readDirectorySelection,
} from "../../../../lib/local-execution";

import { desktopBridge } from "../../../../lib/desktop-bridge";
import { LocalFilesPanel } from "./local-files-panel";

/** Selection exists only before creation. Existing local and cloud conversations show immutable status. */
export function LocalExecutionSelector({
  workspaceId,
  threadId,
}: {
  workspaceId: string | null | undefined;
  threadId?: string;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [directory, setDirectory] =
    useState<ReturnType<typeof readDirectorySelection>>(null);
  const [devices, setDevices] = useState<LocalDevice[]>([]);
  const [selected, setSelected] = useState("");
  const [info, setInfo] = useState<ExecutionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setInfo(null);
    setFilesOpen(false);
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
            const deviceId = sessionStorage.getItem(LOCAL_TARGET_KEY) ?? "";
            setSelected(deviceId);
            setDirectory(readDirectorySelection(deviceId));
            setError(null);
          }
        }
      } catch (error) {
        if (live) {
          setInfo(null);
          setError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [workspaceId, threadId]);

  const chooseDirectory = async () => {
    setChoosing(true);
    setError(null);
    try {
      const status = await desktopBridge.localHostStatus();
      if (status.deviceId !== selected)
        throw new Error("请在所选电脑的 SourceWeft 客户端中选择目录。");
      const value = await desktopBridge.chooseWorkingDirectory();
      if (value) {
        if (value.deviceId !== selected)
          throw new Error("所选电脑发生变化，请重新选择。");
        sessionStorage.setItem(LOCAL_DIRECTORY_KEY, JSON.stringify(value));
        setDirectory(value);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChoosing(false);
    }
  };
  return (
    <>
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
                  : `${info.target?.name ?? "本地电脑"}${info.target?.online ? "" : "（离线）"}`}
            </span>
            {info?.executionTarget.kind === "local" && (
              <>
                <span
                  className="min-w-0 truncate"
                  title={info.workingDirectory ?? undefined}
                >
                  {info.workingDirectory ??
                    (info.executionTarget.directoryGrantId
                      ? "所选工作目录尚未连接"
                      : "工作目录将在首次使用时创建")}
                </span>
                <button
                  type="button"
                  className="ml-auto shrink-0 rounded border px-2 py-1 text-foreground hover:bg-accent"
                  aria-expanded={filesOpen}
                  onClick={() => setFilesOpen((value) => !value)}
                >
                  文件
                </button>
              </>
            )}
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
                setDirectory(readDirectorySelection(event.target.value));
              }}
            >
              <option value="">云端</option>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {device.online ? "" : "（离线）"}
                </option>
              ))}
            </select>
            {selected && (
              <>
                <span className="max-w-72 truncate" title={directory?.path}>
                  {directory?.path ?? "自动创建工作目录"}
                </span>
                {desktopBridge.isAvailable() && (
                  <button
                    type="button"
                    disabled={choosing}
                    onClick={() => void chooseDirectory()}
                    className="rounded border px-2 py-1 hover:bg-accent"
                  >
                    {choosing ? "选择中…" : "选择目录"}
                  </button>
                )}
                {directory && (
                  <button
                    type="button"
                    onClick={() => {
                      sessionStorage.removeItem(LOCAL_DIRECTORY_KEY);
                      setDirectory(null);
                    }}
                    className="underline"
                  >
                    使用自动目录
                  </button>
                )}
              </>
            )}
            <span>创建后不可更改</span>
          </>
        )}
        {error && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )}
      </div>
      {filesOpen &&
        workspaceId &&
        threadId &&
        info?.executionTarget.kind === "local" && (
          <LocalFilesPanel
            key={threadId}
            workspaceId={workspaceId}
            threadId={threadId}
            onClose={() => setFilesOpen(false)}
          />
        )}
    </>
  );
}
