"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  archivedChats as initialArchivedChats,
  privateChats as initialPrivateChats,
  sharedChats as initialSharedChats,
  type ChatItem,
} from "../chat/_components/mock-data";

type ViewMode = "thread" | "new";

type DashboardChatState = {
  mode: ViewMode;
  sourcesVisible: boolean;
  workspaceName: string;
  activeChatId: string;
  threadTitle: string;
  sharedChats: ChatItem[];
  privateChats: ChatItem[];
  archivedChats: ChatItem[];
  toggleSourcesVisible: () => void;
  setWorkspaceName: (workspaceName: string) => void;
  startNewChat: () => void;
  createChat: (title?: string) => void;
  openChat: (id: string, title: string) => void;
  archiveChat: (id: string) => void;
  deleteChat: (id: string) => void;
};

const DashboardChatStateContext = createContext<DashboardChatState | null>(
  null,
);

export function DashboardChatStateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [mode, setMode] = useState<ViewMode>("new");
  const [sourcesVisible, setSourcesVisible] = useState(true);
  const [workspaceName, setWorkspaceName] = useState("AI Research Desk");

  const [sharedChats, setSharedChats] =
    useState<ChatItem[]>(initialSharedChats);
  const [privateChats, setPrivateChats] =
    useState<ChatItem[]>(initialPrivateChats);
  const [archivedChats, setArchivedChats] =
    useState<ChatItem[]>(initialArchivedChats);

  const [activeChatId, setActiveChatId] = useState("");
  const [threadTitle, setThreadTitle] = useState("New chat");
  const [chatCounter, setChatCounter] = useState(1);

  const toggleSourcesVisible = useCallback(() => {
    setSourcesVisible((value) => !value);
  }, []);

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

  const createChat = useCallback(
    (title?: string) => {
      const safeTitle = title?.trim() || `New conversation ${chatCounter}`;
      const id = `new-${chatCounter}`;

      setChatCounter((value) => value + 1);
      setPrivateChats((value) => [
        {
          id,
          title: safeTitle,
          updatedAt: "Now",
          sourceCount: 0,
          status: "ready",
        },
        ...value,
      ]);

      setMode("thread");
      setActiveChatId(id);
      setThreadTitle(safeTitle);
    },
    [chatCounter],
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
          return [{ ...candidate, updatedAt: "Now" }, ...value];
        });
      }
    },
    [sharedChats, privateChats],
  );

  const deleteChat = useCallback((id: string) => {
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

  const state = useMemo<DashboardChatState>(
    () => ({
      mode,
      sourcesVisible,
      workspaceName,
      activeChatId,
      threadTitle,
      sharedChats,
      privateChats,
      archivedChats,
      toggleSourcesVisible,
      setWorkspaceName,
      startNewChat,
      createChat,
      openChat,
      archiveChat,
      deleteChat,
    }),
    [
      mode,
      sourcesVisible,
      workspaceName,
      activeChatId,
      threadTitle,
      sharedChats,
      privateChats,
      archivedChats,
      toggleSourcesVisible,
      openChat,
      createChat,
      archiveChat,
      deleteChat,
      startNewChat,
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
