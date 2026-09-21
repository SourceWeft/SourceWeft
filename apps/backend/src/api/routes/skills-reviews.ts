import type { Context, Hono } from "hono";
import {
  deleteSkillReviewResponseSchema,
  listSkillReviewsRequestSchema,
  listSkillReviewsResponseSchema,
  setSkillReviewReplyRequestSchema,
  setSkillReviewStatusRequestSchema,
  setSkillReviewStatusResponseSchema,
  skillReviewResponseSchema,
  upsertSkillReviewRequestSchema,
} from "@sourceweft/contracts";
import type { z } from "zod";
import { isMarketAdmin } from "../../modules/market/admin";
import {
  deleteMySkillReview,
  listSkillReviews,
  setSkillReviewReply,
  setSkillReviewStatus,
  upsertMySkillReview,
} from "../../modules/skills/market/reviews";
import { logger } from "../../shared/logger";
import { getSessionUserId, requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";
import { requireSkillMarketAdmin } from "./skills-market-admin";

/**
 * Skill market ratings and reviews (§17.3). The list is public but not
 * anonymous: a signed-in viewer also learns whether they may review, their
 * own review (hidden or not), and whether they may reply as the author — so
 * no response here is cacheable by anyone but the viewer.
 *
 * Keyed by slug, which is unique across skills, so the public page and the
 * dashboard use the same routes.
 */

// Longer than any slug the registry derives; past it there is nothing to find.
const MAX_SLUG_LENGTH = 256;
const MAX_ID_LENGTH = 128;

function slugParam(c: Context): string {
  const slug = c.req.param("slug") ?? "";
  if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH) {
    throw ApiError.notFound("Skill not found");
  }
  return slug;
}

function reviewIdParam(c: Context): string {
  const reviewId = decodeURIComponent(c.req.param("reviewId") ?? "");
  if (reviewId.length === 0 || reviewId.length > MAX_ID_LENGTH) {
    throw ApiError.notFound("Review not found");
  }
  return reviewId;
}

async function requireUserId(c: Context): Promise<string> {
  const session = await requireSession(c);
  if (!session) throw ApiError.unauthorized();
  return getSessionUserId(session);
}

async function parseBody<Schema extends z.ZodTypeAny>(
  c: Context,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const parsed = schema.safeParse(
    await c.req.json().catch(() => {
      throw ApiError.invalidJson();
    }),
  );
  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.flatten() as Record<string, unknown>,
    );
  }
  return parsed.data;
}

/** A query parameter that was left empty was not given. */
function given(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function privateJson(c: Context, body: unknown) {
  c.header("Cache-Control", "private, no-store");
  return ApiResponse.success(c, body);
}

export function registerSkillReviewRoutes(app: Hono) {
  app.get("/v1/skills/:slug/reviews", async (c) => {
    const slug = slugParam(c);
    const limit = given(c.req.query("limit"));
    const parsed = listSkillReviewsRequestSchema.safeParse({
      cursor: given(c.req.query("cursor")),
      // NaN for a limit that is not a number, which the schema refuses.
      limit: limit === undefined ? undefined : Number(limit),
      sort: given(c.req.query("sort")),
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    const session = await requireSession(c);
    const userId = session ? getSessionUserId(session) : null;
    const result = await listSkillReviews({
      slug,
      viewer: userId ? { userId, isMarketAdmin: isMarketAdmin(userId) } : null,
      request: parsed.data,
    });
    // Not public, not there and not the viewer's to see are one answer.
    if (!result) throw ApiError.notFound("Skill not found");
    return privateJson(c, listSkillReviewsResponseSchema.parse(result));
  });

  app.put("/v1/skills/:slug/reviews/mine", async (c) => {
    const userId = await requireUserId(c);
    const slug = slugParam(c);
    const body = await parseBody(c, upsertSkillReviewRequestSchema);
    const review = await upsertMySkillReview({ slug, userId, ...body });
    logger.info("Skill review written", {
      userId,
      slug,
      reviewId: review.id,
      rating: review.rating,
    });
    return privateJson(c, skillReviewResponseSchema.parse({ review }));
  });

  app.delete("/v1/skills/:slug/reviews/mine", async (c) => {
    const userId = await requireUserId(c);
    const slug = slugParam(c);
    const deleted = await deleteMySkillReview({ slug, userId });
    if (deleted) logger.info("Skill review deleted", { userId, slug });
    return privateJson(c, deleteSkillReviewResponseSchema.parse({ deleted }));
  });

  app.put("/v1/skills/:slug/reviews/:reviewId/reply", async (c) => {
    const userId = await requireUserId(c);
    const slug = slugParam(c);
    const reviewId = reviewIdParam(c);
    const { body } = await parseBody(c, setSkillReviewReplyRequestSchema);
    const review = await setSkillReviewReply({ slug, reviewId, userId, body });
    logger.info("Skill review answered by its author", {
      userId,
      slug,
      reviewId,
    });
    return privateJson(c, skillReviewResponseSchema.parse({ review }));
  });

  app.delete("/v1/skills/:slug/reviews/:reviewId/reply", async (c) => {
    const userId = await requireUserId(c);
    const slug = slugParam(c);
    const reviewId = reviewIdParam(c);
    const review = await setSkillReviewReply({
      slug,
      reviewId,
      userId,
      body: null,
    });
    logger.info("Skill review reply removed by its author", {
      userId,
      slug,
      reviewId,
    });
    return privateJson(c, skillReviewResponseSchema.parse({ review }));
  });

  app.post("/v1/skills/registry/admin/reviews/:reviewId/status", async (c) => {
    const session = await requireSkillMarketAdmin(c);
    const actorUserId = getSessionUserId(session);
    const reviewId = reviewIdParam(c);
    const body = await parseBody(c, setSkillReviewStatusRequestSchema);
    const result = await setSkillReviewStatus({
      reviewId,
      actorUserId,
      status: body.status,
      ...(body.reason ? { reason: body.reason } : {}),
    });
    if (!result) throw ApiError.notFound("Review not found");
    logger.info("Skill review moderated", { actorUserId, ...result });
    return ApiResponse.success(
      c,
      setSkillReviewStatusResponseSchema.parse(result),
    );
  });
}
