import { z } from "zod";
import {
  setSkillMarketCategoriesRequestSchema,
  setSkillMarketVerifiedRequestSchema,
} from "@sourceweft/contracts";
import { logger } from "../../shared/logger";
import { getRegistryVersionDetail } from "../../modules/skills/registry/versions";
import type { Hono } from "hono";
import { isMarketAdmin } from "../../modules/market/admin";
import {
  listRegistryReviewQueue,
  setRegistrySkillVersionStatus,
} from "../../modules/skills/registry/review";
import {
  delistSkill,
  listSkillPublicly,
  releaseSkillListingHold,
  setSkillCategories,
  setSkillVerified,
} from "../../modules/skills/market/listing";
import { listSkillListingQueue } from "../../modules/skills/market/auto-list";
import { getSkillMarketStanding } from "../../modules/skills/market/standing";
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

  // Published skills carrying an advisory flag: usable by their importer, but
  // going public is this admin's call (`market/auto-list.ts`).
  app.get("/v1/skills/registry/admin/listing-queue", async (c) => {
    await requireSkillRegistryAdmin(c);
    return ApiResponse.success(c, { items: await listSkillListingQueue() });
  });

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

  // --- A skill's standing on the market -----------------------------------
  // Every action below answers with the standing as stored afterwards, and
  // 404s for anything that is not an active registry skill.

  async function requireStanding(skillId: string) {
    const standing = await getSkillMarketStanding(skillId);
    if (!standing) throw ApiError.notFound("No such registry skill");
    return standing;
  }

  // Listing and withdrawing are the same two acts whichever route asks for
  // them. Listing by hand is also the admin lifting their own hold: left in
  // place, the hold would be a lie about a skill that is public again.
  async function listOnMarket(input: { skillId: string; actorUserId: string }) {
    await requireStanding(input.skillId);
    await releaseSkillListingHold({ skillId: input.skillId });
    if (!(await listSkillPublicly(input))) throw ApiError.notFound();
    logger.info("Registry skill listed on the market", input);
    return requireStanding(input.skillId);
  }
  async function withdrawFromMarket(input: {
    skillId: string;
    actorUserId: string;
  }) {
    await requireStanding(input.skillId);
    if (!(await delistSkill(input))) throw ApiError.notFound();
    logger.info("Registry skill withdrawn from the market", input);
    return requireStanding(input.skillId);
  }

  app.get("/v1/skills/registry/admin/skills/:skillId/market", async (c) => {
    await requireSkillRegistryAdmin(c);
    return ApiResponse.success(c, await requireStanding(c.req.param("skillId")));
  });

  app.post("/v1/skills/registry/admin/skills/:skillId/list", async (c) => {
    const session = await requireSkillRegistryAdmin(c);
    return ApiResponse.success(
      c,
      await listOnMarket({
        skillId: c.req.param("skillId"),
        actorUserId: getSessionUserId(session),
      }),
    );
  });

  app.post("/v1/skills/registry/admin/skills/:skillId/delist", async (c) => {
    const session = await requireSkillRegistryAdmin(c);
    return ApiResponse.success(
      c,
      await withdrawFromMarket({
        skillId: c.req.param("skillId"),
        actorUserId: getSessionUserId(session),
      }),
    );
  });

  app.put("/v1/skills/registry/admin/skills/:skillId/verified", async (c) => {
    const session = await requireSkillRegistryAdmin(c);
    const parsed = setSkillMarketVerifiedRequestSchema.safeParse(
      await c.req.json().catch(() => { throw ApiError.invalidJson(); }),
    );
    if (!parsed.success) throw ApiError.validation();
    const input = {
      skillId: c.req.param("skillId"),
      verified: parsed.data.verified,
    };
    await requireStanding(input.skillId);
    if (!(await setSkillVerified(input))) throw ApiError.notFound();
    logger.info("Registry skill verified grant changed", {
      actorUserId: getSessionUserId(session),
      ...input,
    });
    return ApiResponse.success(c, await requireStanding(input.skillId));
  });

  app.put("/v1/skills/registry/admin/skills/:skillId/categories", async (c) => {
    const session = await requireSkillRegistryAdmin(c);
    const parsed = setSkillMarketCategoriesRequestSchema.safeParse(
      await c.req.json().catch(() => { throw ApiError.invalidJson(); }),
    );
    if (!parsed.success) throw ApiError.validation();
    const input = {
      skillId: c.req.param("skillId"),
      categorySlugs: parsed.data.categorySlugs,
    };
    await requireStanding(input.skillId);
    if (!(await setSkillCategories(input))) throw ApiError.notFound();
    logger.info("Registry skill categories changed", {
      actorUserId: getSessionUserId(session),
      ...input,
    });
    return ApiResponse.success(c, await requireStanding(input.skillId));
  });

  // The older form of list/delist, kept for its callers. It goes through the
  // same two functions, so "public" cannot leave a hold behind and
  // "restricted" cannot skip setting one — the auto-listing pass would
  // otherwise put a skill an admin just restricted straight back.
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
    };
    return ApiResponse.success(
      c,
      parsed.data.visibility === "public"
        ? await listOnMarket(input)
        : await withdrawFromMarket(input),
    );
  });
}
