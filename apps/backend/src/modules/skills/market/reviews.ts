import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillMarketEvents,
  skillRepoClaims,
  skillReviews,
  skillVersions,
} from "@sourceweft/db";
import type {
  ListSkillReviewsRequest,
  ListSkillReviewsResponse,
  SkillReview,
  SkillReviewSort,
  SkillReviewSummary,
  SkillReviewViewer,
} from "@sourceweft/contracts";
import { ContentError } from "../../content/errors";
import { findUserIdentitiesByIds } from "../../workspace/store";
import { recordSkillMarketEvent } from "./events";
import { skillRankScoreSql } from "./rank";
import { publicMarketSkillCondition } from "./read-repository";

/**
 * Ratings and reviews of market skills (skill-marketplace-plan §17.3).
 *
 * One review per person per skill, editable. Only someone whose workspace
 * installed the skill may write one, so a rating comes from someone who had it
 * in hand. The repository's claimed author may answer each review once; a
 * market admin may hide a review, which takes it out of every count and every
 * public page — its author still sees it, marked hidden.
 *
 * `skill_definitions.rating_count/rating_avg` are copies of the visible
 * reviews, kept so the catalog and the rank score need no join: the scheduler
 * recomputes them all (`refreshSkillRatings`), and every change here
 * recomputes its one skill at once.
 */

// A person writes at most this many reviews (edits and deletions included)
// per hour. Generous for anyone reviewing what they use, and a ceiling on a
// script that is not.
export const SKILL_REVIEW_WRITES_PER_HOUR = 10;

// Actions a person's own review writes record (`skill_market_events`). The
// rate limit counts them, which is why the event commits with the write.
const REVIEW_WRITE_ACTIONS = ["review.written", "review.deleted"] as const;

type ReviewViewer = { userId: string; isMarketAdmin: boolean } | null;

type ReviewSkill = {
  id: string;
  sourceType: string;
  status: string;
  visibility: string;
  ownerUserId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  isPublic: boolean;
};

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/**
 * Workspaces the user is in on the content plane, the rule
 * `resolveWorkspaceAccessRecord` applies: an organization member is in the
 * organization's default workspace and in any other they were added to; a
 * guest is in the workspaces they were invited to. `w` is the workspace.
 */
function userInWorkspaceSql(userId: string): SQL {
  return sql`(
    exists (
      select 1 from member m
      where m."organizationId" = w.organization_id and m."userId" = ${userId}
        and (w.is_default or exists (
          select 1 from workspace_memberships wm
          where wm.workspace_id = w.id and wm.user_id = ${userId}
        ))
    )
    or exists (
      select 1 from workspace_memberships wm
      where wm.workspace_id = w.id and wm.user_id = ${userId}
        and wm.source = 'guest'
        and not exists (
          select 1 from member m
          where m."organizationId" = w.organization_id and m."userId" = ${userId}
        )
    )
  )`;
}

/** A workspace the user is in has the skill installed. */
function installedByUserSql(skillId: string, userId: string): SQL {
  return sql`exists (
    select 1 from workspace_skills ws
    join workspaces w on w.id = ws.workspace_id
    where ws.skill_id = ${skillId} and ${userInWorkspaceSql(userId)}
  )`;
}

/**
 * A workspace the user is in holds a live grant to the skill — the other way
 * besides installing it that a `restricted` skill reaches a workspace
 * (`skillEntitlementScopeCondition`).
 */
function entitledUserSql(skillId: string, userId: string): SQL {
  return sql`exists (
    select 1 from skill_entitlements e
    join workspaces w
      on (e.workspace_id is not null and w.id = e.workspace_id)
      or (e.workspace_id is null and w.organization_id = e.team_id)
    where e.skill_id = ${skillId}
      and (e.expires_at is null or e.expires_at > now())
      and ${userInWorkspaceSql(userId)}
  )`;
}

async function hasInstalled(skillId: string, userId: string) {
  const result = await db.execute<{ ok: boolean }>(
    sql`select ${installedByUserSql(skillId, userId)} as ok`,
  );
  return result.rows?.[0]?.ok === true;
}

async function holdsVerifiedClaim(skill: ReviewSkill, userId: string) {
  if (!skill.repoOwner || !skill.repoName) return false;
  const [row] = await db
    .select({ id: skillRepoClaims.id })
    .from(skillRepoClaims)
    .where(
      and(
        eq(skillRepoClaims.repoOwner, skill.repoOwner),
        eq(skillRepoClaims.repoName, skill.repoName),
        eq(skillRepoClaims.status, "verified"),
        eq(skillRepoClaims.userId, userId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

function isReviewable(skill: ReviewSkill) {
  return skill.sourceType === "registry_github" && skill.status === "active";
}

async function findSkillBySlug(slug: string): Promise<ReviewSkill | null> {
  const [row] = await db
    .select({
      id: skillDefinitions.id,
      sourceType: skillDefinitions.sourceType,
      status: skillDefinitions.status,
      visibility: skillDefinitions.visibility,
      ownerUserId: skillDefinitions.ownerUserId,
      repoOwner: skillDefinitions.repoOwner,
      repoName: skillDefinitions.repoName,
      // The public market's own predicate, so this page is public exactly
      // when the skill's page is. Null (no current version) is not public.
      isPublic: sql<boolean>`coalesce(${publicMarketSkillCondition()}, false)`,
    })
    .from(skillDefinitions)
    .leftJoin(
      skillVersions,
      and(
        eq(skillVersions.skillId, skillDefinitions.id),
        eq(skillVersions.isCurrent, true),
      ),
    )
    .where(eq(skillDefinitions.slug, slug))
    .limit(1);
  return row ?? null;
}

/**
 * Whether the viewer may read this skill's reviews: anyone when the skill is
 * on the public market; for a `restricted` community skill, a signed-in
 * viewer who could see it in the dashboard — its submitter, a market admin,
 * or someone in a workspace that installed it or holds a grant to it.
 */
async function canReadReviews(skill: ReviewSkill, viewer: ReviewViewer) {
  if (skill.isPublic) return true;
  if (!viewer || !isReviewable(skill) || skill.visibility !== "restricted") {
    return false;
  }
  if (viewer.isMarketAdmin || skill.ownerUserId === viewer.userId) return true;
  const result = await db.execute<{ ok: boolean }>(
    sql`select (${installedByUserSql(skill.id, viewer.userId)} or ${entitledUserSql(skill.id, viewer.userId)}) as ok`,
  );
  return result.rows?.[0]?.ok === true;
}

function skillNotFound() {
  return new ContentError(404, "SKILL_NOT_FOUND", "Skill not found");
}

function reviewNotFound() {
  return new ContentError(404, "SKILL_REVIEW_NOT_FOUND", "Review not found");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * `created_at` as whole microseconds since the epoch: the cursor has to carry
 * the key exactly, and a JS Date would round it to milliseconds and skip the
 * rows inside the rounding (see `catalog-query.ts`).
 */
const createdAtMicros = sql<string>`(extract(epoch from ${skillReviews.createdAt}) * 1000000)::bigint`;

type ReviewCursor = { rating: number; micros: string; id: string };

export function encodeSkillReviewCursor(
  sort: SkillReviewSort,
  cursor: ReviewCursor,
): string {
  return Buffer.from(
    JSON.stringify([sort, cursor.rating, cursor.micros, cursor.id]),
  ).toString("base64url");
}

/** Null for anything that is not a cursor of this sort. */
export function decodeSkillReviewCursor(
  sort: SkillReviewSort,
  value: string,
): ReviewCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return null;
  const [cursorSort, rating, micros, id] = parsed;
  return cursorSort === sort &&
    Number.isInteger(rating) &&
    rating >= 1 &&
    rating <= 5 &&
    typeof micros === "string" &&
    /^-?\d{1,18}$/.test(micros) &&
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128
    ? { rating, micros, id }
    : null;
}

/**
 * Newest first; or by rating, newest first within a rating. Every order ends
 * in the id, so it is total and a keyset resumes it exactly.
 */
function reviewOrder(sort: SkillReviewSort): SQL[] {
  const tail = [desc(skillReviews.createdAt), desc(skillReviews.id)];
  switch (sort) {
    case "newest":
      return tail;
    case "highest":
      return [desc(skillReviews.rating), ...tail];
    case "lowest":
      return [asc(skillReviews.rating), ...tail];
  }
}

/** "Strictly after this row", in `reviewOrder(sort)`. */
function reviewKeyset(sort: SkillReviewSort, cursor: ReviewCursor): SQL {
  const rest = sql`(${createdAtMicros}, ${skillReviews.id}) < (${cursor.micros}::bigint, ${cursor.id})`;
  switch (sort) {
    case "newest":
      return rest;
    case "highest":
      return sql`(${skillReviews.rating} < ${cursor.rating}::int or (${skillReviews.rating} = ${cursor.rating}::int and ${rest}))`;
    case "lowest":
      return sql`(${skillReviews.rating} > ${cursor.rating}::int or (${skillReviews.rating} = ${cursor.rating}::int and ${rest}))`;
  }
}

const reviewColumns = {
  id: skillReviews.id,
  userId: skillReviews.userId,
  rating: skillReviews.rating,
  body: skillReviews.body,
  status: skillReviews.status,
  authorReply: skillReviews.authorReply,
  authorReplyAt: skillReviews.authorReplyAt,
  createdAt: skillReviews.createdAt,
  updatedAt: skillReviews.updatedAt,
  createdAtMicros,
  version: skillVersions.version,
};

type ReviewRow = {
  id: string;
  userId: string;
  rating: number;
  body: string;
  status: "visible" | "hidden";
  authorReply: string | null;
  authorReplyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdAtMicros: string;
  version: string | null;
};

function selectReviews(where: SQL | undefined) {
  return db
    .select(reviewColumns)
    .from(skillReviews)
    .leftJoin(skillVersions, eq(skillVersions.id, skillReviews.skillVersionId))
    .where(where);
}

/** Reviewers by name and avatar, in one query for the whole page. */
async function toReviews(rows: ReviewRow[]): Promise<SkillReview[]> {
  const ids = [...new Set(rows.map((row) => row.userId))];
  const identities = new Map(
    (await findUserIdentitiesByIds(ids)).map((identity) => [
      identity.userId,
      identity,
    ]),
  );
  return rows.map((row) => {
    const identity = identities.get(row.userId);
    return {
      id: row.id,
      rating: row.rating,
      body: row.body,
      status: row.status,
      version: row.version,
      reviewer: {
        name: identity?.name ?? null,
        image: identity?.image ?? null,
      },
      authorReply:
        row.authorReply !== null && row.authorReplyAt !== null
          ? {
              body: row.authorReply,
              createdAt: row.authorReplyAt.toISOString(),
            }
          : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

async function findOwnReview(
  skillId: string,
  userId: string,
): Promise<SkillReview | null> {
  const rows = await selectReviews(
    and(eq(skillReviews.skillId, skillId), eq(skillReviews.userId, userId)),
  ).limit(1);
  const [review] = await toReviews(rows);
  return review ?? null;
}

/** Count, average and the count at each star, over visible reviews. */
export async function summarizeSkillReviews(
  skillId: string,
): Promise<SkillReviewSummary> {
  const rows = await db
    .select({
      rating: skillReviews.rating,
      count: sql<number>`count(*)::int`,
    })
    .from(skillReviews)
    .where(
      and(
        eq(skillReviews.skillId, skillId),
        eq(skillReviews.status, "visible"),
      ),
    )
    .groupBy(skillReviews.rating);
  const distribution = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let count = 0;
  let total = 0;
  for (const row of rows) {
    const key = String(row.rating) as keyof typeof distribution;
    if (!(key in distribution)) continue;
    distribution[key] = row.count;
    count += row.count;
    total += row.count * row.rating;
  }
  return {
    count,
    average: count > 0 ? total / count : null,
    distribution,
  };
}

/**
 * One page of a skill's visible reviews, their summary, and where the viewer
 * stands. Null when the viewer may not read the skill at all — not there, not
 * public and not theirs to see are one answer.
 */
export async function listSkillReviews(input: {
  slug: string;
  viewer: ReviewViewer;
  request: ListSkillReviewsRequest;
}): Promise<ListSkillReviewsResponse | null> {
  const skill = await findSkillBySlug(input.slug);
  if (!skill || !(await canReadReviews(skill, input.viewer))) return null;

  const { sort, limit } = input.request;
  let keyset: SQL | undefined;
  if (input.request.cursor !== undefined) {
    const cursor = decodeSkillReviewCursor(sort, input.request.cursor);
    if (!cursor) {
      throw new ContentError(
        400,
        "SKILL_REVIEW_CURSOR_INVALID",
        "Invalid reviews cursor",
      );
    }
    keyset = reviewKeyset(sort, cursor);
  }

  const viewer = input.viewer;
  const [rows, summary, ownReview, installed, canReply] = await Promise.all([
    selectReviews(
      and(
        eq(skillReviews.skillId, skill.id),
        eq(skillReviews.status, "visible"),
        keyset,
      ),
    )
      .orderBy(...reviewOrder(sort))
      .limit(limit + 1),
    summarizeSkillReviews(skill.id),
    viewer ? findOwnReview(skill.id, viewer.userId) : null,
    viewer && isReviewable(skill)
      ? hasInstalled(skill.id, viewer.userId)
      : false,
    viewer ? holdsVerifiedClaim(skill, viewer.userId) : false,
  ]);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeSkillReviewCursor(sort, {
          rating: last.rating,
          micros: String(last.createdAtMicros),
          id: last.id,
        })
      : null;

  let viewerState: SkillReviewViewer;
  if (!viewer) {
    viewerState = { canReview: false, reason: "signed_out", canReply: false };
  } else {
    viewerState = {
      canReview: installed,
      ...(installed ? {} : { reason: "not_installed" as const }),
      canReply,
      ...(ownReview ? { ownReview } : {}),
    };
  }

  return {
    items: await toReviews(page),
    nextCursor,
    summary,
    viewer: viewerState,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Holds the user's write lock for the transaction and refuses a write past
 * `SKILL_REVIEW_WRITES_PER_HOUR`. The lock makes two concurrent writes count
 * each other.
 */
async function assertWithinWriteLimit(tx: Tx, userId: string) {
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtext('sourceweft:skill-review-writes'),
      hashtext(${userId})
    )
  `);
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(skillMarketEvents)
    .where(
      and(
        eq(skillMarketEvents.actorUserId, userId),
        eq(skillMarketEvents.actorKind, "user"),
        sql`${skillMarketEvents.action} in (${sql.join(
          REVIEW_WRITE_ACTIONS.map((action) => sql`${action}`),
          sql`, `,
        )})`,
        sql`${skillMarketEvents.createdAt} > now() - interval '1 hour'`,
      ),
    );
  if ((row?.count ?? 0) >= SKILL_REVIEW_WRITES_PER_HOUR) {
    throw new ContentError(
      429,
      "SKILL_REVIEW_RATE_LIMITED",
      "Too many review changes. Try again later.",
      { details: { limitPerHour: SKILL_REVIEW_WRITES_PER_HOUR } },
    );
  }
}

/** Recomputes the one skill's rating copy and, from it, its rank score. */
async function refreshOneSkill(skillId: string) {
  await refreshSkillRatings({ skillId });
  await db.execute(sql`
    update skill_definitions
    set rank_score = ${skillRankScoreSql}
    where id = ${skillId} and rank_score <> ${skillRankScoreSql}
  `);
}

/**
 * Creates or replaces the user's review of a skill. Refused unless the skill
 * is an active community skill and a workspace the user is in installed it.
 * Editing keeps a hidden review hidden, and keeps the author's reply.
 */
export async function upsertMySkillReview(input: {
  slug: string;
  userId: string;
  rating: number;
  body: string;
}): Promise<SkillReview> {
  const skill = await findSkillBySlug(input.slug);
  if (!skill || !isReviewable(skill)) throw skillNotFound();
  if (!(await hasInstalled(skill.id, input.userId))) {
    // Someone who cannot see the skill learns nothing more than a 404 tells.
    if (
      !(await canReadReviews(skill, {
        userId: input.userId,
        isMarketAdmin: false,
      }))
    ) {
      throw skillNotFound();
    }
    throw new ContentError(
      403,
      "SKILL_REVIEW_NOT_INSTALLED",
      "Only someone whose workspace installed this skill can review it",
    );
  }

  await db.transaction(async (tx) => {
    await assertWithinWriteLimit(tx, input.userId);
    const [current] = await tx
      .select({ id: skillVersions.id })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, skill.id),
          eq(skillVersions.isCurrent, true),
        ),
      )
      .limit(1);
    const [row] = await tx
      .insert(skillReviews)
      .values({
        id: randomUUID(),
        skillId: skill.id,
        userId: input.userId,
        skillVersionId: current?.id ?? null,
        rating: input.rating,
        body: input.body,
      })
      .onConflictDoUpdate({
        target: [skillReviews.skillId, skillReviews.userId],
        set: {
          skillVersionId: current?.id ?? null,
          rating: input.rating,
          body: input.body,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: skillReviews.id,
        // A fresh row's timestamps are equal; an update moved `updated_at`.
        created: sql<boolean>`${skillReviews.createdAt} = ${skillReviews.updatedAt}`,
      });
    await recordSkillMarketEvent(
      {
        skillId: skill.id,
        actorKind: "user",
        actorUserId: input.userId,
        action: "review.written",
        detail: {
          reviewId: row!.id,
          rating: input.rating,
          created: row!.created,
          skillVersionId: current?.id ?? null,
        },
      },
      tx,
    );
  });
  await refreshOneSkill(skill.id);

  const review = await findOwnReview(skill.id, input.userId);
  if (!review) throw reviewNotFound();
  return review;
}

/**
 * Deletes the user's own review of a skill. False when there was none. Needs
 * no install: anyone may take back what they wrote.
 */
export async function deleteMySkillReview(input: {
  slug: string;
  userId: string;
}): Promise<boolean> {
  const skill = await findSkillBySlug(input.slug);
  if (!skill) throw skillNotFound();
  const deleted = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(skillReviews)
      .where(
        and(
          eq(skillReviews.skillId, skill.id),
          eq(skillReviews.userId, input.userId),
        ),
      )
      .returning({ id: skillReviews.id, rating: skillReviews.rating });
    if (!row) return false;
    // After the delete, so a user with nothing to delete is never limited;
    // a refusal rolls the delete back.
    await assertWithinWriteLimit(tx, input.userId);
    await recordSkillMarketEvent(
      {
        skillId: skill.id,
        actorKind: "user",
        actorUserId: input.userId,
        action: "review.deleted",
        detail: { reviewId: row.id, rating: row.rating },
      },
      tx,
    );
    return true;
  });
  if (deleted) await refreshOneSkill(skill.id);
  return deleted;
}

/**
 * The repository's claimed author answers a review, replacing any earlier
 * answer; `body: null` removes it. Only the holder of the verified claim on
 * the skill's repository may, and only on a visible review.
 */
export async function setSkillReviewReply(input: {
  slug: string;
  reviewId: string;
  userId: string;
  body: string | null;
}): Promise<SkillReview> {
  const skill = await findSkillBySlug(input.slug);
  if (!skill || !isReviewable(skill)) throw skillNotFound();
  if (!(await holdsVerifiedClaim(skill, input.userId))) {
    throw new ContentError(
      403,
      "SKILL_REVIEW_REPLY_FORBIDDEN",
      "Only the verified author of this skill's repository can reply",
    );
  }
  const reply =
    input.body === null
      ? { authorReply: null, authorReplyBy: null, authorReplyAt: null }
      : {
          authorReply: input.body,
          authorReplyBy: input.userId,
          authorReplyAt: sql`now()`,
        };
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(skillReviews)
      .set(reply)
      .where(
        and(
          eq(skillReviews.id, input.reviewId),
          eq(skillReviews.skillId, skill.id),
          eq(skillReviews.status, "visible"),
        ),
      )
      .returning({ id: skillReviews.id });
    if (!row) return false;
    await recordSkillMarketEvent(
      {
        skillId: skill.id,
        repo:
          skill.repoOwner && skill.repoName
            ? { owner: skill.repoOwner, name: skill.repoName }
            : null,
        actorKind: "owner",
        actorUserId: input.userId,
        action: input.body === null ? "review.reply_removed" : "review.replied",
        detail: { reviewId: row.id },
      },
      tx,
    );
    return true;
  });
  if (!updated) throw reviewNotFound();

  const rows = await selectReviews(eq(skillReviews.id, input.reviewId)).limit(
    1,
  );
  const [review] = await toReviews(rows);
  if (!review) throw reviewNotFound();
  return review;
}

// ---------------------------------------------------------------------------
// Moderation and aggregates
// ---------------------------------------------------------------------------

/**
 * A market admin hides a review (or shows it again). Records the audit event.
 * Null when there is no such review. Used by the reports queue too.
 */
export async function setSkillReviewStatus(input: {
  reviewId: string;
  status: "visible" | "hidden";
  actorUserId: string;
  reason?: string;
}): Promise<{
  reviewId: string;
  skillId: string;
  status: "visible" | "hidden";
} | null> {
  const hiding = input.status === "hidden";
  const result = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ skillId: skillReviews.skillId, status: skillReviews.status })
      .from(skillReviews)
      .where(eq(skillReviews.id, input.reviewId))
      .for("update")
      .limit(1);
    if (!before) return null;
    // Already so: nothing to change and nothing to record.
    if (before.status === input.status) {
      return { skillId: before.skillId, changed: false };
    }
    await tx
      .update(skillReviews)
      .set({
        status: input.status,
        hiddenBy: hiding ? input.actorUserId : null,
        hiddenAt: hiding ? sql`now()` : null,
      })
      .where(eq(skillReviews.id, input.reviewId));
    await recordSkillMarketEvent(
      {
        skillId: before.skillId,
        actorKind: "admin",
        actorUserId: input.actorUserId,
        action: hiding ? "review.hidden" : "review.shown",
        detail: {
          reviewId: input.reviewId,
          before: before.status,
          after: input.status,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      },
      tx,
    );
    return { skillId: before.skillId, changed: true };
  });
  if (!result) return null;
  if (result.changed) await refreshOneSkill(result.skillId);
  return {
    reviewId: input.reviewId,
    skillId: result.skillId,
    status: input.status,
  };
}

/**
 * Recomputes `skill_definitions.rating_count/rating_avg` from visible reviews
 * — for every skill, or for one. A skill with none gets 0 and null. Only rows
 * whose numbers changed are written. The scheduler runs it before the rank
 * refresh, which reads both columns.
 */
export async function refreshSkillRatings(
  input: { skillId?: string } = {},
): Promise<{ updated: number }> {
  const only = input.skillId ? sql`where s.id = ${input.skillId}` : sql``;
  const result = await db.execute(sql`
    update skill_definitions d
    set rating_count = c.reviews, rating_avg = c.average
    from (
      select s.id, count(r.id)::int as reviews, avg(r.rating)::float8 as average
      from skill_definitions s
      left join skill_reviews r on r.skill_id = s.id and r.status = 'visible'
      ${only}
      group by s.id
    ) c
    where d.id = c.id
      and (d.rating_count <> c.reviews or d.rating_avg is distinct from c.average)
  `);
  return { updated: result.rowCount ?? 0 };
}
