import { expect, test } from "vitest";
import { loadBillingCatalog } from "./catalog-file";

test("the billing catalog is found at its fixed path next to the billing package", () => {
  const loaded = loadBillingCatalog();

  expect(
    loaded.filePath.endsWith("enterprise/billing/config/billing-catalog.json"),
  ).toBe(true);
  expect(loaded.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  expect(loaded.catalog.plans.pro.priceCents).toEqual({
    monthly: 990,
    yearly: 9900,
  });
  expect(loaded.catalog.credits.unitUsd).toBe(0.00125);
});
