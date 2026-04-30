import assert from "node:assert/strict";
import test from "node:test";
import { ContentThreadStreamService } from "./service";
import type { DeepAgentTurnEvent, DeepAgentTurnOutcome } from "../../agent/turn/runner";
import type { PreparedThreadTurn } from "../turn/types";

function parseSseData(value: string) {
  assert.equal(value.startsWith("data: "), true);
  return JSON.parse(value.slice("data: ".length).trim()) as Record<string, unknown>;
}

const outcome: DeepAgentTurnOutcome = {
  assistantContent: "Answer",
  retrieval: null,
  citations: [],
  availableCitations: [],
  retrievalCalls: [],
  toolCalls: [],
  thinkingSteps: [],
  agentCheckpoint: {
    beforeInput: null,
    beforeAssistant: null,
    final: null,
  },
};

const prepared: PreparedThreadTurn = {
  userId: "user-1",
  workspace: {
    id: "workspace-1",
    organizationId: "team-1",
  } as PreparedThreadTurn["workspace"],
  thread: {
    id: "thread-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    title: "New chat",
    modelSettings: {
      llmModelAlias: null,
      imageModelAlias: null,
      visionModelAlias: null,
    },
    sourceCount: 0,
    createdBy: "user-1",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
  messageContent: "What is in this invoice?",
  sourceIds: [],
  userMessage: {
    id: "user-message-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    parentMessageId: null,
    role: "user",
    content: "What is in this invoice?",
    metadata: {},
    createdAt: new Date(0).toISOString(),
    createdBy: "user-1",
    model: null,
    creditsConsumed: null,
  },
  createdUserMessage: true,
  assistantMessageParentId: null,
  modelAlias: "test-model",
  chatProfile: { gatewayConfigId: "gateway-1" } as PreparedThreadTurn["chatProfile"],
  llmIdempotencyKey: "thread-stream:user-message-1:assistant",
  agentMode: "continue",
  agentBaseCheckpoint: null,
  agentRunThreadId: "thread-1",
  isFirstAssistantResponse: true,
  initialTitle: "New chat",
};

function createTurnService(input?: {
  title?: string | null;
  titleDelayMs?: number;
  finalize?: (value: unknown) => Promise<unknown>;
}) {
  return {
    prepareThreadTurn: async () => prepared,
    generateChatTitle: async () => {
      await new Promise((resolve) => setTimeout(resolve, input?.titleDelayMs ?? 0));
      return input?.title ?? "Invoice Review";
    },
    applyAutomaticThreadTitle: async () => ({
      ...prepared.thread,
      title: input?.title ?? "Invoice Review",
    }),
    finalizeThreadTurn: input?.finalize ?? (async () => ({
      assistantMessage: {
        id: "assistant-message-1",
        parentMessageId: null,
      },
    })),
  };
}

test("streamThreadEvents waits for delayed title update before finish", async () => {
  const turnService = createTurnService();

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<typeof ContentThreadStreamService>[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "Answer" };
      yield { type: "done", outcome };
    },
    async () => {},
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this invoice?",
  })) {
    events.push(parseSseData(event));
  }

  const titleIndex = events.findIndex((event) => event.type === "thread-title-update");
  const finishIndex = events.findIndex((event) => event.type === "finish");

  assert.notEqual(titleIndex, -1);
  assert.notEqual(finishIndex, -1);
  assert.equal(events[titleIndex]?.threadId, "thread-1");
  assert.equal(events[titleIndex]?.title, "Invoice Review");
  assert.equal(titleIndex < finishIndex, true);
});

test("streamThreadEvents emits pending when title is still generating", async () => {
  const turnService = createTurnService({ titleDelayMs: 3500 });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<typeof ContentThreadStreamService>[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "Answer" };
      yield { type: "done", outcome };
    },
    async () => {},
  );

  const startedAt = Date.now();
  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this invoice?",
  })) {
    events.push(parseSseData(event));
  }

  const pendingIndex = events.findIndex((event) => event.type === "thread-title-pending");
  const finishIndex = events.findIndex((event) => event.type === "finish");

  assert.notEqual(pendingIndex, -1);
  assert.notEqual(finishIndex, -1);
  assert.equal(events[pendingIndex]?.threadId, "thread-1");
  assert.equal(pendingIndex < finishIndex, true);
  assert.equal(Date.now() - startedAt < 3400, true);
});

test("streamThreadEvents forwards citation snapshots before assistant message", async () => {
  const citation = {
    citation: "c1",
    sourceId: "source-1",
    sourceTitle: "invoice.pdf",
    documentId: "document-1",
    chunkId: "chunk-1",
    chunkNo: 0,
    score: 1,
    excerpt: "Invoice total is 50.",
    quoteText: "Invoice total is 50.",
    origin: "read_file" as const,
  };
  const turnService = createTurnService({ title: null });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<typeof ContentThreadStreamService>[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "citations", citations: [citation] };
      yield { type: "text-delta", delta: "Total is ¥50.00 [citation:c1]" };
      yield { type: "done", outcome: { ...outcome, citations: [citation] } };
    },
    async () => {},
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this invoice?",
  })) {
    events.push(parseSseData(event));
  }

  const citationIndex = events.findIndex((event) => event.type === "citations");
  const textIndex = events.findIndex((event) => event.type === "text-delta");
  const assistantMessageIndex = events.findIndex((event) => event.type === "assistant-message");

  assert.notEqual(citationIndex, -1);
  assert.notEqual(textIndex, -1);
  assert.notEqual(assistantMessageIndex, -1);
  assert.equal(citationIndex < assistantMessageIndex, true);
  assert.equal(citationIndex < textIndex, true);
  assert.deepEqual(
    (events[citationIndex]?.citations as Array<Record<string, unknown>> | undefined)?.map(
      (item) => item.sourceTitle,
    ),
    ["invoice.pdf"],
  );
});

test("streamThreadEvents sends available citations when final text uses none", async () => {
  const citation = {
    citation: "c1",
    sourceId: "source-1",
    sourceTitle: "invoice.pdf",
    documentId: "document-1",
    chunkId: "chunk-1",
    chunkNo: 0,
    score: 1,
    excerpt: "Invoice total is 50.",
    quoteText: "Invoice total is 50.",
    origin: "read_file" as const,
  };
  const turnService = createTurnService({ title: null });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<typeof ContentThreadStreamService>[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield {
        type: "citations",
        citations: [],
        availableCitations: [citation],
      };
      yield { type: "text-delta", delta: "Total is ¥50.00" };
      yield {
        type: "done",
        outcome: { ...outcome, citations: [], availableCitations: [citation] },
      };
    },
    async () => {},
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this invoice?",
  })) {
    events.push(parseSseData(event));
  }

  const citationEvent = events.find((event) => event.type === "citations");

  assert.ok(citationEvent);
  assert.deepEqual(citationEvent.citations, []);
  assert.deepEqual(
    (citationEvent.availableCitations as Array<Record<string, unknown>> | undefined)?.map(
      (item) => item.sourceTitle,
    ),
    ["invoice.pdf"],
  );
});
