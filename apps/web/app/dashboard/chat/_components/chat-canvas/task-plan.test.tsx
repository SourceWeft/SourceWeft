// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, test, vi } from "vitest";
import messages from "../../../../../messages/en.json";
import { buildVersionedMessageGroups } from "../../[threadId]/_thread/message-groups";
import {
  mergeThinkingStepRecords,
  normalizeThinkingStepRecord,
} from "../../[threadId]/_thread/message-normalizers";
import type { ChatMessageItem } from "../../[threadId]/streaming-assistant-state";
import { createStreamingRenderBuffer } from "../../[threadId]/streaming-render-buffer";
import {
  testExports,
  type StreamingEventHandlerContext,
} from "../../[threadId]/streaming-event-handlers";
import { MessageList } from "./message-list";
import { resolveTaskPlan } from "./task-plan-state";
import type { ThinkingStepRecord, VersionedMessageGroup } from "./types";

vi.mock("@sourceweft/ui-web/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: PropsWithChildren) => <div>{children}</div>,
  ConversationContent: ({ children }: PropsWithChildren) => (
    <div>{children}</div>
  ),
  ConversationScrollButton: () => null,
}));
vi.mock("./message-response", () => ({
  CitationAwareMessageResponse: ({ children }: PropsWithChildren) => (
    <div>{children}</div>
  ),
}));

type Todo = { content: string; status: ThinkingStepRecord["status"] };

const LABELS = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
} as const;

// The step as the backend's `buildDeepAgentTodosStep` emits it: one id, a
// sequence fixed by the first write, and every later write upserted onto it.
function todosStep(todos: Todo[], closedBy?: string) {
  const status = todos.some((todo) => todo.status === "in_progress")
    ? "in_progress"
    : todos.every((todo) => todo.status === "completed")
      ? "completed"
      : "pending";
  return {
    id: "deepagents:todos",
    kind: "state",
    title: "Task plan",
    status,
    sequence: 3,
    items: todos.map((todo) => `${LABELS[todo.status]}: ${todo.content}`),
    metadata: {
      display: "todo_list",
      source: "deepagents",
      tool: "write_todos",
      toolCallId: "call-todos-2",
      todos,
      visibility: "user",
      ...(closedBy ? { closedBy } : {}),
    },
  };
}

const PLANNED: Todo[] = [
  { content: "Collect sources", status: "in_progress" },
  { content: "Draft the report", status: "pending" },
  { content: "Publish the report", status: "pending" },
];
const PUBLISHING: Todo[] = [
  { content: "Collect sources", status: "completed" },
  { content: "Draft the report", status: "completed" },
  { content: "Publish the report", status: "in_progress" },
];
const CLOSED: Todo[] = PUBLISHING.map((todo) => ({
  ...todo,
  status: "completed",
}));

function assistantMessage(
  metadata: Record<string, unknown>,
  content = "",
): ChatMessageItem {
  return {
    id: "assistant-1",
    role: "assistant",
    content,
    contentJson: {},
    parentMessageId: null,
    metadata,
    createdAt: new Date(0).toISOString(),
  };
}

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
});

async function renderMessage(message: ChatMessageItem, isStreaming: boolean) {
  const groups: VersionedMessageGroup[] = buildVersionedMessageGroups([
    message,
  ]);
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root!.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MessageList isStreaming={isStreaming} messageGroups={groups} />
      </NextIntlClientProvider>,
    ),
  );
}

function renderedPlans() {
  return [...host.querySelectorAll<HTMLElement>("[data-task-plan]")].map(
    (plan) => ({
      header: plan.querySelector("button")?.textContent ?? "",
      todos: [...plan.querySelectorAll<HTMLElement>("[data-todo-status]")].map(
        (item) => `${item.dataset.todoStatus}: ${item.textContent ?? ""}`,
      ),
    }),
  );
}

function expectedTodos(todos: Todo[]) {
  return todos.map(
    (todo) => `${todo.status}: ${LABELS[todo.status]}: ${todo.content}`,
  );
}

// Mirrors the stream runner: the handler upserts the step by id, and the
// runner's sync writes the merged steps onto the streaming message.
function createLiveStream() {
  let message = assistantMessage({
    threadRun: { status: "running", mode: "send" },
  });
  const streamThinkingStepsById = new Map<string, ThinkingStepRecord>();
  const context: StreamingEventHandlerContext = {
    appendReasoningChunk: (current, next) => `${current ?? ""}${next}`,
    durableRunKey: "sourceweft-web-run:run-1",
    isCompletedArtifactToolCall: () => false,
    isCompletedWorkfileWriteToolCall: () => false,
    mergeThinkingStepRecords,
    mode: "send",
    normalizeCitationRecords: () => [],
    normalizeModelReasoningSegmentRecord: () => null,
    normalizeThinkingStepRecord,
    normalizeThreadCommandRequest: () => undefined,
    resolveToolCallFromStreamEvent: () => {
      throw new Error("not used");
    },
    resolveTraceEventFromStreamEvent: () => null,
    streamRenderBuffer: createStreamingRenderBuffer({
      maxDeltaBatchChars: 800,
    }),
    streamThinkingStepsById,
    streamToolCallsById: new Map(),
    syncStreamingCitations: () => undefined,
    syncStreamingThinkingSteps: () => {
      message = {
        ...message,
        metadata: {
          ...message.metadata,
          thinkingSteps: [...streamThinkingStepsById.values()],
        },
      };
    },
    syncStreamingToolCalls: () => undefined,
    toNullableString: (value) => (typeof value === "string" ? value : null),
    toObjectRecord: (value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null,
    updateChatTitle: () => undefined,
    updateStreamingAssistantMessage: (updater) => {
      message = updater(message);
    },
  };
  return {
    message: () => message,
    thinkingStep: (step: unknown) =>
      testExports.handleStreamingThinkingStep({ context, step }),
  };
}

test("the live plan updates in place from thinking-step events", async () => {
  const stream = createLiveStream();

  stream.thinkingStep(todosStep(PLANNED));
  await renderMessage(stream.message(), true);
  assert.deepEqual(renderedPlans(), [
    { header: "Task plan0/3 done", todos: expectedTodos(PLANNED) },
  ]);

  stream.thinkingStep(todosStep(PUBLISHING));
  await renderMessage(stream.message(), true);
  assert.deepEqual(renderedPlans(), [
    { header: "Task plan2/3 done", todos: expectedTodos(PUBLISHING) },
  ]);

  // #349: after a committed publish the host re-emits the same step with the
  // in-progress todo closed.
  stream.thinkingStep(todosStep(CLOSED, "committed_delivery"));
  await renderMessage(stream.message(), true);
  assert.deepEqual(renderedPlans(), [
    { header: "Task plan3/3 done", todos: expectedTodos(CLOSED) },
  ]);
  assert.equal(
    (stream.message().metadata.traceParts as Array<{ id: string }>).filter(
      (part) => part.id === "deepagents:todos",
    ).length,
    1,
  );
});

test("a reloaded message renders the persisted plan, closure included", async () => {
  const closed = todosStep(CLOSED, "committed_delivery");
  await renderMessage(
    assistantMessage(
      {
        finishReason: "stop",
        threadRun: { status: "completed", mode: "send" },
        thinkingSteps: [closed],
        traceParts: [
          {
            id: "deepagents:todos",
            kind: "step",
            order: 3,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            title: closed.title,
            status: closed.status,
            items: closed.items,
            metadata: closed.metadata,
          },
        ],
        renderBlocks: [{ id: "answer", type: "text", text: "Published." }],
      },
      "Published.",
    ),
    false,
  );

  assert.deepEqual(renderedPlans(), [
    { header: "Task plan3/3 done", todos: expectedTodos(CLOSED) },
  ]);
});

test("a run that ended mid-plan keeps each todo's own status", async () => {
  // The web terminalizes an in-progress step when the run ends; the todos
  // inside it must not be rewritten with it.
  await renderMessage(
    assistantMessage({
      finishReason: "stop",
      threadRun: { status: "completed", mode: "send" },
      thinkingSteps: [todosStep(PUBLISHING)],
    }),
    false,
  );

  assert.deepEqual(renderedPlans(), [
    { header: "Task plan2/3 done", todos: expectedTodos(PUBLISHING) },
  ]);
  assert.equal(host.querySelector("[data-task-plan] .animate-spin"), null);
});

test("a run without write_todos shows no task plan", async () => {
  await renderMessage(
    assistantMessage(
      {
        finishReason: "stop",
        threadRun: { status: "completed", mode: "send" },
        thinkingSteps: [
          {
            id: "retrieval:search",
            kind: "log",
            title: "Searching sources",
            status: "completed",
            items: [],
          },
        ],
        renderBlocks: [{ id: "answer", type: "text", text: "Done." }],
      },
      "Done.",
    ),
    false,
  );

  assert.deepEqual(renderedPlans(), []);
});

test("the plan ignores malformed todos and empty lists", () => {
  assert.equal(resolveTaskPlan(undefined), null);
  assert.equal(
    resolveTaskPlan([
      {
        id: "deepagents:todos",
        title: "Task plan",
        status: "pending",
        items: [],
        metadata: { todos: [] },
      },
    ]),
    null,
  );
  assert.deepEqual(
    resolveTaskPlan([
      {
        id: "deepagents:todos",
        title: "Task plan",
        status: "in_progress",
        items: [],
        metadata: {
          todos: [
            { content: "  Keep me  ", status: "in_progress" },
            { content: "", status: "pending" },
            { content: "Bad status", status: "done" },
            "not a todo",
          ],
        },
      },
    ]),
    {
      completedCount: 0,
      todos: [{ content: "Keep me", status: "in_progress" }],
    },
  );
});
