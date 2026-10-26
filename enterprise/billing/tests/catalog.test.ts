import assert from "node:assert/strict";
import { test } from "vitest";
import { defaultBillingCatalog } from "../src/catalog/billing-catalog";
import { validateBillingCatalog } from "../src/server/catalog";
import { parseBillingCatalog } from "../src/catalog/billing-catalog";
import { readBillingConfig } from "../src/server/config";
import { getPerSeatQuota, getPlanQuota } from "../src/server/plans";
import { runtimeConfig } from "./test-fixtures";

test("catalog validation catches missing active provider product", async () => {
  assert.throws(
    () =>
      validateBillingCatalog({
        runtimeConfig: {
          ...runtimeConfig,
          saasEnabled: true,
          provider: "creem",
          creem: {
            ...runtimeConfig.creem,
            teamStandardYearlyProductId: "",
          },
        },
      }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "BILLING_CATALOG_INVALID",
      );
      return true;
    },
  );
});

const seatConfig = readBillingConfig(
  {},
  "https://sourceweft.test",
  defaultBillingCatalog,
);

test("pro grants 8,000 credits and 6,000 pages per month", () => {
  assert.deepEqual(getPerSeatQuota(seatConfig, "individual_pro"), {
    active: true,
    monthlyPagesLimit: 6000,
    monthlyCreditsGrant: 8000,
  });
});

test("a team seat is one allocation and the team total scales with seats", () => {
  assert.deepEqual(getPerSeatQuota(seatConfig, "team_standard"), {
    active: true,
    monthlyPagesLimit: 6000,
    monthlyCreditsGrant: 8000,
  });
  assert.equal(
    getPlanQuota(seatConfig, "team_standard", 3).monthlyCreditsGrant,
    24000,
  );
  assert.equal(
    getPlanQuota(seatConfig, "team_standard", 1).monthlyPagesLimit,
    12000,
  );
});

test("plan quotas follow the catalog, and unsold plans stay inactive", () => {
  const changed = readBillingConfig(
    {},
    "https://sourceweft.test",
    parseBillingCatalog({
      ...structuredClone(defaultBillingCatalog),
      plans: {
        ...structuredClone(defaultBillingCatalog.plans),
        pro: {
          ...structuredClone(defaultBillingCatalog.plans.pro),
          credits: 5000,
        },
      },
    }),
  );
  assert.equal(
    getPerSeatQuota(changed, "individual_pro").monthlyCreditsGrant,
    5000,
  );
  assert.equal(getPerSeatQuota(changed, "team_premium").active, false);
  assert.deepEqual(getPerSeatQuota(changed, "enterprise_usage"), {
    active: false,
    monthlyPagesLimit: 0,
    monthlyCreditsGrant: 0,
  });
});

test("creem catalog validation needs a product ID for every sold plan", () => {
  const config = readBillingConfig(
    {
      SOURCEWEFT_SAAS_ENABLED: "true",
      BACKEND_BILLING_PROVIDER: "creem",
      CREEM_API_KEY: "k",
      CREEM_WEBHOOK_SECRET: "s",
    },
    "https://sourceweft.test",
    defaultBillingCatalog,
  );
  assert.throws(
    () =>
      validateBillingCatalog({
        runtimeConfig: config,
        subscriptionPlanFamilies: ["individual_pro"],
        topupUnitTypes: [],
      }),
    (error: unknown) =>
      (error as { code?: string }).code === "BILLING_CATALOG_INVALID",
  );
});
