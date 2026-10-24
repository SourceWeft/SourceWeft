import assert from "node:assert/strict";
import { test } from "vitest";
import { getPricingConfig } from "../src/catalog/pricing";
import { validateBillingCatalog } from "../src/server/catalog";
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

test("pro grants 8,000 credits and 6,000 pages per month", () => {
  assert.deepEqual(getPerSeatQuota("individual_pro"), {
    active: true,
    monthlyPagesLimit: 6000,
    monthlyCreditsGrant: 8000,
  });
});

test("team seat quota does not follow pro", () => {
  assert.deepEqual(getPerSeatQuota("team_standard"), {
    active: true,
    monthlyPagesLimit: 6000,
    monthlyCreditsGrant: 20000,
  });
  assert.equal(getPlanQuota("team_standard", 3).monthlyCreditsGrant, 60000);
  assert.equal(getPlanQuota("team_standard", 1).monthlyPagesLimit, 12000);
});

test("pro defaults to $9.90 monthly and $99 yearly on display and charge", () => {
  const pro = getPricingConfig({}).find((plan) => plan.id === "pro");
  assert.equal(pro?.monthlyPrice, 990);
  assert.equal(pro?.yearlyPrice, 9900);
  assert.ok(pro?.features.includes("8,000 credits / month"));

  const config = readBillingConfig({}, "https://sourceweft.test");
  assert.equal(config.catalog.individualProMonthlyAmountCents, 990);
  assert.equal(config.catalog.individualProYearlyAmountCents, 9900);

  assert.doesNotThrow(() =>
    validateBillingCatalog({
      runtimeConfig: config,
      pricingDisplay: getPricingConfig({}).filter((plan) => plan.id === "pro"),
      subscriptionPlanFamilies: ["individual_pro"],
    }),
  );
});
