import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { BillingSummaryResponse } from "@sourceweft/contracts";
import type { ContentBillingPort } from "../../../content/billing-port";
import type { PreparedThreadTurn } from "../..";
import {
  flushPendingLlmCallUsage,
  meterLlmCallUsage,
  observeLlmCallUsage,
} from "./llm-call-billing";
import { createTurnRuntime } from "./turn-runtime";

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
        providerCostUsd?: number;
        providerCostSource?: string;
        costDetails?: Record<string, number>;
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
          providerCostUsd: input.usage?.providerCostUsd ?? 0,
          platformCostUsd: 0,
          modelKind: input.modelKind,
          operation: input.operation,
          metadata: {
            billedBy: "provider_cost",
            costSource: "provider_actual",
            missingPriceComponents: [],
            modelAlias: input.modelAlias ?? null,
            profileAlias: input.profileAlias,
            pricingSnapshot: null,
            providerActualCostUsd: input.usage?.providerCostUsd ?? null,
            providerCostSource: input.usage?.providerCostSource ?? null,
            providerCostDetails: input.usage?.costDetails ?? null,
            ...(input.metadata ?? {}),
          },
        },
        input.actorUserId,
      );
      return {
        billing,
        cost: {
          providerCostUsd: input.usage?.providerCostUsd ?? null,
          pricingSnapshot: null,
          costSource: "provider_actual" as const,
          missingPriceComponents: [],
        },
        billedBy: "provider_cost" as const,
        skipReason: null,
      };
    },
  ),
}));

vi.mock("../../../content/model-billing", () => ({
  meterBillableModelUsage: modelBillingMocks.meterBillableModelUsage,
}));

function createPreparedTurn(
  overrides: Partial<PreparedThreadTurn> = {},
): PreparedThreadTurn {
  return {
    userId: "user-1",
    workspace: {
      id: "workspace-1",
      organizationId: "team-1",
    },
    thread: {
      id: "thread-1",
    },
    userMessage: {
      id: "message-1",
    },
    runTraceId: "trace-1",
    traceContext: {
      traceId: "trace-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      messageId: "message-1",
      sessionId: "thread-1",
      feature: "chat",
    },
    chatProfile: {
      gatewayConfigId: "gateway-1",
    },
    profileAlias: "chat-default",
    modelAlias: "gpt-test",
    providerModel: "provider-gpt-test",
    llmIdempotencyKey: "thread-stream:message-1:assistant",
    ...overrides,
  } as PreparedThreadTurn;
}

function createBilling(
  overrides: Partial<ContentBillingPort> = {},
): ContentBillingPort {
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
      consumedCredits: 5,
      availableCredits: 95,
      consumedThisCycle: 12,
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
  };
}

test("meterLlmCallUsage writes a traceable consume ledger for provider actual usage", async () => {
  const billing = createBilling();
  const prepared = createPreparedTurn();

  const trace = await meterLlmCallUsage({
    billing,
    prepared,
    usage: {
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      providerCostUsd: 0.0025,
      providerCostSource: "usage.cost",
    },
    operation: "chat.stream",
    callIndex: 1,
    spanId: "agent_run",
    generationId: "generation-1",
  });

  assert.ok(trace);
  assert.equal(trace.id, "llm-call:trace-1:generation-1");
  assert.equal(trace.idempotencyKey, "llm-call:trace-1:generation-1");
  assert.equal(trace.billingStatus, "metered");
  assert.equal(trace.billedBy, "provider_cost");
  assert.equal(trace.costSource, "provider_actual");
  assert.equal(trace.consumedCredits, 5);

  const meterConsume = vi.mocked(billing.meterConsume);
  assert.equal(meterConsume.mock.calls.length, 1);
  assert.deepEqual(meterConsume.mock.calls[0]?.[1], {
    workspaceId: "workspace-1",
    feature: "chat",
    referenceId: "thread:thread-1:message:message-1:llm-call:1",
    idempotencyKey: "llm-call:trace-1:generation-1",
    providerCostUsd: 0.0025,
    platformCostUsd: 0,
    modelKind: "chat",
    operation: "chat.stream",
    metadata: {
      billedBy: "provider_cost",
      costSource: "provider_actual",
      missingPriceComponents: [],
      modelAlias: "gpt-test",
      profileAlias: "chat-default",
      pricingSnapshot: null,
      providerActualCostUsd: 0.0025,
      providerCostSource: "usage.cost",
      providerCostDetails: null,
      threadId: "thread-1",
      messageId: "message-1",
      userMessageId: "message-1",
      runId: "trace-1",
      traceId: "trace-1",
      spanId: "agent_run",
      generationId: "generation-1",
      llmCallId: "llm-call:trace-1:generation-1",
      llmCallIndex: 1,
      operation: "chat.stream",
      catalogModelAlias: null,
      catalogProfileAlias: null,
      provider: null,
      providerModel: "provider-gpt-test",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        providerCostUsd: 0.0025,
        providerCostSource: "usage.cost",
      },
      routeDecision: null,
      baseIdempotencyKey: "thread-stream:message-1:assistant",
    },
  });
});

test("meterLlmCallUsage records meter_failed and continues in shadow mode", async () => {
  const billing = createBilling({
    getSummary: vi.fn(async (teamId: string): Promise<BillingSummaryResponse> => ({
      ...(await createBilling().getSummary(teamId)),
      billingMode: "shadow",
    })),
    meterConsume: vi.fn(async () => {
      throw new Error("ledger write failed");
    }),
  });

  const trace = await meterLlmCallUsage({
    billing,
    prepared: createPreparedTurn(),
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      providerCostUsd: 0.001,
    },
    operation: "chat.stream",
    callIndex: 1,
    generationId: "generation-failed",
  });

  assert.ok(trace);
  assert.equal(trace.billingStatus, "meter_failed");
  assert.equal(trace.consumedCredits, 0);
  assert.equal(trace.idempotencyKey, "llm-call:trace-1:generation-failed");
  assert.equal(trace.error, "ledger write failed");
  assert.equal(trace.metadata?.billingMode, "shadow");
});

test("meterLlmCallUsage throws after recording meter_failed in enforced mode", async () => {
  const billing = createBilling({
    meterConsume: vi.fn(async () => {
      throw new Error("ledger write failed");
    }),
  });

  await assert.rejects(
    () =>
      meterLlmCallUsage({
        billing,
        prepared: createPreparedTurn(),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          providerCostUsd: 0.001,
        },
        operation: "chat.stream",
        callIndex: 1,
        generationId: "generation-failed",
      }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "LLM_CALL_METERING_FAILED",
      );
      assert.equal(
        (error as { meteredLlmCall?: { billingStatus?: string } })
          .meteredLlmCall?.billingStatus,
        "meter_failed",
      );
      return true;
    },
  );
});

test("pending LLM call usage flushes once at a boundary with latest usage", async () => {
  const billing = createBilling();
  const prepared = createPreparedTurn();
  const runtime = createTurnRuntime({ prepared });

  observeLlmCallUsage({
    runtime,
    operation: "chat.stream",
    generationId: "generation-boundary",
    spanId: "agent_run",
    usage: {
      inputTokens: 20,
      outputTokens: 1,
      totalTokens: 21,
      providerCostUsd: 0.001,
    },
  });
  observeLlmCallUsage({
    runtime,
    operation: "chat.stream",
    generationId: "generation-boundary",
    spanId: "agent_run",
    usage: {
      inputTokens: 20,
      outputTokens: 3,
      totalTokens: 23,
      providerCostUsd: 0.003,
    },
  });

  const events = [];
  for await (const event of flushPendingLlmCallUsage({
    runtime,
    billing,
    prepared,
    reason: "tool_start",
  })) {
    events.push(event);
  }
  for await (const event of flushPendingLlmCallUsage({
    runtime,
    billing,
    prepared,
    reason: "final_outcome",
  })) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "billing");
  assert.equal(runtime.usage?.inputTokens, 20);
  assert.equal(runtime.usage?.outputTokens, 3);
  assert.equal(runtime.usage?.totalTokens, 23);
  assert.equal(runtime.usage?.providerCostUsd, 0.003);
  assert.equal(vi.mocked(billing.meterConsume).mock.calls.length, 1);
  const meteredUsage = runtime.collectMeteredLlmCalls()[0]?.usage;
  assert.equal(meteredUsage?.inputTokens, 20);
  assert.equal(meteredUsage?.outputTokens, 3);
  assert.equal(meteredUsage?.totalTokens, 23);
  assert.equal(meteredUsage?.providerCostUsd, 0.003);
});
