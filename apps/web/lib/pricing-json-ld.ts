import type { BillingDisplayCatalog } from "@sourceweft/contracts/billing-catalog";

import { SITE_NAME, SITE_URL } from "../app/seo";

type PlanId = "free" | "pro" | "team";

const PLAN_NAMES: Record<PlanId, string> = {
  free: "Free",
  pro: "Pro",
  team: "Team",
};

function monthlyCents(catalog: BillingDisplayCatalog, id: PlanId): number {
  return id === "free" ? 0 : catalog.plans[id].priceCents.monthly;
}

/**
 * schema.org SoftwareApplication with one Offer per plan, built from the same
 * display catalog the pricing table renders (prices are USD cents; Team is
 * priced per seat).
 */
export function pricingJsonLd(catalog: BillingDisplayCatalog) {
  const ids: PlanId[] = ["free", "pro", "team"];
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    applicationCategory: "ProductivityApplication",
    name: SITE_NAME,
    offers: ids.map((id) => {
      const cents = monthlyCents(catalog, id);
      return {
        "@type": "Offer",
        name: PLAN_NAMES[id],
        price: (cents / 100).toFixed(2),
        priceCurrency: "USD",
        url: `${SITE_URL}/pricing`,
        ...(id === "team"
          ? {
              priceSpecification: {
                "@type": "UnitPriceSpecification",
                price: (cents / 100).toFixed(2),
                priceCurrency: "USD",
                referenceQuantity: {
                  "@type": "QuantitativeValue",
                  unitCode: "C62",
                  value: 1,
                  unitText: "seat",
                },
                unitCode: "MON",
              },
            }
          : {}),
      };
    }),
    operatingSystem: "Web, macOS, Windows",
    url: SITE_URL,
  };
}
