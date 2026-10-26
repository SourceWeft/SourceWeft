import type { BillingAlertSink, BillingLogger } from "../host";
import type { BillingRuntimeConfig } from "../types";

export type CatalogCreemProduct = {
  productId: string;
  label: string;
  expectedPriceCents: number;
};

export type MonitorCreemCatalogPricesDeps = {
  products: CatalogCreemProduct[];
  getProduct: (
    productId: string,
  ) => Promise<{ price: number; currency: string }>;
  alerts: BillingAlertSink;
  logger: BillingLogger;
};

const alertKey = (productId: string) =>
  `billing:creem-catalog-price-mismatch:${productId}`;

/** Every Creem product the catalog configures, with the price the catalog expects. */
export function listCatalogCreemProducts(
  config: BillingRuntimeConfig,
): CatalogCreemProduct[] {
  const { creem, catalog } = config;
  const entries: Array<[string, string, number]> = [
    [
      creem.individualProMonthlyProductId,
      "Pro monthly",
      catalog.individualProMonthlyAmountCents,
    ],
    [
      creem.individualProYearlyProductId,
      "Pro yearly",
      catalog.individualProYearlyAmountCents,
    ],
    [
      creem.teamStandardMonthlyProductId,
      "Team monthly (per seat)",
      catalog.teamStandardMonthlyAmountCents,
    ],
    [
      creem.teamStandardYearlyProductId,
      "Team yearly (per seat)",
      catalog.teamStandardYearlyAmountCents,
    ],
    [
      creem.creditTopupProductId,
      "Credit top-up pack",
      catalog.creditTopupAmountCents,
    ],
    [
      creem.pageTopupProductId,
      "Page top-up pack",
      catalog.pageTopupAmountCents,
    ],
  ];
  return entries
    .filter(([productId]) => productId)
    .map(([productId, label, expectedPriceCents]) => ({
      productId,
      label,
      expectedPriceCents,
    }));
}

/**
 * Alert-only comparison of Creem's own product prices with the billing catalog.
 * Creem charges its product price, so a drift never blocks checkout; it raises
 * one ops alert per product until the catalog and Creem agree again.
 */
export async function monitorCreemCatalogPrices(
  deps: MonitorCreemCatalogPricesDeps,
): Promise<{ checked: number; mismatched: number }> {
  let checked = 0;
  let mismatched = 0;

  for (const product of deps.products) {
    let actual: { price: number; currency: string };
    try {
      actual = await deps.getProduct(product.productId);
    } catch (error) {
      deps.logger.error("Failed to read a Creem product for the price check", {
        productId: product.productId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    checked += 1;

    const matches =
      actual.price === product.expectedPriceCents &&
      actual.currency.toLowerCase() === "usd";
    if (!matches) mismatched += 1;

    try {
      if (matches) {
        await deps.alerts.resolve(alertKey(product.productId));
      } else {
        await deps.alerts.trigger({
          alertKey: alertKey(product.productId),
          level: "error",
          source: "billing.creem",
          title: "Creem product price differs from the billing catalog",
          message:
            "Creem charges its own product price. Update the Creem product or the billing catalog file so they agree.",
          metadata: {
            productId: product.productId,
            label: product.label,
            expectedPriceCents: product.expectedPriceCents,
            actualPriceCents: actual.price,
            actualCurrency: actual.currency,
          },
        });
      }
    } catch (error) {
      // An ops-sink failure must not stop the check of the other products.
      deps.logger.error("Failed to update the Creem catalog price alert", {
        productId: product.productId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { checked, mismatched };
}
