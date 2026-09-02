import assert from "node:assert/strict";
import { test } from "vitest";
import { BillingAccountService } from "./account-service";
import { BillingUsageService } from "./usage-service";
import { type BillingRuntimeConfig } from "./types";
import { runtimeConfig, MemoryBillingStore } from "./test-fixtures";

test("provider receipt reconciliation appends an idempotent extra credit adjustment", async () => {
  const store = new MemoryBillingStore();
  const accountService = new BillingAccountService(store, runtimeConfig);
  const usageService = new BillingUsageService(
    store,
    runtimeConfig,
    accountService,
  );

  await usageService.meterConsume(
    "team_1",
    {
      providerCostUsd: 0.01,
      feature: "chat",
      idempotencyKey: "model-call-1",
    },
    "user_1",
  );
  const first = await usageService.reconcileModelProviderCost({
    teamId: "team_1",
    actorUserId: "user_1",
    workspaceId: "workspace_1",
    feature: "chat",
    originalIdempotencyKey: "model-call-1",
    reconciliationIdempotencyKey: "provider-cost-reconcile:generation-1:v1",
    generationId: "generation-1",
    provider: "orcarouter",
    providerRequestId: "orca-request-1",
    settledProviderCostUsd: 0.02,
  });
  const replay = await usageService.reconcileModelProviderCost({
    teamId: "team_1",
    actorUserId: "user_1",
    workspaceId: "workspace_1",
    feature: "chat",
    originalIdempotencyKey: "model-call-1",
    reconciliationIdempotencyKey: "provider-cost-reconcile:generation-1:v1",
    generationId: "generation-1",
    provider: "orcarouter",
    providerRequestId: "orca-request-1",
    settledProviderCostUsd: 0.02,
  });
  const usage = await usageService.getUsage("team_1", "user_1");

  assert.deepEqual(first, { adjustedCredits: -10, idempotencyReplayed: false });
  assert.deepEqual(replay, { adjustedCredits: -10, idempotencyReplayed: true });
  assert.equal(store.account?.monthlyCreditsBalance, 2980);
  const reconciliationEntries = store.ledgers.filter((entry) =>
    entry.idempotencyKey?.includes("provider-cost-reconcile"),
  );
  assert.equal(reconciliationEntries.length, 1);
  assert.equal(reconciliationEntries[0]?.eventType, "consume");
  assert.equal(reconciliationEntries[0]?.delta, -10);
  assert.equal(usage.totals.creditsConsumed, 20);
});

test("provider receipt reconciliation refunds the original consumed bucket", async () => {
  const store = new MemoryBillingStore();
  const accountService = new BillingAccountService(store, runtimeConfig);
  const usageService = new BillingUsageService(
    store,
    runtimeConfig,
    accountService,
  );

  await usageService.meterConsume(
    "team_1",
    {
      providerCostUsd: 0.02,
      feature: "chat",
      idempotencyKey: "model-call-2",
    },
    "user_1",
  );
  const result = await usageService.reconcileModelProviderCost({
    teamId: "team_1",
    actorUserId: "user_1",
    feature: "chat",
    originalIdempotencyKey: "model-call-2",
    reconciliationIdempotencyKey: "provider-cost-reconcile:generation-2:v1",
    generationId: "generation-2",
    provider: "orcarouter",
    providerRequestId: "orca-request-2",
    settledProviderCostUsd: 0.01,
  });
  const usage = await usageService.getUsage("team_1", "user_1");

  assert.deepEqual(result, { adjustedCredits: 10, idempotencyReplayed: false });
  assert.equal(store.account?.monthlyCreditsBalance, 2990);
  assert.equal(store.account?.addOnCreditsBalance, 0);
  const refund = store.ledgers.find((entry) =>
    entry.idempotencyKey?.includes("provider-cost-reconcile"),
  );
  assert.equal(refund?.eventType, "refund");
  assert.equal(refund?.delta, 10);
  assert.equal(usage.totals.creditsConsumed, 10);
});

test("meterConsume records the applied markup rate on the ledger entry", async () => {
  const store = new MemoryBillingStore();
  const accountService = new BillingAccountService(store, runtimeConfig);
  const usageService = new BillingUsageService(
    store,
    runtimeConfig,
    accountService,
  );

  await usageService.meterConsume(
    "team_1",
    {
      providerCostUsd: 0.01,
      feature: "chat",
      idempotencyKey: "model-call-markup-capture",
    },
    "user_1",
  );

  const entry = store.ledgers.find(
    (row) => row.idempotencyKey === "user_1:model-call-markup-capture",
  );
  assert.equal(entry?.metadata.markupRate, runtimeConfig.defaultMarkupRate);
});

test("reconciliation uses the markup rate captured at consume time, not a later platform default", async () => {
  const store = new MemoryBillingStore();
  const consumeTimeAccountService = new BillingAccountService(
    store,
    runtimeConfig,
  );
  const consumeTimeUsageService = new BillingUsageService(
    store,
    runtimeConfig,
    consumeTimeAccountService,
  );

  await consumeTimeUsageService.meterConsume(
    "team_1",
    {
      providerCostUsd: 0.01,
      feature: "chat",
      idempotencyKey: "model-call-drift",
    },
    "user_1",
  );

  // The platform's default markup rate changes between the original charge
  // and the async reconciliation run (this is the whole point of the drift
  // bug: reconciliation runs minutes/hours later, against a service instance
  // that reads whatever `runtimeConfig.defaultMarkupRate` is *now*).
  const laterRuntimeConfig: BillingRuntimeConfig = {
    ...runtimeConfig,
    defaultMarkupRate: 0.5,
  };
  const laterAccountService = new BillingAccountService(
    store,
    laterRuntimeConfig,
  );
  const laterUsageService = new BillingUsageService(
    store,
    laterRuntimeConfig,
    laterAccountService,
  );

  const result = await laterUsageService.reconcileModelProviderCost({
    teamId: "team_1",
    actorUserId: "user_1",
    feature: "chat",
    originalIdempotencyKey: "model-call-drift",
    reconciliationIdempotencyKey: "provider-cost-reconcile:generation-drift:v1",
    generationId: "generation-drift",
    provider: "orcarouter",
    providerRequestId: "orca-request-drift",
    settledProviderCostUsd: 0.01, // same actual provider cost as the original charge
  });

  // The real provider cost never changed, so a correct reconciliation (using
  // the markup rate captured on the original ledger row) produces no
  // adjustment. Before the fix, this would have recomputed against the new
  // 0.5 default and produced a spurious nonzero adjustment.
  assert.deepEqual(result, { adjustedCredits: 0, idempotencyReplayed: false });
});

test("reconciliation falls back to the current default markup rate for legacy ledger rows missing metadata.markupRate", async () => {
  const store = new MemoryBillingStore();
  const accountService = new BillingAccountService(store, runtimeConfig);
  const usageService = new BillingUsageService(
    store,
    runtimeConfig,
    accountService,
  );

  await usageService.ensureBillingAccount("team_1", "user_1");
  const balanceBefore = store.account?.monthlyCreditsBalance ?? 0;
  const legacyDelta = -10;

  // Simulates a ledger row written before this fix, when meterConsume never
  // wrote `markupRate` into metadata.
  store.ledgers.push({
    id: "legacy-ledger-1",
    teamId: "team_1",
    workspaceId: null,
    actorUserId: "user_1",
    feature: "chat",
    eventType: "consume",
    unitType: "credit",
    delta: legacyDelta,
    balanceAfter: balanceBefore + legacyDelta,
    referenceId: null,
    idempotencyKey: "user_1:model-call-legacy",
    operationId: null,
    operationType: "usage",
    activityVisible: true,
    activityTitle: null,
    activitySummary: null,
    metadata: {
      creditUnitUsd: runtimeConfig.creditUnitUsd,
    },
    createdAt: new Date().toISOString(),
  });

  const result = await usageService.reconcileModelProviderCost({
    teamId: "team_1",
    actorUserId: "user_1",
    feature: "chat",
    originalIdempotencyKey: "model-call-legacy",
    reconciliationIdempotencyKey:
      "provider-cost-reconcile:generation-legacy:v1",
    generationId: "generation-legacy",
    provider: "orcarouter",
    providerRequestId: "orca-request-legacy",
    settledProviderCostUsd: 0.02,
  });

  // desired = ceil(0.02 * (1 + 0.25) / 0.00125) = 20; original = 10 -> +10 to
  // consume, i.e. adjustedCredits = -10. This intentionally still conflates
  // markup drift with cost drift for pre-existing rows lacking the field —
  // a known, accepted backward-compatibility gap (not backfilled).
  assert.deepEqual(result, {
    adjustedCredits: -10,
    idempotencyReplayed: false,
  });
});
