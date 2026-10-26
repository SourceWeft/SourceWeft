import { z } from "zod";

const cents = z.number().int().positive();
const count = z.number().int().nonnegative();
const interval = z.object({ monthly: cents, yearly: cents });

/**
 * The public, display-only part of the billing catalog that rides in the
 * commercial deployment capabilities. It deliberately has no provider product
 * IDs and no credit unit price.
 */
export const billingDisplayCatalogSchema = z.object({
  plans: z.object({
    free: z.object({ credits: count, pages: count }),
    pro: z.object({ credits: count, pages: count, priceCents: interval }),
    team: z.object({
      credits: count,
      pages: count,
      priceCents: interval,
      minSeats: z.number().int().min(1),
    }),
  }),
  topups: z.object({
    credit: z.object({ units: z.number().int().positive(), priceCents: cents }),
    page: z.object({ units: z.number().int().positive(), priceCents: cents }),
  }),
});

export type BillingDisplayCatalog = z.infer<typeof billingDisplayCatalogSchema>;
