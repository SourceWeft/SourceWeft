"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { authClient } from "../../../lib/auth-client";
import { contentClient, workspaceClient } from "../../../lib/sdk";
import type { ChatItem } from "../chat/_components/mock-data";

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
  switchWorkspace: (workspaceId: string) => Promise<void>;
  loadMorePrivateChats: () => Promise<void>;
  startNewChat: () => void;
  createChat: (input?: {
    title?: string;
    modelSettings?: ThreadModelSettingsInput;
  }) => Promise<{ id: string; title: string } | null>;
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
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>(
    [],
  );

  const [sharedChats, setSharedChats] = useState<ChatItem[]>([]);
  const [privateChats, setPrivateChats] = useState<ChatItem[]>([]);
  const [archivedChats, setArchivedChats] = useState<ChatItem[]>([]);
  const [privateChatsCursor, setPrivateChatsCursor] = useState<string | null>(null);
  const [hasMorePrivateChats, setHasMorePrivateChats] = useState(false);
  const [isLoadingPrivateChats, setIsLoadingPrivateChats] = useState(false);

  const [activeChatId, setActiveChatId] = useState("");
  const [threadTitle, setThreadTitle] = useState("New chat");
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

  const hydrateWorkspace = useCallback(async (organizationId: string) => {
    const listed = await workspaceClient.listWorkspaces(organizationId);
    const first = listed.items[0];
    const resolvedItems =
      listed.items.length > 0
        ? listed.items
        : [await workspaceClient.createWorkspace(organizationId, { name: "General" })];
    const active = first ?? resolvedItems[0]!;

    setWorkspaces(resolvedItems.map((item) => ({ id: item.id, name: item.name })));
    setWorkspaceId(active.id);
    setWorkspaceName(active.name);

    setIsLoadingPrivateChats(true);
    setPrivateChats([]);
    setPrivateChatsCursor(null);
    setHasMorePrivateChats(false);

    try {
      await workspaceClient.setWorkspaceContext(active.id);
    } catch {
      // context persistence is best-effort for now
    }

    try {
      const threads = await fetchPrivateChatsPage(active.id);
      setPrivateChats(threads.items);
      setPrivateChatsCursor(threads.nextCursor);
      setHasMorePrivateChats(Boolean(threads.nextCursor));
    } finally {
      setIsLoadingPrivateChats(false);
    }
  }, [fetchPrivateChatsPage]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const current = await workspaceClient.getCurrentContext();
        const orgList = (orgs ?? []) as Array<{ id: string }>;
        const organizationId =
          activeOrg?.id ?? current.activeOrganizationId ?? orgList[0]?.id ?? null;

        if (!organizationId) {
          return;
        }

        if (!activeOrg?.id) {
          try {
            await authClient.organization.setActive({ organizationId });
          } catch {
            // keep bootstrapping even if active organization sync fails
          }
        }

        if (!cancelled) {
          await hydrateWorkspace(organizationId);
        }
      } catch {
        // keep UI usable; sidebar still renders local state
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [activeOrg?.id, hydrateWorkspace, orgs]);

  const switchWorkspace = useCallback(
    async (nextWorkspaceId: string) => {
      const target = workspaces.find((item) => item.id === nextWorkspaceId) ?? null;
      if (!target) {
        return;
      }

      setWorkspaceId(target.id);
      setWorkspaceName(target.name);
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
    [workspaces, fetchPrivateChatsPage],
  );

  const loadMorePrivateChats = useCallback(async () => {
    if (!workspaceId || !privateChatsCursor || isLoadingPrivateChats) {
      return;
    }

    setIsLoadingPrivateChats(true);

    try {
      const threads = await fetchPrivateChatsPage(workspaceId, privateChatsCursor);
      setPrivateChats((value) => {
        const existing = new Set(value.map((item) => item.id));
        const nextItems = threads.items.filter((item) => !existing.has(item.id));
        return [...value, ...nextItems];
      });
      setPrivateChatsCursor(threads.nextCursor);
      setHasMorePrivateChats(Boolean(threads.nextCursor));
    } finally {
      setIsLoadingPrivateChats(false);
    }
  }, [workspaceId, privateChatsCursor, isLoadingPrivateChats, fetchPrivateChatsPage]);

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

  const updateChatSourceCount = useCallback((id: string, sourceCount: number) => {
    setPrivateChats((value) =>
      value.map((item) =>
        item.id === id
          ? { ...item, sourceCount: Math.max(item.sourceCount, sourceCount) }
          : item,
      ),
    );
  }, []);

  const updateChatTitle = useCallback((id: string, title: string) => {
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
  }, [activeChatId]);

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
          return [{ ...candidate, updatedAt: new Date().toISOString() }, ...value];
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
      removeChatFromState(id);
    },
    [workspaceId, removeChatFromState],
  );

  const clearPrivateChats = useCallback(async () => {
    const privateIds = new Set(privateChats.map((item) => item.id));

    if (privateIds.size === 0) return;

    if (!workspaceId) return;

    await Promise.all(
      privateChats.map((item) => contentClient.deleteThread(workspaceId, item.id)),
    );

    privateIds.forEach(removeChatFromState);

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
      const threads = await fetchPrivateChatsPage(workspaceId, privateChatsCursor);
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
      archivedChats.map((item) => contentClient.deleteThread(workspaceId, item.id)),
    );

    archivedIds.forEach(removeChatFromState);

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
      switchWorkspace,
      loadMorePrivateChats,
      startNewChat,
      createChat,
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
      switchWorkspace,
      openChat,
      createChat,
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
