import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { SkillMarketEvent } from "@sourceweft/contracts";
import {
  db,
  skillDefinitions,
  skillMarketEvents,
  skillVersions,
  type SkillMarketEventActorKind,
} from "@sourceweft/db";
import { logger } from "../../../shared/logger";
import { ContentError } from "../../content/errors";
import { findUserIdentitiesByIds } from "../../workspace/store";

/**
 * The skill market's audit trail (`skill_market_events`): who did what to a
 * skill's market standing, and what the platform did by itself. Append-only;
 * read by the admin panel.
 *
 * Actions are dotted verbs, grouped by what they change:
 * - `listing.listed` / `listing.withdrawn` / `listing.auto_listed` /
 *   `listing.owner_allowed` / `listing.owner_private` / `listing.kept`
 * - `verified.set` / `verified.cleared` (a new version cleared it)
 * - `featured.set`
 * - `categories.set` / `categories.reinferred`
 * - `provenance.withheld`
 * - `claim.granted` / `claim.revoked` / `claim.removed` / `claim.restored`
 * - `version.published` / `version.rejected` / `version.revoked`
 * - `review.written` / `review.deleted` (the reviewer, `user`) /
 *   `review.replied` / `review.reply_removed` (the claimed author, `owner`) /
 *   `review.hidden` / `review.shown` (an admin)
 * - `report.actioned` / `report.dismissed`
 * - `overview.regenerated` / `overview.hidden` / `overview.shown`
 * - `settings.updated`
 *
 * Mirrored in `SKILL_MARKET_EVENT_ACTIONS` (contracts) for the web's labels.
 */
export type SkillMarketEventInput = {
  skillId?: string | null;
  repo?: { owner: string; name: string } | null;
  actorKind: SkillMarketEventActorKind;
  actorUserId?: string | null;
  action: string;
  // Small and structured: before/after values, a reason, a version id. Never
  // a skill's content, a command, or anything a reporter wrote in private.
  detail?: Record<string, unknown>;
};

type Executor = Pick<typeof db, "insert">;

/**
 * Records one event. Pass the transaction (`tx`) that made the change so the
 * event commits with it; without one, a failure to record is logged and never
 * undoes or fails the change it describes.
 */
export async function recordSkillMarketEvent(
  input: SkillMarketEventInput,
  executor?: Executor,
): Promise<void> {
  const row = {
    id: randomUUID(),
    // The wall clock, not `defaultNow()` (the transaction's start): events
    // written in one transaction keep the order they were recorded in.
    createdAt: sql`clock_timestamp()`,
    skillId: input.skillId ?? null,
    repoOwner: input.repo?.owner ?? null,
    repoName: input.repo?.name ?? null,
    actorKind: input.actorKind,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    detail: input.detail ?? {},
  };
  if (executor) {
    await executor.insert(skillMarketEvents).values(row);
    return;
  }
  try {
    await db.insert(skillMarketEvents).values(row);
  } catch (error) {
    logger.warn("Failed to record a skill market event", {
      action: input.action,
      skillId: input.skillId ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// --- Reads ---------------------------------------------------------------

/**
 * Keyset position in the newest-first feed. The timestamp travels as
 * Postgres's own text for it, not a JS Date: a Date keeps milliseconds and
 * `created_at` has microseconds, so a round-tripped Date would skip rows.
 */
type EventCursor = { createdAt: string; id: string };

function encodeEventCursor(cursor: EventCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.createdAt, i: cursor.id }),
  ).toString("base64url");
}

/** Null for anything that is not a cursor this module issued. */
export function decodeSkillMarketEventCursor(
  value: string,
): EventCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { t?: unknown; i?: unknown };
    if (
      typeof parsed.t !== "string" ||
      typeof parsed.i !== "string" ||
      !parsed.i ||
      Number.isNaN(Date.parse(parsed.t))
    ) {
      return null;
    }
    return { createdAt: parsed.t, id: parsed.i };
  } catch {
    return null;
  }
}

const eventColumns = {
  id: skillMarketEvents.id,
  skillId: skillMarketEvents.skillId,
  skillSlug: skillDefinitions.slug,
  skillDisplayName: skillDefinitions.displayName,
  repoOwner: skillMarketEvents.repoOwner,
  repoName: skillMarketEvents.repoName,
  actorKind: skillMarketEvents.actorKind,
  actorUserId: skillMarketEvents.actorUserId,
  action: skillMarketEvents.action,
  detail: skillMarketEvents.detail,
  createdAt: skillMarketEvents.createdAt,
  cursorAt: sql<string>`${skillMarketEvents.createdAt}::text`,
};

type EventRow = {
  id: string;
  skillId: string | null;
  skillSlug: string | null;
  skillDisplayName: string | null;
  repoOwner: string | null;
  repoName: string | null;
  actorKind: SkillMarketEventActorKind;
  actorUserId: string | null;
  action: string;
  detail: Record<string, unknown>;
  createdAt: Date;
};

/**
 * The rows as the admin panel shows them, with each actor's name as it is
 * now. A platform actor (`system:*`) is never looked up; a user who has no
 * name, or no longer exists, is shown by id.
 */
async function toSkillMarketEvents(
  rows: EventRow[],
): Promise<SkillMarketEvent[]> {
  const ids = [
    ...new Set(
      rows
        .map((row) => row.actorUserId)
        .filter((id): id is string => !!id && !id.startsWith("system")),
    ),
  ];
  const names = new Map(
    (await findUserIdentitiesByIds(ids)).map((identity) => [
      identity.userId,
      identity.name,
    ]),
  );
  return rows.map((row) => ({
    id: row.id,
    skillId: row.skillId,
    skillSlug: row.skillSlug,
    skillDisplayName: row.skillDisplayName,
    repo:
      row.repoOwner && row.repoName ? `${row.repoOwner}/${row.repoName}` : null,
    actorKind: row.actorKind,
    actorUserId: row.actorUserId,
    actorName: row.actorUserId ? (names.get(row.actorUserId) ?? null) : null,
    action: row.action,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * One skill's history, newest first: its own events, and those about its
 * repository as a whole (a claim granted, revoked, removed, restored), which
 * decide who controls it. Null when there is no such skill.
 */
export async function listSkillMarketEvents(input: {
  skillId: string;
  limit: number;
}): Promise<SkillMarketEvent[] | null> {
  const [skill] = await db
    .select({
      repoOwner: skillDefinitions.repoOwner,
      repoName: skillDefinitions.repoName,
    })
    .from(skillDefinitions)
    .where(eq(skillDefinitions.id, input.skillId))
    .limit(1);
  if (!skill) return null;
  const rows = await db
    .select(eventColumns)
    .from(skillMarketEvents)
    .leftJoin(
      skillDefinitions,
      eq(skillDefinitions.id, skillMarketEvents.skillId),
    )
    .where(
      or(
        eq(skillMarketEvents.skillId, input.skillId),
        skill.repoOwner && skill.repoName
          ? and(
              isNull(skillMarketEvents.skillId),
              eq(skillMarketEvents.repoOwner, skill.repoOwner),
              eq(skillMarketEvents.repoName, skill.repoName),
            )
          : undefined,
      ),
    )
    .orderBy(desc(skillMarketEvents.createdAt), desc(skillMarketEvents.id))
    .limit(input.limit);
  return toSkillMarketEvents(rows);
}

/** Every event, newest first, a page at a time. */
export async function listRecentSkillMarketEvents(input: {
  cursor?: string | null;
  limit: number;
}): Promise<{ items: SkillMarketEvent[]; nextCursor: string | null }> {
  const cursor = input.cursor
    ? decodeSkillMarketEventCursor(input.cursor)
    : null;
  if (input.cursor && !cursor) {
    throw new ContentError(400, "VALIDATION_ERROR", "Invalid cursor");
  }
  const rows = await db
    .select(eventColumns)
    .from(skillMarketEvents)
    .leftJoin(
      skillDefinitions,
      eq(skillDefinitions.id, skillMarketEvents.skillId),
    )
    .where(
      cursor
        ? sql`(${skillMarketEvents.createdAt}, ${skillMarketEvents.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})`
        : undefined,
    )
    .orderBy(desc(skillMarketEvents.createdAt), desc(skillMarketEvents.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: await toSkillMarketEvents(page),
    nextCursor:
      rows.length > input.limit && last
        ? encodeEventCursor({ createdAt: last.cursorAt, id: last.id })
        : null,
  };
}

/**
 * A registry version's skill and status, read before a review-queue decision
 * so the event can say which it was: publishing a draft, rejecting one, or
 * revoking a published version. Null for a version that does not exist.
 */
export async function getVersionForAudit(skillVersionId: string): Promise<{
  skillId: string;
  status: string;
} | null> {
  const [row] = await db
    .select({ skillId: skillVersions.skillId, status: skillVersions.status })
    .from(skillVersions)
    .where(eq(skillVersions.id, skillVersionId))
    .limit(1);
  return row ?? null;
}

/**
 * The event for a review-queue decision (`setRegistrySkillVersionStatus`),
 * recorded once it succeeded. `before` is the version as it was.
 */
export async function recordVersionModeration(input: {
  skillVersionId: string;
  before: { skillId: string; status: string };
  target: "published" | "deprecated";
  actorUserId: string;
  reason?: string;
  visibility?: "public" | "restricted";
}): Promise<void> {
  await recordSkillMarketEvent({
    skillId: input.before.skillId,
    actorKind: "admin",
    actorUserId: input.actorUserId,
    action:
      input.target === "published"
        ? "version.published"
        : input.before.status === "draft"
          ? "version.rejected"
          : "version.revoked",
    detail: {
      skillVersionId: input.skillVersionId,
      status: { from: input.before.status, to: input.target },
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
    },
  });
}
