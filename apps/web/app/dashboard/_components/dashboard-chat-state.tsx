"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { authClient } from "../../../lib/auth-client";
import { ensureDashboardWorkspace } from "../../../lib/dashboard-workspace-bootstrap";
import { setStoredDashboardWorkspaceId } from "../../../lib/dashboard-workspace-context";
import { contentClient, workspaceClient } from "../../../lib/sdk";
import { clearStoredSourceSelection } from "../chat/_components/source-selection-storage";
import type { ChatItem } from "./dashboard-chat-types";

type ThreadModelSettingsInput = {
  llmProfileAlias?: string | null;
  imageProfileAlias?: string | null;
  visionProfileAlias?: string | null;
};

type ViewMode = "thread" | "new";
const THREADS_PAGE_SIZE = 20;

type DashboardChatState = {
  mode: ViewMode;
  sourcesVisible: boolean;
  organizationId: string | null;
  organizationName: string;
  workspaceId: string | null;
  workspaceName: string;
  workspaces: Array<{ id: string; name: string }>;
  activeChatId: string;
  threadTitle: string;
  sharedChats: ChatItem[];
  privateChats: ChatItem[];
  archivedChats: ChatItem[];
  hasMorePrivateChats: boolean;
  isLoadingPrivateChats: boolean;
  toggleSourcesVisible: () => void;
  setWorkspaceName: (workspaceName: string) => void;
  createWorkspace: (
    name?: string,
  ) => Promise<{ id: string; name: string } | null>;
  renameWorkspace: (
    workspaceId: string,
    name: string,
  ) => Promise<{ id: string; name: string } | null>;
  switchWorkspace: (
    workspaceId: string,
    workspaceName?: string,
  ) => Promise<void>;
  loadMorePrivateChats: () => Promise<void>;
  startNewChat: () => void;
  createChat: (input?: {
    title?: string;
    modelSettings?: ThreadModelSettingsInput;
  }) => Promise<{ id: string; title: string } | null>;
  adoptChat: (thread: {
    id: string;
    title: string;
    sourceCount?: number | null;
    updatedAt?: string | null;
  }) => void;
  updateChatTitle: (id: string, title: string) => void;
  updateChatSourceCount: (id: string, sourceCount: number) => void;
  refreshChatThread: (id: string) => Promise<{ title: string } | null>;
  openChat: (id: string, title: string) => void;
  archiveChat: (id: string) => void;
  deleteChat: (id: string) => Promise<void>;
  clearPrivateChats: () => Promise<void>;
  clearArchivedChats: () => Promise<void>;
};

const DashboardChatStateContext = createContext<DashboardChatState | null>(
  null,
);

function normalizeUpdatedAt(value?: string | null) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function mapThreadToChatItem(item: {
  id: string;
  title: string;
  sourceCount?: number | null;
  updatedAt?: string | null;
}): ChatItem {
  return {
    id: item.id,
    title: item.title,
    updatedAt: normalizeUpdatedAt(item.updatedAt),
    sourceCount: item.sourceCount ?? 0,
    status: "ready",
  };
}

function parseOrganizationMetadata(metadata: unknown) {
  if (!metadata) return {};
  if (typeof metadata === "object") return metadata as Record<string, unknown>;
  if (typeof metadata !== "string") return {};

  try {
    let parsed: unknown = JSON.parse(metadata);
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }

    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isPersonalOrganization(org: { metadata?: unknown }) {
  const metadata = parseOrganizationMetadata(org.metadata);
  const sourceweft = metadata.sourceweft;

  return (
    sourceweft &&
    typeof sourceweft === "object" &&
    "kind" in sourceweft &&
    sourceweft.kind === "personal"
  );
}

export function DashboardChatStateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const { data: orgs } = authClient.useListOrganizations();

  const [mode, setMode] = useState<ViewMode>("new");
  const [sourcesVisible, setSourcesVisible] = useState(true);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("Workspace");
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState("SourceWeft");
  const [workspaces, setWorkspaces] = useState<
    Array<{ id: string; name: string }>
  >([]);

  const [sharedChats, setSharedChats] = useState<ChatItem[]>([]);
  const [privateChats, setPrivateChats] = useState<ChatItem[]>([]);
  const [archivedChats, setArchivedChats] = useState<ChatItem[]>([]);
  const [privateChatsCursor, setPrivateChatsCursor] = useState<string | null>(
    null,
  );
  const [hasMorePrivateChats, setHasMorePrivateChats] = useState(false);
  const [isLoadingPrivateChats, setIsLoadingPrivateChats] = useState(false);

  const [activeChatId, setActiveChatId] = useState("");
  const [threadTitle, setThreadTitle] = useState("New chat");
  const activeOrganizationRef = useRef<string | null>(null);
  const hydrateGenerationRef = useRef(0);
  const toggleSourcesVisible = useCallback(() => {
    setSourcesVisible((value) => !value);
  }, []);

  const fetchPrivateChatsPage = useCallback(
    async (targetWorkspaceId: string, cursor?: string | null) => {
      const threads = await contentClient.listThreads(targetWorkspaceId, {
        cursor: cursor ?? undefined,
        limit: THREADS_PAGE_SIZE,
      });

      return {
        items: threads.items.map(mapThreadToChatItem),
        nextCursor: threads.nextCursor,
      };
    },
    [],
  );

  const hydrateWorkspace = useCallback(
    async (targetOrganizationId: string, generation: number) => {
      const isCurrent = () => hydrateGenerationRef.current === generation;
      const { active, items: resolvedItems } =
        await ensureDashboardWorkspace(targetOrganizationId);
      if (!isCurrent()) {
        return;
      }

      if (!active) {
        setWorkspaces([]);
        setWorkspaceId(null);
        setWorkspaceName("Workspace");
        setPrivateChats([]);
        setPrivateChatsCursor(null);
        setHasMorePrivateChats(false);
        setIsLoadingPrivateChats(false);
        return;
      }

      setWorkspaces(
        resolvedItems.map((item) => ({ id: item.id, name: item.name })),
      );
      setWorkspaceId(active.id);
      setWorkspaceName(active.name);
      setStoredDashboardWorkspaceId(targetOrganizationId, active.id);

      setIsLoadingPrivateChats(true);
      setPrivateChats([]);
      setPrivateChatsCursor(null);
      setHasMorePrivateChats(false);

      try {
        const threads = await fetchPrivateChatsPage(active.id);
        if (!isCurrent()) {
          return;
        }
        setPrivateChats(threads.items);
        setPrivateChatsCursor(threads.nextCursor);
        setHasMorePrivateChats(Boolean(threads.nextCursor));
      } finally {
        if (isCurrent()) {
          setIsLoadingPrivateChats(false);
        }
      }
    },
    [fetchPrivateChatsPage],
  );

  useEffect(() => {
    let cancelled = false;
    const generation = ++hydrateGenerationRef.current;

    async function bootstrap() {
      try {
        const current = await workspaceClient.getCurrentContext();
        const orgList = (orgs ?? []) as Array<{
          id: string;
          name?: string;
          metadata?: unknown;
        }>;
        const personalOrg = orgList.find(isPersonalOrganization);
        const resolvedOrganizationId =
          activeOrg?.id ??
          current.activeOrganizationId ??
          personalOrg?.id ??
          null;
        const resolvedOrganizationName =
          activeOrg?.name ??
          orgList.find((org) => org.id === resolvedOrganizationId)?.name ??
          "SourceWeft";

        if (!resolvedOrganizationId) {
          return;
        }

        if (!cancelled) {
          const organizationChanged =
            activeOrganizationRef.current !== resolvedOrganizationId;
          activeOrganizationRef.current = resolvedOrganizationId;
          setOrganizationId(resolvedOrganizationId);
          setOrganizationName(resolvedOrganizationName);

          if (organizationChanged) {
            setWorkspaceId(null);
            setWorkspaceName("Workspace");
            setWorkspaces([]);
            setPrivateChats([]);
            setPrivateChatsCursor(null);
            setHasMorePrivateChats(false);
            setSharedChats([]);
            setArchivedChats([]);
            setActiveChatId("");
            setThreadTitle("New chat");
            setMode("new");
            setIsLoadingPrivateChats(true);
          }
        }

        if (!activeOrg?.id) {
          try {
            await authClient.organization.setActive({
              organizationId: resolvedOrganizationId,
            });
          } catch {
            // keep bootstrapping even if active organization sync fails
          }
        }

        if (!cancelled) {
          await hydrateWorkspace(resolvedOrganizationId, generation);
        }
      } catch {
        // keep UI usable; sidebar still renders local state
        if (!cancelled && hydrateGenerationRef.current === generation) {
          setIsLoadingPrivateChats(false);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [activeOrg?.id, activeOrg?.name, hydrateWorkspace, orgs]);

  const createWorkspace = useCallback(
    async (name?: string) => {
      if (!organizationId) {
        return null;
      }

      const safeName = name?.trim() || `Workspace ${workspaces.length + 1}`;
      const workspace = await workspaceClient.createWorkspace(organizationId, {
        name: safeName,
      });
      const nextWorkspace = { id: workspace.id, name: workspace.name };

      setWorkspaces((value) => [...value, nextWorkspace]);
      setWorkspaceId(nextWorkspace.id);
      setWorkspaceName(nextWorkspace.name);
      setStoredDashboardWorkspaceId(organizationId, nextWorkspace.id);
      setPrivateChats([]);
      setPrivateChatsCursor(null);
      setHasMorePrivateChats(false);
      setMode("new");
      setActiveChatId("");
      setThreadTitle("New chat");

      try {
        await workspaceClient.setWorkspaceContext(nextWorkspace.id);
      } catch {
        // context persistence is best-effort for now
      }

      return nextWorkspace;
    },
    [organizationId, workspaces.length],
  );

  const renameWorkspace = useCallback(
    async (targetWorkspaceId: string, name: string) => {
      const safeName = name.trim();
      if (!safeName) {
        return null;
      }

      const workspace = await workspaceClient.updateWorkspace(
        targetWorkspaceId,
        {
          name: safeName,
        },
      );
      const renamedWorkspace = { id: workspace.id, name: workspace.name };

      setWorkspaces((value) =>
        value.map((item) =>
          item.id === renamedWorkspace.id ? renamedWorkspace : item,
        ),
      );
      setWorkspaceName((value) =>
        workspaceId === renamedWorkspace.id ? renamedWorkspace.name : value,
      );

      return renamedWorkspace;
    },
    [workspaceId],
  );

  const switchWorkspace = useCallback(
    async (nextWorkspaceId: string, nextWorkspaceName?: string) => {
      const target =
        workspaces.find((item) => item.id === nextWorkspaceId) ??
        (nextWorkspaceName
          ? { id: nextWorkspaceId, name: nextWorkspaceName }
          : null);
      if (!target) {
        return;
      }

      setWorkspaces((value) =>
        value.some((item) => item.id === target.id)
          ? value
          : [...value, target],
      );
      setWorkspaceId(target.id);
      setWorkspaceName(target.name);
      setStoredDashboardWorkspaceId(organizationId, target.id);
      setIsLoadingPrivateChats(true);
      setPrivateChats([]);
      setPrivateChatsCursor(null);
      setHasMorePrivateChats(false);

      try {
        await workspaceClient.setWorkspaceContext(target.id);
      } catch {
        // ignore set-context failures; listing threads can still work
      }

      try {
        const threads = await fetchPrivateChatsPage(target.id);
        setPrivateChats(threads.items);
        setPrivateChatsCursor(threads.nextCursor);
        setHasMorePrivateChats(Boolean(threads.nextCursor));
        setMode("new");
        setActiveChatId("");
        setThreadTitle("New chat");
      } catch {
        // leave previous list in place if fetch fails
      } finally {
        setIsLoadingPrivateChats(false);
      }
    },
    [organizationId, workspaces, fetchPrivateChatsPage],
  );

  const loadMorePrivateChats = useCallback(async () => {
    if (!workspaceId || !privateChatsCursor || isLoadingPrivateChats) {
      return;
    }

    setIsLoadingPrivateChats(true);

    try {
      const threads = await fetchPrivateChatsPage(
        workspaceId,
        privateChatsCursor,
      );
      setPrivateChats((value) => {
        const existing = new Set(value.map((item) => item.id));
        const nextItems = threads.items.filter(
          (item) => !existing.has(item.id),
        );
        return [...value, ...nextItems];
      });
      setPrivateChatsCursor(threads.nextCursor);
      setHasMorePrivateChats(Boolean(threads.nextCursor));
    } finally {
      setIsLoadingPrivateChats(false);
    }
  }, [
    workspaceId,
    privateChatsCursor,
    isLoadingPrivateChats,
    fetchPrivateChatsPage,
  ]);

  const startNewChat = useCallback(() => {
    setActiveChatId("");
    setMode("new");
    setThreadTitle("New chat");
  }, []);

  const openChat = useCallback((id: string, title: string) => {
    setMode("thread");
    setActiveChatId(id);
    setThreadTitle(title);
  }, []);

  const updateChatSourceCount = useCallback(
    (id: string, sourceCount: number) => {
      setPrivateChats((value) =>
        value.map((item) =>
          item.id === id
            ? { ...item, sourceCount: Math.max(item.sourceCount, sourceCount) }
            : item,
        ),
      );
    },
    [],
  );

  const updateChatTitle = useCallback(
    (id: string, title: string) => {
      const safeTitle = title.trim();
      if (!safeTitle) return;

      const updateItem = (item: ChatItem) =>
        item.id === id
          ? { ...item, title: safeTitle, updatedAt: new Date().toISOString() }
          : item;

      setPrivateChats((value) => value.map(updateItem));
      setSharedChats((value) => value.map(updateItem));
      setArchivedChats((value) => value.map(updateItem));
      setThreadTitle((value) => (activeChatId === id ? safeTitle : value));
    },
    [activeChatId],
  );

  const refreshChatThread = useCallback(
    async (id: string) => {
      if (!workspaceId) {
        return null;
      }

      const result = await contentClient.getThread(workspaceId, id);
      const nextItem = mapThreadToChatItem(result.thread);
      const updateItem = (item: ChatItem) =>
        item.id === id ? { ...item, ...nextItem } : item;

      setPrivateChats((value) => value.map(updateItem));
      setSharedChats((value) => value.map(updateItem));
      setArchivedChats((value) => value.map(updateItem));
      setThreadTitle((value) => (activeChatId === id ? nextItem.title : value));

      return { title: nextItem.title };
    },
    [activeChatId, workspaceId],
  );

  const createChat = useCallback(
    async (input?: {
      title?: string;
      modelSettings?: ThreadModelSettingsInput;
    }): Promise<{ id: string; title: string } | null> => {
      if (!workspaceId) return null;

      const safeTitle = input?.title?.trim() || "New chat";

      try {
        const result = await contentClient.createThread(workspaceId, {
          title: safeTitle,
          modelSettings: input?.modelSettings,
        });
        const { id, title: newTitle } = result.thread;

        setPrivateChats((value) => [
          {
            id,
            title: newTitle,
            updatedAt: new Date().toISOString(),
            sourceCount: 0,
            status: "ready",
          },
          ...value,
        ]);
        setMode("thread");
        setActiveChatId(id);
        setThreadTitle(newTitle);

        return { id, title: newTitle };
      } catch {
        return null;
      }
    },
    [workspaceId],
  );

  const adoptChat = useCallback(
    (thread: {
      id: string;
      title: string;
      sourceCount?: number | null;
      updatedAt?: string | null;
    }) => {
      const item = mapThreadToChatItem(thread);
      setPrivateChats((value) => {
        const withoutExisting = value.filter((chat) => chat.id !== item.id);
        return [item, ...withoutExisting];
      });
      setSharedChats((value) => value.filter((chat) => chat.id !== item.id));
      setArchivedChats((value) => value.filter((chat) => chat.id !== item.id));
      setMode("thread");
      setActiveChatId(item.id);
      setThreadTitle(item.title);
    },
    [],
  );

  const archiveChat = useCallback(
    (id: string) => {
      const candidate = [...sharedChats, ...privateChats].find(
        (item) => item.id === id,
      );

      setSharedChats((value) => value.filter((item) => item.id !== id));
      setPrivateChats((value) => value.filter((item) => item.id !== id));

      if (candidate) {
        setArchivedChats((value) => {
          const exists = value.some((item) => item.id === candidate.id);
          if (exists) return value;
          return [
            { ...candidate, updatedAt: new Date().toISOString() },
            ...value,
          ];
        });
      }
    },
    [sharedChats, privateChats],
  );

  const removeChatFromState = useCallback((id: string) => {
    setSharedChats((value) => value.filter((item) => item.id !== id));
    setPrivateChats((value) => value.filter((item) => item.id !== id));
    setArchivedChats((value) => value.filter((item) => item.id !== id));

    setActiveChatId((value) => {
      if (value !== id) return value;
      setMode("new");
      setThreadTitle("New chat");
      return "";
    });
  }, []);

  const deleteChat = useCallback(
    async (id: string) => {
      if (!workspaceId) return;

      await contentClient.deleteThread(workspaceId, id);
      clearStoredSourceSelection(workspaceId, id);
      removeChatFromState(id);
    },
    [workspaceId, removeChatFromState],
  );

  const clearPrivateChats = useCallback(async () => {
    const privateIds = new Set(privateChats.map((item) => item.id));

    if (privateIds.size === 0) return;

    if (!workspaceId) return;

    await Promise.all(
      privateChats.map((item) =>
        contentClient.deleteThread(workspaceId, item.id),
      ),
    );

    privateIds.forEach(removeChatFromState);
    privateIds.forEach((id) => clearStoredSourceSelection(workspaceId, id));

    setActiveChatId((value) => {
      if (!privateIds.has(value)) return value;
      setMode("new");
      setThreadTitle("New chat");
      return "";
    });

    if (!workspaceId || !privateChatsCursor) {
      setHasMorePrivateChats(false);
      return;
    }

    setIsLoadingPrivateChats(true);

    try {
      const threads = await fetchPrivateChatsPage(
        workspaceId,
        privateChatsCursor,
      );
      setPrivateChats(threads.items);
      setPrivateChatsCursor(threads.nextCursor);
      setHasMorePrivateChats(Boolean(threads.nextCursor));
    } finally {
      setIsLoadingPrivateChats(false);
    }
  }, [
    workspaceId,
    privateChats,
    privateChatsCursor,
    fetchPrivateChatsPage,
    removeChatFromState,
  ]);

  const clearArchivedChats = useCallback(async () => {
    const archivedIds = new Set(archivedChats.map((item) => item.id));

    if (archivedIds.size === 0) return;

    if (!workspaceId) return;

    await Promise.all(
      archivedChats.map((item) =>
        contentClient.deleteThread(workspaceId, item.id),
      ),
    );

    archivedIds.forEach(removeChatFromState);
    archivedIds.forEach((id) => clearStoredSourceSelection(workspaceId, id));

    setActiveChatId((value) => {
      if (!archivedIds.has(value)) return value;
      setMode("new");
      setThreadTitle("New chat");
      return "";
    });
  }, [workspaceId, archivedChats, removeChatFromState]);

  const state = useMemo<DashboardChatState>(
    () => ({
      mode,
      sourcesVisible,
      organizationId,
      organizationName,
      workspaceId,
      workspaceName,
      workspaces,
      activeChatId,
      threadTitle,
      sharedChats,
      privateChats,
      archivedChats,
      hasMorePrivateChats,
      isLoadingPrivateChats,
      toggleSourcesVisible,
      setWorkspaceName,
      createWorkspace,
      renameWorkspace,
      switchWorkspace,
      loadMorePrivateChats,
      startNewChat,
      createChat,
      adoptChat,
      updateChatTitle,
      updateChatSourceCount,
      refreshChatThread,
      openChat,
      archiveChat,
      deleteChat,
      clearPrivateChats,
      clearArchivedChats,
    }),
    [
      mode,
      sourcesVisible,
      organizationId,
      organizationName,
      workspaceId,
      workspaceName,
      workspaces,
      activeChatId,
      threadTitle,
      sharedChats,
      privateChats,
      archivedChats,
      hasMorePrivateChats,
      isLoadingPrivateChats,
      toggleSourcesVisible,
      createWorkspace,
      renameWorkspace,
      switchWorkspace,
      openChat,
      createChat,
      adoptChat,
      updateChatTitle,
      updateChatSourceCount,
      refreshChatThread,
      archiveChat,
      deleteChat,
      clearPrivateChats,
      clearArchivedChats,
      startNewChat,
      loadMorePrivateChats,
    ],
  );

  return (
    <DashboardChatStateContext.Provider value={state}>
      {children}
    </DashboardChatStateContext.Provider>
  );
}

export function useDashboardChatState() {
  const context = useContext(DashboardChatStateContext);
  if (!context) {
    throw new Error(
      "useDashboardChatState must be used within DashboardChatStateProvider",
    );
  }
  return context;
}
