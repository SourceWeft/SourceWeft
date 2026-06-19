import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { BillingSummaryResponse } from "@sourceweft/contracts";
import type { ContentBillingPort } from "../../../content/billing-port";
import type { PreparedThreadTurn } from "../..";
import { handleMessagesStreamChunk } from "./message-stream-handler";
import { createTurnRuntime } from "./turn-runtime";
import type { DeepAgentTurnEvent } from "./events";

const modelBillingMocks = vi.hoisted(() => ({
  meterBillableModelUsage: vi.fn(
    async (input: {
      billing: ContentBillingPort;
      teamId: string;
      workspaceId?: string;
      actorUserId: string;
      feature: string;
      operation: string;
      modelKind: string;
      profileAlias: string;
      modelAlias?: string | null;
      referenceId?: string;
      idempotencyKey?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
      metadata?: Record<string, unknown>;
    }) => {
      const billing = await input.billing.meterConsume(
        input.teamId,
        {
          workspaceId: input.workspaceId,
          feature: input.feature,
          referenceId: input.referenceId,
          idempotencyKey: input.idempotencyKey,
          credits: 1,
          modelKind: input.modelKind,
          operation: input.operation,
          metadata: input.metadata,
        },
        input.actorUserId,
      );
      return {
        billing,
        cost: {
          providerCostUsd: null,
          pricingSnapshot: null,
          costSource: "missing_usage" as const,
          missingPriceComponents: [],
        },
        billedBy: "minimum_credit" as const,
        skipReason: null,
      };
    },
  ),
}));

vi.mock("../../../content/model-billing", () => ({
  meterBillableModelUsage: modelBillingMocks.meterBillableModelUsage,
}));

async function collectMessageStreamEvents(
  input: Parameters<typeof handleMessagesStreamChunk>[0],
) {
  const events: DeepAgentTurnEvent[] = [];
  for await (const event of handleMessagesStreamChunk(input)) {
    events.push(event);
  }
  return events;
}

function createPreparedTurn() {
  return {
    runTraceId: "trace-meter-once",
    thread: { id: "thread-1" },
    userMessage: { id: "message-1" },
    workspace: { id: "workspace-1", organizationId: "team-1" },
    userId: "user-1",
    traceContext: {
      traceId: "trace-meter-once",
      parentSpanId: "agent_run",
    },
    chatProfile: { gatewayConfigId: "gateway-1" },
    profileAlias: "test-profile",
    modelAlias: "test-model",
    providerModel: "test-model",
    llmIdempotencyKey: "thread-stream:message-1:assistant",
  } as unknown as PreparedThreadTurn;
}

function createBilling(): ContentBillingPort {
  const summary = (teamId: string): BillingSummaryResponse => ({
    teamId,
    planFamily: "individual_free",
    billingMode: "enforced",
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
      monthlyBalance: 100,
      addOnBalance: 0,
      reserved: 0,
      consumedThisCycle: 7,
      available: 100,
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
  });

  return {
    getSummary: vi.fn(async (teamId: string) => summary(teamId)),
    meterConsume: vi.fn(async (teamId: string) => ({
      teamId,
      consumedCredits: 1,
      availableCredits: 99,
      consumedThisCycle: 8,
      idempotencyReplayed: false,
    })),
    meterIngestion: vi.fn(async (teamId: string) => ({
      teamId,
      pagesConsumed: 0,
      pagesUsed: 0,
      pagesRemaining: 0,
      idempotencyReplayed: false,
    })),
  };
}

test("messages stream handler meters once at terminal finish using latest usage", async () => {
  modelBillingMocks.meterBillableModelUsage.mockClear();
  const prepared = createPreparedTurn();
  const runtime = createTurnRuntime({ prepared });
  const billing = createBilling();

  const firstEvents = await collectMessageStreamEvents({
    payload: [
      {
        id: "generation-1",
        role: "assistant",
        content: "Hel",
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 1,
          total_tokens: 11,
        },
      },
    ],
    billing,
    commandSuccessCriteria: { kind: "none" },
    prepared,
    runtime,
    suppressModelReasoning: false,
  });
  const secondEvents = await collectMessageStreamEvents({
    payload: [
      {
        id: "generation-1",
        role: "assistant",
        content: "lo",
        response_metadata: { finish_reason: "stop" },
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
        },
      },
    ],
    billing,
    commandSuccessCriteria: { kind: "none" },
    prepared,
    runtime,
    suppressModelReasoning: false,
  });

  assert.equal(modelBillingMocks.meterBillableModelUsage.mock.calls.length, 1);
  const meteredUsage =
    modelBillingMocks.meterBillableModelUsage.mock.calls[0]?.[0].usage;
  assert.equal(meteredUsage?.inputTokens, 10);
  assert.equal(meteredUsage?.outputTokens, 2);
  assert.equal(meteredUsage?.totalTokens, 12);
  assert.equal(runtime.usage?.inputTokens, 10);
  assert.equal(runtime.usage?.outputTokens, 2);
  assert.equal(runtime.usage?.totalTokens, 12);
  assert.equal(firstEvents.some((event) => event.type === "billing"), false);
  assert.equal(
    secondEvents.filter((event) => event.type === "billing").length,
    1,
  );
});

test("messages stream handler treats non-stop finish reasons as terminal", async () => {
  modelBillingMocks.meterBillableModelUsage.mockClear();
  const prepared = createPreparedTurn();
  const runtime = createTurnRuntime({ prepared });
  const billing = createBilling();

  const events = await collectMessageStreamEvents({
    payload: [
      {
        id: "generation-1",
        role: "assistant",
        content: "lo",
        response_metadata: { finishReason: "tool_calls" },
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
        },
      },
    ],
    billing,
    commandSuccessCriteria: { kind: "none" },
    prepared,
    runtime,
    suppressModelReasoning: false,
  });

  assert.equal(modelBillingMocks.meterBillableModelUsage.mock.calls.length, 1);
  assert.equal(
    events.filter((event) => event.type === "billing").length,
    1,
  );
});
