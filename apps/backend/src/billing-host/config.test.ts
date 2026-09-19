import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveCommercialEnabled } from "./config";

test("commercial module defaults off and credentials never enable it", () => {
  assert.equal(resolveCommercialEnabled({}), false);
  assert.equal(
    resolveCommercialEnabled({
      CREEM_API_KEY: "present",
      STRIPE_SECRET_KEY: "present",
    }),
    false,
  );
  assert.equal(
    resolveCommercialEnabled({
      BACKEND_BILLING_MODE: "disabled",
      BACKEND_BILLING_PROVIDER: "none",
    }),
    false,
  );
});
test("strict module switch accepts normalized booleans and rejects malformed values", () => {
  for (const value of ["true", "1", " TRUE "])
    assert.equal(
      resolveCommercialEnabled({ SOURCEWEFT_COMMERCIAL_ENABLED: value }),
      true,
    );
  for (const value of ["false", "0", " False "])
    assert.equal(
      resolveCommercialEnabled({ SOURCEWEFT_COMMERCIAL_ENABLED: value }),
      false,
    );
  for (const value of ["", "yes", "on", "tru"])
    assert.throws(
      () => resolveCommercialEnabled({ SOURCEWEFT_COMMERCIAL_ENABLED: value }),
      /SOURCEWEFT_COMMERCIAL_ENABLED/,
    );
});
test("feature flags require explicit module activation and never silently select core", () => {
  for (const flag of [
    "SOURCEWEFT_SAAS_ENABLED",
    "BACKEND_CREDITS_ENABLED",
    "BACKEND_PAGES_ENABLED",
    "BACKEND_TEAM_BILLING_ENABLED",
    "BACKEND_BILLING_RECONCILE_ENABLED",
  ]) {
    assert.throws(
      () => resolveCommercialEnabled({ [flag]: "true" }),
      /SOURCEWEFT_COMMERCIAL_ENABLED=true/,
    );
    assert.throws(
      () =>
        resolveCommercialEnabled({
          SOURCEWEFT_COMMERCIAL_ENABLED: "true",
          [flag]: "typo",
        }),
      new RegExp(flag),
    );
    assert.equal(
      resolveCommercialEnabled({
        SOURCEWEFT_COMMERCIAL_ENABLED: "true",
        [flag]: "true",
      }),
      true,
    );
  }
  assert.throws(() =>
    resolveCommercialEnabled({ BACKEND_BILLING_MODE: "enforced" }),
  );
  assert.throws(() =>
    resolveCommercialEnabled({ BACKEND_BILLING_PROVIDER: "stripe" }),
  );
});
test("legacy edition cannot activate or contradict the module switch", () => {
  assert.throws(() =>
    resolveCommercialEnabled({ SOURCEWEFT_EDITION: "commercial" }),
  );
  assert.throws(() =>
    resolveCommercialEnabled({
      SOURCEWEFT_COMMERCIAL_ENABLED: "true",
      SOURCEWEFT_EDITION: "core",
    }),
  );
  assert.equal(
    resolveCommercialEnabled({
      SOURCEWEFT_COMMERCIAL_ENABLED: "true",
      SOURCEWEFT_EDITION: "commercial",
    }),
    true,
  );
});
