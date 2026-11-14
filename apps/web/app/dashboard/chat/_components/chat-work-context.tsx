"use client";
import {
  useCallback,
  useEffect,
  useState,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { authClient } from "../../../../lib/auth-client";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Cloud,
  Laptop,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronDown,
  Check,
  Copy,
  Plus,
  Loader2,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sourceweft/ui-web/components/ui/popover";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
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
import {
  desktopBridge,
  FOLDER_SELECTION_CANCELLED,
} from "../../../../lib/desktop-bridge";
import { ensureLocalHostSession } from "../../../../lib/local-host-session";
import { parentOfWirePath, shortenHomePath } from "../../../../lib/local-path";

import { LocalFilesPanel } from "./local-files-panel";
import { useLocalConversationStatus } from "./local-conversation-status";

export function useChatCreationContext() {
  const t = useTranslations("dashboardChat");
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
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(false);
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
          throw new Error(t("work.draftDataUnavailable"));
        folderByComputer.current = value;
      }
    } catch (e) {
      setDraftMetadataError(
        e instanceof Error ? e.message : t("work.restoreSelectionFailed"),
      );
    }
  }, [folderStorageKey, t]);

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
  const refresh = useCallback(
    async (discover = true) => {
      const version = ++refreshVersion.current;
      let cloud = requested === "cloud";
      try {
        const native =
          !desktopBridge.isAvailable() || (requested === "cloud" && !discover)
            ? null
            : await ensureLocalHostSession(session.data?.user.id);
        if (version !== refreshVersion.current) return;
        cloud = requested === "cloud" || (!requested && !native);
        if (native) setNativeId(native.deviceId);
        else if (!desktopBridge.isAvailable()) setNativeId(null);
        setError(null);
        // Cloud readiness is independent of computer discovery, including a
        // request that never settles. Native bootstrap errors remain blocking.
        if (cloud) {
          setReadyFor(requested);
          if (!discover) return;
        }
        setDevicesLoading(true);
        const response = await localRequest<{ devices: LocalDevice[] }>(
          "/v1/local-devices",
          undefined,
          { localProof: Boolean(native) },
        );
        if (version !== refreshVersion.current) return;
        setDevices(response.devices);
        setDevicesError(null);
        setReadyFor(requested);
      } catch (e) {
        if (version !== refreshVersion.current) return;
        const message = e instanceof Error ? e.message : String(e);
        setDevicesError(message);
        if (!cloud) {
          setReadyFor(undefined);
          setError(message);
        }
      } finally {
        if (version === refreshVersion.current) setDevicesLoading(false);
      }
    },
    [requested, session.data?.user.id],
  );
  useEffect(() => {
    const requests = refreshVersion;
    setDevices([]);
    setDevicesError(null);
    setDevicesLoading(false);
    setReadyFor(undefined);
    void refresh(false);
    const timer =
      requested !== "cloud" && (requested || desktopBridge.isAvailable())
        ? setInterval(() => void refresh(false), 10000)
        : undefined;
    return () => {
      requests.current++;
      clearInterval(timer);
    };
  }, [refresh, requested]);
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
        setDraftMetadataError(t("work.saveSelectionFailed"));
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
    devicesError,
    devicesLoading,
    nativeId,
    error: invalid
      ? t("work.computerUnavailableChooseAnother")
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

export function ChatWorkContext({
  workspaceId,
  threadId,
  creation,
  disabled = false,
  compact = false,
}: {
  workspaceId: string | null;
  threadId?: string;
  creation?: ChatCreationContext;
  disabled?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations("dashboardChat");
  const { setWorkTarget } = useDashboardChatState();
  const localStatus = useLocalConversationStatus(workspaceId, threadId);
  const info = localStatus.info;
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!threadId || !workspaceId) return;
    setFilesOpen(false);
    setError(null);
  }, [workspaceId, threadId, setWorkTarget]);
  useEffect(() => {
    if (info) setWorkTarget(info.executionTarget);
  }, [info, setWorkTarget]);
  const target = threadId ? info?.executionTarget : creation?.target;
  const device = threadId ? info?.target : creation?.selectedDevice;
  const contextError =
    error || (threadId && localStatus.message) || creation?.error;
  const label =
    target?.kind === "cloud"
      ? t("work.cloud")
      : device
        ? `${device.name}${contextError ? ` · ${t("work.statusUnavailable")}` : device.online ? "" : ` · ${t("work.offline")}`}`
        : contextError || (info && target?.kind === "local")
          ? t("work.computerUnavailable")
          : t("work.connecting");
  const workingDirectory =
    threadId && target?.kind === "local" ? info?.workingDirectory : null;
  const directoryLabel = workingDirectory
    ? target?.kind === "local" && (target.folderId || target.directoryGrantId)
      ? (workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ??
        workingDirectory)
      : t("work.taskFolder")
    : t("work.directoryPending");
  const triggerClassName = compact
    ? "-ml-1 flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md px-1 text-xs leading-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
    : "flex h-10 min-w-0 max-w-full items-center gap-1 rounded-md px-1 text-xs leading-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 sm:-ml-1 sm:h-6";
  const icon =
    target?.kind === "cloud" ? (
      <Cloud className="size-3.5 shrink-0" />
    ) : (
      <Laptop className="size-3.5 shrink-0" />
    );
  return (
    <div
      className={cn(
        "flex min-w-0 items-center text-xs text-muted-foreground",
        compact
          ? "w-full max-w-full shrink"
          : "max-w-[55%] shrink-0 sm:w-full sm:max-w-full sm:shrink",
      )}
      data-testid="chat-work-context"
    >
      {threadId ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("work.conversationDetails")}
              className={triggerClassName}
              title={workingDirectory ? `${label}\n${workingDirectory}` : label}
            >
              <span
                role="status"
                data-testid="thread-work-context"
                className="flex min-w-0 items-center gap-1"
              >
                {icon}
                <span className="max-w-32 truncate">{label}</span>
                {target?.kind === "local" && (
                  <>
                    <span aria-hidden="true" className="shrink-0">
                      ·
                    </span>
                    <Folder className="size-3 shrink-0" />
                    <span
                      data-testid="thread-working-directory"
                      title={workingDirectory ?? undefined}
                      className="min-w-0 truncate"
                    >
                      {directoryLabel}
                    </span>
                  </>
                )}
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
                ? t("work.runsInCloud")
                : t("work.fixedComputer")}
              {device &&
                !contextError &&
                (device.online
                  ? ` ${t("work.computerOnline")}`
                  : ` ${t("work.computerOffline")}`)}
            </p>
            {target?.kind === "local" && (
              <div className="space-y-2 border-t pt-2">
                <p className="text-xs font-medium">
                  {t("work.workingDirectory")}
                </p>
                <WorkingDirectoryPath
                  path={info?.workingDirectory}
                  native={target.deviceId === creation?.nativeId}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFilesOpen(true)}
                >
                  {t("common.files")}
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
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) void creation?.refresh();
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={t("work.chooseCloudOrComputer")}
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
              {t("work.cloud")}
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
              {t("work.myComputers")}
            </p>
            {creation?.devicesLoading && (
              <p role="status" className="px-2 py-1 text-xs">
                {t("work.loadingComputers")}
              </p>
            )}
            {creation?.devicesError &&
              creation.devicesError !== contextError && (
                <p role="alert" className="px-2 py-1 text-xs text-destructive">
                  {t("work.couldNotLoadComputers", {
                    error: creation.devicesError,
                  })}
                </p>
              )}
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
                      {d.id === creation.nativeId
                        ? `${t("work.thisComputer")} · `
                        : ""}
                      {d.name}
                      {creation.devices.filter((other) => other.name === d.name)
                        .length > 1
                        ? ` · ${d.id.slice(0, 6)}`
                        : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {d.online ? t("work.online") : t("work.offline")}
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
                void creation?.refresh();
              }}
            >
              <Plus className="mr-2 size-4" />
              {t("work.connectComputerEllipsis")}
            </Button>
          </PopoverContent>
        </Popover>
      )}
      {threadId && workspaceId && target?.kind === "local" && (
        <Dialog open={filesOpen} onOpenChange={setFilesOpen}>
          <DialogContent className="max-w-3xl overflow-hidden">
            <DialogHeader>
              <DialogTitle>{t("common.files")}</DialogTitle>
              <DialogDescription>
                {t("work.filesDescription")}
              </DialogDescription>
            </DialogHeader>
            {filesOpen && (
              <LocalFilesPanel
                key={`${workspaceId}:${threadId}`}
                workspaceId={workspaceId}
                threadId={threadId}
                computerName={info?.target?.name}
              />
            )}
          </DialogContent>
        </Dialog>
      )}
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("work.connectComputerTitle")}</DialogTitle>
            <DialogDescription>
              {t("work.connectComputerDescription")}
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
                    t("work.open")
                  ) : d.remoteEnabled ? (
                    t("work.connect")
                  ) : (
                    t("work.accessDisabled")
                  )}
                </Button>
              </div>
            ))}
          {creation?.devicesLoading && (
            <p role="status">{t("work.loadingComputers")}</p>
          )}
          {creation?.devicesError && (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>
                {t("work.couldNotLoadComputers", {
                  error: creation.devicesError,
                })}
              </p>
              <Button
                variant="outline"
                disabled={creation.devicesLoading}
                onClick={() => void creation.refresh()}
              >
                {t("common.tryAgain")}
              </Button>
            </div>
          )}
          {!creation?.devices.length &&
            !creation?.devicesLoading &&
            !creation?.devicesError && (
              <p className="text-sm text-muted-foreground">
                {t("work.noComputers")}
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

/**
 * A conversation's working directory with the actions that apply to it. `native` is true when
 * the conversation runs on the computer this desktop app runs on: only then can the app ask
 * that computer's file manager to show the directory.
 */
function WorkingDirectoryPath({
  path,
  native,
}: {
  path: string | null | undefined;
  native: boolean;
}) {
  const t = useTranslations("dashboardChat");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => {
    if (!native) return;
    let live = true;
    // The platform only picks the file manager's name. Until it is known, and if the app
    // cannot report it, the action keeps the name that is correct on every platform.
    void desktopBridge.info().then(
      (value) => {
        if (live) setPlatform(value.platform);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [native]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!path)
    return (
      <p className="break-all text-xs text-muted-foreground">
        {t("work.directoryConnectedWhenUsed")}
      </p>
    );
  return (
    <>
      <p
        data-testid="working-directory-path"
        title={path}
        className="break-all text-xs text-muted-foreground"
      >
        {shortenHomePath(path)}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="xs"
          variant="outline"
          onClick={async () => {
            setError(null);
            try {
              await navigator.clipboard.writeText(path);
              setCopied(true);
            } catch {
              setError(t("work.copyPathFailed"));
            }
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t("work.pathCopied") : t("work.copyPath")}
        </Button>
        {native && (
          <Button
            size="xs"
            variant="outline"
            onClick={async () => {
              setError(null);
              try {
                await desktopBridge.revealLocalDirectory(path);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            <FolderOpen />
            {platform === "macos"
              ? t("work.showInFinder")
              : t("work.showInFileManager")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

/** A folder this account may work in on a computer. `path` is in the wire form. */
type GrantedFolder = { id: string; name: string; path?: string };

/**
 * One entry per directory, in a stable order. Picking the same directory again creates another
 * grant with the same path; the selected grant is the one kept, so its check mark stays on the
 * entry that is shown.
 */
function distinctFolders(
  folders: GrantedFolder[],
  selectedId: string | null | undefined,
) {
  const byPath = new Map<string, GrantedFolder>();
  for (const folder of folders) {
    const key = folder.path ?? `grant:${folder.id}`;
    const kept = byPath.get(key);
    if (!kept || folder.id === selectedId) byPath.set(key, folder);
  }
  return [...byPath.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.path ?? "").localeCompare(b.path ?? ""),
  );
}

function FolderOption({
  icon,
  label,
  detail,
  detailTitle,
  selected,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  detailTitle?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      variant="ghost"
      aria-current={selected ? "true" : undefined}
      className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
      onClick={onSelect}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {detail && (
          <span
            title={detailTitle}
            className="block truncate text-xs font-normal text-muted-foreground"
          >
            {detail}
          </span>
        )}
      </span>
      {selected && <Check className="size-4 shrink-0" />}
    </Button>
  );
}

export function WorkingFolderPicker({
  creation,
  onChooseFolder,
  disabled = false,
}: {
  creation: Pick<
    ChatCreationContext,
    "target" | "nativeId" | "selectedDevice" | "setFolder"
  >;
  onChooseFolder?: () => Promise<void>;
  disabled?: boolean;
}) {
  const t = useTranslations("dashboardChat");
  const [folders, setFolders] = useState<GrantedFolder[]>([]);
  // Where this computer creates automatic task folders. Known only for the computer the
  // desktop app runs on; never guessed for another one.
  const [taskFolderPath, setTaskFolderPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const target = creation.target;
  const id = target?.kind === "local" ? target.deviceId : null;
  const selectedFolderId = target?.kind === "local" ? target.folderId : null;
  const connected = creation.selectedDevice?.connected;
  const native = id !== null && id === creation.nativeId;
  // Another computer has other folders. A new selection on the same computer keeps the list
  // on screen while it is read again, so the chosen folder's name does not flicker.
  useEffect(() => {
    setFolders([]);
  }, [id, connected]);
  useEffect(() => {
    let live = true;
    setError(null);
    if (id && connected)
      void localRequest<{ folders: GrantedFolder[] }>(
        `/v1/local-devices/${id}/folders`,
        undefined,
        { localProof: true },
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
  }, [id, connected, selectedFolderId]);
  useEffect(() => {
    if (!native) {
      setTaskFolderPath(null);
      return;
    }
    let live = true;
    // Read again whenever the list opens: the location can be changed in Settings. An app
    // version without this command leaves the location unknown, which the list says as such.
    void desktopBridge.getTaskFolder().then(
      (value) => {
        if (live) setTaskFolderPath(value.path);
      },
      () => {
        if (live) setTaskFolderPath(null);
      },
    );
    return () => {
      live = false;
    };
  }, [native, open]);
  if (target?.kind !== "local") return null;
  const folder = folders.find((f) => f.id === target.folderId);
  const label =
    folder?.name ??
    (target.folderId
      ? t("folderPicker.selectedFolderFallback")
      : t("work.taskFolder"));
  const title = target.folderId
    ? (folder?.path ?? label)
    : taskFolderPath
      ? t("folderPicker.createdIn", { path: taskFolderPath })
      : label;
  const listed = distinctFolders(folders, target.folderId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="working-folder-trigger"
          title={title}
          className="flex h-7 min-w-0 max-w-48 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted"
        >
          <Folder className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] gap-1 p-1.5"
      >
        <FolderOption
          icon={<FolderPlus className="size-4 text-muted-foreground" />}
          label={t("folderPicker.newTaskFolder")}
          detail={
            taskFolderPath
              ? t("folderPicker.createdIn", {
                  path: shortenHomePath(taskFolderPath),
                })
              : t("folderPicker.createdAutomatically")
          }
          detailTitle={taskFolderPath ?? undefined}
          selected={!target.folderId}
          onSelect={() => {
            creation.setFolder("");
            setOpen(false);
          }}
        />
        {listed.length > 0 && (
          <>
            <p className="px-2 pt-1 text-xs text-muted-foreground">
              {t("folderPicker.folders")}
            </p>
            <div
              data-testid="working-folder-list"
              className="max-h-56 overflow-y-auto"
            >
              {listed.map((f) => (
                <FolderOption
                  key={f.id}
                  icon={<Folder className="size-4 text-muted-foreground" />}
                  label={f.name}
                  detail={
                    f.path
                      ? shortenHomePath(parentOfWirePath(f.path))
                      : undefined
                  }
                  detailTitle={f.path}
                  selected={f.id === target.folderId}
                  onSelect={() => {
                    creation.setFolder(f.id);
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          </>
        )}
        {native && (
          <Button
            variant="ghost"
            className="w-full justify-start rounded-t-none border-t-border"
            onClick={async () => {
              setError(null);
              try {
                if (onChooseFolder) {
                  await onChooseFolder();
                  setOpen(false);
                  return;
                }
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
                // Closing the folder dialog without choosing is not a failure.
                if (!String(e).includes(FOLDER_SELECTION_CANCELLED))
                  setError(String(e));
              }
            }}
          >
            <Plus className="mr-2 size-4" />
            {t("folderPicker.chooseDifferentFolder")}
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
