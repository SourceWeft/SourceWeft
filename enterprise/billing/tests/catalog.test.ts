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

test("a team seat grants 8,000 credits and 6,000 pages", () => {
  assert.deepEqual(getPerSeatQuota("team_standard"), {
    active: true,
    monthlyPagesLimit: 6000,
    monthlyCreditsGrant: 8000,
  });
  assert.equal(getPlanQuota("team_standard", 3).monthlyCreditsGrant, 24000);
  assert.equal(getPlanQuota("team_standard", 1).monthlyPagesLimit, 12000);
});

test("pro and team seat default to $9.90 monthly and $99 yearly on display and charge", () => {
  const plans = getPricingConfig({});
  const pro = plans.find((plan) => plan.id === "pro");
  const team = plans.find((plan) => plan.id === "team");
  assert.equal(pro?.monthlyPrice, 990);
  assert.equal(pro?.yearlyPrice, 9900);
  assert.equal(team?.monthlyPrice, 990);
  assert.equal(team?.yearlyPrice, 9900);
  assert.ok(pro?.features.includes("8,000 credits / month"));
  assert.ok(team?.features.includes("8,000 credits × seats / month"));

  const config = readBillingConfig({}, "https://sourceweft.test");
  assert.equal(config.catalog.individualProMonthlyAmountCents, 990);
  assert.equal(config.catalog.individualProYearlyAmountCents, 9900);
  assert.equal(config.catalog.teamStandardMonthlyAmountCents, 990);
  assert.equal(config.catalog.teamStandardYearlyAmountCents, 9900);

  assert.doesNotThrow(() =>
    validateBillingCatalog({
      runtimeConfig: config,
      pricingDisplay: plans.filter(
        (plan) => plan.id === "pro" || plan.id === "team",
      ),
      subscriptionPlanFamilies: ["individual_pro", "team_standard"],
    }),
  );
});
