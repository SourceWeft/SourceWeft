"use client";
import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { authClient } from "../../../../lib/auth-client";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { useRouter, useSearchParams } from "next/navigation";
import { Cloud, Laptop, ChevronDown, Check, Plus, Loader2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sourceweft/ui-web/components/ui/popover";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@sourceweft/ui-web/components/ui/dialog";
import type { ThreadExecutionTarget } from "@sourceweft/contracts";
import {
  localRequest,
  type LocalDevice,
} from "../../../../lib/local-execution";
import { desktopBridge } from "../../../../lib/desktop-bridge";
import { ensureLocalHostSession } from "../../../../lib/local-host-session";

export function useChatCreationContext() {
  const { setWorkTarget, workspaceId } = useDashboardChatState();
  const session = authClient.useSession();
  const query = useSearchParams();
  const draftNonce = useRef<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const router = useRouter();
  const [devices, setDevices] = useState<LocalDevice[]>([]);
  const [nativeId, setNativeId] = useState<string | null>(null);
  const [readyFor, setReadyFor] = useState<string | null | undefined>(
    undefined,
  );
  const refreshVersion = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const requested = query.get("computer");
  const ready = readyFor === requested;
  const queryDraft = query.get("draft");
  useEffect(() => {
    if (!draftNonce.current) draftNonce.current = crypto.randomUUID();
    const id = queryDraft ?? draftNonce.current;
    setDraftId(id);
    if (!queryDraft) {
      const next = new URLSearchParams(window.location.search);
      next.set("draft", id);
      router.replace(`/dashboard/chat?${next.toString()}`);
    }
  }, [queryDraft, router]);
  const folderByComputer = useRef<Record<string, string | undefined>>({});
  const [draftMetadataError, setDraftMetadataError] = useState<string | null>(
    null,
  );
  const folderStorageKey =
    session.data?.user.id && workspaceId && draftId
      ? `sourceweft:draft-folders:${session.data.user.id}:${workspaceId}:${draftId}`
      : null;
  useEffect(() => {
    folderByComputer.current = {};
    setDraftMetadataError(null);
    if (!folderStorageKey) return;
    try {
      const raw = sessionStorage.getItem(folderStorageKey);
      if (raw) {
        const value = JSON.parse(raw);
        if (
          !value ||
          Array.isArray(value) ||
          typeof value !== "object" ||
          Object.values(value).some((folder) => typeof folder !== "string")
        )
          throw new Error("工作文件夹草稿数据不可用。");
        folderByComputer.current = value;
      }
    } catch (e) {
      setDraftMetadataError(
        e instanceof Error ? e.message : "无法恢复工作文件夹选择。",
      );
    }
  }, [folderStorageKey]);

  const folderId = query.get("folder");
  const target = useMemo<ThreadExecutionTarget | null>(
    () =>
      requested === "cloud"
        ? { kind: "cloud" }
        : !ready
          ? null
          : requested
            ? {
                kind: "local",
                deviceId: requested,
                ...(folderId ? { folderId } : {}),
              }
            : nativeId
              ? { kind: "local", deviceId: nativeId }
              : { kind: "cloud" },
    [ready, requested, nativeId, folderId],
  );
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const native =
        requested === "cloud"
          ? null
          : await ensureLocalHostSession(session.data?.user.id);
      const response = await localRequest<{ devices: LocalDevice[] }>(
        "/v1/local-devices",
      );
      if (version !== refreshVersion.current) return;
      setDevices(response.devices);
      if (native) setNativeId(native.deviceId);
      setReadyFor(requested);
      setError(null);
    } catch (e) {
      if (version === refreshVersion.current)
        setError(e instanceof Error ? e.message : String(e));
    }
  }, [requested, session.data?.user.id]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  const select = (id: string) => {
    const next = new URLSearchParams(query.toString());
    if (target?.kind === "local")
      folderByComputer.current[target.deviceId] = target.folderId;
    if (folderStorageKey) {
      try {
        sessionStorage.setItem(
          folderStorageKey,
          JSON.stringify(folderByComputer.current),
        );
      } catch {
        setDraftMetadataError("工作文件夹选择保存失败，请暂勿刷新。");
        return;
      }
    }
    next.set("computer", id);
    if (draftId) next.set("draft", draftId);
    const rememberedFolder = folderByComputer.current[id];
    if (rememberedFolder) next.set("folder", rememberedFolder);
    else next.delete("folder");
    router.push(`/dashboard/chat?${next.toString()}`);
  };
  useEffect(() => {
    setWorkTarget(target);
  }, [target, setWorkTarget]);
  const selectedDevice =
    target?.kind === "local"
      ? devices.find((d) => d.id === target.deviceId)
      : null;
  const invalid = ready && target?.kind === "local" && !selectedDevice;
  return {
    draftId,
    userId: session.data?.user.id ?? null,
    target,
    devices,
    nativeId,
    error: invalid
      ? "所选电脑不可用，请重新选择。"
      : (draftMetadataError ?? error),
    ready,
    select,
    refresh,
    selectedDevice,
    setFolder: (folderId: string) => {
      const next = new URLSearchParams(query.toString());
      if (target?.kind !== "local") return;
      next.set("computer", target.deviceId);
      if (folderId) next.set("folder", folderId);
      else next.delete("folder");
      router.replace(`/dashboard/chat?${next.toString()}`);
    },
    key:
      target?.kind === "local"
        ? target.deviceId
        : (target?.kind ?? "initializing"),
  };
}
export type ChatCreationContext = ReturnType<typeof useChatCreationContext>;

type ExecutionInfo = {
  executionTarget: ThreadExecutionTarget;
  target: { deviceId: string; name: string; online: boolean } | null;
};
export function ChatWorkContext({
  workspaceId,
  threadId,
  creation,
  disabled = false,
}: {
  workspaceId: string | null;
  threadId?: string;
  creation?: ChatCreationContext;
  disabled?: boolean;
}) {
  const { setWorkTarget } = useDashboardChatState();
  const [info, setInfo] = useState<ExecutionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!threadId || !workspaceId) return;
    let active = true;
    setInfo(null);
    setError(null);
    const refresh = () =>
      localRequest<ExecutionInfo>(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/local-execution`,
      ).then(
        (value) => {
          if (active) {
            setInfo(value);
            setWorkTarget(value.executionTarget);
            setError(null);
          }
        },
        (e) => {
          if (active) setError(e instanceof Error ? e.message : String(e));
        },
      );
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [workspaceId, threadId, setWorkTarget]);
  const target = threadId ? info?.executionTarget : creation?.target;
  const device = threadId ? info?.target : creation?.selectedDevice;
  const label =
    target?.kind === "cloud"
      ? "云端工作"
      : device
        ? `${!threadId && creation?.nativeId === ("deviceId" in device ? device.deviceId : device.id) ? "这台电脑 · " : ""}${device.name} · ${device.online ? "在线" : "离线"}`
        : error || creation?.error
          ? "电脑信息不可用"
          : "正在连接…";
  const icon =
    target?.kind === "cloud" ? (
      <Cloud className="size-3.5 shrink-0" />
    ) : (
      <Laptop className="size-3.5 shrink-0" />
    );
  return (
    <div
      className="flex min-w-0 items-center gap-2 pl-14 pr-4 pb-2 text-xs text-muted-foreground"
      data-testid="chat-work-context"
    >
      {threadId ? (
        <span
          className="flex min-w-0 items-center gap-1.5"
          role="status"
          data-testid="thread-work-context"
        >
          {icon}
          <span className="truncate" title={label}>
            {label}
          </span>
        </span>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="选择云端或电脑"
              className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded px-1 hover:bg-muted disabled:opacity-50"
            >
              {icon}
              <span className="truncate">{label}</span>
              <ChevronDown className="size-3 shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-72 max-w-[calc(100vw-2rem)] p-1.5"
          >
            <Button
              variant="ghost"
              className="w-full justify-start gap-2"
              onClick={() => {
                creation?.select("cloud");
                setOpen(false);
              }}
            >
              <Cloud className="size-4" />
              云端工作
              {target?.kind === "cloud" && <Check className="ml-auto size-4" />}
            </Button>
            <p className="px-2 py-2 text-xs text-muted-foreground">我的电脑</p>
            <div className="max-h-64 overflow-y-auto">
              {creation?.devices
                .filter((d) => d.connected)
                .map((d) => (
                  <Button
                    key={d.id}
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      creation.select(d.id);
                      setOpen(false);
                    }}
                    title={`${d.name} · ${d.id.slice(0, 8)}`}
                  >
                    <Laptop className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {d.id === creation.nativeId ? "这台电脑 · " : ""}
                      {d.name}
                      {creation.devices.filter((other) => other.name === d.name)
                        .length > 1
                        ? ` · ${d.id.slice(0, 6)}`
                        : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {d.online ? "在线" : "离线"}
                    </span>
                    {target?.kind === "local" && target.deviceId === d.id && (
                      <Check className="size-4 shrink-0" />
                    )}
                  </Button>
                ))}
            </div>
            <Button
              variant="ghost"
              className="mt-1 w-full justify-start border-t rounded-t-none"
              onClick={() => {
                setOpen(false);
                setConnectOpen(true);
              }}
            >
              <Plus className="mr-2 size-4" />
              连接电脑…
            </Button>
          </PopoverContent>
        </Popover>
      )}
      {(error || creation?.error) && (
        <span
          role="alert"
          className="min-w-0 truncate text-destructive"
          title={error || creation?.error || ""}
        >
          {error || creation?.error}
        </span>
      )}
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>连接电脑</DialogTitle>
            <DialogDescription>
              请在目标 PC 登录同一账号，并在“设置 → 本机”开启允许其他设备连接。
            </DialogDescription>
          </DialogHeader>
          {creation?.devices
            .filter((d) => d.id !== creation.nativeId)
            .map((d) => (
              <div key={d.id} className="flex min-w-0 items-center gap-3 py-2">
                <Laptop className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!d.remoteEnabled || busy !== null}
                  onClick={async () => {
                    setBusy(d.id);
                    setError(null);
                    try {
                      await localRequest(
                        `/v1/local-devices/${d.id}/connect`,
                        {},
                      );
                      await creation.refresh();
                      creation.select(d.id);
                      setConnectOpen(false);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === d.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : d.connected ? (
                    "进入"
                  ) : d.remoteEnabled ? (
                    "连接"
                  ) : (
                    "未开启许可"
                  )}
                </Button>
              </div>
            ))}
          {!creation?.devices.length && (
            <p className="text-sm text-muted-foreground">
              还没有可连接的电脑。
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function WorkingFolderPicker({
  creation,
  disabled = false,
}: {
  creation: ChatCreationContext;
  disabled?: boolean;
}) {
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const target = creation.target;
  const id = target?.kind === "local" ? target.deviceId : null;
  useEffect(() => {
    let live = true;
    setFolders([]);
    setError(null);
    if (id && creation.selectedDevice?.connected)
      void localRequest<{ folders: { id: string; name: string }[] }>(
        `/v1/local-devices/${id}/folders`,
      ).then(
        (v) => {
          if (live) setFolders(v.folders);
        },
        (e) => {
          if (live) setError(String(e));
        },
      );
    return () => {
      live = false;
    };
  }, [id, creation.selectedDevice?.connected]);
  if (target?.kind !== "local") return null;
  const folder = folders.find((f) => f.id === target.folderId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-7 min-w-0 max-w-48 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted"
        >
          <span className="truncate">
            {folder?.name ??
              (target.folderId ? "工作文件夹不可用" : "选择工作文件夹")}
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 max-w-[calc(100vw-2rem)] p-2"
      >
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => {
            creation.setFolder("");
            setOpen(false);
          }}
        >
          自动创建任务文件夹
        </Button>
        {folders.map((f) => (
          <Button
            key={f.id}
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              creation.setFolder(f.id);
              setOpen(false);
            }}
          >
            {f.name}
          </Button>
        ))}
        {id === creation.nativeId && (
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={async () => {
              setError(null);
              try {
                const challenge = await localRequest<{
                  ticket: string;
                  userId: string;
                }>("/v1/local-devices/enroll", {});
                const f = await desktopBridge.chooseLocalFolder(
                  challenge.ticket,
                  challenge.userId,
                );
                setFolders((previous) => [...previous, f]);
                creation.setFolder(f.id);
                setOpen(false);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <Plus className="mr-2 size-4" />
            添加工作文件夹…
          </Button>
        )}
        {error && (
          <p role="alert" className="p-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
