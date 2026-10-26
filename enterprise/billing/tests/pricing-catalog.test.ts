import assert from "node:assert/strict";
import { test } from "vitest";
import {
  defaultBillingCatalog,
  parseBillingCatalog,
  toDisplayCatalog,
} from "../src/catalog/billing-catalog";
import { buildPricingPlans } from "../src/catalog/pricing";
import { getBillingMessages } from "../src/messages";

const display = toDisplayCatalog(defaultBillingCatalog);
const plansFor = (locale: string, catalog = display) =>
  buildPricingPlans(catalog, getBillingMessages(locale).plans);
const byId = (plans: ReturnType<typeof plansFor>, id: string) =>
  plans.find((plan) => plan.id === id)!;

test("prices, ids and structure come from the catalog; copy comes from the messages", () => {
  const plans = plansFor("en");
  assert.deepEqual(
    plans.map((plan) => plan.id),
    ["free", "pro", "team"],
  );
  assert.deepEqual(
    plans.map((plan) => [plan.monthlyPrice, plan.yearlyPrice]),
    [
      [0, 0],
      [990, 9900],
      [990, 9900],
    ],
  );
  assert.deepEqual(
    plans.map((plan) => plan.highlighted),
    [false, true, false],
  );
  assert.ok(plans.every((plan) => plan.ctaHref === "/auth/sign-in"));
  assert.equal(byId(plans, "pro").name, "Pro");
  assert.equal(byId(plans, "pro").cta, "Upgrade to Pro");
});

test("feature lines are filled from the catalog quotas in English", () => {
  const plans = plansFor("en");
  assert.deepEqual(byId(plans, "free").features.slice(0, 2), [
    "300 pages / month",
    "3,000 credits / month",
  ]);
  assert.deepEqual(byId(plans, "pro").features.slice(0, 2), [
    "6,000 pages / month",
    "8,000 credits / month",
  ]);
  assert.deepEqual(byId(plans, "team").features.slice(0, 2), [
    "6,000 pages × seats / month",
    "8,000 credits × seats / month",
  ]);
});

test("changing a quota in the catalog changes the copy with no number left behind", () => {
  const changed = structuredClone(defaultBillingCatalog) as Record<string, any>;
  changed.plans.pro.credits = 12345;
  changed.plans.team.pages = 7000;
  const plans = plansFor("en", toDisplayCatalog(parseBillingCatalog(changed)));
  assert.ok(byId(plans, "pro").features.includes("12,345 credits / month"));
  assert.ok(
    !byId(plans, "pro").features.some((line) => line.includes("8,000")),
  );
  assert.ok(
    byId(plans, "team").features.includes("7,000 pages × seats / month"),
  );
});

test("zh-CN and zh-TW lines carry the same numbers", () => {
  const cn = plansFor("zh-CN");
  const tw = plansFor("zh-TW");
  assert.ok(byId(cn, "pro").features.includes("每月 8,000 积分"));
  assert.ok(byId(cn, "team").features.includes("每席位每月 6,000 页"));
  assert.ok(byId(tw, "pro").features.includes("每月 8,000 點數"));
  assert.ok(byId(tw, "team").features.includes("每席位每月 6,000 頁"));
});

test("no feature line keeps a placeholder after the catalog fills it", () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    for (const plan of plansFor(locale)) {
      assert.ok(
        plan.features.every((line) => !/[{}]/.test(line)),
        `${locale} ${plan.id}`,
      );
    }
  }
});
