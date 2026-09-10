// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubMessage, HubSnapshot } from "./hub-protocol";
import type { ChatHubRegistration } from "./chat-hub-context";

const state = vi.hoisted(() => ({
  pathname: "/dashboard/chat/A",
  workspaceId: "ws",
  title: "Conversation A",
  listener: undefined as ((message: HubMessage) => void) | undefined,
  send: vi.fn().mockResolvedValue(undefined),
  action: vi.fn().mockResolvedValue(undefined),
  error: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../../../../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user" } } }) },
}));
vi.mock("../../../../lib/desktop-bridge", () => ({
  desktopBridge: { isAvailable: () => true, showMainWindow: vi.fn() },
}));
vi.mock("../../../../lib/desktop-hub-bridge", () => ({
  desktopHubBridge: {
    send: state.send,
    action: state.action,
    listen: async (cb: typeof state.listener) => {
      state.listener = cb;
      return async () => {};
    },
  },
}));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    workspaceId: state.workspaceId,
    threadTitle: state.title,
    sourcesVisible: true,
    toggleSourcesVisible: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({ toast: { error: state.error } }));
import { useDesktopHubHost } from "./use-desktop-hub-host";

let root: Root;
let host: ReturnType<typeof useDesktopHubHost>;
const registration = (threadId: string): ChatHubRegistration => ({
  threadId,
  mode: "thread",
  workspaceId: "ws",
  workspaceName: "Workspace",
  activeCitationIndex: null,
  activeCitationMessageId: null,
  displayedCitations: [],
  threadCitations: [],
  artifactsRefreshKey: 0,
  workfilesRefreshKey: 0,
  initialSources: [],
  initialSourcesLoaded: true,
  activeSourceIds: [],
  activeSkillIds: [],
  activeMcpInstallIds: [],
  activeMcpToolIds: [],
  availableSkills: [],
  hubSkills: [],
  capabilityCatalog: null,
  disabledToolNames: [],
  previewArtifact: null,
  onSelectionChange: vi.fn(),
  onSkillSelectionChange: vi.fn(),
  onMcpSelectionChange: vi.fn(),
  onSkillsCatalogChange: vi.fn().mockResolvedValue(undefined),
  onArtifactOpen: vi.fn(),
  onArtifactPreviewClose: vi.fn(),
  onSourceLoad: vi.fn(),
  onSourceMerge: vi.fn(),
});
function Harness({ value }: { value: ChatHubRegistration }) {
  host = useDesktopHubHost(value, true);
  return null;
}
async function render(value: ChatHubRegistration) {
  await act(async () => root.render(createElement(Harness, { value })));
}
async function emit(message: HubMessage) {
  await act(async () => {
    state.listener?.(message);
  });
}
function latest() {
  return state.send.mock.calls
    .map(([m]) => m)
    .filter((m) => m.kind === "snapshot")
    .at(-1).snapshot as HubSnapshot;
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  state.pathname = "/dashboard/chat/A";
  state.title = "Conversation A";
  state.workspaceId = "ws";
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

it("queues automatic upload selections for their original conversation and applies them only after its sources load", async () => {
  const a = registration("A");
  await render(a);
  await emit({ kind: "ready", accountId: "user", protocolVersion: 1 });
  const old = latest();
  state.pathname = "/dashboard/chat/B";
  const b = registration("B");
  await render(b);
  await emit({
    kind: "command",
    command: {
      id: "upload-A",
      sessionId: old.sessionId,
      contextKey: old.contextKey,
      revision: old.revision,
      action: { type: "auto-sources", ids: ["uploaded"] },
    },
  });
  expect(b.onSelectionChange).not.toHaveBeenCalled();
  expect(a.onSelectionChange).not.toHaveBeenCalled();
  state.pathname = "/dashboard/chat/A";
  await render(a);
  expect(a.onSelectionChange).not.toHaveBeenCalled();
  const loaded = {
    ...a,
    initialSources: [
      { id: "uploaded" },
    ] as ChatHubRegistration["initialSources"],
  };
  await render(loaded);
  expect(a.onSelectionChange).toHaveBeenCalledWith(["uploaded"]);
});

it("retains the last conversation in read-only mode after leaving chat", async () => {
  await render(registration("A"));
  await emit({ kind: "ready", accountId: "user", protocolVersion: 1 });
  const old = latest();
  state.pathname = "/dashboard/settings";
  await render(registration("A"));
  await emit({ kind: "ready", accountId: "user", protocolVersion: 1 });
  expect(latest().phase).toBe("away");
  expect(latest().data.threadId).toBe("A");
  expect(latest().contextKey).toBe(old.contextKey);
});

it("keeps inline Hub until the matching ready/applied handshake, rejects a wrong account", async () => {
  await render(registration("A"));
  await act(async () => host.open());
  expect(host.mode).toBe("opening");
  await emit({ kind: "ready", accountId: "other", protocolVersion: 1 });
  expect(state.send).toHaveBeenLastCalledWith({ kind: "disconnected" });
  await emit({ kind: "ready", accountId: "user", protocolVersion: 1 });
  const s = latest();
  await emit({
    kind: "applied",
    sessionId: s.sessionId,
    contextKey: s.contextKey,
    revision: s.revision - 1,
  });
  expect(host.mode).toBe("opening");
  await emit({
    kind: "applied",
    sessionId: s.sessionId,
    contextKey: s.contextKey,
    revision: s.revision,
  });
  expect(host.mode).toBe("detached");
});

it("revokes A immediately on route change, before B registers; late commands cannot call B", async () => {
  const a = registration("A");
  await render(a);
  await emit({ kind: "ready", accountId: "user", protocolVersion: 1 });
  const old = latest();
  state.pathname = "/dashboard/chat/B";
  await render(a);
  // Explicit ready is also the reconnect/heartbeat full snapshot request.
  await emit({ kind: "ready", accountId: "user", protocolVersion: 1 });
  expect(latest().phase).toBe("transition");
  const b = registration("B");
  await render(b);
  await emit({
    kind: "command",
    command: {
      id: "late",
      sessionId: old.sessionId,
      contextKey: old.contextKey,
      revision: old.revision,
      action: { type: "sources", ids: ["from-A"] },
    },
  });
  expect(a.onSelectionChange).not.toHaveBeenCalled();
  expect(b.onSelectionChange).not.toHaveBeenCalled();
  expect(
    state.send.mock.calls.some(
      ([m]) => m.kind === "result" && m.id === "late" && m.error,
    ),
  ).toBe(true);
});

it("deduplicates a command instead of executing it again", async () => {
  const a = registration("A");
  await render(a);
  await emit({ kind: "ready", accountId: "user", protocolVersion: 1 });
  const s = latest();
  const m: HubMessage = {
    kind: "command",
    command: {
      id: "once",
      sessionId: s.sessionId,
      contextKey: s.contextKey,
      revision: s.revision,
      action: { type: "sources", ids: ["source"] },
    },
  };
  await emit(m);
  await emit(m);
  expect(a.onSelectionChange).toHaveBeenCalledTimes(1);
});

it("restores inline availability when opening times out", async () => {
  vi.useFakeTimers();
  await render(registration("A"));
  await act(async () => host.open());
  await act(async () => vi.advanceTimersByTime(10001));
  expect(state.action).toHaveBeenCalledWith("abort");
  expect(host.mode).toBe("inline");
  expect(state.error).toHaveBeenCalled();
});
