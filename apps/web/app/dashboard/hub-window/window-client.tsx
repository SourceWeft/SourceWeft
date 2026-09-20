"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, X, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { toast } from "sonner";
import {
  createHubFileClient,
  registerHubFileRequester,
} from "../../../lib/hub-file-relay";
import { contentClient } from "../../../lib/sdk";
import { authClient } from "../../../lib/auth-client";
import { desktopBridge } from "../../../lib/desktop-bridge";
import { desktopHubBridge as bridge } from "../../../lib/desktop-hub-bridge";
import { SourcePreviewPanel } from "../chat/_components/source-preview-panel";
import type { CitationRecord } from "../chat/_components/chat-canvas";
import {
  SourcesHub,
  ArtifactPreviewPanel,
} from "../chat/_components/sources-hub";
import type { ArtifactListItem } from "../chat/_components/sources-hub";
import {
  HUB_PROTOCOL,
  type HubAction,
  type HubMessage,
  type HubSnapshot,
  type HubViewState,
} from "../chat/_components/hub-protocol";

export function DesktopHubWindow() {
  const t = useTranslations("dashboardWindows");
  const { data: session, isPending } = authClient.useSession();
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    setAvailable(desktopBridge.isAvailable());
  }, []);
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState({ editing: false, busy: false });
  const [generation, setGeneration] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [citation, setCitation] = useState<CitationRecord | null>(null);
  const [preview, setPreview] = useState<ArtifactListItem | null>(null);
  const [docking, setDocking] = useState(false);
  const dockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newest = useRef<HubSnapshot | null>(null);
  const visible = useRef(snapshot);
  const activityRef = useRef(activity);
  const view = useRef<HubViewState | undefined>(undefined);
  const lastSeen = useRef(0);
  const opened = useRef(false);
  const pending = useRef(
    new Map<
      string,
      {
        resolve: () => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  activityRef.current = activity;
  visible.current = snapshot;

  const fileClient = useMemo(
    () =>
      createHubFileClient({
        current: () => visible.current,
        connected: () => connectedRef.current,
        send: (request) => bridge.send({ kind: "local-file-request", request }),
      }),
    [],
  );
  const apply = useCallback((next: HubSnapshot) => {
    if (visible.current?.contextKey !== next.contextKey) {
      setPreview(null);
      setCitation(null);
      view.current = next.view;
    }
    visible.current = next;
    setSnapshot(next);
    document.title = `Hub · ${next.title} · SourceWeft`;
    void bridge
      .send({
        kind: "applied",
        sessionId: next.sessionId,
        contextKey: next.contextKey,
        revision: next.revision,
      })
      .catch((e) => setError(e.message));
    if (!opened.current) {
      opened.current = true;
      void bridge.action("show").catch((e) => setError(e.message));
    }
  }, []);

  const close = useCallback(async () => {
    if (activityRef.current.busy) {
      toast.error(t("hub.uploadRunningToast"));
      return;
    }
    if (
      activityRef.current.editing &&
      !window.confirm(t("hub.discardCloseConfirm"))
    )
      return;
    await bridge.action("close");
  }, [t]);

  useEffect(() => {
    if (!desktopBridge.isAvailable() || !session?.user.id) return;
    let disposed = false;
    let unlisten: (() => Promise<void>) | undefined;
    const unregisterFiles = registerHubFileRequester(fileClient.request);
    const accountId = session.user.id;
    const pendingCommands = pending.current;
    const hello = () =>
      bridge.send({ kind: "ready", accountId, protocolVersion: HUB_PROTOCOL });
    const handle = (message: HubMessage) => {
      if (message.kind === "local-file-result") {
        fileClient.receive(message.result);
      } else if (message.kind === "barrier") {
        void bridge
          .send({
            kind: "barrier-result",
            id: message.id,
            pending: pending.current.size > 0 || !connectedRef.current,
          })
          .catch((e) => setError(e.message));
      } else if (message.kind === "snapshot") {
        const next = message.snapshot;
        if (
          next.protocolVersion !== HUB_PROTOCOL ||
          next.accountId !== accountId
        ) {
          setSnapshot(null);
          newest.current = null;
          setConnected(false);
          setError(t("hub.accountMismatch"));
          return;
        }
        if (
          newest.current?.sessionId === next.sessionId &&
          newest.current.revision > next.revision
        )
          return;
        if (newest.current && newest.current.sessionId !== next.sessionId) {
          for (const p of pendingCommands.values()) {
            clearTimeout(p.timer);
            p.reject(new Error(t("hub.mainWindowRestarted")));
          }
          pendingCommands.clear();
          setPendingCount(0);
        }
        lastSeen.current = Date.now();
        setConnected(true);
        setError(null);
        newest.current = next;
        const isChanging =
          visible.current &&
          (visible.current.contextKey !== next.contextKey ||
            next.phase !== "active");
        if (
          isChanging &&
          (activityRef.current.editing || activityRef.current.busy)
        ) {
          // Keep the old operation/form mounted, with its captured scope. A
          // cross-workspace transition hides its portals as well as its body.
          setGeneration((v) => v + 1);
        } else apply(next);
      } else if (message.kind === "result") {
        const command = pending.current.get(message.id);
        if (!command) return;
        clearTimeout(command.timer);
        pending.current.delete(message.id);
        setPendingCount(pending.current.size);
        if (message.error) command.reject(new Error(message.error));
        else command.resolve();
      } else if (message.kind === "disconnected") {
        setConnected(false);
        setError(t("hub.connectionInterrupted"));
      } else if (message.kind === "close-requested") {
        void close().catch((e) => setError(e.message));
      } else if (
        message.kind === "dock-applied" &&
        message.sessionId === visible.current?.sessionId
      ) {
        if (dockTimer.current) clearTimeout(dockTimer.current);
        if (message.error) {
          setDocking(false);
          setError(message.error);
          return;
        }
        void bridge.action("docked").catch((e) => {
          setDocking(false);
          setError(e.message);
        });
      }
    };
    void bridge
      .listen(handle)
      .then(async (stop) => {
        if (disposed) {
          await stop();
          return;
        }
        unlisten = stop;
        await hello();
      })
      .catch((e) => setError(e.message));
    const heartbeat = setInterval(() => {
      if (lastSeen.current && Date.now() - lastSeen.current > 15000) {
        setConnected(false);
        setError(t("hub.notResponding"));
      }
      void hello().catch((e) => {
        setConnected(false);
        setError(e.message);
      });
    }, 5000);
    return () => {
      disposed = true;
      unregisterFiles();
      fileClient.cancel(t("hub.sessionEnded"));
      clearInterval(heartbeat);
      if (dockTimer.current) clearTimeout(dockTimer.current);
      void unlisten?.();
      for (const p of pendingCommands.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(t("hub.sessionEnded")));
      }
      pendingCommands.clear();
      newest.current = null;
      visible.current = null;
    };
  }, [session?.user.id, apply, close, fileClient, t]);

  useEffect(() => {
    if (
      !activity.editing &&
      !activity.busy &&
      newest.current &&
      newest.current !== visible.current
    )
      apply(newest.current);
  }, [activity, apply, generation]);

  useEffect(() => {
    const guard = (event: Event) => {
      if (
        connectedRef.current &&
        newest.current?.phase === "active" &&
        visible.current?.data.workspaceId ===
          (newest.current.targetWorkspaceId !== undefined
            ? newest.current.targetWorkspaceId
            : newest.current.data.workspaceId)
      )
        return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-hub-toolbar]"))
        return;
      if (event instanceof KeyboardEvent && event.key === "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const event of ["click", "keydown", "submit", "drop"])
      document.addEventListener(event, guard, true);
    return () => {
      for (const event of ["click", "keydown", "submit", "drop"])
        document.removeEventListener(event, guard, true);
    };
  }, []);
  const crossWorkspace = Boolean(
    snapshot &&
    newest.current &&
    snapshot.data.workspaceId !==
      (newest.current.targetWorkspaceId !== undefined
        ? newest.current.targetWorkspaceId
        : newest.current.data.workspaceId),
  );
  useEffect(() => {
    if (crossWorkspace) document.documentElement.dataset.hubHidden = "true";
    else delete document.documentElement.dataset.hubHidden;
    return () => {
      delete document.documentElement.dataset.hubHidden;
    };
  }, [crossWorkspace]);

  const command = useCallback((action: HubAction, quiet = false) => {
    const s = visible.current;
    if (!s || !connectedRef.current)
      return Promise.reject(new Error(t("hub.disconnected")));
    const id = crypto.randomUUID();
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current.delete(id);
        setPendingCount(pending.current.size);
        reject(new Error(t("hub.actionNotConfirmed")));
      }, 10000);
      pending.current.set(id, { resolve, reject, timer });
      setPendingCount(pending.current.size);
      void bridge
        .send({
          kind: "command",
          command: {
            id,
            sessionId: s.sessionId,
            contextKey: s.contextKey,
            revision: s.revision,
            action,
          },
        })
        .catch((e) => {
          clearTimeout(timer);
          pending.current.delete(id);
          setPendingCount(pending.current.size);
          reject(e);
        });
    });
    return promise.catch((e) => {
      if (!quiet) toast.error(e.message);
      throw e;
    });
  }, [t]);
  const fire = useCallback(
    (action: HubAction) => {
      void command(action).catch(() => {});
    },
    [command],
  );
  const actions = useMemo(
    () => ({
      sources: (ids: string[]) => fire({ type: "sources", ids }),
      autoSources: (ids: string[]) => fire({ type: "auto-sources", ids }),
      skills: (ids: string[]) => fire({ type: "skills", ids }),
      mcp: (s: import("@sourceweft/sdk").McpToolSelection) =>
        fire({
          type: "mcp",
          installIds: s.installIds ?? [],
          toolIds: s.toolIds ?? [],
        }),
      locate: (messageId: string) => fire({ type: "locate", messageId }),
      refreshSkills: () => command({ type: "refresh-skills" }),
      workFolder: (folderId: string) => {
        void command({ type: "work-folder", folderId });
      },
      chooseWorkFolder: async () => {
        await command({ type: "choose-work-folder" });
      },
      connectors: (connectors: import("@sourceweft/sdk").SourceConnector[]) =>
        fire({ type: "connectors", connectors }),
      sourcesLoaded: (
        sources: import("../chat/_components/source-types").SourceItem[],
      ) => {
        if (
          visible.current?.contextKey !== newest.current?.contextKey ||
          newest.current?.phase !== "active"
        )
          return;
        void command({ type: "sources-loaded", sources }, true).catch((e) =>
          setError(e.message),
        );
      },
    }),
    [fire, command],
  );
  const saveView = useCallback((state: HubViewState) => {
    view.current = { ...view.current, ...state };
    const s = visible.current;
    if (s)
      void bridge
        .send({
          kind: "view",
          sessionId: s.sessionId,
          contextKey: s.contextKey,
          view: view.current,
        })
        .catch((e) => setError(e.message));
  }, []);
  const restoreArtifactId = snapshot?.view?.artifactId;
  const restoreWorkspaceId = snapshot?.data.workspaceId;
  useEffect(() => {
    if (!restoreArtifactId || !restoreWorkspaceId) return;
    let cancelled = false;
    void contentClient
      .getArtifact(restoreWorkspaceId, restoreArtifactId)
      .then(({ artifact }) => {
        if (!cancelled && view.current?.artifactId === restoreArtifactId)
          setPreview(artifact);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [restoreArtifactId, restoreWorkspaceId]);
  const openArtifact = useCallback(
    (artifact: ArtifactListItem) => {
      setPreview(artifact);
      saveView({ artifactId: artifact.id });
    },
    [saveView],
  );
  const closeArtifact = () => {
    setPreview(null);
    saveView({ artifactId: undefined });
  };
  const dock = async () => {
    if (!snapshot) return;
    setDocking(true);
    try {
      await bridge.send({
        kind: "dock",
        sessionId: snapshot.sessionId,
        contextKey: snapshot.contextKey,
        view: view.current,
      });
      dockTimer.current = setTimeout(() => {
        setDocking(false);
        setError(t("hub.dockNotConfirmed"));
      }, 10000);
    } catch (e) {
      setDocking(false);
      setError(e instanceof Error ? e.message : t("hub.dockFailed"));
    }
  };

  if (!available)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("hub.openFromDesktop")}
      </div>
    );
  if (
    !isPending &&
    (!session?.user.id || (snapshot && snapshot.accountId !== session.user.id))
  )
    return <div className="p-6 text-sm">{t("hub.signInAgain")}</div>;
  if (isPending || !snapshot)
    return (
      <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {error ?? t("hub.connecting")}
      </div>
    );
  const paused =
    snapshot !== newest.current && (activity.editing || activity.busy);
  const blocked =
    !connected ||
    paused ||
    snapshot.phase !== "active" ||
    pendingCount > 0 ||
    docking;
  const r = snapshot.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <style>{`html[data-hub-hidden="true"] [role="dialog"], html[data-hub-hidden="true"] [role="alertdialog"], html[data-hub-hidden="true"] [data-slot="dialog-overlay"] { visibility: hidden !important; pointer-events: none !important; }`}</style>
      <header
        data-hub-toolbar
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={snapshot.title}>
            {snapshot.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {r.workspaceName} ·{" "}
            {paused ? t("hub.followingPaused") : t("hub.followingCurrent")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          title={
            activity.editing || activity.busy
              ? t("hub.closeTitleBusy")
              : snapshot.phase === "active" && connected
                ? t("hub.closeTitleReturn")
                : t("hub.closeTitlePlain")
          }
          aria-label={t("hub.closeAria")}
          className="size-7 shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          disabled={
            docking || pendingCount > 0 || activity.editing || activity.busy
          }
          onClick={() => {
            void (
              snapshot.phase === "active" && connected ? dock() : close()
            ).catch((e) => setError(e.message));
          }}
        >
          {docking ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <X className="size-4" />
          )}
        </Button>
      </header>
      {error ? (
        <div
          data-hub-toolbar
          role="alert"
          className="flex items-center gap-2 border-b bg-destructive/5 p-3 text-xs"
        >
          <span className="flex-1">{error}</span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("hub.reconnectAria")}
            onClick={() => {
              if (session?.user.id)
                void bridge
                  .send({
                    kind: "ready",
                    accountId: session.user.id,
                    protocolVersion: HUB_PROTOCOL,
                  })
                  .catch((e) => setError(e.message));
            }}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      ) : null}
      {paused ? (
        <div
          data-hub-toolbar
          role="status"
          className="border-b bg-muted/50 p-3 text-xs"
        >
          {crossWorkspace
            ? t("hub.pausedCrossWorkspace")
            : t("hub.pausedFollow", {
                current: snapshot.title,
                target: newest.current?.title ?? "",
              })}
          {!activity.busy ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm(t("hub.discardFollowConfirm"))) {
                  setActivity({ editing: false, busy: false });
                  setResetKey((v) => v + 1);
                  if (newest.current) apply(newest.current);
                }
              }}
            >
              {t("hub.discardFollow")}
            </Button>
          ) : (
            <p className="mt-1">{t("hub.operationContinues")}</p>
          )}
        </div>
      ) : null}
      {snapshot.phase === "away" ? (
        <div
          data-hub-toolbar
          className="border-b p-3 text-xs text-muted-foreground"
        >
          {t("hub.mainWindowLeft")}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => fire({ type: "return" })}
          >
            {t("hub.returnToConversation")}
          </Button>
        </div>
      ) : null}
      <SourcePreviewPanel
        citation={citation}
        open={Boolean(citation) && !crossWorkspace}
        onOpenChange={(open) => {
          if (!open) setCitation(null);
        }}
        workspaceId={r.workspaceId}
      />
      {snapshot.phase === "transition" ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("hub.loadingConversation")}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1" hidden={crossWorkspace}>
          <fieldset
            disabled={blocked}
            className="h-full min-w-0 border-0 p-0"
            inert={blocked ? true : undefined}
          >
            {preview ? (
              <div className="flex h-full flex-col">
                <Button
                  className="shrink-0 self-start"
                  variant="ghost"
                  onClick={closeArtifact}
                >
                  <ArrowLeft className="mr-2 size-4" />
                  {t("hub.backToHub")}
                </Button>
                <ArtifactPreviewPanel
                  artifact={preview}
                  workspaceId={r.workspaceId}
                  onClose={closeArtifact}
                  className="min-h-0 w-full flex-1 border-0"
                />
              </div>
            ) : null}
            <div className="h-full" hidden={Boolean(preview)}>
              <SourcesHub
                key={`${snapshot.contextKey}:${resetKey}`}
                variant="window"
                viewKey={snapshot.contextKey}
                mode={r.mode}
                draftWorkContext={r.draftWorkContext}
                onWorkFolderChange={actions.workFolder}
                onChooseWorkFolder={actions.chooseWorkFolder}
                workspaceId={r.workspaceId}
                workspaceName={r.workspaceName}
                threadId={r.threadId}
                initialSources={r.initialSources}
                initialSourcesLoaded={r.initialSourcesLoaded}
                selectedIds={r.activeSourceIds}
                onSelectionChange={actions.sources}
                onAutomaticSelectionChange={actions.autoSources}
                installedSkills={r.availableSkills}
                hubSkills={r.hubSkills}
                capabilityCatalog={r.capabilityCatalog}
                disabledToolNames={r.disabledToolNames}
                selectedSkillIds={r.activeSkillIds}
                onSkillSelectionChange={actions.skills}
                selectedMcpInstallIds={r.activeMcpInstallIds}
                selectedMcpToolIds={r.activeMcpToolIds}
                onMcpSelectionChange={actions.mcp}
                citations={r.displayedCitations}
                threadCitations={r.threadCitations}
                activeCitationIndex={r.activeCitationIndex}
                currentCitationMessageId={r.activeCitationMessageId}
                onCitationLocate={actions.locate}
                onCitationOpen={setCitation}
                onArtifactOpen={openArtifact}
                artifactsRefreshKey={r.artifactsRefreshKey}
                workfilesRefreshKey={r.workfilesRefreshKey}
                onSkillsCatalogChange={actions.refreshSkills}
                onSourceLoad={actions.sourcesLoaded}
                onConnectorsChange={actions.connectors}
                initialView={snapshot.view}
                onViewChange={saveView}
                onActivityChange={setActivity}
              />
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}
