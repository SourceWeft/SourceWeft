import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import type { ToolConfirmationRequest } from "@sourceweft/contracts";
import type {
  EndSpanInput,
  EndTraceInput,
  StartSpanInput,
  StartTraceInput,
} from "../../llm-observability";
import { closeQueue } from "../../../shared/queue";
import {
  buildAgentRunSpanMetadata,
  buildAgentRunSpanOutput,
  ContentThreadStreamService,
  threadStreamObservability,
} from "./service";
import { buildGatewayRequestMetadata } from "../../content/model-gateway-audit";
import type {
  DeepAgentTurnEvent,
  DeepAgentTurnOutcome,
} from "../agent/turn/runner";
import type { ContentBillingPort } from "../../content/billing-port";
import type { MessageRecord } from "../../content/types";
import type {
  MeteredLlmCallTrace,
  PreparedThreadTurn,
  ToolCallTrace,
} from "../turn/types";
import { SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED } from "../turn/sandbox-execute-error";
import {
  AGENT_TOOL_TERMINATION_UNKNOWN_CODE,
  AgentToolTerminationUnknownError,
} from "../agent/middleware/tool-execution-timeout";

afterAll(async () => {
  await closeQueue();
});

function parseSseData(value: string) {
  assert.equal(value.startsWith("data: "), true);
  return JSON.parse(value.slice("data: ".length).trim()) as Record<
    string,
    unknown
  >;
}

function createBillingPort(
  overrides: Partial<ContentBillingPort> = {},
): ContentBillingPort {
  return {
    getSummary: vi.fn(async (teamId: string) => ({
      teamId,
      planFamily: "individual_free",
      billingMode: "disabled",
      cycleAnchorAt: new Date(0).toISOString(),
      cycleSource: "free_account",
      cycleStartAt: new Date(0).toISOString(),
      cycleEndAt: new Date(0).toISOString(),
      pages: {
        limit: 0,
        used: 0,
        remaining: 0,
        monthlyGrant: 0,
        monthlyBalance: 0,
        addOnBalance: 0,
        consumedThisCycle: 0,
        available: 0,
      },
      credits: {
        monthlyGrant: 0,
        monthlyBalance: 0,
        addOnBalance: 0,
        reserved: 0,
        consumedThisCycle: 0,
        available: 0,
      },
      seats: {
        used: 0,
        limit: 0,
        remaining: 0,
        activeMembers: 0,
        pendingInvitations: 0,
      },
      spendLimits: {
        softCapUsd: null,
        hardCapUsd: null,
      },
    })),
    meterConsume: vi.fn(async (teamId: string) => ({
      teamId,
      consumedCredits: 0,
      availableCredits: 0,
      consumedThisCycle: 0,
      idempotencyReplayed: false,
    })),
    meterIngestion: vi.fn(async (teamId: string) => ({
      teamId,
      pagesConsumed: 0,
      pagesUsed: 0,
      pagesRemaining: 0,
      idempotencyReplayed: false,
    })),
    ...overrides,
  } as unknown as ContentBillingPort;
}

function createAssistantMessageRecord(
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    id: "assistant-message-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    parentMessageId: null,
    role: "assistant",
    content: "",
    createdBy: null,
    model: null,
    creditsConsumed: null,
    contentJson: {},
    metadata: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
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
    resume: null,
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

function createToolConfirmation(
  overrides: Partial<ToolConfirmationRequest> = {},
): ToolConfirmationRequest {
  return {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "confirmation-1",
    domain: "connector",
    subject: {
      label: "Notion",
      provider: "notion",
      connectorId: "connector-1",
    },
    action: {
      type: "create_page",
      toolName: "notion.pages.create",
      label: "Create Notion page",
      riskLevel: "medium",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Create page",
      requestJson: { title: "Demo" },
    },
    decisionOptions: [
      { decision: "approve", label: "Approve" },
      { decision: "reject", label: "Reject" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: {
        kind: "connector_action_run",
        connectorId: "connector-1",
        actionRunId: "confirmation-1",
      },
    },
    status: "proposed",
    userMessage: "Create the Notion page?",
    ...overrides,
  };
}

function createConfirmationToolCall(
  overrides: Partial<ToolCallTrace> = {},
): ToolCallTrace {
  const confirmation = createToolConfirmation();

  return {
    id: "tool-call-1",
    tool: "notion.pages.create",
    input: { title: "Demo" },
    output: confirmation,
    status: "approval_requested",
    latencyMs: 0,
    error: null,
    sequence: 1,
    approvalConfirmationId: confirmation.id,
    ...overrides,
  };
}

function createMeteredLlmCall(
  overrides: Partial<MeteredLlmCallTrace> = {},
): MeteredLlmCallTrace {
  return {
    id: "llm-call:user-message-1:gen-1",
    operation: "chat.stream",
    modelKind: "chat",
    modelAlias: "test-model",
    profileAlias: "test-profile",
    gatewayConfigId: "gateway-1",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    billingStatus: "metered",
    consumedCredits: 3,
    billedBy: "provider_cost",
    skipReason: null,
    idempotencyKey: "llm-call:user-message-1:gen-1",
    referenceId: "thread:thread-1:message:user-message-1:llm-call:1",
    providerCostUsd: 0.001,
    costSource: "provider_actual",
    missingPriceComponents: [],
    pricingSnapshot: null,
    metadata: {
      threadId: "thread-1",
      messageId: "user-message-1",
      traceId: "user-message-1",
      generationId: "gen-1",
    },
    ...overrides,
  };
}

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
      renderBlockCount: 0,
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

test("buildAgentRunSpanMetadata uses BYOK identity over catalog profile", () => {
  assert.deepEqual(
    buildAgentRunSpanMetadata({
      ...prepared,
      llm: {
        executionMode: "BYOK",
        providerHint: "openrouter",
        byokModelId: "byok-model-1",
        credentialId: "credential-1",
        modelAlias: "openai/gpt-4o",
        providerModel: "openai/gpt-4o",
        byok: {
          provider: "openrouter",
          apiKey: "test-key",
        },
      },
    }),
    {
      mode: "continue",
      modelAlias: "byok:openrouter:openai/gpt-4o",
      profileAlias: null,
      catalogModelAlias: "test-model",
      gateway: {
        executionMode: "BYOK",
        providerHint: "openrouter",
        byokProvider: "openrouter",
        byokModelId: "byok-model-1",
        credentialId: "credential-1",
        thinkingMode: null,
        thinkingEnabled: false,
        thinkingEffort: null,
        thinkingIncludeReasoning: null,
        keySource: "byokCredential",
        provider: null,
        routeStrategy: null,
      },
      selectedSkillCount: 0,
    },
  );
});

test("buildGatewayRequestMetadata keeps BYOK profileAlias out of observed metadata", () => {
  const metadata = buildGatewayRequestMetadata({
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    threadId: "thread-1",
    messageId: "message-1",
    feature: "chat",
    operation: "chat.complete",
    modelAlias: "catalog-model",
    profileAlias: "global-profile",
    modelKind: "chat",
    llm: {
      executionMode: "BYOK",
      providerHint: "openrouter",
      byokModelId: "byok-model-1",
      credentialId: "credential-1",
      modelAlias: "openai/gpt-4o",
      providerModel: "openai/gpt-4o",
      byok: {
        provider: "openrouter",
        apiKey: "test-key",
      },
    },
  });

  assert.equal(metadata.profileAlias, null);
  assert.equal(metadata.catalogProfileAlias, undefined);
  assert.equal(metadata.modelAlias, "byok:openrouter:openai/gpt-4o");
  assert.equal(metadata.catalogModelAlias, "catalog-model");
  assert.equal(metadata.byokModelId, "byok-model-1");
  assert.equal(metadata.credentialId, "credential-1");
  assert.equal(metadata.providerModel, "openai/gpt-4o");
  assert.equal(metadata.keySource, "byokCredential");
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
    chatPreferences: {
      thinking: { mode: "auto", effort: "medium" },
      webAccess: true,
      composerOptions: {},
    },
    sourceCount: 0,
    visibility: "private",
    createdBy: "user-1",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastMessageAt: null,
  },
  messageContent: "What is in this invoice?",
  messageContentJson: {
    version: 1,
    parts: [{ type: "text", text: "What is in this invoice?" }],
  },
  imageParts: [],
  preflightBilling: [],
  preflightThinkingSteps: [],
  mcpInstallIds: [],
  enabledSkills: [],
  invokedSkillIds: [],
  agentMessageContent: "What is in this invoice?",
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

  webAccessEnabled: false,
  command: null,
  invocation: null,
  commandSuccessCriteria: { kind: "none" },
  toolPermissions: {},
  effectiveTools: {},
  runtimeTools: {},
  turnState: {},
  timezone: "UTC",
  runTraceId: "user-message-1",
  userMessage: {
    id: "user-message-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    parentMessageId: null,
    role: "user",
    content: "What is in this invoice?",
    contentJson: {},
    metadata: {},
    createdAt: new Date(0).toISOString(),
    createdBy: "user-1",
    model: null,
    creditsConsumed: null,
  },
  createdUserMessage: true,
  assistantMessageParentId: null,
  assistantMessageId: null,
  assistantMessageIdOverride: null,
  profileAlias: "test-profile",
  modelAlias: "test-model",
  providerModel: "test-model",
  chatProfile: {
    gatewayConfigId: "gateway-1",
  } as PreparedThreadTurn["chatProfile"],
  llm: undefined,
  llmIdempotencyKey: "thread-stream:user-message-1:assistant",
  agentMode: "continue",
  agentBaseCheckpoint: null,
  agentRunThreadId: "thread-1",
  toolApprovalResume: null,
  traceContinuation: null,
  isFirstAssistantResponse: true,
  isFirstAssistantAttempt: true,
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
          teamId: "team-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          parentMessageId: null,
          role: "assistant",
          content: "Answer",
          contentJson: {},
          createdBy: null,
          model: "test-model",
          creditsConsumed: 1,
          metadata: {},
          createdAt: new Date(0).toISOString(),
        },
        billing: {
          teamId: "team-1",
          consumedCredits: 1,
          availableCredits: 99,
          consumedThisCycle: 1,
          idempotencyReplayed: false,
        },
      })),
  };
}

function createTitleJob(input: { resolve?: boolean; title?: string }) {
  return {
    id: "thread-title_thread-1_user-message-1",
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
      return turnService.finalizeThreadTurn(input as never);
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
    undefined,
    createBillingPort(),
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
    undefined,
    createBillingPort(),
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
    undefined,
    createBillingPort(),
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
    "thread-title_thread-1_user-message-1",
  );
  assert.equal(pendingIndex < finishIndex, true);
  assert.equal(Date.now() - startedAt < 3400, true);
});

test("streamThreadEvents includes finish reason in finish events", async () => {
  const turnService = createTurnService();
  const toolCall = createConfirmationToolCall();

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield {
        type: "done",
        outcome: {
          ...outcome,
          finishReason: "tool_confirmation_requested",
          toolCalls: [toolCall],
        },
      };
    },
    async () => null,
    undefined,
    createBillingPort(),
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

  const finish = events.find((event) => event.type === "finish");

  assert.equal(finish?.finishReason, "tool_confirmation_requested");
  assert.equal(finish?.messageId, "assistant-message-1");
  assert.equal(finish?.userMessageId, "user-message-1");
  assert.equal(finish?.parentMessageId, null);
  assert.deepEqual(finish?.agentCheckpoint, outcome.agentCheckpoint);
  const liveConfirmations = finish?.liveConfirmations as
    Record<string, unknown>[] | undefined;
  assert.equal(liveConfirmations?.length, 1);
  const liveConfirmation = liveConfirmations?.[0] as
    Record<string, unknown> | undefined;
  assert.equal(
    (liveConfirmation?.confirmation as Record<string, unknown> | undefined)?.id,
    "confirmation-1",
  );
  assert.equal(
    (liveConfirmation?.toolCall as Record<string, unknown> | undefined)?.id,
    "tool-call-1",
  );
  assert.equal(
    (liveConfirmation?.toolCall as Record<string, unknown> | undefined)?.status,
    "approval_requested",
  );
});

test("streamThreadEvents fails confirmation finishes without confirmation payload", async () => {
  const turnService = createTurnService();

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield {
        type: "done",
        outcome: {
          ...outcome,
          finishReason: "tool_confirmation_requested",
          toolCalls: [],
        },
      };
    },
    async () => null,
    undefined,
    createBillingPort(),
  );

  await assert.rejects(
    async () => {
      for await (const _event of service.streamThreadEvents({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userId: "user-1",
        content: "What is in this invoice?",
      })) {
        // Drain stream.
      }
    },
    (error) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code ===
        "TOOL_CONFIRMATION_PAYLOAD_MISSING",
  );
});

test("streamThreadEvents defaults successful finish events to stop", async () => {
  const turnService = createTurnService();

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "done", outcome: { ...outcome, finishReason: undefined } };
    },
    async () => null,
    undefined,
    createBillingPort(),
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

  const finish = events.find((event) => event.type === "finish");

  assert.equal(finish?.finishReason, "stop");
});

test("streamThreadEvents skips title after a cancelled assistant attempt", async () => {
  const continuedAfterCancelPrepared = createPrepared({
    messageContent: "继续",
    messageContentJson: {
      version: 1,
      parts: [{ type: "text", text: "继续" }],
    },
    agentMessageContent: "继续",
    isFirstAssistantResponse: true,
    isFirstAssistantAttempt: false,
  });
  const turnService = createTurnService({
    prepared: continuedAfterCancelPrepared,
  });
  let titleJobEnqueued = false;

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "Answer" };
      yield { type: "done", outcome };
    },
    async () => {
      titleJobEnqueued = true;
      return createTitleJob({ title: "继续对话" });
    },
    undefined,
    createBillingPort(),
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "继续",
  })) {
    events.push(parseSseData(event));
  }

  assert.equal(titleJobEnqueued, false);
  assert.equal(
    events.some((event) => event.type === "thread-title-update"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "thread-title-pending"),
    false,
  );
});

test("streamThreadEvents calls onFinalized with assistant message and billing", async () => {
  const turnService = createTurnService();
  const finalizedResults: unknown[] = [];
  const retrievalOutcome: DeepAgentTurnOutcome = {
    ...outcome,
    retrieval: {
      profile: {
        id: "embedding-profile-1",
        kind: "embedding",
        profileAlias: "embedding-default",
        gatewayConfigId: "gateway-1",
        modelAlias: "embed-model",
        requestedDimensions: 1024,
        vectorStrategy: "auto",
        isDefault: true,
        isActive: true,
        configJson: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      planner: {
        strategy: "ann_hnsw",
        annIndexUsed: "sources_embedding_hnsw_idx",
        requestedDimensions: 1024,
      },
      fusedCandidates: [],
      retrievalSummary: [],
      contextAssembly: null,
    } as unknown as DeepAgentTurnOutcome["retrieval"],
    citations: [citation],
    availableCitations: [citation],
  };
  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "Answer" };
      yield { type: "done", outcome: retrievalOutcome };
    },
    async () => null,
    undefined,
    createBillingPort(),
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents(
    {
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      content: "What is in this invoice?",
    },
    {
      onFinalized: async (result) => {
        finalizedResults.push(result);
      },
    },
  )) {
    events.push(parseSseData(event));
  }

  assert.equal(finalizedResults.length, 1);
  assert.deepEqual(finalizedResults[0], {
    assistantMessage: {
      id: "assistant-message-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      parentMessageId: null,
      role: "assistant",
      content: "Answer",
      contentJson: {},
      createdBy: null,
      model: "test-model",
      creditsConsumed: 1,
      metadata: {},
      createdAt: new Date(0).toISOString(),
    },
    billing: {
      teamId: "team-1",
      consumedCredits: 1,
      availableCredits: 99,
      consumedThisCycle: 1,
      idempotencyReplayed: false,
    },
    retrieval: {
      embeddingProfileId: "embedding-profile-1",
      vectorStrategy: "ann_hnsw",
      annIndexUsed: "sources_embedding_hnsw_idx",
      citations: [citation],
      availableCitations: [citation],
    },
  });
  assert.equal(
    events.some((event) => event.type === "finish"),
    true,
  );
});

test("streamThreadEvents emits prepared thread run metadata on start", async () => {
  const turnService = createTurnService();
  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "Answer" };
      yield { type: "done", outcome };
    },
    async () => null,
    undefined,
    createBillingPort(),
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents(
    {
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      content: "What is in this invoice?",
    },
    {
      onPrepared: async () => ({
        assistantMessageId: "assistant-message-1",
        assistantMetadata: {
          threadRun: {
            id: "run-1",
            idempotencyKey: "sourceweft-web-run:resume-1",
            mode: "resume",
            status: "running",
          },
        },
      }),
    },
  )) {
    events.push(parseSseData(event));
  }

  assert.deepEqual(events[0]?.threadRun, {
    assistantMessageId: "assistant-message-1",
    id: "run-1",
    idempotencyKey: "sourceweft-web-run:resume-1",
    mode: "resume",
    status: "running",
  });
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
    undefined,
    createBillingPort(),
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

test("streamThreadEvents persists terminal command verification thinking steps", async () => {
  let finalizedThinkingSteps: unknown;
  let finalizedTraceParts: unknown;
  const commandStep = {
    id: "command-success",
    kind: "verification" as const,
    title: "Checking command outcome",
    status: "completed" as const,
    items: [],
    sequence: 1,
    description:
      "Command failed because publish_artifact did not create a slides artifact.",
  };
  const turnService = createTurnService({
    finalize: async (input) => {
      finalizedThinkingSteps = (
        input as {
          thinkingSteps?: unknown;
          traceParts?: unknown;
        }
      ).thinkingSteps;
      finalizedTraceParts = (
        input as {
          thinkingSteps?: unknown;
          traceParts?: unknown;
        }
      ).traceParts;
      return {
        assistantMessage: {
          id: "assistant-message-1",
          parentMessageId: null,
        },
      };
    },
  });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield {
        type: "thinking-step",
        step: {
          ...commandStep,
          status: "in_progress",
        },
      };
      yield {
        type: "thinking-step",
        step: commandStep,
      };
      yield {
        type: "done",
        outcome: {
          ...outcome,
          assistantContent:
            "Command failed because publish_artifact did not create a slides artifact.",
          finishReason: "command_success_criteria_failed",
          thinkingSteps: [commandStep],
        },
      };
    },
    async () => createTitleJob({}),
    undefined,
    createBillingPort(),
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "PPT Deck",
  })) {
    events.push(parseSseData(event));
  }

  const commandEvents = events.filter(
    (event) =>
      event.type === "thinking-step" &&
      (event.step as { id?: string } | undefined)?.id === "command-success",
  );
  assert.deepEqual(
    commandEvents.map(
      (event) => (event.step as { status?: string } | undefined)?.status,
    ),
    ["in_progress", "completed"],
  );
  assert.equal(
    (finalizedThinkingSteps as Array<{ id: string; status: string }>).find(
      (step) => step.id === "command-success",
    )?.status,
    "completed",
  );
  assert.equal(
    (finalizedTraceParts as Array<{ id: string; status?: string }>).find(
      (part) => part.id === "command-success",
    )?.status,
    "completed",
  );
});

test("streamThreadEvents finalizes successful traces as terminal completed state", async () => {
  let finalizedFinishReason: unknown;
  let finalizedThinkingSteps: unknown;
  let finalizedTraceParts: unknown;
  const runningStep = {
    id: "draft-presentation",
    kind: "state" as const,
    title: "Publishing presentation",
    status: "in_progress" as const,
    items: [],
    sequence: 1,
  };
  const turnService = createTurnService({
    finalize: async (input) => {
      finalizedFinishReason = (input as { finishReason?: unknown })
        .finishReason;
      finalizedThinkingSteps = (
        input as {
          thinkingSteps?: unknown;
          traceParts?: unknown;
        }
      ).thinkingSteps;
      finalizedTraceParts = (
        input as {
          thinkingSteps?: unknown;
          traceParts?: unknown;
        }
      ).traceParts;
      return {
        assistantMessage: {
          id: "assistant-message-1",
          parentMessageId: null,
        },
      };
    },
  });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield {
        type: "thinking-step",
        step: runningStep,
      };
      yield {
        type: "done",
        outcome: {
          ...outcome,
          finishReason: undefined,
          thinkingSteps: [runningStep],
        },
      };
    },
    async () => createTitleJob({}),
    undefined,
    createBillingPort(),
  );

  for await (const _event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "PPT Deck",
  })) {
    // Drain the stream so finalizeThreadTurn runs.
  }

  assert.equal(finalizedFinishReason, "stop");
  assert.equal(
    (finalizedThinkingSteps as Array<{ id: string; status: string }>).find(
      (step) => step.id === "draft-presentation",
    )?.status,
    "completed",
  );
  assert.equal(
    (finalizedTraceParts as Array<{ id: string; status?: string }>).find(
      (part) => part.id === "draft-presentation",
    )?.status,
    "completed",
  );
});

test("streamThreadEvents persists DeepAgents todos as a visible step without generic tool trace", async () => {
  let finalizedToolCalls: unknown;
  let finalizedTraceParts: unknown;
  const todoStep = {
    id: "deepagents:todos",
    kind: "state" as const,
    title: "Task plan",
    status: "in_progress" as const,
    items: ["In progress: Surface todos in trace"],
    sequence: 1,
    metadata: {
      source: "deepagents",
      tool: "write_todos",
      toolCallId: "call-todos",
      todos: [
        {
          content: "Surface todos in trace",
          status: "in_progress",
        },
      ],
    },
  };
  const writeTodosToolCall = {
    id: "call-todos",
    tool: "write_todos",
    input: {
      todos: [
        {
          content: "Surface todos in trace",
          status: "in_progress",
        },
      ],
    },
    output: {
      content:
        'Updated todo list to [{"content":"Surface todos in trace","status":"in_progress"}]',
    },
    status: "completed" as const,
    latencyMs: 8,
    error: null,
    sequence: 2,
  };
  const turnService = createTurnService({
    finalize: async (input) => {
      finalizedToolCalls = (input as { toolCalls?: unknown }).toolCalls;
      finalizedTraceParts = (input as { traceParts?: unknown }).traceParts;
      return {
        assistantMessage: {
          id: "assistant-message-1",
          parentMessageId: null,
        },
      };
    },
  });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield {
        type: "thinking-step",
        step: todoStep,
      };
      yield {
        type: "done",
        outcome: {
          ...outcome,
          toolCalls: [writeTodosToolCall],
          thinkingSteps: [todoStep],
        },
      };
    },
    async () => createTitleJob({}),
    undefined,
    createBillingPort(),
  );

  for await (const _event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "Implement the plan",
  })) {
    // Drain the stream so finalizeThreadTurn runs.
  }

  assert.equal(
    (finalizedToolCalls as Array<{ tool: string }>).some(
      (toolCall) => toolCall.tool === "write_todos",
    ),
    true,
  );
  assert.deepEqual(
    (finalizedTraceParts as Array<{ id: string; kind: string; tool?: string }>)
      .filter((part) => part.id === "deepagents:todos")
      .map((part) => part.kind),
    ["step"],
  );
  assert.equal(
    (finalizedTraceParts as Array<{ kind: string; tool?: string }>).some(
      (part) => part.kind === "tool" && part.tool === "write_todos",
    ),
    false,
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
    undefined,
    createBillingPort(),
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
        Array<Record<string, unknown>> | undefined
    )?.map((item) => item.sourceTitle),
    ["invoice.pdf"],
  );
});

test("streamThreadEvents emits preflight thinking steps while preparing", async () => {
  const preflightSteps = [
    {
      id: "vision-capability-check",
      kind: "state" as const,
      title: "Checking chat model vision support",
      status: "completed" as const,
      items: ["1 image(s)"],
      sequence: -2,
    },
    {
      id: "vision-fallback-describe",
      kind: "state" as const,
      title: "Preparing image descriptions with vision model",
      status: "in_progress" as const,
      items: ["1 image(s)"],
      sequence: -1,
    },
    {
      id: "vision-fallback-describe",
      kind: "state" as const,
      title: "Prepared image descriptions with vision model",
      status: "completed" as const,
      items: ["receipt.png"],
      sequence: -1,
    },
  ];
  let resolvePrepare: (() => void) | undefined;
  const turnService = {
    prepareThreadTurn: async (input: {
      onPreflightThinkingStep?: (step: (typeof preflightSteps)[number]) => void;
    }) => {
      for (const step of preflightSteps) {
        input.onPreflightThinkingStep?.(step);
      }
      await new Promise<void>((resolve) => {
        resolvePrepare = resolve;
      });
      return createPrepared({
        preflightThinkingSteps: preflightSteps,
      });
    },
    finalizeThreadTurn: createTurnService().finalizeThreadTurn,
  };

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield {
        type: "done",
        outcome,
      };
    },
    async () => null,
    undefined,
    createBillingPort(),
  );

  const iterator = service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this image?",
  });

  const first = parseSseData((await iterator.next()).value);
  const second = parseSseData((await iterator.next()).value);
  const third = parseSseData((await iterator.next()).value);

  assert.deepEqual(
    [first, second, third].map((event) => [
      event.type,
      (event.step as { title?: string; status?: string }).title,
      (event.step as { title?: string; status?: string }).status,
    ]),
    [
      ["thinking-step", "Checking chat model vision support", "completed"],
      [
        "thinking-step",
        "Preparing image descriptions with vision model",
        "in_progress",
      ],
      [
        "thinking-step",
        "Prepared image descriptions with vision model",
        "completed",
      ],
    ],
  );

  resolvePrepare?.();

  const remainingEvents: Record<string, unknown>[] = [];
  for await (const event of iterator) {
    remainingEvents.push(parseSseData(event));
  }

  assert.equal(remainingEvents[0]?.type, "start");
  assert.equal(
    remainingEvents.filter((event) => event.type === "thinking-step").length,
    0,
  );
});

test("streamThreadEvents preserves preflight billing for finalization", async () => {
  let finalizedPrepared: PreparedThreadTurn | undefined;
  const preparedWithPreflightBilling = createPrepared({
    preflightBilling: [
      {
        id: "image-1",
        operation: "chat.vision_fallback",
        modelKind: "vision",
        modelAlias: "vision-default",
        profileAlias: "vision-profile",
        consumedCredits: 2,
        billedBy: "provider_cost",
        skipReason: null,
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
        metadata: {
          imageFileName: "image.png",
        },
      },
    ],
  });
  const turnService = createTurnService({
    prepared: preparedWithPreflightBilling,
    finalize: async (input) => {
      finalizedPrepared = (input as { prepared: PreparedThreadTurn }).prepared;
      return {
        assistantMessage: {
          id: "assistant-message-1",
          parentMessageId: null,
        },
        billing: {
          teamId: "team-1",
          consumedCredits: 1,
          availableCredits: 97,
          consumedThisCycle: 3,
          idempotencyReplayed: false,
        },
      };
    },
  });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "Answer" };
      yield { type: "done", outcome };
    },
    async () => null,
    undefined,
    createBillingPort(),
  );

  for await (const _event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this image?",
  })) {
    // Drain stream.
  }

  assert.deepEqual(
    finalizedPrepared?.preflightBilling,
    preparedWithPreflightBilling.preflightBilling,
  );
});

test("streamThreadEvents passes metered LLM calls to finalization", async () => {
  const meteredLlmCall = createMeteredLlmCall();
  let finalizedMeteredCalls: MeteredLlmCallTrace[] | undefined;
  const turnService = createTurnService({
    finalize: async (input) => {
      finalizedMeteredCalls = (
        input as { meteredLlmCalls?: MeteredLlmCallTrace[] }
      ).meteredLlmCalls;
      return {
        assistantMessage: createAssistantMessageRecord({
          id: "assistant-message-1",
          content: "Answer",
          creditsConsumed: 3,
        }),
        billing: {
          teamId: "team-1",
          consumedCredits: 3,
          availableCredits: 97,
          consumedThisCycle: 3,
          idempotencyReplayed: false,
        },
      };
    },
  });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "Answer" };
      yield {
        type: "done",
        outcome: { ...outcome, meteredLlmCalls: [meteredLlmCall] },
      };
    },
    async () => null,
    undefined,
    createBillingPort(),
  );

  for await (const _event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this invoice?",
  })) {
    // Drain stream.
  }

  assert.deepEqual(finalizedMeteredCalls, [meteredLlmCall]);
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
    undefined,
    createBillingPort(),
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
        Array<Record<string, unknown>> | undefined
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
    contentJson: {},
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
    createBillingPort(),
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

test("streamThreadEvents classifies sandbox execute approval errors", async () => {
  let observedCode: string | undefined;
  const turnService = createTurnService();

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      throw new Error("MiddlewareError", {
        cause: new Error(
          "SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED: sandbox execute requires an approved stable tool call id from HITL resume metadata.",
        ),
      });
    },
    async () => null,
    async (input) => {
      observedCode = input.contentError.code;
      return createAssistantMessageRecord({
        id: "assistant-sandbox-error-1",
        content: input.contentError.message,
        metadata: {
          isError: true,
          errorCode: input.contentError.code,
          error: input.contentError.message,
        },
      });
    },
    createBillingPort(),
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "Run the deck command",
  })) {
    events.push(parseSseData(event));
  }

  const errorEvent = events.find((event) => event.type === "error");
  assert.equal(errorEvent?.code, SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED);
  assert.equal(observedCode, SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED);
  assert.equal(errorEvent?.messageId, "assistant-sandbox-error-1");
});

test("streamThreadEvents converts LangChain tool middleware failures into terminal error events", async () => {
  const turnService = createTurnService();
  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      const cause = new Error(
        "SANDBOX_PROVIDER_ERROR: sandbox provider mkdir failed: bad request",
      );
      const error = new Error("MiddlewareError", { cause });
      error.name = "MiddlewareError";
      throw error;
    },
    async () => null,
    async (input) =>
      createAssistantMessageRecord({
        id: "assistant-provider-error-1",
        content: input.contentError.message,
        metadata: {
          isError: true,
          errorCode: input.contentError.code,
          error: input.contentError.message,
        },
      }),
    createBillingPort(),
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "Prepare the workspace",
  })) {
    events.push(parseSseData(event));
  }

  const errorEvent = events.find((event) => event.type === "error");
  const finishEvent = events.find((event) => event.type === "finish");
  assert.equal(errorEvent?.code, "CHAT_RUN_FAILED");
  assert.equal(errorEvent?.messageId, "assistant-provider-error-1");
  assert.ok(finishEvent);
});

test("external Stop preserves termination_unknown instead of claiming cancellation", async () => {
  const abortController = new AbortController();
  let persistedCode: string | undefined;
  const turnService = createTurnService();
  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      abortController.abort(
        new DOMException("user requested Stop", "AbortError"),
      );
      const terminationUnknown = new AgentToolTerminationUnknownError({
        cause: abortController.signal.reason,
        terminationGraceMs: 30_000,
        toolName: "validate_video_presentation",
      });
      const wrapped = new Error("MiddlewareError", {
        cause: terminationUnknown,
      });
      wrapped.name = "MiddlewareError";
      throw wrapped;
    },
    async () => null,
    async (input) => {
      persistedCode = input.contentError.code;
      return createAssistantMessageRecord({
        id: "assistant-termination-unknown-1",
        content: input.contentError.message,
      });
    },
    createBillingPort(),
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents(
    {
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      content: "Render the video",
    },
    {
      abortSignal: abortController.signal,
      shouldCancel: async () => true,
    },
  )) {
    events.push(parseSseData(event));
  }

  const errorEvent = events.find((event) => event.type === "error");
  assert.equal(errorEvent?.code, AGENT_TOOL_TERMINATION_UNKNOWN_CODE);
  assert.equal(persistedCode, AGENT_TOOL_TERMINATION_UNKNOWN_CODE);
  assert.notEqual(errorEvent?.code, "CLIENT_CANCELLED");
});

test("streamThreadEvents preserves preflight billing on persisted errors", async () => {
  let errorPrepared: PreparedThreadTurn | undefined;
  const preparedWithPreflightBilling = createPrepared({
    preflightBilling: [
      {
        id: "image-1",
        operation: "chat.vision_fallback",
        modelKind: "vision",
        modelAlias: "vision-default",
        profileAlias: "vision-profile",
        consumedCredits: 2,
        billedBy: "minimum_credit",
        skipReason: null,
      },
    ],
  });
  const turnService = createTurnService({
    prepared: preparedWithPreflightBilling,
  });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      throw new Error("provider exploded");
    },
    async () => null,
    async (input) => {
      errorPrepared = input.prepared;
      return {
        id: "assistant-error-1",
        teamId: "team-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        parentMessageId: null,
        role: "assistant",
        content: "provider exploded",
        createdBy: null,
        model: "test-model",
        creditsConsumed: 2,
        contentJson: {},
        metadata: {
          preflightBilling: input.prepared.preflightBilling,
          preflightCreditsConsumed: 2,
        },
        createdAt: new Date(0).toISOString(),
      };
    },
    createBillingPort(),
  );

  for await (const _event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "What is in this image?",
  })) {
    // Drain stream.
  }

  assert.deepEqual(
    errorPrepared?.preflightBilling,
    preparedWithPreflightBilling.preflightBilling,
  );
});

test("streamThreadEvents preserves metered LLM calls on persisted errors", async () => {
  const meteredLlmCall = createMeteredLlmCall({
    id: "llm-call:user-message-1:gen-before-tool-error",
    consumedCredits: 4,
    metadata: {
      threadId: "thread-1",
      messageId: "user-message-1",
      traceId: "user-message-1",
      generationId: "gen-before-tool-error",
      operation: "chat.stream",
    },
  });
  let errorMeteredCalls: MeteredLlmCallTrace[] | undefined;
  const turnService = createTurnService();

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (input) {
      // Production hands the scope over as soon as the turn opens it, before
      // any model call can fail — so a crash still leaves the already-metered
      // calls reachable.
      input.onBillingScope?.({
        meteredCalls: () => [meteredLlmCall],
      } as never);
      throw new Error("tool exploded after model usage");
    } as ConstructorParameters<typeof ContentThreadStreamService>[1],
    async () => null,
    async (input) => {
      errorMeteredCalls = input.partialState?.meteredLlmCalls;
      return createAssistantMessageRecord({
        id: "assistant-error-1",
        content: input.contentError.message,
        creditsConsumed: 4,
        metadata: {
          isError: true,
          meteredLlmCalls: errorMeteredCalls ?? [],
          meteredLlmCreditsConsumed: 4,
          billingFinalizerSkipped: true,
          billingFinalizerSkipReason: "model_error",
        },
      });
    },
    createBillingPort(),
  );

  for await (const _event of service.streamThreadEvents({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "Use a tool after answering",
  })) {
    // Drain stream.
  }

  assert.deepEqual(errorMeteredCalls, [meteredLlmCall]);
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
        reasoning: "I found",
        segment: {
          id: "model-reasoning-1",
          text: "I found",
          sequence: 0,
          phase: "initial",
        },
      };
      yield {
        type: "reasoning",
        reasoning: " the invoice total.",
        segment: {
          id: "model-reasoning-1",
          text: "I found the invoice total.",
          sequence: 0,
          phase: "initial",
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
        type: "reasoning",
        reasoning: " It came from the source.",
        segment: {
          id: "model-reasoning-1",
          text: "It came from the source.",
          sequence: 3,
          phase: "after_tool",
          toolCallId: "tool-1",
          tool: "search_sources",
        },
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
        contentJson: {},
        metadata: {},
        createdAt: new Date(0).toISOString(),
      };
    },
    createBillingPort(),
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
  const reasoningEvents = events.filter((event) => event.type === "reasoning");

  assert.deepEqual(
    reasoningEvents.map((event) => event.reasoning),
    ["I found", " the invoice total.", " It came from the source."],
  );
  assert.deepEqual(
    reasoningEvents.map((event) => event.segment),
    [
      {
        id: "model-reasoning-1",
        sequence: 0,
        phase: "initial",
      },
      {
        id: "model-reasoning-1",
        sequence: 0,
        phase: "initial",
      },
      {
        id: "model-reasoning-1",
        sequence: 3,
        phase: "after_tool",
        toolCallId: "tool-1",
        tool: "search_sources",
      },
    ],
  );
  assert.equal(
    reasoningEvents.some((event) =>
      Object.hasOwn(event.segment as Record<string, unknown>, "text"),
    ),
    false,
  );
  assert.equal(textDeltaEvent?.delta, "Partial answer before failure.");
  assert.equal(partialAssistantContent, "Partial answer before failure.");
  assert.equal(
    partialState?.reasoning,
    "I found the invoice total. It came from the source.",
  );
  assert.deepEqual(partialState?.reasoningSegments, [
    {
      id: "model-reasoning-1",
      text: "It came from the source.",
      sequence: 0,
      phase: "after_tool",
      toolCallId: "tool-1",
      tool: "search_sources",
    },
  ]);
  assert.deepEqual(
    (
      partialState?.traceParts as Array<{
        kind: string;
        order: number;
        text?: string;
      }>
    )
      .filter((part) => part.kind === "reasoning")
      .map((part) => `${part.order}:${part.kind}:${part.text ?? ""}`),
    ["0:reasoning:It came from the source."],
  );
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
        contentJson: {},
        metadata: {},
        createdAt: new Date(0).toISOString(),
      };
    },
    createBillingPort(),
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

test("streamThreadEvents closes trace as cancelled when stream is abandoned", async () => {
  const startedSpans: StartSpanInput[] = [];
  const endedSpans: EndSpanInput[] = [];
  const endedTraces: EndTraceInput[] = [];
  let persistedCancelledError: {
    errorCode?: string;
    partialAssistantContent?: string;
    toolCalls?: unknown[];
  } | null = null;
  vi.spyOn(threadStreamObservability, "startTrace").mockImplementation(
    async (input: StartTraceInput) => ({
      id: "00000000-0000-4000-8000-000000000001",
      traceId: input.traceId ?? "trace",
    }),
  );
  vi.spyOn(threadStreamObservability, "startSpan").mockImplementation(
    async (input: StartSpanInput) => {
      startedSpans.push(input);
      return {
        id: "00000000-0000-4000-8000-000000000002",
        spanId: input.spanId ?? "span",
      };
    },
  );
  vi.spyOn(threadStreamObservability, "endSpan").mockImplementation(
    async (input: EndSpanInput) => {
      endedSpans.push(input);
    },
  );
  vi.spyOn(threadStreamObservability, "endTrace").mockImplementation(
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
      yield {
        type: "tool-call-start",
        id: "tool-cancelled",
        tool: "validate_demo",
        input: {},
        toolCall: {
          id: "tool-cancelled",
          tool: "validate_demo",
          input: {},
          output: null,
          status: "running",
          latencyMs: null,
          error: null,
          sequence: 1,
        },
      };
    },
    async () => null,
    async (input) => {
      persistedCancelledError = {
        errorCode: input.contentError.code,
        partialAssistantContent: input.partialAssistantContent,
        toolCalls: input.partialState?.toolCalls,
      };
      return createAssistantMessageRecord({
        id: "assistant-message-cancelled",
        parentMessageId: null,
      });
    },
    createBillingPort(),
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
  assert.equal(
    parseSseData((await iterator.next()).value).type,
    "tool-call-start",
  );
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
  assert.deepEqual(persistedCancelledError, {
    errorCode: "CLIENT_CANCELLED",
    partialAssistantContent: "partial",
    toolCalls: [
      {
        id: "tool-cancelled",
        tool: "validate_demo",
        input: {},
        output: null,
        status: "error",
        latencyMs: null,
        error: "Client closed the stream before completion",
        sequence: 1,
      },
    ],
  });
});

test("streamThreadEvents observes requested cancellation as cancelled, not error", async () => {
  const endedSpans: EndSpanInput[] = [];
  const endedTraces: EndTraceInput[] = [];
  let persistedCancelledError: {
    errorCode?: string;
    partialAssistantContent?: string;
    toolCalls?: unknown[];
  } | null = null;
  vi.spyOn(threadStreamObservability, "startTrace").mockImplementation(
    async (input: StartTraceInput) => ({
      id: "00000000-0000-4000-8000-000000000003",
      traceId: input.traceId ?? "trace",
    }),
  );
  vi.spyOn(threadStreamObservability, "startSpan").mockImplementation(
    async (input: StartSpanInput) => ({
      id: "00000000-0000-4000-8000-000000000004",
      spanId: input.spanId ?? "span",
    }),
  );
  vi.spyOn(threadStreamObservability, "endSpan").mockImplementation(
    async (input: EndSpanInput) => {
      endedSpans.push(input);
    },
  );
  vi.spyOn(threadStreamObservability, "endTrace").mockImplementation(
    async (input: EndTraceInput) => {
      endedTraces.push(input);
    },
  );

  let cancelChecks = 0;
  const service = new ContentThreadStreamService(
    createTurnService() as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield {
        type: "tool-call-start",
        id: "tool-cancelled",
        tool: "validate_demo",
        input: {},
        toolCall: {
          id: "tool-cancelled",
          tool: "validate_demo",
          input: {},
          output: null,
          status: "running",
          latencyMs: null,
          error: null,
          sequence: 1,
        },
      };
      yield { type: "text-delta", delta: "partial" };
      yield { type: "text-delta", delta: " after cancel" };
    },
    async () => null,
    async (input) => {
      persistedCancelledError = {
        errorCode: input.contentError.code,
        partialAssistantContent: input.partialAssistantContent,
        toolCalls: input.partialState?.toolCalls,
      };
      return null;
    },
    createBillingPort(),
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents(
    {
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      content: "What is in this invoice?",
    },
    {
      shouldCancel: async () => {
        cancelChecks += 1;
        return cancelChecks > 2;
      },
      createErrorMessage: async (input) => {
        persistedCancelledError = {
          errorCode: input.contentError.code,
          partialAssistantContent: input.partialAssistantContent,
          toolCalls: input.partialState?.toolCalls,
        };
        return createAssistantMessageRecord({
          id: "assistant-message-cancelled",
          parentMessageId: null,
        });
      },
    },
  )) {
    events.push(parseSseData(event));
  }

  const cancelledAgentSpan = endedSpans.find(
    (span) => span.spanId === "agent_run" && span.status === "cancelled",
  );
  assert.ok(cancelledAgentSpan);
  assert.deepEqual(cancelledAgentSpan.metadata, {
    cancelled: true,
    cancelReason: "client_requested",
    finishReason: "cancelled",
  });
  assert.equal(
    endedSpans.some(
      (span) => span.spanId === "agent_run" && span.status === "error",
    ),
    false,
  );
  const cancelledTrace = endedTraces.find(
    (trace) => trace.status === "cancelled",
  );
  assert.ok(cancelledTrace);
  assert.equal(cancelledTrace.errorCode, "CLIENT_CANCELLED");
  assert.deepEqual(cancelledTrace.metadata, {
    operation: "chat.stream",
    modelAlias: "test-model",
    profileAlias: "test-profile",
    agentMode: "continue",
    sourceCount: 0,
    effectiveSourceCount: 0,
    mentionedSourceCount: 0,
    effectiveMentionedSourceCount: 0,
    selectedSkillCount: 0,
    preflightThinkingStepCount: 0,
    cancelled: true,
    cancelReason: "client_requested",
    finishReason: "cancelled",
  });
  assert.equal(
    endedTraces.some((trace) => trace.status === "error"),
    false,
  );
  assert.deepEqual(persistedCancelledError, {
    errorCode: "CLIENT_CANCELLED",
    partialAssistantContent: "partial",
    toolCalls: [
      {
        id: "tool-cancelled",
        tool: "validate_demo",
        input: {},
        output: null,
        status: "error",
        latencyMs: null,
        error: "Chat run was cancelled",
        sequence: 1,
      },
    ],
  });
  assert.equal(
    events.find((event) => event.type === "error")?.code,
    "CLIENT_CANCELLED",
  );
});

test("streamThreadEvents honors cancellation after agent outcome before finalization", async () => {
  let finalizeCalled = false;
  let cancelChecks = 0;
  const turnService = createTurnService({
    finalize: async () => {
      finalizeCalled = true;
      return {
        assistantMessage: createAssistantMessageRecord(),
        billing: {
          teamId: "team-1",
          consumedCredits: 1,
          availableCredits: 99,
          consumedThisCycle: 1,
          idempotencyReplayed: false,
        },
      };
    },
  });

  const service = new ContentThreadStreamService(
    turnService as unknown as ConstructorParameters<
      typeof ContentThreadStreamService
    >[0],
    async function* (): AsyncGenerator<DeepAgentTurnEvent> {
      yield { type: "text-delta", delta: "Answer" };
      yield { type: "done", outcome };
    },
    async () => null,
    async () => createAssistantMessageRecord({ id: "assistant-cancelled-1" }),
    createBillingPort(),
  );

  const events: Record<string, unknown>[] = [];
  for await (const event of service.streamThreadEvents(
    {
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      content: "What is in this invoice?",
    },
    {
      shouldCancel: async () => {
        cancelChecks += 1;
        return cancelChecks > 1;
      },
    },
  )) {
    events.push(parseSseData(event));
  }

  assert.equal(finalizeCalled, false);
  assert.equal(
    events.find((event) => event.type === "error")?.code,
    "CLIENT_CANCELLED",
  );
  assert.equal(
    events.some((event) => event.type === "assistant-message"),
    false,
  );
});
