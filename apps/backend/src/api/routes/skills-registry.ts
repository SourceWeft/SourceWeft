import { z } from "zod";
import { logger } from "../../shared/logger";
import { getRegistryVersionDetail } from "../../modules/skills/registry/versions";
import type { Hono } from "hono";
import { isMarketAdmin } from "../../modules/market/admin";
import {
  listRegistryReviewQueue,
  setRegistryVisibility,
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
      const session = await requireSkillRegistryAdmin(c);
      const parsed = z
        .object({
          reason: z.string().trim().max(1000).optional(),
          visibility: z.enum(["public", "restricted"]).optional(),
        })
        .strict()
        .safeParse(await c.req.json().catch(() => { throw ApiError.invalidJson(); }));
      if (!parsed.success) throw ApiError.validation();
      const result = await setRegistrySkillVersionStatus(
        decodeURIComponent(c.req.param("versionId")),
        "published",
        { ...parsed.data, actorUserId: getSessionUserId(session) },
      );
      if (!result) {
        throw ApiError.notFound("No draft registry version awaiting review");
      }
      logger.info("Registry version moderated", { actorUserId: getSessionUserId(session), ...result });
      return ApiResponse.success(c, result);
    },
  );

  app.post(
    "/v1/skills/registry/admin/submissions/:versionId/reject",
    async (c) => {
      const session = await requireSkillRegistryAdmin(c);
      const parsed = z
        .object({
          reason: z.string().trim().max(1000).optional(),
          visibility: z.enum(["public", "restricted"]).optional(),
        })
        .strict()
        .safeParse(await c.req.json().catch(() => { throw ApiError.invalidJson(); }));
      if (!parsed.success) throw ApiError.validation();
      const result = await setRegistrySkillVersionStatus(
        decodeURIComponent(c.req.param("versionId")),
        "deprecated",
        { reason: parsed.data.reason, actorUserId: getSessionUserId(session) },
      );
      if (!result) {
        throw ApiError.notFound("No registry version to deprecate");
      }
      logger.info("Registry version moderated", { actorUserId: getSessionUserId(session), ...result });
      return ApiResponse.success(c, result);
    },
  );
  app.get(
    "/v1/skills/registry/admin/skills/:skillId/versions/:versionId",
    async (c) => {
      const session = await requireSkillRegistryAdmin(c);
      return ApiResponse.success(
        c,
        await getRegistryVersionDetail({
          userId: getSessionUserId(session),
          teamId: "",
          workspaceId: "",
          catalogId: c.req.param("skillId"),
          versionId: c.req.param("versionId"),
        }),
      );
    },
  );
  app.put("/v1/skills/registry/admin/skills/:skillId/visibility", async (c) => {
    const session = await requireSkillRegistryAdmin(c);
    const parsed = z
      .object({ visibility: z.enum(["public", "restricted"]) })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success) throw ApiError.validation();
    const input = {
      skillId: c.req.param("skillId"),
      actorUserId: getSessionUserId(session),
      visibility: parsed.data.visibility,
    };
    const result = await setRegistryVisibility(input);
    if (!result) throw ApiError.notFound();
    logger.info("Registry skill visibility changed", input);
    return ApiResponse.success(c, result);
  });
}
