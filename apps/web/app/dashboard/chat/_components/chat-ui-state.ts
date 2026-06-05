export type ChatSkeletonPolicy =
  | "none"
  | "route"
  | "canvas"
  | "sources"
  | "overlay"
  | "inline";

export type ChatUiRouteKind = "new" | "thread";
export type ChatLoadStatus = "idle" | "loading" | "ready" | "error";

export type ChatUiRegionState =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "empty"
  | "streaming";

export type ChatUiStatus =
  | "route-bootstrap"
  | "workspace-loading"
  | "new-ready"
  | "creating-thread"
  | "thread-switching"
  | "thread-bootstrap"
  | "thread-ready"
  | "model-loading"
  | "model-error"
  | "sources-loading"
  | "sources-error"
  | "empty"
  | "streaming"
  | "fatal-error";

export type ChatUiErrorKind =
  | "route"
  | "workspace"
  | "thread"
  | "model-catalog"
  | "sources"
  | "creation";

export type ChatUiStateInput = {
  routeKind: ChatUiRouteKind;
  shellStatus?: ChatLoadStatus;
  workspaceStatus?: ChatLoadStatus;
  modelCatalogStatus?: ChatLoadStatus;
  sourcesStatus?: ChatLoadStatus;
  threadStatus?: ChatLoadStatus;
  creationStatus?: ChatLoadStatus;
  streamingStatus?: ChatLoadStatus;
  requestedThreadId?: string | null;
  activeThreadId?: string | null;
  hasWorkspace?: boolean;
  hasThread?: boolean;
  hasMessages?: boolean;
  isInitialRouteLoad?: boolean;
  isWorkspaceShortcutPending?: boolean;
  isThreadSwitching?: boolean;
  errorKind?: ChatUiErrorKind | null;
};

export type ChatUiRegions = {
  shell: ChatUiRegionState;
  workspace: ChatUiRegionState;
  newChat: ChatUiRegionState;
  thread: ChatUiRegionState;
  modelCatalog: ChatUiRegionState;
  sources: ChatUiRegionState;
  composer: ChatUiRegionState;
  creation: ChatUiRegionState;
  streaming: ChatUiRegionState;
  error: ChatUiRegionState;
};

export type ChatUiState = {
  status: ChatUiStatus;
  skeletonPolicy: ChatSkeletonPolicy;
  regions: ChatUiRegions;
  routeKind: ChatUiRouteKind;
  errorKind: ChatUiErrorKind | null;
};

const readyRegions: ChatUiRegions = {
  shell: "ready",
  workspace: "ready",
  newChat: "idle",
  thread: "idle",
  modelCatalog: "ready",
  sources: "ready",
  composer: "ready",
  creation: "idle",
  streaming: "idle",
  error: "idle",
};

function normalizeStatus(status: ChatLoadStatus | undefined): ChatLoadStatus {
  return status ?? "ready";
}

function buildState(input: {
  status: ChatUiStatus;
  skeletonPolicy: ChatSkeletonPolicy;
  regions: Partial<ChatUiRegions>;
  routeKind: ChatUiRouteKind;
  errorKind?: ChatUiErrorKind | null;
}): ChatUiState {
  return {
    status: input.status,
    skeletonPolicy: input.skeletonPolicy,
    regions: { ...readyRegions, ...input.regions },
    routeKind: input.routeKind,
    errorKind: input.errorKind ?? null,
  };
}

function resolveThreadIsSwitching(input: ChatUiStateInput) {
  if (input.routeKind !== "thread") {
    return false;
  }
  if (input.isThreadSwitching) {
    return true;
  }
  if (!input.requestedThreadId || !input.activeThreadId) {
    return false;
  }
  return input.requestedThreadId !== input.activeThreadId;
}

export function resolveChatUiState(input: ChatUiStateInput): ChatUiState {
  const shellStatus = normalizeStatus(input.shellStatus);
  const workspaceStatus = normalizeStatus(input.workspaceStatus);
  const modelCatalogStatus = normalizeStatus(input.modelCatalogStatus);
  const sourcesStatus = normalizeStatus(input.sourcesStatus);
  const threadStatus = normalizeStatus(input.threadStatus);
  const creationStatus = normalizeStatus(input.creationStatus);
  const streamingStatus = normalizeStatus(input.streamingStatus);
  const hasWorkspace = input.hasWorkspace ?? workspaceStatus === "ready";
  const isThreadRoute = input.routeKind === "thread";
  const isThreadSwitching = resolveThreadIsSwitching(input);

  if (input.errorKind === "route" || shellStatus === "error") {
    return buildState({
      status: "fatal-error",
      skeletonPolicy: "none",
      routeKind: input.routeKind,
      errorKind: input.errorKind ?? "route",
      regions: {
        shell: "error",
        workspace: "idle",
        newChat: input.routeKind === "new" ? "error" : "idle",
        thread: isThreadRoute ? "error" : "idle",
        modelCatalog: "idle",
        sources: "idle",
        composer: "idle",
        creation: "idle",
        streaming: "idle",
        error: "error",
      },
    });
  }

  if (shellStatus === "loading" || input.isInitialRouteLoad) {
    return buildState({
      status: "route-bootstrap",
      skeletonPolicy: "route",
      routeKind: input.routeKind,
      regions: {
        shell: "loading",
        workspace: "loading",
        newChat: input.routeKind === "new" ? "loading" : "idle",
        thread: isThreadRoute ? "loading" : "idle",
        modelCatalog: "loading",
        sources: "loading",
        composer: "loading",
      },
    });
  }

  if (
    input.errorKind === "workspace" ||
    workspaceStatus === "error" ||
    (workspaceStatus === "ready" && !hasWorkspace)
  ) {
    return buildState({
      status: "fatal-error",
      skeletonPolicy: "none",
      routeKind: input.routeKind,
      errorKind: input.errorKind ?? "workspace",
      regions: {
        workspace: "error",
        newChat: input.routeKind === "new" ? "error" : "idle",
        thread: isThreadRoute ? "error" : "idle",
        modelCatalog: "idle",
        sources: "idle",
        composer: "idle",
        error: "error",
      },
    });
  }

  if (workspaceStatus === "loading" || input.isWorkspaceShortcutPending) {
    return buildState({
      status: "workspace-loading",
      skeletonPolicy: input.isInitialRouteLoad ? "route" : "overlay",
      routeKind: input.routeKind,
      regions: {
        workspace: "loading",
        newChat: input.routeKind === "new" ? "loading" : "idle",
        thread: isThreadRoute ? "loading" : "idle",
        modelCatalog: "idle",
        sources: "idle",
        composer: "idle",
      },
    });
  }

  if (input.errorKind === "model-catalog" || modelCatalogStatus === "error") {
    return buildState({
      status: "model-error",
      skeletonPolicy: "none",
      routeKind: input.routeKind,
      errorKind: "model-catalog",
      regions: {
        modelCatalog: "error",
        newChat: input.routeKind === "new" ? "error" : "idle",
        thread: isThreadRoute ? "error" : "idle",
        composer: "idle",
        error: "error",
      },
    });
  }

  if (input.errorKind === "sources" || sourcesStatus === "error") {
    return buildState({
      status: "sources-error",
      skeletonPolicy: "none",
      routeKind: input.routeKind,
      errorKind: "sources",
      regions: {
        sources: "error",
        newChat: input.routeKind === "new" ? "ready" : "idle",
        thread: isThreadRoute ? "ready" : "idle",
        error: "error",
      },
    });
  }

  if (input.errorKind === "thread" || threadStatus === "error") {
    return buildState({
      status: "empty",
      skeletonPolicy: "none",
      routeKind: input.routeKind,
      errorKind: input.errorKind ?? "thread",
      regions: {
        thread: "empty",
        composer: "idle",
        error: "error",
      },
    });
  }

  if (creationStatus === "error" || input.errorKind === "creation") {
    return buildState({
      status: "fatal-error",
      skeletonPolicy: "inline",
      routeKind: input.routeKind,
      errorKind: "creation",
      regions: {
        newChat: input.routeKind === "new" ? "error" : "idle",
        creation: "error",
        composer: "ready",
        error: "error",
      },
    });
  }

  if (creationStatus === "loading") {
    return buildState({
      status: "creating-thread",
      skeletonPolicy: "inline",
      routeKind: input.routeKind,
      regions: {
        newChat: input.routeKind === "new" ? "streaming" : "idle",
        creation: "loading",
        streaming: "streaming",
      },
    });
  }

  if (modelCatalogStatus === "loading") {
    return buildState({
      status: "model-loading",
      skeletonPolicy: "inline",
      routeKind: input.routeKind,
      regions: {
        modelCatalog: "loading",
        newChat: input.routeKind === "new" ? "ready" : "idle",
        thread: isThreadRoute ? "ready" : "idle",
      },
    });
  }

  if (isThreadRoute && isThreadSwitching) {
    return buildState({
      status: "thread-switching",
      skeletonPolicy: "overlay",
      routeKind: input.routeKind,
      regions: {
        thread: "loading",
        composer: "idle",
      },
    });
  }

  if (isThreadRoute && threadStatus === "loading") {
    const hasConfirmedActiveThreadMessages = Boolean(
      input.hasMessages &&
        input.requestedThreadId &&
        input.activeThreadId &&
        input.requestedThreadId === input.activeThreadId,
    );

    if (hasConfirmedActiveThreadMessages) {
      return buildState({
        status: "thread-ready",
        skeletonPolicy: "none",
        routeKind: input.routeKind,
        regions: {
          thread: "ready",
          composer: "ready",
        },
      });
    }

    return buildState({
      status: "thread-bootstrap",
      skeletonPolicy: "canvas",
      routeKind: input.routeKind,
      regions: {
        thread: "loading",
        composer: "idle",
      },
    });
  }

  if (sourcesStatus === "loading") {
    return buildState({
      status: "sources-loading",
      skeletonPolicy: "sources",
      routeKind: input.routeKind,
      regions: {
        newChat: input.routeKind === "new" ? "ready" : "idle",
        thread: isThreadRoute ? "ready" : "idle",
        sources: "loading",
      },
    });
  }

  if (streamingStatus === "loading") {
    return buildState({
      status: "streaming",
      skeletonPolicy: "inline",
      routeKind: input.routeKind,
      regions: {
        newChat: input.routeKind === "new" ? "streaming" : "idle",
        thread: isThreadRoute ? "streaming" : "idle",
        streaming: "streaming",
      },
    });
  }

  if (isThreadRoute) {
    return buildState({
      status: "thread-ready",
      skeletonPolicy: "none",
      routeKind: input.routeKind,
      regions: {
        thread: input.hasThread === false ? "empty" : "ready",
        composer: "ready",
      },
    });
  }

  return buildState({
    status: "new-ready",
    skeletonPolicy: "none",
    routeKind: input.routeKind,
    regions: {
      newChat: input.hasMessages ? "ready" : "empty",
      thread: "idle",
      composer: "ready",
    },
  });
}
