import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createCoreBillingRuntime } from "../../billing-host/core";
const mocks = vi.hoisted(() => ({ computeProviderCost: vi.fn() }));
vi.mock("./provider-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-cost")>()),
  computeProviderCost: mocks.computeProviderCost,
}));
const { meterBillableModelUsage } = await import("./model-billing");
const cost = {
  providerCostUsd: 0.042,
  costSource: "price_book",
  pricingSnapshot: null,
  missingPriceComponents: [],
};
const input = {
  teamId: "team_1",
  actorUserId: "user_1",
  workspaceId: "ws_1",
  feature: "chat",
  operation: "chat.complete",
  modelKind: "chat" as const,
  profileAlias: "default-chat",
  gatewayConfigId: "gw_1",
};
test("core preserves observed cost facts without inventing a billing balance", async () => {
  mocks.computeProviderCost.mockResolvedValue(cost);
  const result = await meterBillableModelUsage({
    ...input,
    billing: createCoreBillingRuntime(),
  });
  assert.equal(result.cost.providerCostUsd, 0.042);
  assert.equal(result.billing, undefined);
  assert.equal(result.skipReason, "billing_not_installed");
});
test("the host delegates charging with actor, provider identity and price-book restrictions", async () => {
  mocks.computeProviderCost.mockResolvedValue(cost);
  const billing = createCoreBillingRuntime();
  const settle = vi.spyOn(billing, "settleModelUsage");
  await meterBillableModelUsage({
    ...input,
    billing,
    llm: { executionMode: "BYOK" },
    allowPriceBookFallback: false,
  });
  assert.equal(
    mocks.computeProviderCost.mock.lastCall?.[0].allowPriceBookFallback,
    false,
  );
  assert.equal(settle.mock.lastCall?.[0].actorUserId, "user_1");
  assert.equal(settle.mock.lastCall?.[0].executionMode, "BYOK");
  assert.equal(typeof settle.mock.lastCall?.[0].cost, "function");
});
test("a settlement failure is not reclassified as an unmetered core request", async () => {
  mocks.computeProviderCost.mockResolvedValue(cost);
  const billing = createCoreBillingRuntime();
  vi.spyOn(billing, "settleModelUsage").mockRejectedValue(
    new Error("ledger unavailable"),
  );
  await assert.rejects(
    meterBillableModelUsage({ ...input, billing }),
    /ledger unavailable/,
  );
});
test("the ledger's provider facts come from the call's observed cost", async () => {
  mocks.computeProviderCost.mockResolvedValue(cost);
  const billing = createCoreBillingRuntime();
  const settle = vi.spyOn(billing, "settleModelUsage");
  const observed = {
    currency: "USD" as const,
    inlineUsd: 0.0009,
    effectiveUsd: 0.0009,
    source: "provider_inline" as const,
    status: "inline" as const,
  };
  await meterBillableModelUsage({
    ...input,
    billing,
    usage: { inputTokens: 11, outputTokens: 7 },
    cost: observed,
  });
  assert.deepEqual(mocks.computeProviderCost.mock.lastCall?.[0].cost, observed);
  assert.equal(settle.mock.lastCall?.[0].providerActualCostUsd, 0.0009);
  assert.equal(settle.mock.lastCall?.[0].providerCostSource, "provider_inline");
  assert.equal(settle.mock.lastCall?.[0].providerCostDetails, undefined);
});
test("a fee without a total is not presented to the ledger as the actual cost", async () => {
  mocks.computeProviderCost.mockResolvedValue(cost);
  const billing = createCoreBillingRuntime();
  const settle = vi.spyOn(billing, "settleModelUsage");
  await meterBillableModelUsage({
    ...input,
    billing,
    usage: { inputTokens: 11, outputTokens: 7 },
    cost: {
      currency: "USD",
      inlineUsd: 0.00001,
      source: "provider_inline",
      status: "estimated",
    },
  });
  assert.equal(settle.mock.lastCall?.[0].providerActualCostUsd, undefined);
});
