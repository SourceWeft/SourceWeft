import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createCoreBillingRuntime,
  createCoreBillingOrganizationHooks,
  coreDeploymentCapabilities,
} from "./core";

test("core executions carry an explicit unmetered outcome, never a synthetic account balance", async () => {
  const billing = createCoreBillingRuntime();
  assert.deepEqual(await billing.getExecutionState("team_1", "user_1"), {
    kind: "unmetered",
    reason: "billing_not_installed",
  });
  const result = await billing.settleModelUsage({
    teamId: "team_1",
    actorUserId: "user_1",
    feature: "chat",
    operation: "chat",
    modelKind: "chat",
    profileAlias: "default",
    executionMode: "GLOBAL",
    cost: {
      providerCostUsd: 12,
      costSource: "provider_actual",
      missingPriceComponents: [],
      pricingSnapshot: null,
    },
  });
  assert.deepEqual(result, {
    status: "skipped",
    reason: "billing_not_installed",
  });
  assert.equal("billing" in result, false);
  assert.deepEqual(
    await billing.meterIngestion(
      "team_1",
      { feature: "ingestion", pages: 3000 },
      "user_1",
    ),
    result,
  );
});

test("core organization hooks do not require payment configuration or an account", async () => {
  const hooks = createCoreBillingOrganizationHooks();
  await hooks.provisionAccount("team_1", "user_1");
  await hooks.beforeAddMember("team_1");
  await hooks.beforeInviteMember("team_1");
  await hooks.beforeAcceptInvitation("team_1");
  assert.deepEqual(coreDeploymentCapabilities().billing, {
    available: false,
    mode: null,
    checkout: false,
    teamSubscriptions: false,
    topup: false,
  });
});
