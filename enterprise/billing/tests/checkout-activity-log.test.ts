import assert from "node:assert/strict";
import { test } from "vitest";
import type { BillingServiceHost } from "../src/server/host";
import { BillingService } from "../src/server/service";
import {
  MemoryBillingStore,
  runtimeConfig,
  noopProvider,
} from "./test-fixtures";

const TEAM_ID = "team_0199cd4f7b1e7c3a9f0e";
const BUYER_EMAIL = "buyer@example.invalid";

function captureHost() {
  const infoCalls: { message: string; fields?: Record<string, unknown> }[] = [];
  const host: BillingServiceHost = {
    logger: {
      info(message, fields) {
        infoCalls.push({ message, fields });
      },
      warn() {},
      error() {},
    },
    organizationMetadata: () => ({}),
    async createTeamOrganization() {
      throw new Error("not used");
    },
    async ensureMembershipWorkspace() {},
  };
  return { host, infoCalls };
}

test("creating a top-up checkout logs billing.checkout_created with a truncated team id", async () => {
  const { host, infoCalls } = captureHost();
  const store = new MemoryBillingStore();
  const billing = new BillingService(
    store,
    { ...runtimeConfig, saasEnabled: true, provider: "creem" },
    {
      ...noopProvider,
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://test-checkout.creem.io/test",
          externalCheckoutId: "ch_test",
          externalCustomerId: "cust_test",
        };
      },
    },
    undefined,
    host,
  );
  await billing.ensureBillingAccount(TEAM_ID, "user_1");

  await billing.createTopupCheckout(
    TEAM_ID,
    { unitType: "page", quantity: 1 },
    "user_1",
    BUYER_EMAIL,
  );

  const created = infoCalls.filter(
    (call) => call.message === "billing.checkout_created",
  );
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]?.fields, {
    provider: "creem",
    teamId: "team_019",
    kind: "page_topup",
  });
  const serialized = JSON.stringify(created);
  assert.ok(!serialized.includes(TEAM_ID), "full team id leaked");
  assert.ok(!serialized.includes(BUYER_EMAIL), "buyer email leaked");
  assert.ok(!serialized.includes("creem.io"), "checkout url leaked");
});

test("a failed provider checkout logs nothing as created", async () => {
  const { host, infoCalls } = captureHost();
  const billing = new BillingService(
    new MemoryBillingStore(),
    { ...runtimeConfig, saasEnabled: true, provider: "creem" },
    noopProvider,
    undefined,
    host,
  );
  await billing.ensureBillingAccount(TEAM_ID, "user_1");

  await assert.rejects(() =>
    billing.createTopupCheckout(
      TEAM_ID,
      { unitType: "page", quantity: 1 },
      "user_1",
      BUYER_EMAIL,
    ),
  );

  assert.equal(
    infoCalls.some((call) => call.message === "billing.checkout_created"),
    false,
  );
});
