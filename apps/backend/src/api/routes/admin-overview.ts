import type { Hono } from "hono";
import { adminOverviewResponseSchema } from "@sourceweft/contracts";
import { countBlogPostsForAdmin } from "../../modules/blog/repository";
import { countReviewQueue } from "../../modules/market/review";
import { listSkillListingQueue } from "../../modules/skills/market/auto-list";
import { countOpenSkillReports } from "../../modules/skills/market/reports";
import { countRegistryReviewQueue } from "../../modules/skills/registry/review";
import { ApiResponse } from "../response/api-response";
import { requireSkillMarketAdmin } from "./skills-market-admin";

/**
 * What is waiting for an admin, as numbers, for the admin navigation and the
 * admin home page. Admins are the market admins for now.
 */
export function registerAdminOverviewRoutes(app: Hono) {
  app.get("/v1/admin/overview", async (c) => {
    await requireSkillMarketAdmin(c);
    const [mcpReview, skillReview, listing, reports, blog] = await Promise.all([
      countReviewQueue(),
      countRegistryReviewQueue(),
      // The listing queue is the union of two bounded reads with their own
      // rules; its length is the count the page will show.
      listSkillListingQueue(),
      countOpenSkillReports(),
      countBlogPostsForAdmin(),
    ]);
    c.header("Cache-Control", "no-store");
    return ApiResponse.success(
      c,
      adminOverviewResponseSchema.parse({
        pending: {
          mcpReview,
          skillReview,
          skillListing: listing.length,
          reports,
        },
        blog,
      }),
    );
  });
}
