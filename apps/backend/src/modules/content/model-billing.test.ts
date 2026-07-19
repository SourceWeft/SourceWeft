import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { BillingSummaryResponse } from "@sourceweft/contracts";
import type { ContentBillingPort } from "./billing-port";
import type { ProviderCostResult } from "./provider-cost";

const providerCostMocks = vi.hoisted(() => ({
  computeProviderCost: vi.fn(),
}));

// provider-cost.ts imports `db` at module scope, so it must be mocked wholesale
// rather than exercised against a live database.
vi.mock("./provider-cost", () => ({
  computeProviderCost: providerCostMocks.computeProviderCost,
}));

const { meterBillableModelUsage } = await import("./model-billing");

function createBilling(): ContentBillingPort {
  return {
    getSummary: vi.fn(
      async (teamId: string) =>
        ({
          teamId,
          credits: { available: 1000, consumedThisCycle: 0 },
        }) as unknown as BillingSummaryResponse,
    ),
    meterConsume: vi.fn(async (teamId: string) => ({
      teamId,
      consumedCredits: 1,
      availableCredits: 999,
      consumedThisCycle: 1,
      idempotencyReplayed: false,
    })),
    meterIngestion: vi.fn(async (teamId: string) => ({
      teamId,
      pagesConsumed: 0,
      pagesUsed: 0,
      pagesRemaining: 0,
      idempotencyReplayed: false,
    })),
  } as unknown as ContentBillingPort;
}

const byokCost: ProviderCostResult = {
  providerCostUsd: 0,
  pricingSnapshot: null,
  costSource: "byok",
  missingPriceComponents: [],
};

function baseInput(billing: ContentBillingPort) {
  return {
    billing,
    teamId: "team_1",
    workspaceId: "ws_1",
    actorUserId: "user_1",
    feature: "chat",
    operation: "chat.complete",
    modelKind: "chat" as const,
    gatewayConfigId: "gw_1",
    profileAlias: "default-chat",
  };
}

beforeEach(() => {
  providerCostMocks.computeProviderCost.mockReset();
});

test("skips billing when BYOK is signalled by the request execution mode", async () => {
  providerCostMocks.computeProviderCost.mockResolvedValue(byokCost);
  const billing = createBilling();

  const result = await meterBillableModelUsage({
    ...baseInput(billing),
    llm: { executionMode: "BYOK" },
  });

  assert.equal(result.billedBy, "skipped");
  assert.equal(result.skipReason, "byok");
  assert.equal(result.billing.consumedCredits, 0);
  assert.equal((billing.meterConsume as ReturnType<typeof vi.fn>).mock.calls.length, 0);
});

// Regression: computeProviderCost also classifies BYOK from the
// modelGatewayConfigs.isBYOK DB flag without the caller setting executionMode.
// That path used to fall through to the 1-credit minimum floor and overcharge.
test("skips billing when BYOK comes from the gateway config flag alone", async () => {
  providerCostMocks.computeProviderCost.mockResolvedValue(byokCost);
  const billing = createBilling();

  const result = await meterBillableModelUsage(baseInput(billing));

  assert.equal(result.billedBy, "skipped");
  assert.equal(result.skipReason, "byok");
  assert.equal(result.billing.consumedCredits, 0);
  assert.equal((billing.meterConsume as ReturnType<typeof vi.fn>).mock.calls.length, 0);
});

test("still applies the minimum credit floor when the price is merely missing", async () => {
  providerCostMocks.computeProviderCost.mockResolvedValue({
    providerCostUsd: 0,
    pricingSnapshot: null,
    costSource: "missing_or_zero_price",
    missingPriceComponents: [],
  } satisfies ProviderCostResult);
  const billing = createBilling();

  const result = await meterBillableModelUsage(baseInput(billing));

  assert.equal(result.billedBy, "minimum_credit");
  assert.equal(result.skipReason, null);

  const meterConsume = billing.meterConsume as ReturnType<typeof vi.fn>;
  assert.equal(meterConsume.mock.calls.length, 1);
  assert.equal(meterConsume.mock.calls[0]?.[1]?.credits, 1);
});

test("bills real provider cost when one is available", async () => {
  providerCostMocks.computeProviderCost.mockResolvedValue({
    providerCostUsd: 0.042,
    pricingSnapshot: null,
    costSource: "price_book",
    missingPriceComponents: [],
  } satisfies ProviderCostResult);
  const billing = createBilling();

  const result = await meterBillableModelUsage(baseInput(billing));

  assert.equal(result.billedBy, "provider_cost");

  const meterConsume = billing.meterConsume as ReturnType<typeof vi.fn>;
  assert.equal(meterConsume.mock.calls.length, 1);
  assert.equal(meterConsume.mock.calls[0]?.[1]?.providerCostUsd, 0.042);
});

test("skips embedding and rerank kinds without computing cost", async () => {
  const billing = createBilling();

  const result = await meterBillableModelUsage({
    ...baseInput(billing),
    modelKind: "embedding",
  });

  assert.equal(result.billedBy, "skipped");
  assert.equal(result.skipReason, "model_kind_not_user_billed");
  assert.equal(providerCostMocks.computeProviderCost.mock.calls.length, 0);
  assert.equal((billing.meterConsume as ReturnType<typeof vi.fn>).mock.calls.length, 0);
});
