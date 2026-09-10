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

import { LocalFilesPanel } from "./local-files-panel";

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
          throw new Error("Working directory draft data is unavailable.");
        folderByComputer.current = value;
      }
    } catch (e) {
      setDraftMetadataError(
        e instanceof Error
          ? e.message
          : "Could not restore the working directory selection.",
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
        setDraftMetadataError(
          "Could not save the working directory selection. Keep this page open and try again.",
        );
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
      ? "This computer is unavailable. Choose another computer."
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
  workingDirectory: string | null;
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
  const [filesOpen, setFilesOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!threadId || !workspaceId) return;
    let active = true;
    setInfo(null);
    setFilesOpen(false);
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
  const contextError = error || creation?.error;
  const label =
    target?.kind === "cloud"
      ? "Cloud"
      : device
        ? `${device.name}${contextError ? " · Status unavailable" : device.online ? "" : " · Offline"}`
        : contextError || (info && target?.kind === "local")
          ? "Computer unavailable"
          : "Connecting…";
  const triggerClassName =
    "flex h-10 min-w-0 max-w-full items-center gap-1 rounded-md px-1 text-xs leading-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 sm:-ml-1 sm:h-6";
  const icon =
    target?.kind === "cloud" ? (
      <Cloud className="size-3.5 shrink-0" />
    ) : (
      <Laptop className="size-3.5 shrink-0" />
    );
  return (
    <div
      className="flex min-w-0 max-w-[55%] shrink-0 items-center text-xs text-muted-foreground sm:w-full sm:max-w-full sm:shrink"
      data-testid="chat-work-context"
    >
      {threadId ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Conversation details"
              className={triggerClassName}
              title={label}
            >
              <span
                role="status"
                data-testid="thread-work-context"
                className="flex min-w-0 items-center gap-1"
              >
                {icon}
                <span className="truncate">{label}</span>
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-72 max-w-[calc(100vw-2rem)] space-y-2 text-sm"
          >
            <p className="break-words font-medium">{device?.name ?? label}</p>
            <p className="text-xs text-muted-foreground">
              {target?.kind === "cloud"
                ? "This conversation runs in the cloud."
                : "This conversation uses a fixed computer and working directory."}
              {device &&
                !contextError &&
                (device.online
                  ? " The computer is online."
                  : " The computer is offline. Local tasks can continue when it reconnects.")}
            </p>
            {target?.kind === "local" && (
              <div className="space-y-2 border-t pt-2">
                <p className="text-xs font-medium">Working directory</p>
                <p className="break-all text-xs text-muted-foreground">
                  {info?.workingDirectory ??
                    "The working directory will be connected when first used."}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFilesOpen(true)}
                >
                  Files
                </Button>
              </div>
            )}
            {contextError && (
              <p role="alert" className="break-words text-xs text-destructive">
                {contextError}
              </p>
            )}
          </PopoverContent>
        </Popover>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Choose cloud or computer"
              className={triggerClassName}
              title={label}
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
              Cloud
              {target?.kind === "cloud" && <Check className="ml-auto size-4" />}
            </Button>
            {contextError && (
              <p
                role="alert"
                className="break-words px-2 py-1 text-xs text-destructive"
              >
                {contextError}
              </p>
            )}
            <p className="px-2 py-2 text-xs text-muted-foreground">
              My computers
            </p>
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
                      {d.id === creation.nativeId ? "This computer · " : ""}
                      {d.name}
                      {creation.devices.filter((other) => other.name === d.name)
                        .length > 1
                        ? ` · ${d.id.slice(0, 6)}`
                        : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {d.online ? "Online" : "Offline"}
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
              Connect a computer…
            </Button>
          </PopoverContent>
        </Popover>
      )}
      {threadId && workspaceId && target?.kind === "local" && (
        <Dialog open={filesOpen} onOpenChange={setFilesOpen}>
          <DialogContent className="max-w-3xl overflow-hidden">
            <DialogHeader>
              <DialogTitle>Files</DialogTitle>
              <DialogDescription>
                Files in this conversation’s working directory.
              </DialogDescription>
            </DialogHeader>
            {filesOpen && (
              <LocalFilesPanel
                key={`${workspaceId}:${threadId}`}
                workspaceId={workspaceId}
                threadId={threadId}
                onClose={() => setFilesOpen(false)}
              />
            )}
          </DialogContent>
        </Dialog>
      )}
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect a computer</DialogTitle>
            <DialogDescription>
              Sign in with the same account on that computer, then enable access
              from other devices in Settings → This computer.
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
                    "Open"
                  ) : d.remoteEnabled ? (
                    "Connect"
                  ) : (
                    "Access disabled"
                  )}
                </Button>
              </div>
            ))}
          {!creation?.devices.length && (
            <p className="text-sm text-muted-foreground">
              No computers are available yet.
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
              (target.folderId ? "Folder unavailable" : "Working directory")}
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
          Default task folder
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
            Select folder…
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
