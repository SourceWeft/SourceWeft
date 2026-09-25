// @vitest-environment jsdom
import { act, useMemo } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { mountWithIntl, unmountAll } from "@/test/react";
import { useThreadSources } from "./use-thread-sources";
import { useThreadVersioning } from "./use-thread-versioning";
import {
  useStreamingAssistantTransientState,
  type ChatMessageItem,
} from "../streaming-assistant-state";
import {
  ChatHubProvider,
  useChatHubContext,
  useRegisterChatHub,
  type ChatHubRegistration,
} from "../../_components/chat-hub-context";
import { MessageList } from "../../_components/chat-canvas/message-list";
import { HubSlot } from "../../_components/chat-workspace-shell";

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  dashboard: {
    workspaceId: "ws",
    threadTitle: "Synthetic regression",
    sourcesVisible: true,
    toggleSourcesVisible: vi.fn(),
  },
  layout: {
    hubDrawerOpen: false,
    setHubDrawerOpen: vi.fn(),
    canDockHub: true,
    previewWidth: 360,
  },
  sync: { trackConnectorSyncRun: vi.fn() },
  empty: {
    items: [],
    accounts: [],
    connectors: [],
    installs: [],
    tools: [],
    catalog: [],
    nextCursor: null,
    file: null,
    events: [],
    commands: [],
    selection: { revision: 1, selectedSourceIds: [] },
    thread: { chatPreferences: { skillIds: [] } },
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
  usePathname: () => "/dashboard/chat/thread",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "owner" } } }) },
}));
vi.mock("@/app/dashboard/_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => mocks.dashboard,
}));
vi.mock("@/app/dashboard/_components/dashboard-workspace-layout", () => ({
  useWorkspaceLayout: () => mocks.layout,
}));
vi.mock("@/lib/local-execution", () => ({
  localRequest: vi
    .fn()
    .mockResolvedValue({ executionTarget: { kind: "cloud" } }),
}));
vi.mock("../../_components/sources-hub/use-connector-sync-runs", () => ({
  useConnectorSyncRuns: () => mocks.sync,
  isDocumentVisible: () => true,
}));
vi.mock("@/lib/sdk", () => ({
  apiBaseUrl: "http://localhost",
  contentClient: new Proxy(
    {},
    { get: () => vi.fn().mockResolvedValue(mocks.empty) },
  ),
  connectorsClient: new Proxy(
    {},
    { get: () => vi.fn().mockResolvedValue(mocks.empty) },
  ),
}));
afterEach(unmountAll);
// jsdom has no layout observer; real scrolling remains browser acceptance.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
const empty: never[] = [];
const noop = () => {};
const registration: ChatHubRegistration = {
  mode: "thread",
  workspaceId: "ws",
  workspaceName: "Synthetic workspace",
  threadId: "thread",
  threadTitle: "Synthetic regression",
  activeCitationIndex: null,
  activeCitationMessageId: null,
  displayedCitations: empty,
  threadCitations: empty,
  artifactsRefreshKey: 0,
  workfilesRefreshKey: 0,
  initialSources: empty,
  initialSourcesLoaded: true,
  activeSourceIds: empty,
  activeSkillIds: empty,
  activeMcpInstallIds: empty,
  activeMcpToolIds: empty,
  availableSkills: empty,
  hubSkills: empty,
  capabilityCatalog: null,
  disabledToolNames: empty,
  onSelectionChange: noop,
  onSkillSelectionChange: noop,
  onMcpSelectionChange: noop,
  onSkillsCatalogChange: async () => {},
  onArtifactOpen: noop,
  previewArtifact: null,
  onArtifactPreviewClose: noop,
  onSourceLoad: noop,
  onSourceMerge: noop,
};
const messages: ChatMessageItem[] = [
  {
    id: "u",
    role: "user",
    content: "Synthetic stream",
    contentJson: {},
    metadata: {},
    parentMessageId: null,
    createdAt: "2026-09-23T00:00:00Z",
  },
  {
    id: "a",
    role: "assistant",
    content: "",
    contentJson: {},
    metadata: { sourceUserMessageId: "u" },
    parentMessageId: null,
    createdAt: "2026-09-23T00:00:01Z",
  },
];

const citation = {
  citation: "c1",
  sourceId: "source",
  documentId: "document",
  chunkId: "chunk",
  sourceTitle: "Synthetic source",
  score: 1,
  excerpt: "Synthetic evidence",
};
messages.unshift(
  {
    id: "history-user",
    role: "user",
    content: "Synthetic source and workfile history",
    contentJson: {},
    metadata: {},
    parentMessageId: null,
    createdAt: "2026-09-22T00:00:00Z",
  },
  {
    id: "history-answer",
    role: "assistant",
    content: "Evidence [citation:c1] and [report](/files/report.txt)",
    contentJson: {},
    metadata: {
      sourceUserMessageId: "history-user",
      retrieval: { citations: [citation] },
      renderBlocks: [
        {
          id: "history-text",
          type: "text",
          text: "Evidence [citation:c1] and [report](/files/report.txt)",
        },
      ],
    },
    parentMessageId: null,
    createdAt: "2026-09-22T00:00:01Z",
  },
);
const streamingBase = messages.find((message) => message.id === "a")!;

// This replays 1,000 growing Markdown snapshots through the real UI tree.
// CI shares its runner with the backend and package suites; allow CPU contention
// without reducing the replay or relaxing the selection-identity assertions.
test("streaming through real versioning, Hub registration, desktop host and SourcesHub settles", async () => {
  let stream: ReturnType<typeof useStreamingAssistantTransientState>;
  let versions: ReturnType<typeof useThreadVersioning>;
  let rewrites = 0;
  function RegisterView({
    state,
    sourceFields,
  }: {
    state: ReturnType<typeof useThreadVersioning>;
    sourceFields: Partial<ChatHubRegistration>;
  }) {
    useChatHubContext(); // The real thread view also consumes the Hub controls.
    const value = useMemo(
      () => ({
        ...registration,
        ...sourceFields,
        displayedCitations: state.displayedCitations,
        threadCitations: state.threadCitations,
        activeCitationMessageId: state.activeAssistantVersion?.id ?? null,
      }),
      [
        sourceFields,
        state.displayedCitations,
        state.threadCitations,
        state.activeAssistantVersion?.id,
      ],
    );
    useRegisterChatHub(value);
    return (
      <MessageList
        messageGroups={state.messageGroups}
        activeVersionByGroup={state.activeVersionByGroup}
        onActiveVersionChange={state.handleActiveVersionChange}
        isStreaming
        allSources={empty}
        resolvedConfirmations={empty}
        workspaceId="ws"
      />
    );
  }
  function Controller() {
    const {
      activeSourceIds,
      initialSourcesForWorkspace,
      hasCachedWorkspaceSources,
      handleLibrarySourcesLoad,
      handleLibrarySourcesMerge,
      persistActiveSourceIds,
      availableSkills,
      hubSkills,
      capabilityCatalog,
      activeSkillIds,
      handleSkillSelectionChange,
      loadAvailableSkills,
    } = useThreadSources({ workspaceId: "ws", threadId: "thread" });
    const sourceFields = useMemo(
      () => ({
        activeSourceIds: activeSourceIds,
        initialSources: initialSourcesForWorkspace,
        initialSourcesLoaded: hasCachedWorkspaceSources("ws"),
        onSourceLoad: handleLibrarySourcesLoad,
        onSourceMerge: handleLibrarySourcesMerge,
        onSelectionChange: persistActiveSourceIds,
        availableSkills: availableSkills,
        hubSkills: hubSkills,
        capabilityCatalog: capabilityCatalog,
        activeSkillIds: activeSkillIds,
        onSkillSelectionChange: handleSkillSelectionChange,
        onSkillsCatalogChange: loadAvailableSkills,
      }),
      [
        activeSourceIds,
        initialSourcesForWorkspace,
        hasCachedWorkspaceSources,
        handleLibrarySourcesLoad,
        handleLibrarySourcesMerge,
        persistActiveSourceIds,
        availableSkills,
        hubSkills,
        capabilityCatalog,
        activeSkillIds,
        handleSkillSelectionChange,
        loadAvailableSkills,
      ],
    );
    stream = useStreamingAssistantTransientState();
    versions = useThreadVersioning({
      isStreaming: true,
      messages,
      mergeStreamingAssistantIntoMessages:
        stream.mergeStreamingAssistantIntoMessages,
    });
    return <RegisterView state={versions} sourceFields={sourceFields} />;
  }
  const { container: element } = await mountWithIntl(
    <ChatHubProvider>
      <Controller />
      <HubSlot />
    </ChatHubProvider>,
  );
  let previous = versions!.activeVersionByGroup;
  for (let n = 1; n <= 1000; n++) {
    const content = `STREAM-END-${n}\n${Array.from({ length: n }, (_, i) => i + 1).join("\n")}`;
    const message = {
      ...streamingBase,
      content,
      metadata: {
        ...streamingBase.metadata,
        renderBlocks: [{ id: "stream-text-a", type: "text", text: content }],
        threadRun: {
          idempotencyKey: "synthetic-run",
          status: "running",
          mode: "send",
        },
      },
    };
    await act(async () =>
      stream!.setStreamingAssistantSnapshot({
        message,
        messageId: "a",
        messageIds: ["a"],
        renderVersion: n,
      }),
    );
    if (versions!.activeVersionByGroup !== previous) rewrites++;
    previous = versions!.activeVersionByGroup;
  }
  expect(element.textContent).toContain("STREAM-END-1000");
  expect(element.textContent).toContain("Sources");
  expect(rewrites).toBe(0);
  expect(
    versions!.threadCitations.map((item) => item.citation.chunkId),
  ).toEqual(["chunk"]);
}, 180000);
