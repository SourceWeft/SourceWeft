import type { Hono } from "hono";
import {
  skillRunStatsFullSchema,
  skillRunStatsPublicSchema,
} from "@sourceweft/contracts";
import { isMarketAdmin } from "../../modules/market/admin";
import { getSkillMarketClaim } from "../../modules/skills/market/claims";
import {
  findRunStatsSkill,
  getFullSkillRunStats,
  getPublicSkillRunStats,
} from "../../modules/skills/market/run-stats";
import { getSessionUserId, requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";
import { cachedJson } from "../response/cached-json";
import { requireSkillMarketAdmin } from "./skills-market-admin";
import { RESERVED_MARKET_SKILL_SLUGS } from "./skills-public";

/**
 * Skill market sandbox run stats (§17.5).
 *
 * - `GET /v1/skills/:slug/run-stats` — anonymous and cacheable, public skills
 *   only. The numbers once they clear the floor of runs and workspaces,
 *   otherwise `{ available: false }`.
 * - `GET /v1/skills/:slug/run-stats?full=1` — the author holding the verified
 *   claim on the skill's repository, or a market admin: the numbers whatever
 *   their size, never cached.
 * - `GET /v1/skills/registry/admin/skills/:skillId/run-stats` — the same for
 *   market admins, by id.
 *
 * Counts only, on every route: no command, path or output was ever stored.
 */

const PUBLIC_MAX_AGE_SECONDS = 60;
const MAX_SLUG_LENGTH = 256;

export function registerSkillRunStatsRoutes(app: Hono) {
  app.get("/v1/skills/registry/admin/skills/:skillId/run-stats", async (c) => {
    await requireSkillMarketAdmin(c);
    const skill = await findRunStatsSkill({
      skillId: decodeURIComponent(c.req.param("skillId")),
    });
    if (!skill) {
      throw ApiError.notFound("No registry skill with this id");
    }
    c.header("cache-control", "private, no-store");
    return ApiResponse.success(
      c,
      skillRunStatsFullSchema.parse(await getFullSkillRunStats(skill.id)),
    );
  });

  app.get("/v1/skills/:slug/run-stats", async (c, next) => {
    const slug = c.req.param("slug");
    // `/v1/skills/collections/run-stats` is a collection, not this route.
    if (RESERVED_MARKET_SKILL_SLUGS.has(slug)) {
      return next();
    }
    const skill =
      slug.length > MAX_SLUG_LENGTH ? null : await findRunStatsSkill({ slug });
    const full = c.req.query("full");
    if (full === "1" || full === "true") {
      const session = await requireSession(c);
      if (!session) {
        throw ApiError.unauthorized();
      }
      const userId = getSessionUserId(session);
      const allowed =
        skill !== null &&
        (isMarketAdmin(userId) ||
          (await getSkillMarketClaim(skill.id))?.userId === userId);
      if (!allowed) {
        // A skill that is not public is not there for anyone else.
        if (!skill?.isPublic) {
          throw ApiError.notFound("Skill not found");
        }
        throw ApiError.forbidden(
          "Only the skill's verified author or a market admin sees full run stats",
        );
      }
      c.header("cache-control", "private, no-store");
      return ApiResponse.success(
        c,
        skillRunStatsFullSchema.parse(await getFullSkillRunStats(skill!.id)),
      );
    }
    // Not public, not there and not a skill are one 404.
    if (!skill?.isPublic) {
      throw ApiError.notFound("Skill not found");
    }
    return cachedJson(
      c,
      skillRunStatsPublicSchema.parse(await getPublicSkillRunStats(skill.id)),
      { maxAge: PUBLIC_MAX_AGE_SECONDS },
    );
  });
}
