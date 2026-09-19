"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { serveHubFileRequest } from "../../../../lib/hub-file-relay";
import { readLocalPreviewForHub } from "../../../../lib/local-file-preview";
import { localRequest } from "../../../../lib/local-execution";
import { downloadLocalFile } from "../../../../lib/local-file-download";
import { ensureLocalHostSession } from "../../../../lib/local-host-session";
import { hubSkillMemory } from "../../../../lib/hub-skill-memory";
import { registerHubSendBarrier } from "../../../../lib/hub-send-barrier";
import { authClient } from "../../../../lib/auth-client";
import { desktopBridge } from "../../../../lib/desktop-bridge";
import { desktopHubBridge as bridge } from "../../../../lib/desktop-hub-bridge";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import type { ChatHubRegistration } from "./chat-hub-context";
import {
  HUB_PROTOCOL,
  HubViewCache,
  hubContextKey,
  serializableHubData,
  validateHubCommand,
  type HubMessage,
  type HubSnapshot,
  type HubViewState,
} from "./hub-protocol";

export function useDesktopHubHost(
  registration: ChatHubRegistration,
  registered: boolean,
  onDock?: () => void,
) {
  const dockPresentation = useRef(onDock);
  dockPresentation.current = onDock;
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const dashboard = useDashboardChatState();
  const [available, setAvailable] = useState(false);
  const [mode, setMode] = useState<"inline" | "opening" | "detached">("inline");
  const [inlineVisible, setInlineVisible] = useState(true);
  const [viewVersion, setViewVersion] = useState(0);
  const [publishedKey, setPublishedKey] = useState("");
  const barriers = useRef(new Map<string, (pending: boolean) => void>());
  const cache = useRef(new HubViewCache());
  const knownContexts = useRef(new Map<string, HubSnapshot>());
  const deferredSources = useRef(new Map<string, Set<string>>());
  const sessionId = useRef("");
  const draftId = useRef("");
  const current = useRef<HubSnapshot | null>(null);
  const previousPath = useRef(pathname);
  const reg = useRef(registration);
  const peer = useRef<string | null>(null);
  const modeRef = useRef(mode);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expectedClose = useRef(false);
  const docking = useRef(false);
  const results = useRef(new Map<string, string | undefined>());
  const handling = useRef(new Set<string>());
  const listenerReady = useRef(false);
  const pending = useRef(false);
  reg.current = registration;
  modeRef.current = mode;
  if (!sessionId.current && typeof window !== "undefined")
    sessionId.current = crypto.randomUUID();
  if (!draftId.current && typeof window !== "undefined")
    draftId.current = `draft:${crypto.randomUUID()}`;

  const sendSnapshot = useCallback(async () => {
    if (current.current && peer.current === current.current.accountId) {
      await bridge.send({
        kind: "snapshot",
        snapshot: {
          ...current.current,
          view: cache.current.get(current.current.contextKey),
        },
      });
    }
  }, []);

  useLayoutEffect(() => {
    if (!session?.user.id) return;
    if (previousPath.current !== pathname && pathname === "/dashboard/chat")
      draftId.current = `draft:${crypto.randomUUID()}`;
    previousPath.current = pathname;
    const match = pathname?.match(/^\/dashboard\/chat(?:\/([^/]+))?\/?$/);
    const routeId = match?.[1] ? decodeURIComponent(match[1]) : null;
    const active = Boolean(
      match &&
      registered &&
      registration.workspaceId === dashboard.workspaceId &&
      (routeId
        ? registration.threadId === routeId
        : registration.mode === "new"),
    );
    const previous = current.current;
    const data =
      !match &&
      previous &&
      previous.accountId === session.user.id &&
      previous.data.workspaceId === dashboard.workspaceId
        ? previous.data
        : serializableHubData(registration);
    const contextKey = hubContextKey(
      session.user.id,
      dashboard.workspaceId,
      routeId ?? (match ? draftId.current : (data.threadId ?? draftId.current)),
    );
    const next: HubSnapshot = {
      protocolVersion: HUB_PROTOCOL,
      sessionId: sessionId.current,
      accountId: session.user.id,
      targetWorkspaceId: dashboard.workspaceId,
      contextKey,
      revision: previous?.revision ?? 0,
      title: active
        ? routeId
          ? (registration.threadTitle ?? dashboard.threadTitle)
          : "New conversation"
        : (previous?.title ?? "Hub"),
      phase: !match ? "away" : active ? "active" : "transition",
      data,
    };
    if (active || next.phase === "away")
      knownContexts.current.set(contextKey, next);
    if (knownContexts.current.size > 50)
      knownContexts.current.delete(knownContexts.current.keys().next().value!);
    if (active && deferredSources.current.has(contextKey)) {
      const ids = deferredSources.current.get(contextKey)!;
      const available = new Set(
        registration.initialSources.map((source) => source.id),
      );
      const additions = [...ids].filter((id) => available.has(id));
      if (additions.length) {
        for (const id of additions) ids.delete(id);
        if (!ids.size) deferredSources.current.delete(contextKey);
        registration.onSelectionChange([
          ...new Set([...registration.activeSourceIds, ...additions]),
        ]);
      }
    }
    if (
      JSON.stringify({ ...previous, view: undefined }) !== JSON.stringify(next)
    ) {
      next.revision++;
      current.current = next;
      setPublishedKey(next.contextKey);
      if (modeRef.current !== "inline")
        void sendSnapshot().catch((error) => toast.error(error.message));
    }
  }, [
    pathname,
    registration,
    registered,
    session?.user.id,
    dashboard.workspaceId,
    dashboard.threadTitle,
    sendSnapshot,
  ]);

  const handle = useRef<(message: HubMessage) => Promise<void>>(async () => {});
  handle.current = async (message) => {
    const snapshot = current.current;
    if (message.kind === "local-file-request") {
      await serveHubFileRequest(message.request, {
        current: () => current.current,
        authorize: ensureLocalHostSession,
        read: localRequest,
        preview: readLocalPreviewForHub,
        download: downloadLocalFile,
        send: (result) => bridge.send({ kind: "local-file-result", result }),
      });
    } else if (message.kind === "barrier-result") {
      barriers.current.get(message.id)?.(message.pending);
      barriers.current.delete(message.id);
    } else if (message.kind === "ready") {
      if (
        message.protocolVersion !== HUB_PROTOCOL ||
        message.accountId !== snapshot?.accountId
      ) {
        await bridge.send({ kind: "disconnected" });
        return;
      }
      peer.current = message.accountId;
      await sendSnapshot();
    } else if (message.kind === "applied") {
      if (docking.current) return;
      if (
        !snapshot ||
        message.sessionId !== snapshot.sessionId ||
        message.contextKey !== snapshot.contextKey ||
        message.revision !== snapshot.revision
      )
        return;
      if (timer.current) clearTimeout(timer.current);
      setMode("detached");
    } else if (message.kind === "view") {
      if (message.sessionId === snapshot?.sessionId)
        cache.current.set(message.contextKey, message.view);
    } else if (message.kind === "dock") {
      if (
        message.sessionId !== snapshot?.sessionId ||
        message.contextKey !== snapshot.contextKey ||
        snapshot.phase !== "active"
      ) {
        await bridge.send({
          kind: "dock-applied",
          sessionId: message.sessionId,
          error: "Return to the current conversation before docking Hub.",
        });
        return;
      }
      docking.current = true;
      if (message.view) cache.current.set(message.contextKey, message.view);
      setViewVersion((v) => v + 1);
      setInlineVisible(true);
      if (!dashboard.sourcesVisible) dashboard.toggleSourcesVisible();
      setMode("inline");
      dockPresentation.current?.();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      expectedClose.current = true;
      await bridge.send({
        kind: "dock-applied",
        sessionId: snapshot.sessionId,
      });
    } else if (message.kind === "closed" || message.kind === "destroyed") {
      if (timer.current) clearTimeout(timer.current);
      peer.current = null;
      docking.current = false;
      pending.current = false;
      if (message.kind === "closed") {
        expectedClose.current = true;
        if (message.reason === "close") setInlineVisible(false);
      } else if (!expectedClose.current && modeRef.current === "detached") {
        setInlineVisible(true);
        toast.error(
          "The Hub window closed unexpectedly. Hub has returned to the main window.",
        );
      }
      setMode("inline");
    } else if (message.kind === "command") {
      const command = message.command;
      if (!snapshot) return;
      if (handling.current.has(command.id)) return;
      if (results.current.has(command.id)) {
        await bridge.send({
          kind: "result",
          id: command.id,
          error: results.current.get(command.id),
        });
        return;
      }
      const scope =
        command.action?.type === "auto-sources" ||
        command.action?.type === "return"
          ? knownContexts.current.get(command.contextKey)
          : snapshot;
      let error = scope
        ? (validateHubCommand(command, {
            ...scope,
            phase:
              command.action?.type === "auto-sources" ? "active" : scope.phase,
          }) ?? undefined)
        : "The original conversation is no longer available.";
      handling.current.add(command.id);
      pending.current = true;
      try {
        if (!error) {
          const r = reg.current;
          const action = command.action;
          switch (action.type) {
            case "work-folder":
              r.onWorkFolderChange?.(action.folderId);
              break;
            case "choose-work-folder":
              await r.onChooseWorkFolder?.();
              break;
            case "auto-sources": {
              const additions = action.ids.filter(
                (id) => !scope!.data.activeSourceIds.includes(id),
              );
              if (
                command.contextKey === snapshot.contextKey &&
                snapshot.phase === "active"
              ) {
                flushSync(() =>
                  r.onSelectionChange([
                    ...new Set([...r.activeSourceIds, ...additions]),
                  ]),
                );
              } else {
                const ids =
                  deferredSources.current.get(command.contextKey) ??
                  new Set<string>();
                for (const id of additions) ids.add(id);
                deferredSources.current.set(command.contextKey, ids);
              }
              break;
            }
            case "sources":
              flushSync(() => r.onSelectionChange(action.ids));
              break;
            case "skills":
              flushSync(() => r.onSkillSelectionChange(action.ids));
              break;
            case "mcp":
              flushSync(() => r.onMcpSelectionChange(action));
              break;
            case "connectors":
              r.onConnectorsChange?.(action.connectors);
              break;
            case "sources-loaded":
              flushSync(() => r.onSourceLoad(action.sources));
              break;
            case "refresh-skills":
              await r.onSkillsCatalogChange();
              break;
            case "locate":
              r.onCitationLocate?.(action.messageId);
              await desktopBridge.showMainWindow();
              break;
            case "return": {
              const destination = scope!.data;
              if (
                destination.workspaceId &&
                destination.workspaceId !== dashboard.workspaceId
              ) {
                const switched = await dashboard.switchWorkspace(
                  destination.workspaceId,
                  destination.workspaceName ?? undefined,
                );
                if (!switched)
                  throw new Error(
                    "Could not return to the original workspace.",
                  );
              }
              const target = destination.threadId
                ? `/dashboard/chat/${encodeURIComponent(destination.threadId)}`
                : "/dashboard/chat";
              router.push(target);
              await desktopBridge.showMainWindow();
              break;
            }
          }
        }
      } catch (e) {
        error = e instanceof Error ? e.message : "Hub action failed.";
      } finally {
        pending.current = false;
        handling.current.delete(command.id);
      }
      results.current.set(command.id, error);
      if (results.current.size > 200)
        results.current.delete(results.current.keys().next().value!);
      await sendSnapshot();
      await bridge.send({ kind: "result", id: command.id, error });
    }
  };

  useEffect(() => {
    if (!desktopBridge.isAvailable()) return;
    let disposed = false;
    let unlisten: (() => Promise<void>) | undefined;
    void bridge
      .listen((m) => {
        void handle.current(m).catch((e) => toast.error(e.message));
      })
      .then((stop) => {
        if (disposed) {
          void stop();
          return;
        }
        unlisten = stop;
        listenerReady.current = true;
        setAvailable(true);
      })
      .catch((e) => toast.error(e.message));
    const unloading = () => {
      void bridge.send({ kind: "disconnected" });
    };
    window.addEventListener("beforeunload", unloading);
    return () => {
      disposed = true;
      listenerReady.current = false;
      void unlisten?.();
      window.removeEventListener("beforeunload", unloading);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(
    () =>
      registerHubSendBarrier(async () => {
        if (modeRef.current !== "detached") return;
        const revision = current.current?.revision;
        const id = crypto.randomUUID();
        const hasPending = await new Promise<boolean>((resolve, reject) => {
          const timeout = setTimeout(() => {
            barriers.current.delete(id);
            reject(
              new Error("Hub is not responding. Reconnect Hub before sending."),
            );
          }, 5000);
          barriers.current.set(id, (value) => {
            clearTimeout(timeout);
            resolve(value);
          });
          void bridge.send({ kind: "barrier", id }).catch((e) => {
            clearTimeout(timeout);
            barriers.current.delete(id);
            reject(e);
          });
        });
        if (
          hasPending ||
          pending.current ||
          revision !== current.current?.revision
        )
          throw new Error(
            "Hub selections are updating. Review them and send again.",
          );
      }),
    [],
  );

  const account = useRef(session?.user.id);
  useEffect(() => {
    if (account.current && account.current !== session?.user.id) {
      cache.current.clear();
      knownContexts.current.clear();
      deferredSources.current.clear();
      current.current = null;
      peer.current = null;
      results.current.clear();
      setMode("inline");
      if (desktopBridge.isAvailable())
        void bridge.action("logout").catch((e) => toast.error(e.message));
    }
    account.current = session?.user.id;
  }, [session?.user.id]);

  const open = useCallback(async () => {
    if (modeRef.current === "opening") return;
    try {
      if (modeRef.current === "detached") {
        await bridge.action("focus");
        return;
      }
      if (!listenerReady.current || current.current?.phase !== "active")
        throw new Error(
          "Wait for the current conversation to load before opening Hub.",
        );
      expectedClose.current = false;
      docking.current = false;
      setMode("opening");
      modeRef.current = "opening";
      await bridge.action("open");
      timer.current = setTimeout(() => {
        if (modeRef.current !== "opening") return;
        expectedClose.current = true;
        void bridge.action("abort").catch((e) => toast.error(e.message));
        setMode("inline");
        toast.error(
          "Hub did not finish connecting within 10 seconds. The inline Hub is still available.",
        );
      }, 10000);
    } catch (e) {
      setMode("inline");
      toast.error(e instanceof Error ? e.message : "Could not open Hub.");
    }
  }, []);

  return {
    available,
    mode,
    open,
    inlineVisible,
    viewVersion,
    showInline: () => setInlineVisible(true),
    saveView: (view: HubViewState) => {
      if (publishedKey)
        cache.current.set(publishedKey, {
          ...cache.current.get(publishedKey),
          ...view,
        });
    },
    getView: () =>
      current.current
        ? cache.current.get(current.current.contextKey)
        : undefined,
    contextKey: publishedKey,
    promoteDraft: (threadId: string) => {
      const s = current.current;
      if (!s || s.data.mode !== "new" || !s.data.workspaceId) return;
      const key = hubContextKey(s.accountId, s.data.workspaceId, threadId);
      const existing = cache.current.get(s.contextKey);
      if (existing) cache.current.set(key, existing);
      hubSkillMemory.write(
        s.accountId,
        s.data.workspaceId,
        threadId,
        s.data.activeSkillIds,
      );
    },
    pending,
  };
}
