import assert from "node:assert/strict";
import { test } from "vitest";
import {
  defaultBillingCatalog,
  parseBillingCatalog,
} from "../src/catalog/billing-catalog";
import {
  findIgnoredLegacyBillingEnv,
  readBillingConfig,
  validateBillingConfiguration,
} from "../src/server/config";

const url = "http://localhost:3000";

function catalogWith(change: (catalog: Record<string, any>) => void) {
  const catalog = structuredClone(defaultBillingCatalog) as Record<string, any>;
  change(catalog);
  return parseBillingCatalog(catalog);
}

test("billing defaults do not depend on the developer environment or a credential being present", () => {
  const config = readBillingConfig(
    { CREEM_API_KEY: "test-only-credential" },
    url,
    defaultBillingCatalog,
  );
  assert.equal(config.provider, "none");
  assert.equal(config.saasEnabled, false);
  assert.equal(config.planQuotas.individual_free.monthlyCreditsGrant, 3000);
  assert.equal(config.planQuotas.individual_free.monthlyPagesLimit, 300);
  assert.equal(config.creditUnitUsd, 0.00125);
  assert.equal(config.defaultMarkupRate, 0.25);
});

test("prices, packs and product IDs come from the catalog, not the environment", () => {
  const catalog = catalogWith((c) => {
    c.credits.unitUsd = 0.002;
    c.plans.pro.creemProductId = { monthly: "prod_pm", yearly: "prod_py" };
    c.plans.team.creemProductId = { monthly: "prod_tm", yearly: "prod_ty" };
    c.topups.credit.creemProductId = "prod_credit";
  });
  const config = readBillingConfig(
    {
      BACKEND_CREDIT_UNIT_USD: "0.5",
      BILLING_PRICE_INDIVIDUAL_PRO_MONTHLY_CENTS: "1",
      CREEM_INDIVIDUAL_PRO_MONTHLY_PRODUCT_ID: "prod_from_env",
    },
    url,
    catalog,
  );
  assert.equal(config.creditUnitUsd, 0.002);
  assert.equal(config.catalog.individualProMonthlyAmountCents, 990);
  assert.equal(config.catalog.individualProYearlyAmountCents, 9900);
  assert.equal(config.catalog.teamStandardMonthlyAmountCents, 990);
  assert.equal(config.catalog.teamStandardYearlyAmountCents, 9900);
  assert.equal(config.catalog.creditTopupUnitAmount, 10000);
  assert.equal(config.catalog.creditTopupAmountCents, 1250);
  assert.equal(config.catalog.pageTopupUnitAmount, 1000);
  assert.equal(config.catalog.pageTopupAmountCents, 500);
  assert.equal(config.creem.individualProMonthlyProductId, "prod_pm");
  assert.equal(config.creem.individualProYearlyProductId, "prod_py");
  assert.equal(config.creem.teamStandardMonthlyProductId, "prod_tm");
  assert.equal(config.creem.teamStandardYearlyProductId, "prod_ty");
  assert.equal(config.creem.creditTopupProductId, "prod_credit");
  assert.equal(config.creem.pageTopupProductId, "");
});

test("retired environment variables are reported by name, in a fixed order", () => {
  assert.deepEqual(
    findIgnoredLegacyBillingEnv({
      CREEM_API_KEY: "not-retired",
      BACKEND_CREDIT_UNIT_USD: "0.002",
      BILLING_PRICE_INDIVIDUAL_PRO_MONTHLY_CENTS: "1",
      CREEM_PAGE_TOPUP_PRODUCT_ID: "",
      NEXT_PUBLIC_PRICING_PRO_MONTHLY: "1",
    }),
    [
      "NEXT_PUBLIC_PRICING_PRO_MONTHLY",
      "BILLING_PRICE_INDIVIDUAL_PRO_MONTHLY_CENTS",
      "BACKEND_CREDIT_UNIT_USD",
    ],
  );
  assert.deepEqual(findIgnoredLegacyBillingEnv({}), []);
});

test("invalid modes and explicitly unsupported checkout providers fail rather than silently disabling billing", () => {
  assert.throws(() =>
    readBillingConfig(
      { BACKEND_BILLING_MODE: "typo" },
      url,
      defaultBillingCatalog,
    ),
  );
  assert.throws(
    () =>
      readBillingConfig(
        { SOURCEWEFT_SAAS_ENABLED: "true", BACKEND_BILLING_PROVIDER: "manual" },
        url,
        defaultBillingCatalog,
      ),
    /not supported/,
  );
});

test("enabled checkout requires credentials, while disabled checkout can run the ledger", () => {
  validateBillingConfiguration(
    readBillingConfig({}, url, defaultBillingCatalog),
  );
  assert.throws(
    () =>
      validateBillingConfiguration(
        readBillingConfig(
          {
            SOURCEWEFT_SAAS_ENABLED: "true",
            BACKEND_BILLING_PROVIDER: "creem",
          },
          url,
          defaultBillingCatalog,
        ),
      ),
    /CREEM_API_KEY/,
  );
});
