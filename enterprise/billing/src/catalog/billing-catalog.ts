import { z } from "zod";
import type { BillingDisplayCatalog } from "@sourceweft/contracts/billing-catalog";
import defaultCatalogJson from "../../config/billing-catalog.json";

const cents = z.number().int().positive();
const count = z.number().int().nonnegative();
const productId = z.string().trim().min(1);

const paidPlanShape = {
  credits: count,
  pages: count,
  priceCents: z.strictObject({ monthly: cents, yearly: cents }),
  creemProductId: z
    .strictObject({
      monthly: productId.optional(),
      yearly: productId.optional(),
    })
    .optional(),
};

const topup = z.strictObject({
  units: z.number().int().positive(),
  priceCents: cents,
  creemProductId: productId.optional(),
});

export const billingCatalogSchema = z.strictObject({
  version: z.literal(1),
  currency: z.literal("usd"),
  credits: z.strictObject({
    unitUsd: z.number().positive(),
    markupRate: z.number().nonnegative(),
  }),
  plans: z.strictObject({
    free: z.strictObject({ credits: count, pages: count }),
    pro: z.strictObject(paidPlanShape),
    team: z.strictObject({
      ...paidPlanShape,
      minSeats: z.number().int().min(1),
    }),
  }),
  topups: z.strictObject({ credit: topup, page: topup }),
});

export type BillingCatalog = z.infer<typeof billingCatalogSchema>;

/** Throws `Invalid billing catalog: <path>: <reason>; …` and never echoes values. */
export function parseBillingCatalog(input: unknown): BillingCatalog {
  const result = billingCatalogSchema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid billing catalog: ${details}`);
}

/** The ID-free, credit-unit-free projection that is safe to publish. */
export function toDisplayCatalog(
  catalog: BillingCatalog,
): BillingDisplayCatalog {
  const { free, pro, team } = catalog.plans;
  return {
    plans: {
      free: { credits: free.credits, pages: free.pages },
      pro: {
        credits: pro.credits,
        pages: pro.pages,
        priceCents: { ...pro.priceCents },
      },
      team: {
        credits: team.credits,
        pages: team.pages,
        priceCents: { ...team.priceCents },
        minSeats: team.minSeats,
      },
    },
    topups: {
      credit: {
        units: catalog.topups.credit.units,
        priceCents: catalog.topups.credit.priceCents,
      },
      page: {
        units: catalog.topups.page.units,
        priceCents: catalog.topups.page.priceCents,
      },
    },
  };
}

/** The file shipped with the image; deployments may mount their own over it. */
export const defaultBillingCatalog: BillingCatalog =
  parseBillingCatalog(defaultCatalogJson);
