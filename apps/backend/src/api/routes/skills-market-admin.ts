import type { Hono } from "hono";
import { acknowledgeSkillVersionResponseSchema } from "@sourceweft/contracts";
import { isMarketAdmin } from "../../modules/market/admin";
import { acknowledgeSkillVersion } from "../../modules/skills/market/auto-list";
import { logger } from "../../shared/logger";
import { getSessionUserId, requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

/**
 * The session of a market admin, or the answer for anyone else: 401 signed
 * out, 403 signed in. The same allowlist (`isMarketAdmin`) as every other
 * market admin route.
 */
export async function requireSkillMarketAdmin(
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

/**
 * Market admin decisions about skills that are already public. The listing
 * queue (`GET /v1/skills/registry/admin/listing-queue`) shows a public skill
 * whose new version brought scan flags or scripts; withdrawing it is the
 * existing delist route, keeping it is this one.
 */
export function registerSkillMarketAdminRoutes(app: Hono) {
  app.post(
    "/v1/skills/registry/admin/listing-queue/:versionId/acknowledge",
    async (c) => {
      const session = await requireSkillMarketAdmin(c);
      const actorUserId = getSessionUserId(session);
      const result = await acknowledgeSkillVersion({
        skillVersionId: decodeURIComponent(c.req.param("versionId")),
        actorUserId,
      });
      if (!result) {
        throw ApiError.notFound(
          "No current version of a public skill with this id",
        );
      }
      logger.info("Skill version kept public", { actorUserId, ...result });
      return ApiResponse.success(
        c,
        acknowledgeSkillVersionResponseSchema.parse(result),
      );
    },
  );
}
