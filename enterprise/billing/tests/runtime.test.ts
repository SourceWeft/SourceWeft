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

for (const modelKind of ["embedding", "rerank"]) {
  test(`${modelKind} preserves the existing no-cost-lookup billing policy`, async () => {
    const store = new MemoryBillingStore();
    const runtime = createBillingRuntime(
      new BillingService(store, runtimeConfig, noopProvider),
    );
    const result = await runtime.settleModelUsage({
      teamId: "t",
      actorUserId: "u",
      feature: "retrieval",
      operation: "retrieval",
      modelKind,
      profileAlias: "default",
      cost: async () => {
        throw new Error(
          "Non-user-billed work must not need a billing price lookup",
        );
      },
    });
    assert.deepEqual(result, {
      status: "skipped",
      reason: "model_kind_not_user_billed",
    });
    assert.equal(store.ledgers.length, 0);
  });
}

test("execution state reports ingestion-page admission exactly when settlement would reject", async () => {
  const store = new MemoryBillingStore();
  const runtime = createBillingRuntime(
    new BillingService(store, runtimeConfig, noopProvider),
  );
  const initial = await runtime.getExecutionState("team_1", "user_1");
  assert.equal(initial.kind, "metered");
  if (initial.kind !== "metered") throw new Error("Expected metered state");
  assert.deepEqual(initial.ingestionPages, {
    enforced: true,
    available: 300,
    cycleCapacity: 300,
  });

  await runtime.meterIngestion(
    "team_1",
    {
      pages: 300,
      feature: "ingestion",
      referenceId: "source:1",
      idempotencyKey: "source-index:1",
    },
    "user_1",
  );
  const drained = await runtime.getExecutionState("team_1", "user_1");
  if (drained.kind !== "metered") throw new Error("Expected metered state");
  assert.equal(drained.ingestionPages.available, 0);
  assert.equal(drained.ingestionPages.cycleCapacity, 300);
  await assert.rejects(
    runtime.meterIngestion(
      "team_1",
      {
        pages: 1,
        feature: "ingestion",
        referenceId: "source:2",
        idempotencyKey: "source-index:2",
      },
      "user_1",
    ),
    { code: "PAGES_LIMIT_EXCEEDED" },
  );

  for (const config of [
    { ...runtimeConfig, mode: "shadow" as const },
    { ...runtimeConfig, enforceLimits: false },
    { ...runtimeConfig, pagesEnabled: false },
  ]) {
    const relaxed = createBillingRuntime(
      new BillingService(new MemoryBillingStore(), config, noopProvider),
    );
    const state = await relaxed.getExecutionState("team_1", "user_1");
    if (state.kind !== "metered") throw new Error("Expected metered state");
    assert.equal(state.ingestionPages.enforced, false);
  }
});
