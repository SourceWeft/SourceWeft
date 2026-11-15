import { z } from "zod";

/**
 * GET /v1/admin/overview — what is waiting for an admin, as numbers. The admin
 * navigation shows them beside each section and the admin home page lists
 * them. Admins only (403 otherwise); each section's own routes still check.
 */

const count = z.number().int().nonnegative();

export const adminOverviewResponseSchema = z.object({
  pending: z.object({
    /** MCP submissions the automated checks would not publish. */
    mcpReview: count,
    /** Skill versions the scan would not publish. */
    skillReview: count,
    /** Published skills waiting for a decision about going or staying public. */
    skillListing: count,
    /** Reports nobody has resolved yet. */
    reports: count,
  }),
  blog: z.object({
    /** Language versions that are imported but not public. */
    drafts: count,
    /** Language versions readers can see. */
    published: count,
  }),
});
export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;
