import { expect, it } from "vitest";

import { pricingJsonLd } from "./pricing-json-ld";

const catalog = {
  plans: {
    free: { credits: 100, pages: 10 },
    pro: { credits: 8000, pages: 100, priceCents: { monthly: 990, yearly: 9900 } },
    team: {
      credits: 8000,
      minSeats: 2,
      pages: 100,
      priceCents: { monthly: 990, yearly: 9900 },
    },
  },
  topups: {
    credit: { priceCents: 500, units: 1000 },
    page: { priceCents: 500, units: 100 },
  },
};

it("builds one USD offer per plan from the catalog", () => {
  const data = pricingJsonLd(catalog);
  const offers = data.offers as { name: string; price: string; priceCurrency: string }[];
  expect(offers.map((o) => [o.name, o.price, o.priceCurrency])).toEqual([
    ["Free", "0.00", "USD"],
    ["Pro", "9.90", "USD"],
    ["Team", "9.90", "USD"],
  ]);
});

it("prices Team per seat", () => {
  const team = pricingJsonLd(catalog).offers[2] as Record<string, unknown>;
  expect(team.priceSpecification).toMatchObject({
    referenceQuantity: { unitText: "seat" },
  });
});
