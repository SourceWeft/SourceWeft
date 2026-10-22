// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { mountWithIntl, unmountAll } from "@/test/react";
import type { MessageRenderBlock } from "../../_components/chat-canvas";
import type {
  ChatMessageItem,
  StreamingAssistantSnapshot,
} from "../streaming-assistant-state";
import {
  useThreadStreamAction,
  type ThreadStreamActionInput,
} from "./use-thread-stream-action";

// Issue #357: a reload mid-run re-attaches to the durable run, and the server
// replays the run's whole event log from offset 0 before continuing live. The
// real runner and event handlers run here; only the network is faked.

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { getActiveThreadRun: vi.fn() },
}));
vi.mock("../../../../../lib/local-host-session", () => ({
  localHostHeaders: async () => ({}),
  clearLocalHostSession: () => {},
}));
vi.mock("../../_components/local-conversation-status", () => ({
  useLocalConversationStatus: () => ({ ready: true, message: null }),
}));
vi.mock("../../../../../lib/local-availability-events", () => ({
  reportLocalAvailabilityError: vi.fn(),
}));

const artifactOutputBlock = {
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  id: "artifact-output:run-1:artifact-1:version-1",
  placement: "terminal",
  producer: { kind: "main" },
  sequence: 1,
  sourceToolCallId: "call-1",
  threadRunId: "run-1",
  type: "artifact_output",
} as const;

const seg1 = { id: "seg-1", sequence: 1, phase: "initial" };
const seg2 = {
  id: "seg-2",
  sequence: 2,
  phase: "after_tool",
  toolCallId: "call-1",
  tool: "read_file",
};
const seg3 = { id: "seg-3", sequence: 3, phase: "after_tool" };

/**
 * The running assistant row as `/messages` returns it mid-run: the durable
 * runner's progress write holds every block streamed so far under the
 * server's block ids, with structural (text-less) reasoning segments.
 */
function persistedAssistant(
  input: { mode?: string; extraBlocks?: unknown[] } = {},
): ChatMessageItem {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "partial",
    contentJson: {},
    parentMessageId: null,
    createdAt: new Date(0).toISOString(),
    metadata: {
      threadRun: {
        idempotencyKey: "run-key",
        status: "running",
        mode: input.mode ?? "send",
      },
      reasoningSegments: [
        { ...seg1, durationMs: 1000 },
        { ...seg2, durationMs: 2000 },
      ],
      renderBlocks: [
        {
          id: "reasoning-seg-1",
          type: "reasoning",
          text: "think one",
          durationMs: 1000,
        },
        { id: "tool-call-1", type: "tool", toolCallId: "call-1" },
        {
          id: "reasoning-seg-2",
          type: "reasoning",
          text: "think two",
          durationMs: 2000,
        },
        { id: "text-1", type: "text", text: "partial" },
        ...(input.extraBlocks ?? []),
      ],
    },
  };
}

/** Everything the run streamed before the reload, replayed from offset 0. */
const replayedPrefix: Record<string, unknown>[] = [
  { type: "start", messageId: "user-1" },
  { type: "reasoning", reasoning: "think ", segment: seg1 },
  {
    type: "reasoning",
    reasoning: "one",
    segment: { ...seg1, durationMs: 1000 },
  },
  { type: "tool-call-start", id: "call-1", tool: "read_file", input: {} },
  { type: "tool-call-result", id: "call-1", tool: "read_file", output: "ok" },
  {
    type: "reasoning",
    reasoning: "think two",
    segment: { ...seg2, durationMs: 2000 },
  },
  { type: "text-delta", delta: "partial" },
];

/** The live segment that is still thinking when the attach catches up. */
const liveSegment = {
  type: "reasoning",
  reasoning: "think three",
  segment: seg3,
};

function sseResponse(events: Record<string, unknown>[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

let messages: ChatMessageItem[] = [];
let snapshot: StreamingAssistantSnapshot | null = null;
let latest: ReturnType<typeof useThreadStreamAction>;

function Harness() {
  latest = useThreadStreamAction({
    attachReattach: {
      handleAttachFailure: () => "scheduled",
      noteAttachProgress: () => {},
      noteAttachSucceeded: () => {},
      noteStreamStart: () => {},
    },
    catalogKindEnabled: {} as never,
    clearAttachedRunKeyIfCurrent: () => {},
    clearEditingState: () => {},
    clearRunIfCurrent: () => {},
    currentUserId: null,
    librarySources: [],
    loadThreadMessages: async () => {},
    markRunStarted: () => {},
    markRunTerminal: () => {},
    messages,
    searchEnabled: false,
    selectedByokModels: {},
    selectedModels: {} as never,
    setArtifactsRefreshKey: () => {},
    setComposerInitialInput: () => {},
    setComposerResetKey: () => {},
    setMessages: (updater) => {
      messages = updater(messages);
    },
    setStreamingAssistantSnapshot: (updater) => {
      snapshot = typeof updater === "function" ? updater(snapshot) : updater;
    },
    setWorkfilesRefreshKey: () => {},
    streamWithSelectedLlm: false,
    thinkingSettings: {} as never,
    threadId: "thread-1",
    updateActiveRunIfCurrent: () => {},
    updateChatSourceCount: () => {},
    updateChatTitle: () => {},
    workspaceId: "workspace-1",
  });
  return null;
}

async function attach(input: {
  events: Record<string, unknown>[];
  mode?: ThreadStreamActionInput["mode"];
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sseResponse(input.events)),
  );
  await mountWithIntl(createElement(Harness));
  await act(async () =>
    latest.streamThreadAction({
      mode: input.mode ?? "send",
      attachOnly: true,
      reattachOnFailure: input.mode !== "resume",
      durableRunKey: "run-key",
      assistantMessageId: "assistant-1",
      baseMessages: messages,
      runOwnerUserId: "user-1",
    }),
  );
}

/** The blocks of the assistant row after the attach stream ended. */
function committedBlocks(): MessageRenderBlock[] {
  const message = messages.find((item) => item.id === "assistant-1");
  return (message?.metadata.renderBlocks ?? []) as MessageRenderBlock[];
}

function reasoningRows(blocks: MessageRenderBlock[]) {
  return blocks.flatMap((block) =>
    block.type === "reasoning"
      ? [{ text: block.text, durationMs: block.durationMs }]
      : [],
  );
}

function textOf(blocks: MessageRenderBlock[]) {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

beforeEach(() => {
  snapshot = null;
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

test("a mid-run reload shows one reasoning row per segment plus the live one", async () => {
  messages = [persistedAssistant()];

  await attach({ events: [...replayedPrefix, liveSegment] });

  const blocks = committedBlocks();
  assert.deepEqual(reasoningRows(blocks), [
    { text: "think one", durationMs: 1000 },
    { text: "think two", durationMs: 2000 },
    // The one live "Thinking" row: no duration yet.
    { text: "think three", durationMs: undefined },
  ]);
  assert.equal(blocks.filter((block) => block.type === "tool").length, 1);
  assert.equal(textOf(blocks), "partial");
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["reasoning", "tool", "reasoning", "text", "reasoning"],
  );
});

test("rows still match segments when the reloaded run then finishes", async () => {
  messages = [persistedAssistant()];

  await attach({
    events: [
      ...replayedPrefix,
      liveSegment,
      {
        type: "reasoning",
        reasoning: ".",
        segment: { ...seg3, durationMs: 3000 },
      },
      { type: "text-delta", delta: " answer" },
      { type: "finish", finishReason: "stop" },
    ],
  });

  const blocks = committedBlocks();
  assert.deepEqual(reasoningRows(blocks), [
    { text: "think one", durationMs: 1000 },
    { text: "think two", durationMs: 2000 },
    { text: "think three.", durationMs: 3000 },
  ]);
  assert.equal(textOf(blocks), "partial answer");
  assert.equal(
    messages.find((item) => item.id === "assistant-1")?.content,
    "partial answer",
  );
});

test("a mid-run reload keeps committed artifact outputs, which are not replayed", async () => {
  messages = [persistedAssistant({ extraBlocks: [artifactOutputBlock] })];

  await attach({ events: [...replayedPrefix, liveSegment] });

  const blocks = committedBlocks();
  assert.equal(
    blocks.filter((block) => block.type === "artifact_output").length,
    1,
  );
  assert.equal(reasoningRows(blocks).length, 3);
  assert.equal(textOf(blocks), "partial");
});

test("a resume attach still continues from the persisted blocks", async () => {
  // A resume stream carries only the resumed run's events, so the persisted
  // pre-approval blocks are the base it continues from.
  messages = [persistedAssistant({ mode: "resume" })];

  await attach({ mode: "resume", events: [liveSegment] });

  const blocks = committedBlocks();
  assert.deepEqual(reasoningRows(blocks), [
    { text: "think one", durationMs: 1000 },
    { text: "think two", durationMs: 2000 },
    { text: "think three", durationMs: undefined },
  ]);
  assert.equal(blocks.filter((block) => block.type === "tool").length, 1);
});
