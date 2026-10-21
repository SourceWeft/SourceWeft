import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  written: [] as Record<string, unknown>[],
  existing: null as Record<string, unknown> | null,
}));

vi.mock("../message-repository", () => ({
  findMessageRecord: vi.fn(async () => state.existing),
  createMessageRecord: vi.fn(async (input: Record<string, unknown>) => {
    state.written.push(input.metadata as Record<string, unknown>);
    return { id: "assistant-1", ...input };
  }),
  updateMessageRecord: vi.fn(async (input: Record<string, unknown>) => {
    state.written.push(input.metadata as Record<string, unknown>);
    return { id: input.messageId, ...input };
  }),
}));
vi.mock("../../citations", () => ({
  createCitationRecords: vi.fn(async () => undefined),
  replaceCitationRecords: vi.fn(async () => undefined),
}));
vi.mock("../../workspace", () => ({
  workspaceService: {
    resolveBillingOrganizationId: vi.fn(async () => "team-1"),
  },
}));
vi.mock("../../content/model-gateway-audit", () => ({
  buildGatewayAuditMetadata: vi.fn(() => ({})),
  recordGatewayOperationEvent: vi.fn(async () => undefined),
}));
vi.mock("./cost", () => ({
  computeTurnProviderCost: vi.fn(async () => ({
    providerCostUsd: 0,
    pricingSnapshot: null,
    costSource: "none",
    missingPriceComponents: [],
  })),
}));
vi.mock("../agent/middleware/context-compression", () => ({
  consumeSourceWeftContextCompressionReport: vi.fn(() => null),
}));

import { finalizeThreadTurn } from "./finalizer";
import { tracePartFromReasoningSegment, upsertTracePart } from "./trace-parts";
import type {
  FinalizeThreadTurnInput,
  ModelReasoningSegmentTrace,
} from "./types";

const segments: ModelReasoningSegmentTrace[] = [
  { id: "segment-1", text: "Need to search.", sequence: 1, durationMs: 400 },
  {
    id: "segment-2",
    text: "Found it.",
    sequence: 3,
    phase: "after_tool",
    toolCallId: "search-1",
    tool: "search_sources",
  },
];

function finalizeInput(
  overrides: Partial<FinalizeThreadTurnInput> = {},
): FinalizeThreadTurnInput {
  return {
    prepared: {
      workspace: { id: "workspace-1", organizationId: "team-1" },
      thread: { id: "thread-1" },
      userId: "user-1",
      userMessage: { id: "user-message-1" },
      preflightBilling: [],
      modelAlias: "test-model",
      profileAlias: "default",
      agentMode: "default",
      assistantMessageParentId: "user-message-1",
      reasoningRun: { runId: "run-1", parentRunId: null, base: "" },
    },
    retrieval: null,
    citations: [],
    retrievalCalls: [],
    toolCalls: [],
    thinkingSteps: [],
    reasoning: "Need to search. Found it.",
    reasoningSegments: segments,
    traceParts: segments.reduce(
      (parts, segment) =>
        upsertTracePart(parts, tracePartFromReasoningSegment(segment)),
      [] as ReturnType<typeof upsertTracePart>,
    ),
    renderBlocks: [
      { id: "reasoning-1", type: "reasoning", text: "Need to search." },
    ],
    assistantContent: "answer",
    operation: "chat.stream",
    usage: {},
    finishReason: "stop",
    latencyMs: 10,
    billing: {
      getExecutionState: vi.fn(async () => ({ kind: "unmetered" })),
    },
    ...overrides,
  } as unknown as FinalizeThreadTurnInput;
}

beforeEach(() => {
  state.written = [];
  state.existing = null;
});

test("the finalizer persists reasoning segments and reasoning parts as structure only", async () => {
  await finalizeThreadTurn(finalizeInput());

  const [metadata] = state.written;
  assert.ok(metadata);
  assert.deepEqual(metadata.reasoningSegments, [
    { id: "segment-1", sequence: 1, durationMs: 400 },
    {
      id: "segment-2",
      sequence: 3,
      phase: "after_tool",
      toolCallId: "search-1",
      tool: "search_sources",
    },
  ]);
  const parts = metadata.traceParts as Record<string, unknown>[];
  assert.deepEqual(
    parts.map((part) => `${part.kind}:${part.id}`),
    ["reasoning:segment-1", "reasoning:segment-2"],
  );
  assert.equal(
    parts.some((part) => Object.hasOwn(part, "text")),
    false,
  );
  // The text survives where it is read: the `reasoning` string (continuation
  // base and reasoning CAS) and the render blocks (the UI).
  assert.equal(metadata.reasoning, "Need to search. Found it.");
  assert.deepEqual(metadata.renderBlocks, [
    { id: "reasoning-1", type: "reasoning", text: "Need to search." },
  ]);
  // The in-memory runtime segments keep their text for observability.
  assert.equal(segments[0]?.text, "Need to search.");
});

test("a continuation rewrite drops the legacy segment text of the existing row", async () => {
  state.existing = {
    id: "assistant-1",
    content: "before",
    metadata: {
      reasoning: "Before.",
      reasoningSegments: [{ id: "segment-0", text: "Before.", sequence: 0 }],
      traceParts: [
        {
          id: "segment-0",
          kind: "reasoning",
          order: 0,
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
          text: "Before.",
        },
      ],
    },
  };
  await finalizeThreadTurn(
    finalizeInput({ assistantMessageId: "assistant-1" }),
  );

  const [metadata] = state.written;
  assert.ok(metadata);
  assert.deepEqual(
    (metadata.reasoningSegments as Record<string, unknown>[]).map(
      (segment) => `${segment.sequence}:${segment.id}:${"text" in segment}`,
    ),
    ["0:segment-0:false", "1:segment-1:false", "3:segment-2:false"],
  );
  assert.equal(
    (metadata.traceParts as Record<string, unknown>[]).some((part) =>
      Object.hasOwn(part, "text"),
    ),
    false,
  );
});
