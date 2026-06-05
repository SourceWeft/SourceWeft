type ViewMode = "thread" | "new";
export type WorkspaceSwitchStatus = "idle" | "loading" | "error";

type DashboardChatSelection = {
  mode: ViewMode;
  activeChatId: string;
  threadTitle: string;
};

export type WorkspaceSwitchTransitionState = DashboardChatSelection & {
  pendingWorkspaceId: string | null;
  workspaceSwitchStatus: WorkspaceSwitchStatus;
  lastChatTransitionError: string | null;
};

type WorkspaceSwitchTransitionEvent =
  | { type: "start"; targetWorkspaceId: string }
  | { type: "success" }
  | { type: "failure"; errorMessage?: string | null };

const NEW_CHAT_SELECTION = {
  mode: "new",
  activeChatId: "",
  threadTitle: "New chat",
} satisfies DashboardChatSelection;

export function resolveWorkspaceSwitchTransition(
  current: WorkspaceSwitchTransitionState,
  event: WorkspaceSwitchTransitionEvent,
): WorkspaceSwitchTransitionState {
  if (event.type === "start") {
    return {
      ...current,
      pendingWorkspaceId: event.targetWorkspaceId,
      workspaceSwitchStatus: "loading",
      lastChatTransitionError: null,
    };
  }

  if (event.type === "success") {
    return {
      ...current,
      ...NEW_CHAT_SELECTION,
      pendingWorkspaceId: null,
      workspaceSwitchStatus: "idle",
      lastChatTransitionError: null,
    };
  }

  return {
    ...current,
    pendingWorkspaceId: null,
    workspaceSwitchStatus: "error",
    lastChatTransitionError:
      event.errorMessage ?? "Failed to switch workspace.",
  };
}
