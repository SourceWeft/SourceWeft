import assert from "node:assert/strict";
import { test } from "vitest";
import { createBillingRuntime } from "../src/server/runtime";
import { BillingService } from "../src/server/service";
import { createBilling } from "../src/server/index";
import {
  MemoryBillingStore,
  noopProvider,
  runtimeConfig,
} from "./test-fixtures";

test("commercial factory rejects missing host services rather than selecting a core runtime", () => {
  assert.throws(
    () =>
      createBilling({
        config: runtimeConfig,
        store: new MemoryBillingStore(),
        host: undefined as never,
        alerts: undefined as never,
      }),
    { code: "BILLING_HOST_MISSING" },
  );
});

test("runtime settles an explicit provider cost once and preserves the BYOK and minimum-charge policy", async () => {
  const store = new MemoryBillingStore();
  const runtime = createBillingRuntime(
    new BillingService(store, runtimeConfig, noopProvider),
  );
  const input = {
    teamId: "team_1",
    actorUserId: "user_1",
    feature: "chat",
    operation: "chat",
    modelKind: "chat",
    profileAlias: "default",
    idempotencyKey: "model_1",
    cost: {
      providerCostUsd: 0.01,
      costSource: "provider_actual",
      missingPriceComponents: [],
      pricingSnapshot: null,
    },
  };
  const result = await runtime.settleModelUsage(input);
  assert.equal(result.status, "settled");
  if (result.status !== "settled")
    throw new Error("Expected a real ledger settlement");
  assert.equal(result.billing.consumedCredits, 10);
  const replay = await runtime.settleModelUsage(input);
  assert.equal(replay.status, "settled");
  if (replay.status !== "settled")
    throw new Error("Expected an idempotent settlement");
  assert.equal(replay.billing.idempotencyReplayed, true);

  const beforeByok = store.ledgers.length;
  assert.deepEqual(
    await runtime.settleModelUsage({
      ...input,
      executionMode: "BYOK",
      idempotencyKey: "byok_1",
      cost: { ...input.cost, providerCostUsd: 0, costSource: "byok" },
    }),
    { status: "skipped", reason: "byok" },
  );
  assert.equal(store.ledgers.length, beforeByok);
  const minimum = await runtime.settleModelUsage({
    ...input,
    idempotencyKey: "minimum_1",
    cost: {
      ...input.cost,
      providerCostUsd: null,
      costSource: "missing_provider_actual",
    },
  });
  assert.equal(minimum.status, "settled");
  if (minimum.status !== "settled")
    throw new Error("Expected the existing minimum-charge policy");
  assert.equal(minimum.billedBy, "minimum_credit");
  assert.equal(minimum.billing.consumedCredits, 1);
});
