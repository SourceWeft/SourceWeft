import { adaptBillingTestPort } from "../../../test/billing-runtime";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { BillingSummaryResponse } from "@sourceweft/contracts";
import type { LegacyBillingTestPort as ContentBillingPort } from "../../../test/billing-runtime";
import type { ModelUsageContext } from "./context";
import { deriveIdempotencyKey, openBillingScope } from "./scope";
import type { ScheduleProviderCostReconciliationFn } from "./settle";

function createBilling(billingMode = "enforced"): ContentBillingPort {
  return adaptBillingTestPort({
    getSummary: vi.fn(
      async (teamId: string) =>
        ({
          teamId,
          billingMode,
          credits: { available: 500, consumedThisCycle: 0 },
        }) as unknown as BillingSummaryResponse,
    ),
    meterConsume: vi.fn(async (teamId: string) => ({
      teamId,
      consumedCredits: 3,
      availableCredits: 497,
      consumedThisCycle: 3,
      idempotencyReplayed: false,
    })),
    meterIngestion: vi.fn(),
  }) as unknown as ContentBillingPort;
}

function billedContext(
  overrides: Partial<ModelUsageContext> = {},
): ModelUsageContext {
  return {
    teamId: "team_1",
    workspaceId: "ws_1",
    actorUserId: "user_1",
    feature: "chat",
    intent: { mode: "billed" },
    scopeKind: "thread-turn",
    scopeId: "trace_1",
    ...overrides,
  };
}

function meterUsageStub(consumedCredits = 3) {
  return vi.fn(async () => ({
    billing: {
      teamId: "team_1",
      consumedCredits,
      availableCredits: 500 - consumedCredits,
      consumedThisCycle: consumedCredits,
      idempotencyReplayed: false,
    },
    cost: {
      providerCostUsd: 0.01,
      pricingSnapshot: null,
      costSource: "price_book",
      missingPriceComponents: [],
    },
    billedBy: "provider_cost" as const,
    skipReason: null,
  }));
}

const chatOptions = {
  operation: "chat.complete",
  modelKind: "chat" as const,
  profileAlias: "default-chat",
  gatewayConfigId: "gw_1",
};

test("an explicit idempotency key always wins over the derived form", () => {
  assert.equal(
    deriveIdempotencyKey({
      explicitKey: "thread-title:msg_1",
      scopeId: "trace_1",
      operation: "chat.title",
      seq: 4,
    }),
    "thread-title:msg_1",
  );
});

test("derived keys are stable per scope and distinct per call", () => {
  const first = deriveIdempotencyKey({
    scopeId: "job_1",
    operation: "chat.complete",
    seq: 1,
  });
  const second = deriveIdempotencyKey({
    scopeId: "job_1",
    operation: "chat.complete",
    seq: 2,
  });

  assert.equal(first, "job_1:chat.complete:0:1");
  assert.notEqual(first, second);
});

test("derived keys separate distinct scope keys", () => {
  const slideOne = deriveIdempotencyKey({
    scopeId: "job_1",
    operation: "tts.speech",
    scopeKey: 1,
    seq: 1,
  });
  const slideTwo = deriveIdempotencyKey({
    scopeId: "job_1",
    operation: "tts.speech",
    scopeKey: 2,
    seq: 1,
  });

  assert.notEqual(slideOne, slideTwo);
});

test("settling a billed call records a metered trace and spends scope budget", async () => {
  const billing = createBilling();
  const meterUsage = meterUsageStub(3);
  const scope = openBillingScope({
    context: billedContext(),
    billing,
    billingMode: "enforced",
    availableCredits: 500,
    meterUsage: meterUsage as never,
  });

  const trace = await scope.settle({
    options: chatOptions,
    usage: { inputTokens: 10, outputTokens: 4 },
  });

  assert.equal(trace?.billingStatus, "metered");
  assert.equal(trace?.consumedCredits, 3);
  assert.equal(scope.meteredCalls().length, 1);
  assert.equal(scope.remainingCredits(), 497);
});

test("a provider receipt observation schedules reconciliation with the billing key", async () => {
  const scheduleReconciliation = vi.fn<ScheduleProviderCostReconciliationFn>(
    async () => null,
  );
  const scope = openBillingScope({
    context: billedContext(),
    billing: createBilling(),
    billingMode: "enforced",
    availableCredits: 500,
    meterUsage: meterUsageStub(3) as never,
    scheduleReconciliation,
  });
  const observation = {
    traceId: "trace_1",
    spanId: "span_1",
    identity: {
      modelAlias: "chat-default",
      provider: "orcarouter",
      requestedProviderModel: "orcarouter/auto",
      providerRequestId: "orca-request-1",
    },
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    cost: {
      currency: "USD" as const,
      inlineUsd: 0.01,
      effectiveUsd: 0.01,
      source: "provider_inline" as const,
      status: "inline" as const,
    },
    provenance: {},
  };

  await scope.settle({
    options: chatOptions,
    usage: observation.usage,
    observation,
  });

  assert.equal(scheduleReconciliation.mock.calls.length, 1);
  assert.equal(
    scheduleReconciliation.mock.calls[0]?.[0]?.originalBillingIdempotencyKey,
    "trace_1:chat.complete:0:1",
  );
  assert.equal(
    scheduleReconciliation.mock.calls[0]?.[0]?.observation,
    observation,
  );
});

test("empty usage settles to nothing and never reaches the meter", async () => {
  const billing = createBilling();
  const meterUsage = meterUsageStub();
  const scope = openBillingScope({
    context: billedContext(),
    billing,
    billingMode: "enforced",
    availableCredits: 500,
    meterUsage: meterUsage as never,
  });

  const trace = await scope.settle({ options: chatOptions, usage: undefined });

  assert.equal(trace, null);
  assert.equal(meterUsage.mock.calls.length, 0);
  assert.equal(scope.meteredCalls().length, 0);
});

// The whole point of the covered intent: cost is observed, credits are not spent.
test("a covered call is traced but never metered", async () => {
  const billing = createBilling();
  const meterUsage = meterUsageStub();
  const scope = openBillingScope({
    context: billedContext({
      intent: { mode: "covered", coveredBy: "model_kind_not_user_billed" },
      feature: "retrieval",
    }),
    billing,
    billingMode: "enforced",
    availableCredits: 500,
    meterUsage: meterUsage as never,
  });

  const trace = await scope.settle({
    options: { ...chatOptions, operation: "rerank.rank", modelKind: "rerank" },
    usage: { inputTokens: 120 },
  });

  assert.equal(trace?.billingStatus, "covered");
  assert.equal(trace?.coveredBy, "model_kind_not_user_billed");
  assert.equal(trace?.consumedCredits, 0);
  assert.equal(meterUsage.mock.calls.length, 0);
  assert.equal(
    (billing.meterConsume as ReturnType<typeof vi.fn>).mock.calls.length,
    0,
  );
  assert.equal(scope.remainingCredits(), 500);
});

test("enforced mode rethrows a metering failure with the trace attached", async () => {
  const billing = createBilling("enforced");
  const meterUsage = vi.fn(async () => {
    throw new Error("ledger unavailable");
  });
  const scope = openBillingScope({
    context: billedContext(),
    billing,
    billingMode: "enforced",
    availableCredits: 500,
    meterUsage: meterUsage as never,
  });

  const error = await scope
    .settle({ options: chatOptions, usage: { inputTokens: 10 } })
    .then(() => null)
    .catch((thrown: unknown) => thrown);

  assert.ok(error instanceof Error);
  assert.equal((error as { code?: string }).code, "LLM_CALL_METERING_FAILED");
  const trace = (error as { meteredLlmCall?: { billingStatus?: string } })
    .meteredLlmCall;
  assert.equal(trace?.billingStatus, "meter_failed");
});

test("non-enforced mode swallows a metering failure and returns the trace", async () => {
  const billing = createBilling("shadow");
  const meterUsage = vi.fn(async () => {
    throw new Error("ledger unavailable");
  });
  const scope = openBillingScope({
    context: billedContext(),
    billing,
    billingMode: "shadow",
    availableCredits: 500,
    meterUsage: meterUsage as never,
  });

  const trace = await scope.settle({
    options: chatOptions,
    usage: { inputTokens: 10 },
  });

  assert.equal(trace?.billingStatus, "meter_failed");
  assert.equal(trace?.consumedCredits, 0);
});

// Fail closed: if billing state cannot be read at all, assume enforced rather
// than handing out free usage.
test("an unreadable billing summary is treated as enforced", async () => {
  const billing = adaptBillingTestPort({
    getSummary: vi.fn(async () => {
      throw new Error("billing down");
    }),
    meterConsume: vi.fn(),
    meterIngestion: vi.fn(),
  }) as unknown as ContentBillingPort;

  const scope = openBillingScope({
    context: billedContext(),
    billing,
    billingMode: "shadow",
    availableCredits: 500,
    meterUsage: meterUsageStub() as never,
  });

  const error = await scope
    .settle({ options: chatOptions, usage: { inputTokens: 10 } })
    .then(() => null)
    .catch((thrown: unknown) => thrown);

  assert.ok(error instanceof Error);
  assert.equal((error as { code?: string }).code, "LLM_CALL_METERING_FAILED");
});
