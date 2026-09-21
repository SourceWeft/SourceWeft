import { createHmac, randomUUID } from "node:crypto";
import { and, desc, eq, gt, lt, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillReports,
  skillReviews,
  skillVersions,
  workspaceMemberships,
  workspaceSkills,
  type SkillReportReason,
  type SkillReportStatus,
} from "@sourceweft/db";
import type {
  ListSkillReportsResponse,
  SkillReportAction,
  SkillReportItem,
} from "@sourceweft/contracts";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import { ContentError } from "../../content/errors";
import { mailDeliveryConfigured } from "../../mail/delivery";
import { setRegistrySkillVersionStatus } from "../registry/review";
import { recordSkillMarketEvent } from "./events";
import { delistSkill } from "./listing";
import { publicMarketSkillCondition } from "./read-repository";
import { setSkillReviewStatus } from "./reviews";

/**
 * Reports about market skills and their reviews (skill-marketplace-plan
 * §17.2): anyone telling the market admins something is wrong, and the admins
 * deciding what to do about it.
 *
 * Submitting a report never changes the skill. Every consequence — withdrawing
 * the skill, revoking its version, hiding a review — is an admin's decision
 * made through the same functions the other admin routes use, and is recorded
 * in the market's audit trail (`report.actioned` / `report.dismissed`).
 */

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How many reports one address, and one account, may send. Counted from
 * `skill_reports` itself, so the limit holds across processes and restarts.
 */
export const SKILL_REPORT_LIMITS = [
  { windowMs: HOUR_MS, max: 5 },
  { windowMs: DAY_MS, max: 20 },
] as const;

/** One window's reports from one sender: how many, and the oldest. */
export type SkillReportWindowUsage = { count: number; oldestAt: Date | null };

/**
 * Null while the sender may report again; otherwise how long until the oldest
 * report of a full window leaves it. `usage` is aligned with
 * `SKILL_REPORT_LIMITS`.
 */
export function skillReportRetryAfterSeconds(
  usage: readonly SkillReportWindowUsage[],
  now: Date,
): number | null {
  let wait: number | null = null;
  SKILL_REPORT_LIMITS.forEach((limit, index) => {
    const window = usage[index];
    if (!window || window.count < limit.max) return;
    const freesAt =
      (window.oldestAt?.getTime() ?? now.getTime()) + limit.windowMs;
    const seconds = Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000));
    wait = Math.max(wait ?? 0, seconds);
  });
  return wait;
}

/**
 * The address a report came from, as stored: an HMAC under the deployment's
 * auth secret, so the column can count one sender's reports without holding
 * anyone's IP address or letting it be recovered by hashing the IPv4 space.
 */
export function hashSkillReporterIp(
  ip: string,
  secret: string = config.auth.secret,
): string {
  return createHmac("sha256", secret)
    .update(`skill-report-ip:${ip.trim().toLowerCase()}`)
    .digest("hex");
}

async function windowUsage(
  executor: Pick<typeof db, "select">,
  sender: SQL,
  now: Date,
): Promise<SkillReportWindowUsage[]> {
  const usage: SkillReportWindowUsage[] = [];
  for (const limit of SKILL_REPORT_LIMITS) {
    const [row] = await executor
      .select({
        count: sql<number>`count(*)::int`,
        oldestAt: sql<Date | string | null>`min(${skillReports.createdAt})`,
      })
      .from(skillReports)
      .where(
        and(
          sender,
          gt(skillReports.createdAt, new Date(now.getTime() - limit.windowMs)),
        ),
      );
    usage.push({
      count: Number(row?.count ?? 0),
      oldestAt: row?.oldestAt ? new Date(row.oldestAt) : null,
    });
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

/**
 * The skill a report may be about: an active registry skill that is on the
 * public market, or — for a signed-in reporter — one they imported or one a
 * workspace of theirs has installed. Anything else is null, the same null
 * whether it exists or not.
 */
export async function findReportableSkill(input: {
  slug: string;
  userId: string | null;
}): Promise<{ skillId: string; slug: string; displayName: string } | null> {
  const columns = {
    skillId: skillDefinitions.id,
    slug: skillDefinitions.slug,
    displayName: skillDefinitions.displayName,
  };
  const registrySkill = and(
    eq(skillDefinitions.slug, input.slug),
    eq(skillDefinitions.sourceType, "registry_github"),
    eq(skillDefinitions.status, "active"),
  );
  const [listed] = await db
    .select(columns)
    .from(skillDefinitions)
    .innerJoin(skillVersions, eq(skillVersions.skillId, skillDefinitions.id))
    .where(and(registrySkill, publicMarketSkillCondition()))
    .limit(1);
  if (listed) return listed;
  if (!input.userId) return null;
  const installedByMember = db
    .select({ one: sql`1` })
    .from(workspaceSkills)
    .innerJoin(
      workspaceMemberships,
      eq(workspaceMemberships.workspaceId, workspaceSkills.workspaceId),
    )
    .where(
      and(
        eq(workspaceSkills.skillId, skillDefinitions.id),
        eq(workspaceMemberships.userId, input.userId),
      ),
    );
  const [own] = await db
    .select(columns)
    .from(skillDefinitions)
    .where(
      and(
        registrySkill,
        or(
          eq(skillDefinitions.ownerUserId, input.userId),
          sql`exists (${installedByMember})`,
        ),
      ),
    )
    .limit(1);
  return own ?? null;
}

export type CreateSkillReportInput = {
  slug: string;
  reason: SkillReportReason;
  details: string;
  contactEmail?: string;
  reviewId?: string;
  reporterUserId: string | null;
  /** The sender's address; hashed before anything stores or counts it. */
  clientIp: string;
  now?: Date;
};

export type CreateSkillReportResult =
  | {
      ok: true;
      report: { id: string; status: "open"; createdAt: string };
      skill: { skillId: string; slug: string; displayName: string };
    }
  | {
      ok: false;
      reason: "contact_required" | "skill_not_found" | "review_not_found";
    }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number };

/**
 * Stores one report. A visitor who is not signed in must leave an address.
 * The limits are counted and the row written under one lock per sender, so
 * parallel requests cannot all squeeze under the same count.
 */
export async function createSkillReport(
  input: CreateSkillReportInput,
): Promise<CreateSkillReportResult> {
  if (!input.reporterUserId && !input.contactEmail) {
    return { ok: false, reason: "contact_required" };
  }
  const skill = await findReportableSkill({
    slug: input.slug,
    userId: input.reporterUserId,
  });
  if (!skill) return { ok: false, reason: "skill_not_found" };
  if (input.reviewId) {
    const [review] = await db
      .select({ id: skillReviews.id })
      .from(skillReviews)
      .where(
        and(
          eq(skillReviews.id, input.reviewId),
          eq(skillReviews.skillId, skill.skillId),
        ),
      )
      .limit(1);
    if (!review) return { ok: false, reason: "review_not_found" };
  }

  const ipHash = hashSkillReporterIp(input.clientIp);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // Always the address first, then the account: one order, no deadlock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"skill-report:ip:" + ipHash}))`,
    );
    if (input.reporterUserId) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"skill-report:user:" + input.reporterUserId}))`,
      );
    }
    const senders = [eq(skillReports.ipHash, ipHash)];
    if (input.reporterUserId) {
      senders.push(eq(skillReports.reporterUserId, input.reporterUserId));
    }
    let retryAfterSeconds = 0;
    for (const sender of senders) {
      const wait = skillReportRetryAfterSeconds(
        await windowUsage(tx, sender, now),
        now,
      );
      retryAfterSeconds = Math.max(retryAfterSeconds, wait ?? 0);
    }
    if (retryAfterSeconds > 0) {
      return {
        ok: false as const,
        reason: "rate_limited" as const,
        retryAfterSeconds,
      };
    }
    const [row] = await tx
      .insert(skillReports)
      .values({
        id: randomUUID(),
        skillId: skill.skillId,
        reviewId: input.reviewId ?? null,
        reason: input.reason,
        details: input.details,
        contactEmail: input.contactEmail ?? null,
        reporterUserId: input.reporterUserId,
        ipHash,
        createdAt: now,
      })
      .returning({ id: skillReports.id, createdAt: skillReports.createdAt });
    return {
      ok: true as const,
      report: {
        id: row!.id,
        status: "open" as const,
        createdAt: row!.createdAt.toISOString(),
      },
      skill,
    };
  });
}

// ---------------------------------------------------------------------------
// Telling the admins
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const NOTIFICATION_DETAILS_MAX_LENGTH = 1000;

/**
 * Mails the market admins about a new report, where this deployment can
 * deliver mail at all; where it cannot, the admin queue is the only place a
 * report shows up, which it does either way. Never throws: a report is stored
 * whether or not anyone was mailed about it.
 */
export async function notifySkillReportAdmins(input: {
  reportId: string;
  skill: { slug: string; displayName: string };
  reason: SkillReportReason;
  details: string;
  aboutReview: boolean;
}): Promise<void> {
  try {
    const adminIds = config.market.adminUserIds;
    if (!mailDeliveryConfigured() || adminIds.length === 0) return;
    const users = await db.execute<{ email: string | null }>(sql`
      select email from "user"
      where id in (${sql.join(
        adminIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    const to = (users.rows ?? [])
      .map((row) => row.email?.trim())
      .filter((email): email is string => !!email);
    if (to.length === 0) return;

    const target = input.aboutReview
      ? `a review of ${input.skill.displayName}`
      : input.skill.displayName;
    const details =
      input.details.length > NOTIFICATION_DETAILS_MAX_LENGTH
        ? `${input.details.slice(0, NOTIFICATION_DETAILS_MAX_LENGTH)}…`
        : input.details;
    const queueUrl = `${config.auth.webBaseUrl}/dashboard/admin/market`;
    const subject = `[SourceWeft] Skill report (${input.reason}): ${target}`;
    const lines = [
      `A ${input.reason} report about ${target} (${input.skill.slug}) is waiting in the market admin queue.`,
      details ? `Details: ${details}` : "No details were given.",
      `Report: ${input.reportId}`,
      queueUrl,
    ];
    // Lazily, as the auth module does: the mail provider is built on import.
    const { mailService } = await import("../../mail/service");
    // One message per admin, so no admin's address is shown to the others.
    await Promise.all(
      to.map((email) =>
        mailService.send({
          to: email,
          subject,
          text: lines.join("\n\n"),
          html: lines
            .map((line, index) =>
              index === lines.length - 1
                ? `<p><a href="${escapeHtml(line)}">${escapeHtml(line)}</a></p>`
                : `<p>${escapeHtml(line)}</p>`,
            )
            .join(""),
          messageType: "ops.alert",
        }),
      ),
    );
  } catch (error) {
    logger.warn("Failed to mail market admins about a skill report", {
      reportId: input.reportId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// The admin queue
// ---------------------------------------------------------------------------

const REVIEW_EXCERPT_LENGTH = 280;

/** `createdAt|id` of the last item, opaque to the caller. */
export function encodeSkillReportCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeSkillReportCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const createdAt = at ? new Date(at) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

/**
 * Reports with one status, newest first, with what an admin needs to decide
 * on each: the skill's standing, the review it is about, who sent it, and
 * how many other reports about the same skill are still open.
 */
export async function listSkillReports(input: {
  status: SkillReportStatus;
  cursor?: string;
  limit: number;
}): Promise<ListSkillReportsResponse> {
  const after = input.cursor ? decodeSkillReportCursor(input.cursor) : null;
  if (input.cursor && !after) {
    throw new ContentError(
      400,
      "SKILL_REPORT_CURSOR_INVALID",
      "Invalid cursor",
    );
  }
  const others = sql<number>`(
    select count(*)::int from ${skillReports} as other
    where other.skill_id = ${skillReports.skillId}
      and other.status = 'open'
      and other.id <> ${skillReports.id}
  )`;
  const rows = await db
    .select({
      report: skillReports,
      skill: {
        id: skillDefinitions.id,
        slug: skillDefinitions.slug,
        displayName: skillDefinitions.displayName,
        visibility: skillDefinitions.visibility,
        listingHold: skillDefinitions.listingHold,
      },
      review: {
        id: skillReviews.id,
        rating: skillReviews.rating,
        body: skillReviews.body,
        status: skillReviews.status,
      },
      otherOpenReports: others,
    })
    .from(skillReports)
    .innerJoin(skillDefinitions, eq(skillDefinitions.id, skillReports.skillId))
    .leftJoin(skillReviews, eq(skillReviews.id, skillReports.reviewId))
    .where(
      and(
        eq(skillReports.status, input.status),
        after
          ? or(
              lt(skillReports.createdAt, after.createdAt),
              and(
                eq(skillReports.createdAt, after.createdAt),
                lt(skillReports.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(skillReports.createdAt), desc(skillReports.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);

  const reporterIds = [
    ...new Set(
      page
        .map((row) => row.report.reporterUserId)
        .filter((id): id is string => !!id),
    ),
  ];
  const reporters = new Map<
    string,
    { name: string | null; email: string | null }
  >();
  if (reporterIds.length > 0) {
    const result = await db.execute<{
      id: string;
      name: string | null;
      email: string | null;
    }>(sql`
      select id, name, email from "user"
      where id in (${sql.join(
        reporterIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    for (const row of result.rows ?? []) {
      reporters.set(row.id, { name: row.name, email: row.email });
    }
  }

  const items = page.map(({ report, skill, review, otherOpenReports }) => {
    const account = report.reporterUserId
      ? reporters.get(report.reporterUserId)
      : undefined;
    const item: SkillReportItem = {
      id: report.id,
      reason: report.reason,
      details: report.details,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
      resolution: report.resolution,
      resolvedBy: report.resolvedBy,
      resolvedAt: report.resolvedAt?.toISOString() ?? null,
      skill,
      review:
        review && review.id
          ? {
              id: review.id,
              rating: review.rating,
              excerpt: review.body.slice(0, REVIEW_EXCERPT_LENGTH),
              status: review.status,
            }
          : null,
      reporter: {
        userId: report.reporterUserId,
        displayName: report.reporterUserId
          ? account?.name?.trim() || report.reporterUserId
          : "anonymous",
        contactEmail: report.contactEmail,
        accountEmail: account?.email ?? null,
      },
      otherOpenReports: Number(otherOpenReports),
    };
    return item;
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor:
      rows.length > input.limit && last
        ? encodeSkillReportCursor(last.report.createdAt, last.report.id)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

export type ResolveSkillReportResult = {
  reportId: string;
  status: "actioned" | "dismissed";
  action: SkillReportAction;
  resolvedReportIds: string[];
};

/**
 * An admin's decision on an open report. The action runs first, through the
 * function its own admin route uses; only when it succeeds is the report
 * closed, so a failed action leaves the report open to try again. Null when
 * there is no such report.
 */
export async function resolveSkillReport(input: {
  reportId: string;
  action: SkillReportAction;
  resolution?: string;
  alsoResolveSameTarget?: boolean;
  actorUserId: string;
}): Promise<ResolveSkillReportResult | null> {
  const [report] = await db
    .select()
    .from(skillReports)
    .where(eq(skillReports.id, input.reportId))
    .limit(1);
  if (!report) return null;
  if (report.status !== "open") {
    throw new ContentError(
      409,
      "SKILL_REPORT_ALREADY_RESOLVED",
      "This report has already been resolved",
    );
  }
  const resolution = input.resolution?.trim() || null;
  const detail: Record<string, unknown> = {
    reportId: report.id,
    action: input.action,
    reason: report.reason,
  };

  switch (input.action) {
    case "withdraw_skill": {
      const withdrawn = await delistSkill({
        skillId: report.skillId,
        actorUserId: input.actorUserId,
      });
      if (!withdrawn)
        throw targetGone("The reported skill is no longer active");
      logger.info("Registry skill withdrawn from the market", {
        skillId: report.skillId,
        actorUserId: input.actorUserId,
        reportId: report.id,
      });
      break;
    }
    case "revoke_version": {
      const [current] = await db
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.skillId, report.skillId),
            eq(skillVersions.isCurrent, true),
            eq(skillVersions.status, "published"),
          ),
        )
        .limit(1);
      if (!current) {
        throw targetGone("The reported skill has no published current version");
      }
      const revoked = await setRegistrySkillVersionStatus(
        current.id,
        "deprecated",
        {
          actorUserId: input.actorUserId,
          reason: resolution ?? `Revoked on a ${report.reason} report`,
        },
      );
      if (!revoked)
        throw targetGone("The reported version could not be revoked");
      detail.skillVersionId = current.id;
      break;
    }
    case "hide_review": {
      if (!report.reviewId) {
        throw new ContentError(
          400,
          "SKILL_REPORT_NOT_ABOUT_A_REVIEW",
          "This report is about the skill, not a review",
        );
      }
      const hidden = await setSkillReviewStatus({
        reviewId: report.reviewId,
        status: "hidden",
        actorUserId: input.actorUserId,
        reason: resolution ?? undefined,
      });
      if (!hidden) throw targetGone("The reported review no longer exists");
      detail.reviewId = report.reviewId;
      break;
    }
    case "dismiss":
    case "none":
      break;
  }

  const status = input.action === "dismiss" ? "dismissed" : "actioned";
  const now = new Date();
  return db.transaction(async (tx) => {
    const sameTarget = and(
      eq(skillReports.skillId, report.skillId),
      report.reviewId
        ? eq(skillReports.reviewId, report.reviewId)
        : sql`${skillReports.reviewId} is null`,
    );
    const closed = await tx
      .update(skillReports)
      .set({
        status,
        resolution,
        resolvedBy: input.actorUserId,
        resolvedAt: now,
      })
      .where(
        and(
          eq(skillReports.status, "open"),
          input.alsoResolveSameTarget
            ? or(eq(skillReports.id, report.id), sameTarget)
            : eq(skillReports.id, report.id),
        ),
      )
      .returning({ id: skillReports.id });
    // Another admin closed it while the action ran; their decision stands.
    if (!closed.some((row) => row.id === report.id)) {
      throw new ContentError(
        409,
        "SKILL_REPORT_ALREADY_RESOLVED",
        "This report has already been resolved",
      );
    }
    const resolvedReportIds = [
      report.id,
      ...closed.map((row) => row.id).filter((id) => id !== report.id),
    ];
    if (resolvedReportIds.length > 1) {
      detail.alsoResolved = resolvedReportIds.slice(1);
    }
    await recordSkillMarketEvent(
      {
        skillId: report.skillId,
        actorKind: "admin",
        actorUserId: input.actorUserId,
        action: status === "dismissed" ? "report.dismissed" : "report.actioned",
        detail,
      },
      tx,
    );
    return {
      reportId: report.id,
      status,
      action: input.action,
      resolvedReportIds,
    };
  });
}

function targetGone(message: string) {
  return new ContentError(409, "SKILL_REPORT_TARGET_GONE", message);
}
