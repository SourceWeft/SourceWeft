import type { Hono } from "hono";
import {
  acknowledgeSkillVersionResponseSchema,
  listSkillMarketAdminSkillsQuerySchema,
  listSkillMarketAdminSkillsResponseSchema,
  listSkillMarketEventsQuerySchema,
  listSkillMarketEventsResponseSchema,
  reinferSkillCategoriesResponseSchema,
  skillMarketAdminMeResponseSchema,
} from "@sourceweft/contracts";
import { isMarketAdmin } from "../../modules/market/admin";
import { listSkillMarketAdminSkills } from "../../modules/skills/market/admin-list";
import { acknowledgeSkillVersion } from "../../modules/skills/market/auto-list";
import {
  listRecentSkillMarketEvents,
  listSkillMarketEvents,
} from "../../modules/skills/market/events";
import {
  reinferAllSkillCategories,
  reinferSkillCategories,
} from "../../modules/skills/market/listing";
import { getSkillMarketStanding } from "../../modules/skills/market/standing";
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

function queryOf(c: Parameters<typeof requireSession>[0]) {
  return Object.fromEntries(
    Object.entries(c.req.queries()).map(([key, values]) => [key, values[0]]),
  );
}

/**
 * The market admin's own screens: who is one, every community skill, the
 * audit trail, re-inferring categories, and decisions about skills that are
 * already public. The listing queue
 * (`GET /v1/skills/registry/admin/listing-queue`) shows a public skill whose
 * new version brought scan flags or scripts; withdrawing it is the existing
 * delist route, keeping it is the acknowledge route below.
 */
export function registerSkillMarketAdminRoutes(app: Hono) {
  // Whether to show the market admin's entry points. Any signed-in user may
  // ask; the answer grants nothing — every admin route checks for itself.
  app.get("/v1/skills/registry/admin/me", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    return ApiResponse.success(
      c,
      skillMarketAdminMeResponseSchema.parse({
        isMarketAdmin: isMarketAdmin(getSessionUserId(session)),
      }),
    );
  });

  // Every community skill, filtered and paged (`market/admin-list.ts`).
  app.get("/v1/skills/registry/admin/skills", async (c) => {
    await requireSkillMarketAdmin(c);
    const parsed = listSkillMarketAdminSkillsQuerySchema.safeParse(queryOf(c));
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    return ApiResponse.success(
      c,
      listSkillMarketAdminSkillsResponseSchema.parse(
        await listSkillMarketAdminSkills(parsed.data),
      ),
    );
  });

  // One skill's history, its repository's claim events included.
  app.get("/v1/skills/registry/admin/skills/:skillId/events", async (c) => {
    await requireSkillMarketAdmin(c);
    const parsed = listSkillMarketEventsQuerySchema
      .pick({ limit: true })
      .safeParse(queryOf(c));
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    const items = await listSkillMarketEvents({
      skillId: c.req.param("skillId"),
      limit: parsed.data.limit,
    });
    if (!items) throw ApiError.notFound("No such skill");
    return ApiResponse.success(
      c,
      listSkillMarketEventsResponseSchema.parse({ items, nextCursor: null }),
    );
  });

  // Everything that happened on the market, newest first.
  app.get("/v1/skills/registry/admin/events", async (c) => {
    await requireSkillMarketAdmin(c);
    const parsed = listSkillMarketEventsQuerySchema.safeParse(queryOf(c));
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    return ApiResponse.success(
      c,
      listSkillMarketEventsResponseSchema.parse(
        await listRecentSkillMarketEvents(parsed.data),
      ),
    );
  });

  // One skill's categories from its text again, even where an admin picked
  // them; they are the classifier's (`auto`) from then on.
  app.post(
    "/v1/skills/registry/admin/skills/:skillId/reinfer-categories",
    async (c) => {
      const session = await requireSkillMarketAdmin(c);
      const input = {
        skillId: c.req.param("skillId"),
        actorUserId: getSessionUserId(session),
      };
      if (!(await getSkillMarketStanding(input.skillId))) {
        throw ApiError.notFound("No such registry skill");
      }
      const result = await reinferSkillCategories(input);
      if (!result) throw ApiError.notFound("No such registry skill");
      logger.info("Registry skill categories re-inferred", {
        ...input,
        categorySlugs: result.categorySlugs,
      });
      const standing = await getSkillMarketStanding(input.skillId);
      if (!standing) throw ApiError.notFound("No such registry skill");
      return ApiResponse.success(c, standing);
    },
  );

  // Every inferred skill's categories again, after the taxonomy or the
  // classifier changed. An admin's pick is never touched.
  app.post("/v1/skills/registry/admin/reinfer-categories", async (c) => {
    const session = await requireSkillMarketAdmin(c);
    const actorUserId = getSessionUserId(session);
    const result = await reinferAllSkillCategories({ actorUserId });
    logger.info("Registry skill categories re-inferred in bulk", {
      actorUserId,
      ...result,
    });
    return ApiResponse.success(
      c,
      reinferSkillCategoriesResponseSchema.parse(result),
    );
  });

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
