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
