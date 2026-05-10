import assert from "node:assert/strict";
import test, { after } from "node:test";
import type {
  EndSpanInput,
  EndTraceInput,
  StartSpanInput,
  StartTraceInput,
} from "../../../../shared/llm-observability";
import { closeQueue } from "../../../../shared/queue";
import {
  buildAgentRunSpanMetadata,
  buildAgentRunSpanOutput,
  ContentThreadStreamService,
  threadStreamObservability,
} from "./service";
import type {
  DeepAgentTurnEvent,
  DeepAgentTurnOutcome,
} from "../../agent/turn/runner";
import type { PreparedThreadTurn } from "../turn/types";

after(async () => {
  await closeQueue();
});

function parseSseData(value: string) {
  assert.equal(value.startsWith("data: "), true);
  return JSON.parse(value.slice("data: ".length).trim()) as Record<
    string,
    unknown
  >;
}

const outcome: DeepAgentTurnOutcome = {
  assistantContent: "Answer",
  retrieval: null,
  citations: [],
  availableCitations: [],
  retrievalCalls: [],
  toolCalls: [],
  thinkingSteps: [],
  reasoningSegments: [],
  agentCheckpoint: {
    beforeInput: null,
    beforeAssistant: null,
    final: null,
  },
};

const citation = {
  citation: "c1",
  sourceId: "source-1",
  sourceTitle: "invoice.pdf",
  documentId: "document-1",
  chunkId: "chunk-1",
  chunkNo: 0,
  score: 0.95,
  excerpt: "Invoice total is 50.",
  quoteText: "Invoice total is 50.",
  origin: "search_sources" as const,
};

test("buildAgentRunSpanOutput includes reasoning and usage", () => {
  assert.deepEqual(
    buildAgentRunSpanOutput({
      ...outcome,
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cacheReadTokens: 3,
      },
      reasoning: "Used the invoice total from the retrieved source.",
      thinkingSteps: [
        {
          id: "reasoning-summary",
          kind: "reasoning_summary",
          title: "Reasoning summary",
          status: "completed",
          items: [],
          sequence: 0,
          description: "Used the invoice total from the retrieved source.",
        },
      ],
      reasoningSegments: [
        {
          id: "model-reasoning-1",
          text: "Used the invoice total from the retrieved source.",
          sequence: 0,
        },
      ],
    }),
    {
      assistantContent: "Answer",
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cacheReadTokens: 3,
      },
      reasoning: "Used the invoice total from the retrieved source.",
      reasoningSegments: [
        {
          id: "model-reasoning-1",
          index: 0,
          sequence: 0,
          phase: "initial",
          text: {
            preview: "Used the invoice total from the retrieved source.",
            length: 49,
            truncated: false,
          },
        },
      ],
      toolCallCount: 0,
      retrievalCallCount: 0,
      citationCount: 0,
      availableCitationCount: 0,
      citations: [],
      availableCitations: [],
      thinkingStepCount: 1,
      reasoningSegmentCount: 1,
    },
  );
});

test("buildAgentRunSpanOutput includes citation evidence summaries", () => {
  const output = buildAgentRunSpanOutput({
    ...outcome,
    citations: [citation],
    availableCitations: [
      citation,
      {
        ...citation,
        citation: "c2",
        chunkId: "chunk-2",
        chunkNo: 1,
        origin: "read_file",
        path: "/kb/invoice.md",
        excerpt: "x".repeat(500),
        quoteText: "y".repeat(500),
      },
    ],
  });

  assert.equal(output.citationCount, 1);
  assert.equal(output.availableCitationCount, 2);
  assert.deepEqual(output.citations, [
    {
      citation: "c1",
      rank: 1,
      sourceId: "source-1",
      sourceTitle: "invoice.pdf",
      documentId: "document-1",
      chunkId: "chunk-1",
      chunkNo: 0,
      origin: "search_sources",
      score: 0.95,
      excerpt: {
        preview: "Invoice total is 50.",
        length: 20,
        truncated: false,
      },
      quoteText: {
        preview: "Invoice total is 50.",
        length: 20,
        truncated: false,
      },
    },
  ]);

  const available = output.availableCitations as Array<Record<string, unknown>>;
  assert.equal(available.length, 2);
  assert.equal(available[1]?.path, "/kb/invoice.md");
  assert.deepEqual(available[1]?.excerpt, {
    preview: "x".repeat(320),
    length: 500,
    truncated: true,
  });
  assert.deepEqual(available[1]?.quoteText, {
    preview: "y".repeat(400),
    length: 500,
    truncated: true,
  });
});

test("buildAgentRunSpanMetadata includes thinking settings", () => {
  assert.deepEqual(
    buildAgentRunSpanMetadata({
      ...prepared,
      llm: {
        executionMode: "GLOBAL",
        thinking: {
          mode: "effort",
          enabled: true,
          effort: "high",
          includeReasoning: true,
        },
      },
    }),
    {
      mode: "continue",
      modelAlias: "test-model",
      profileAlias: "test-profile",
      gateway: {
        executionMode: "GLOBAL",
        providerHint: null,
        byokProvider: null,
        thinkingMode: "effort",
        thinkingEnabled: true,
        thinkingEffort: "high",
        thinkingIncludeReasoning: true,
        keySource: "global",
        provider: null,
        routeStrategy: null,
      },
      selectedSkillCount: 0,
    },
  );
});

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
      llmProfileAlias: null,
      imageProfileAlias: null,
      visionProfileAlias: null,
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
  mentionedSourceIds: [],
  effectiveMentionedSourceIds: [],
  selectedSourceIds: [],
  sourceIds: [],
  sourceScope: {
    requestedSourceIds: [],
    effectiveSourceIds: [],
    selectedDirectoryIds: [],
    expandedDescendantSourceIds: [],
  },
  skillIds: [],
  webSearchEnabled: false,
  artifact: undefined,
  artifactIntent: {
    kind: null,
    shouldInjectTool: false,
    source: "none",
    confidence: 0,
    reason: "No artifact generation intent detected.",
    config: {
      aspectRatio: "auto",
      quality: "auto",
      style: "auto",
    },
    warnings: [],
  },
  imageProfile: null,
  timezone: "UTC",
  enabledSkills: [],
  runTraceId: "user-message-1",
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
  profileAlias: "test-profile",
  modelAlias: "test-model",
  chatProfile: {
    gatewayConfigId: "gateway-1",
  } as PreparedThreadTurn["chatProfile"],
  llm: undefined,
  llmIdempotencyKey: "thread-stream:user-message-1:assistant",
  agentMode: "continue",
  agentBaseCheckpoint: null,
  agentRunThreadId: "thread-1",
  isFirstAssistantResponse: true,
  initialTitle: "New chat",
  failurePersistence: "persist-error-turn",
};

function createTurnService(input?: {
  title?: string | null;
  prepared?: PreparedThreadTurn;
  finalize?: (value: unknown) => Promise<unknown>;
  createErrorMessage?: (value: unknown) => Promise<unknown>;
}) {
  return {
    prepareThreadTurn: async () => input?.prepared ?? prepared,
    finalizeThreadTurn:
      input?.finalize ??
      (async () => ({
        assistantMessage: {
          id: "assistant-message-1",
          parentMessageId: null,
        },
      })),
  };
}

function createTitleJob(input: { resolve?: boolean; title?: string }) {
  return {
    id: "thread-title:thread-1:user-message-1",
    waitUntilFinished: async () => {
      if (input.resolve === false) {
        await new Promise(() => undefined);
      }
      return {
        status: "applied",
        threadId: "thread-1",
        title: input.title ?? "Invoice Review",
      };
    },
  } as unknown as Awaited<
    ReturnType<
      NonNullable<ConstructorParameters<typeof ContentThreadStreamService>[2]>
    >
  >;
}

function createPrepared(input: Partial<PreparedThreadTurn>) {
  return {
    ...prepared,
    ...input,
  } as PreparedThreadTurn;
}

test("streamThreadEvents waits for delayed title update before finish", async () => {
  let agentTraceContext: unknown;
  let finalizedTraceId: string | undefined;
  const turnService = createTurnService();

  const observedTurnService = {
    ...turnService,
    finalizeThreadTurn: async (input: { prepared: PreparedThreadTurn }) => {
      finalizedTraceId = input.prepared.traceContext?.traceId;
      return {
        assistantMessage: {
          id: "assistant-message-1",
          parentMessageId: null,
        },
      };
    },
  };

  const observedService = new ContentThreadStreamService(
    observedTurnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (input): AsyncGenerator<DeepAgentTurnEvent> {
      agentTraceContext = input.traceContext;
      await new Promise((resolve) => setTimeout(resolve, 0));
      yield { type: "text-delta", delta: "Answer" };
      yield { type: "done", outcome };
    },
    async () => createTitleJob({}),
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of observedService.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this invoice?",
  })) {
    events.push(parseSseData(event));
  }

  const titleIndex = events.findIndex(
    (event) => event.type === "thread-title-update",
  );
  const finishIndex = events.findIndex((event) => event.type === "finish");

  assert.notEqual(titleIndex, -1);
  assert.notEqual(finishIndex, -1);
  assert.equal(events[titleIndex]?.threadId, "thread-1");
  assert.equal(events[titleIndex]?.title, "Invoice Review");
  assert.equal(titleIndex < finishIndex, true);
  assert.deepEqual(agentTraceContext, {
    traceId: "user-message-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    threadId: "thread-1",
    messageId: "user-message-1",
    sessionId: "thread-1",
    feature: "chat",
    parentSpanId: "agent_run",
  });
  assert.equal(finalizedTraceId, "user-message-1");
});

test("streamThreadEvents uses run trace id without changing session or message id", async () => {
  let agentTraceContext: unknown;
  let titleJobTraceId: string | undefined;
  let finalizedTraceId: string | undefined;
  const refreshPrepared = createPrepared({
    runTraceId: "thread-run-refresh-1",
    createdUserMessage: false,
    userMessage: {
      ...prepared.userMessage,
      metadata: { traceId: "original-user-message-trace" },
    },
  });
  const turnService = createTurnService({
    prepared: refreshPrepared,
    finalize: async (value: unknown) => {
      const input = value as { prepared: PreparedThreadTurn };
      finalizedTraceId = input.prepared.traceContext?.traceId;
      return {
        assistantMessage: {
          id: "assistant-refresh-1",
          parentMessageId: null,
        },
      };
    },
  });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (input): AsyncGenerator<DeepAgentTurnEvent> {
      agentTraceContext = input.traceContext;
      yield { type: "done", outcome };
    },
    async (input) => {
      titleJobTraceId = input.prepared.traceContext?.traceId;
      return null;
    },
  );

  for await (const _event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this invoice?",
  })) {
    // Drain stream.
  }

  assert.deepEqual(agentTraceContext, {
    traceId: "thread-run-refresh-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    threadId: "thread-1",
    messageId: "user-message-1",
    sessionId: "thread-1",
    feature: "chat",
    parentSpanId: "agent_run",
  });
  assert.equal(titleJobTraceId, "thread-run-refresh-1");
  assert.equal(finalizedTraceId, "thread-run-refresh-1");
});

test("streamThreadEvents emits pending when title is still generating", async () => {
  const turnService = createTurnService();

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "Answer" };
      yield { type: "done", outcome };
    },
    async () => createTitleJob({ resolve: false }),
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

  const pendingIndex = events.findIndex(
    (event) => event.type === "thread-title-pending",
  );
  const finishIndex = events.findIndex((event) => event.type === "finish");

  assert.notEqual(pendingIndex, -1);
  assert.notEqual(finishIndex, -1);
  assert.equal(events[pendingIndex]?.threadId, "thread-1");
  assert.equal(
    events[pendingIndex]?.jobId,
    "thread-title:thread-1:user-message-1",
  );
  assert.equal(pendingIndex < finishIndex, true);
  assert.equal(Date.now() - startedAt < 3400, true);
});

test("streamThreadEvents generates title when retrying after first failed assistant", async () => {
  const retryPrepared = createPrepared({
    assistantMessageParentId: "assistant-error-1",
    isFirstAssistantResponse: true,
  });
  const turnService = createTurnService({
    prepared: retryPrepared,
    finalize: async () => ({
      assistantMessage: {
        id: "assistant-message-1",
        parentMessageId: "assistant-error-1",
      },
    }),
  });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "Answer" };
      yield { type: "done", outcome };
    },
    async () => createTitleJob({}),
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

  const titleIndex = events.findIndex(
    (event) => event.type === "thread-title-update",
  );
  const assistantMessageIndex = events.findIndex(
    (event) => event.type === "assistant-message",
  );

  assert.notEqual(titleIndex, -1);
  assert.notEqual(assistantMessageIndex, -1);
  assert.equal(events[titleIndex]?.title, "Invoice Review");
  assert.equal(
    events[assistantMessageIndex]?.parentMessageId,
    "assistant-error-1",
  );
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
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "citations", citations: [citation] };
      yield { type: "text-delta", delta: "Total is ¥50.00 [citation:c1]" };
      yield { type: "done", outcome: { ...outcome, citations: [citation] } };
    },
    async () => null,
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
  const assistantMessageIndex = events.findIndex(
    (event) => event.type === "assistant-message",
  );

  assert.notEqual(citationIndex, -1);
  assert.notEqual(textIndex, -1);
  assert.notEqual(assistantMessageIndex, -1);
  assert.equal(citationIndex < assistantMessageIndex, true);
  assert.equal(citationIndex < textIndex, true);
  assert.deepEqual(
    (
      events[citationIndex]?.citations as
        | Array<Record<string, unknown>>
        | undefined
    )?.map((item) => item.sourceTitle),
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
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
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
    async () => null,
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
    (
      citationEvent.availableCitations as
        | Array<Record<string, unknown>>
        | undefined
    )?.map((item) => item.sourceTitle),
    ["invoice.pdf"],
  );
});

test("streamThreadEvents persists send errors as assistant error messages", async () => {
  const errorMessage = {
    id: "assistant-error-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    parentMessageId: null,
    role: "assistant" as const,
    content: "provider exploded",
    createdBy: null,
    model: "test-model",
    creditsConsumed: 0,
    metadata: {},
    createdAt: new Date(0).toISOString(),
  };
  const turnService = createTurnService();

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      throw new Error("provider exploded");
    },
    async () => null,
    async () => errorMessage,
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

  const errorEvent = events.find((event) => event.type === "error");
  assert.ok(errorEvent);
  assert.equal(errorEvent.code, "MODEL_UPSTREAM_ERROR");
  assert.equal(errorEvent.error, "provider exploded");
  assert.equal(errorEvent.userMessageId, "user-message-1");
  assert.equal(errorEvent.messageId, "assistant-error-1");
  assert.equal(errorEvent.parentMessageId, null);
});

test("streamThreadEvents preserves partial assistant content for persisted errors", async () => {
  let partialAssistantContent: string | undefined;
  let partialState: Record<string, unknown> | undefined;
  const turnService = createTurnService();

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield {
        type: "reasoning",
        reasoning: "I found the invoice total.",
        segment: {
          id: "model-reasoning-1",
          text: "I found the invoice total.",
          sequence: 0,
        },
      };
      yield {
        type: "thinking-step",
        step: {
          id: "step-1",
          title: "Checking invoice",
          status: "in_progress",
          items: ["invoice.pdf"],
          sequence: 1,
        },
      };
      yield {
        type: "tool-call-start",
        id: "tool-1",
        tool: "search_sources",
        input: { query: "invoice total" },
        toolCall: {
          id: "tool-1",
          tool: "search_sources",
          input: { query: "invoice total" },
          output: null,
          status: "running",
          latencyMs: null,
          error: null,
          sequence: 2,
        },
      };
      yield {
        type: "citations",
        citations: [citation],
      };
      yield {
        type: "text-delta",
        delta: "Partial answer before failure.",
      };
      throw new Error("provider exploded");
    },
    async () => null,
    async (input) => {
      partialAssistantContent = input.partialAssistantContent;
      partialState = input.partialState as Record<string, unknown>;
      return {
        id: "assistant-error-1",
        teamId: "team-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        parentMessageId: null,
        role: "assistant",
        content: "Partial answer before failure.",
        createdBy: null,
        model: "test-model",
        creditsConsumed: 0,
        metadata: {},
        createdAt: new Date(0).toISOString(),
      };
    },
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

  const textDeltaEvent = events.find((event) => event.type === "text-delta");
  const errorEvent = events.find((event) => event.type === "error");

  assert.equal(textDeltaEvent?.delta, "Partial answer before failure.");
  assert.equal(partialAssistantContent, "Partial answer before failure.");
  assert.equal(partialState?.reasoning, "I found the invoice total.");
  assert.deepEqual(partialState?.reasoningSegments, [
    {
      id: "model-reasoning-1",
      text: "I found the invoice total.",
      sequence: 0,
    },
  ]);
  assert.deepEqual(partialState?.thinkingSteps, [
    {
      id: "step-1",
      title: "Checking invoice",
      status: "completed",
      items: ["invoice.pdf"],
      sequence: 1,
    },
  ]);
  assert.deepEqual(partialState?.toolCalls, [
    {
      id: "tool-1",
      tool: "search_sources",
      input: { query: "invoice total" },
      output: null,
      status: "error",
      latencyMs: null,
      error: "Tool execution failed.",
      sequence: 2,
    },
  ]);
  assert.deepEqual(partialState?.citations, [citation]);
  assert.deepEqual(partialState?.availableCitations, [citation]);
  assert.equal(errorEvent?.messageId, "assistant-error-1");
});

test("streamThreadEvents persists edit errors as latest assistant versions", async () => {
  const editPrepared = createPrepared({
    createdUserMessage: true,
    assistantMessageParentId: "assistant-error-1",
    userMessage: {
      ...prepared.userMessage,
      id: "user-message-2",
      parentMessageId: "user-message-1",
      content: "Edited question",
    },
    messageContent: "Edited question",
    runTraceId: "user-message-2",
  });
  let latestErrorMessage = "";
  const turnService = createTurnService({ prepared: editPrepared });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      throw new Error("provider exploded again");
    },
    async () => null,
    async (input) => {
      latestErrorMessage = input.contentError.message;
      return {
        id: "assistant-error-2",
        teamId: "team-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        parentMessageId: "assistant-error-1",
        role: "assistant",
        content: "provider exploded again",
        createdBy: null,
        model: "test-model",
        creditsConsumed: 0,
        metadata: {},
        createdAt: new Date(0).toISOString(),
      };
    },
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "Edited question",
  })) {
    events.push(parseSseData(event));
  }

  const errorEvent = events.find((event) => event.type === "error");
  assert.ok(errorEvent);
  assert.equal(latestErrorMessage, "provider exploded again");
  assert.equal(errorEvent.error, "provider exploded again");
  assert.equal(errorEvent.userMessageId, "user-message-2");
  assert.equal(errorEvent.messageId, "assistant-error-2");
  assert.equal(errorEvent.parentMessageId, "assistant-error-1");
});

test("streamThreadEvents closes trace as cancelled when stream is abandoned", async (t) => {
  const startedSpans: StartSpanInput[] = [];
  const endedSpans: EndSpanInput[] = [];
  const endedTraces: EndTraceInput[] = [];
  t.mock.method(
    threadStreamObservability,
    "startTrace",
    async (input: StartTraceInput) => ({
      id: "trace-row",
      traceId: input.traceId ?? "trace",
    }),
  );
  t.mock.method(
    threadStreamObservability,
    "startSpan",
    async (input: StartSpanInput) => {
      startedSpans.push(input);
      return { id: "span-row", spanId: input.spanId ?? "span" };
    },
  );
  t.mock.method(
    threadStreamObservability,
    "endSpan",
    async (input: EndSpanInput) => {
      endedSpans.push(input);
    },
  );
  t.mock.method(
    threadStreamObservability,
    "endTrace",
    async (input: EndTraceInput) => {
      endedTraces.push(input);
    },
  );

  const service = new ContentThreadStreamService(
    createTurnService() as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "partial" };
    },
    async () => null,
  );

  const iterator = service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this invoice?",
  });

  assert.equal(parseSseData((await iterator.next()).value).type, "start");
  assert.equal(parseSseData((await iterator.next()).value).type, "text-start");
  assert.equal(parseSseData((await iterator.next()).value).type, "text-delta");
  await iterator.return(undefined);

  assert.equal(
    startedSpans.some((span) => span.spanId === "agent_run"),
    true,
  );
  const cancelledAgentSpan = endedSpans.find(
    (span) => span.spanId === "agent_run" && span.status === "cancelled",
  );
  assert.ok(cancelledAgentSpan);
  const cancelledTrace = endedTraces.find(
    (trace) => trace.status === "cancelled",
  );
  assert.ok(cancelledTrace);
  assert.equal(cancelledTrace.traceId, "user-message-1");
  assert.equal(cancelledTrace.errorCode, "CLIENT_CANCELLED");
});
