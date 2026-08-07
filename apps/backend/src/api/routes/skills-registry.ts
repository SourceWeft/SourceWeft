import type { Hono } from "hono";
import { isMarketAdmin } from "../../modules/market/admin";
import {
  listRegistryReviewQueue,
  setRegistrySkillVersionStatus,
} from "../../modules/skills/registry/review";
import { getSessionUserId, requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

/**
 * Admin moderation queue for registry skill submissions — the HTTP surface over
 * `skills/registry/review.ts`, mirroring the market admin submission routes
 * (`routes/market.ts`). Reuses `isMarketAdmin` as the single platform-admin
 * choke point (docs/architecture/skill-registry-index.md §3 Stage 5); a queued
 * submission is a `draft` version an admin publishes or deprecates (no hard
 * delete).
 */
export function registerSkillRegistryAdminRoutes(app: Hono) {
  async function requireSkillRegistryAdmin(
    c: Parameters<typeof requireSession>[0],
  ) {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    if (!isMarketAdmin(getSessionUserId(session))) {
      throw ApiError.forbidden("Registry admin access required");
    }
    return session;
  }

  app.get("/v1/skills/registry/admin/submissions", async (c) => {
    await requireSkillRegistryAdmin(c);
    return ApiResponse.success(c, { items: await listRegistryReviewQueue() });
  });

  app.post(
    "/v1/skills/registry/admin/submissions/:versionId/publish",
    async (c) => {
      await requireSkillRegistryAdmin(c);
      const result = await setRegistrySkillVersionStatus(
        decodeURIComponent(c.req.param("versionId")),
        "published",
      );
      if (!result) {
        throw ApiError.notFound("No draft registry version awaiting review");
      }
      return ApiResponse.success(c, result);
    },
  );

  app.post(
    "/v1/skills/registry/admin/submissions/:versionId/reject",
    async (c) => {
      await requireSkillRegistryAdmin(c);
      const result = await setRegistrySkillVersionStatus(
        decodeURIComponent(c.req.param("versionId")),
        "deprecated",
      );
      if (!result) {
        throw ApiError.notFound("No registry version to deprecate");
      }
      return ApiResponse.success(c, result);
    },
  );
}
