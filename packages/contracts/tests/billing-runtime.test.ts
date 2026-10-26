import assert from "node:assert/strict";
import test from "node:test";
import { BillingError, isBillingError } from "../src/billing-runtime";
import { deploymentCapabilitiesSchema } from "../src/deployment-capabilities";

test("billing errors remain recognizable across bundle boundaries", () => {
  const error = new BillingError("BILLING_UNAVAILABLE", 501, "Not installed");
  assert.equal(isBillingError(error), true);
  assert.equal(isBillingError({ ...error, message: error.message }), true);
  for (const invalid of [
    null,
    new Error("BILLING_UNAVAILABLE"),
    { name: "BillingError", message: "bad", code: "X", statusCode: 200 },
    { name: "BillingError", message: "bad", code: "X", statusCode: 500.5 },
    {
      name: "BillingError",
      message: "bad",
      code: "X",
      statusCode: 500,
      details: [],
    },
  ])
    assert.equal(isBillingError(invalid), false);
});

test("capabilities cannot describe a core edition that silently enables checkout", () => {
  const core = {
    edition: "core",
    billingRuntimeApiVersion: 1,
    billing: {
      available: false,
      mode: null,
      checkout: false,
      teamSubscriptions: false,
      topup: false,
    },
  };
  assert.equal(deploymentCapabilitiesSchema.safeParse(core).success, true);
  assert.equal(
    deploymentCapabilitiesSchema.safeParse({
      ...core,
      billing: { ...core.billing, checkout: true },
    }).success,
    false,
  );
  assert.equal(
    deploymentCapabilitiesSchema.safeParse({
      ...core,
      billingRuntimeApiVersion: 2,
    }).success,
    false,
  );
  assert.equal(
    deploymentCapabilitiesSchema.safeParse({ ...core, edition: "commercial" })
      .success,
    false,
  );
});

test("commercial capabilities carry the display catalog and nothing provider-specific", () => {
  const catalog = {
    plans: {
      free: { credits: 3000, pages: 300 },
      pro: {
        credits: 8000,
        pages: 6000,
        priceCents: { monthly: 990, yearly: 9900 },
      },
      team: {
        credits: 8000,
        pages: 6000,
        priceCents: { monthly: 990, yearly: 9900 },
        minSeats: 2,
      },
    },
    topups: {
      credit: { units: 10000, priceCents: 1250 },
      page: { units: 1000, priceCents: 500 },
    },
  };
  const commercial = {
    edition: "commercial",
    billingRuntimeApiVersion: 1,
    billing: {
      available: true,
      mode: "shadow",
      checkout: true,
      teamSubscriptions: true,
      topup: true,
      catalog,
    },
  };
  assert.equal(
    deploymentCapabilitiesSchema.safeParse(commercial).success,
    true,
  );

  const { catalog: _omitted, ...withoutCatalog } = commercial.billing;
  assert.equal(
    deploymentCapabilitiesSchema.safeParse({
      ...commercial,
      billing: withoutCatalog,
    }).success,
    false,
  );

  const parsed = deploymentCapabilitiesSchema.parse({
    ...commercial,
    billing: {
      ...commercial.billing,
      catalog: {
        ...catalog,
        credits: { unitUsd: 0.002 },
        plans: {
          ...catalog.plans,
          pro: { ...catalog.plans.pro, creemProductId: { monthly: "prod_x" } },
        },
      },
    },
  });
  const text = JSON.stringify(parsed);
  assert.ok(!text.includes("prod_x"));
  assert.ok(!text.includes("unitUsd"));
});
