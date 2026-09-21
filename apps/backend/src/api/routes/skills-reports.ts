import type { Context, Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  createSkillReportRequestSchema,
  createSkillReportResponseSchema,
  listSkillReportsRequestSchema,
  listSkillReportsResponseSchema,
  resolveSkillReportRequestSchema,
  resolveSkillReportResponseSchema,
} from "@sourceweft/contracts";
import {
  createSkillReport,
  listSkillReports,
  notifySkillReportAdmins,
  resolveSkillReport,
} from "../../modules/skills/market/reports";
import { logger } from "../../shared/logger";
import { getSessionUserId, requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";
import { requireSkillMarketAdmin } from "./skills-market-admin";
import { RESERVED_MARKET_SKILL_SLUGS } from "./skills-public";

/**
 * Skill market reports (skill-marketplace-plan §17.2): anyone reporting a
 * skill or one of its reviews, and the market admins' queue of reports.
 */

// Longer than any slug the registry derives; the same bound as the public
// detail route.
const MAX_SLUG_LENGTH = 256;

/**
 * The sender's address for the report limits. The same order of trust as the
 * public share view counter (`public-shares.ts`): headers our own edge sets —
 * Cloudflare's `cf-connecting-ip`, then `x-real-ip` — then the RIGHT-most
 * X-Forwarded-For hop, which a caller cannot choose (they can only prepend on
 * the left), then the socket. Unknown senders share one bucket, which only
 * makes the limit stricter for them.
 */
export function skillReportClientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;
  const hops = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const rightMost = hops[hops.length - 1];
  if (rightMost) return rightMost;
  try {
    const remote = getConnInfo(c).remote.address;
    if (remote) return remote.replace(/^::ffff:/, "");
  } catch {
    // Not served by the node adapter (tests); fall through.
  }
  return "unknown";
}

/** A query parameter that was left empty was not given. */
function given(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

async function jsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => {
    throw ApiError.invalidJson();
  });
}

export function registerSkillReportRoutes(app: Hono) {
  // Signed in or not. Not public, not there and not reportable are one 404,
  // so a report never confirms that a private skill exists.
  app.post("/v1/skills/:slug/reports", async (c) => {
    const slug = c.req.param("slug");
    const parsed = createSkillReportRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    const session = await requireSession(c);
    const reporterUserId = session ? getSessionUserId(session) : null;
    if (!reporterUserId && !parsed.data.contactEmail) {
      throw new ApiError(
        400,
        "SKILL_REPORT_CONTACT_REQUIRED",
        "An email address is required to report without signing in",
      );
    }
    if (
      RESERVED_MARKET_SKILL_SLUGS.has(slug) ||
      slug.length > MAX_SLUG_LENGTH
    ) {
      throw ApiError.notFound("Skill not found");
    }

    const result = await createSkillReport({
      slug,
      reason: parsed.data.reason,
      details: parsed.data.details,
      contactEmail: parsed.data.contactEmail,
      reviewId: parsed.data.reviewId,
      reporterUserId,
      clientIp: skillReportClientIp(c),
    });
    if (!result.ok) {
      switch (result.reason) {
        case "contact_required":
          throw new ApiError(
            400,
            "SKILL_REPORT_CONTACT_REQUIRED",
            "An email address is required to report without signing in",
          );
        case "skill_not_found":
          throw ApiError.notFound("Skill not found");
        case "review_not_found":
          throw new ApiError(
            404,
            "SKILL_REVIEW_NOT_FOUND",
            "No such review of this skill",
          );
        case "rate_limited":
          c.header("Retry-After", String(result.retryAfterSeconds));
          throw new ApiError(
            429,
            "SKILL_REPORT_RATE_LIMITED",
            "Too many reports; try again later",
            { retryAfterSeconds: result.retryAfterSeconds },
          );
      }
    }

    logger.info("Skill report received", {
      reportId: result.report.id,
      skillId: result.skill.skillId,
      reason: parsed.data.reason,
      aboutReview: !!parsed.data.reviewId,
      signedIn: !!reporterUserId,
    });
    // Fire and forget: the report is stored, and the admin queue shows it
    // whether or not the mail goes out.
    void notifySkillReportAdmins({
      reportId: result.report.id,
      skill: result.skill,
      reason: parsed.data.reason,
      details: parsed.data.details,
      aboutReview: !!parsed.data.reviewId,
    });
    return ApiResponse.success(
      c,
      createSkillReportResponseSchema.parse(result.report),
      201,
    );
  });

  app.get("/v1/skills/registry/admin/reports", async (c) => {
    await requireSkillMarketAdmin(c);
    const limit = given(c.req.query("limit"));
    const parsed = listSkillReportsRequestSchema.safeParse({
      status: given(c.req.query("status")),
      cursor: given(c.req.query("cursor")),
      limit: limit === undefined ? undefined : Number(limit),
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    return ApiResponse.success(
      c,
      listSkillReportsResponseSchema.parse(await listSkillReports(parsed.data)),
    );
  });

  app.post("/v1/skills/registry/admin/reports/:reportId/resolve", async (c) => {
    const session = await requireSkillMarketAdmin(c);
    const parsed = resolveSkillReportRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    const actorUserId = getSessionUserId(session);
    const result = await resolveSkillReport({
      reportId: c.req.param("reportId"),
      ...parsed.data,
      actorUserId,
    });
    if (!result) throw ApiError.notFound("No such report");
    logger.info("Skill report resolved", { actorUserId, ...result });
    return ApiResponse.success(
      c,
      resolveSkillReportResponseSchema.parse(result),
    );
  });
}
