import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type {
  ListSkillMarketAdminSkillsResponse,
  SkillMarketAdminStandingFilter,
} from "@sourceweft/contracts";
import { db, skillDefinitions } from "@sourceweft/db";
import { ContentError } from "../../content/errors";

/**
 * Every community skill, for the market admin's "all skills" screen — not only
 * the ones a queue is waiting on. Newest change first, keyset-paged on
 * (`updated_at`, `id`), so a skill an admin just acted on comes to the top.
 */

export type SkillMarketAdminListFilters = {
  q?: string;
  standing?: SkillMarketAdminStandingFilter;
  featured?: boolean;
  verified?: boolean;
  claimed?: boolean;
  flagged?: boolean;
  reported?: boolean;
};

/**
 * Keyset position. The timestamp travels as Postgres's own text for it: a JS
 * Date keeps milliseconds, `updated_at` may carry microseconds (`now()`), and
 * a truncated key would skip rows.
 */
type AdminListCursor = { updatedAt: string; id: string };

function encodeCursor(cursor: AdminListCursor): string {
  return Buffer.from(
    JSON.stringify({ u: cursor.updatedAt, i: cursor.id }),
  ).toString("base64url");
}

/** Null for anything that is not a cursor this module issued. */
export function decodeSkillMarketAdminCursor(
  value: string,
): AdminListCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { u?: unknown; i?: unknown };
    if (
      typeof parsed.u !== "string" ||
      typeof parsed.i !== "string" ||
      !parsed.i ||
      Number.isNaN(Date.parse(parsed.u))
    ) {
      return null;
    }
    return { updatedAt: parsed.u, id: parsed.i };
  } catch {
    return null;
  }
}

// Written with explicit table names: in a single-table select Drizzle leaves
// the outer table's columns unqualified, and inside a correlated subquery an
// unqualified `id` would bind to the inner table.
const flagCount = sql<number>`coalesce((
  select jsonb_array_length(coalesce(v.manifest_json->'registry'->'scan'->'flags', '[]'::jsonb))
  from skill_versions v
  where v.skill_id = "skill_definitions"."id" and v.is_current = true
  limit 1
), 0)`;

const openReportCount = sql<number>`(
  select count(*) from skill_reports r
  where r.skill_id = "skill_definitions"."id" and r.status = 'open'
)`;

function standingFilter(standing: SkillMarketAdminStandingFilter): SQL {
  switch (standing) {
    case "public":
      return eq(skillDefinitions.visibility, "public");
    case "restricted":
      return and(
        eq(skillDefinitions.visibility, "restricted"),
        eq(skillDefinitions.listingHold, false),
      )!;
    case "held":
      return eq(skillDefinitions.listingHoldBy, "admin");
    case "owner_held":
      return eq(skillDefinitions.listingHoldBy, "owner");
  }
}

const yesNo = (value: boolean | undefined, yes: SQL, no: SQL) =>
  value === undefined ? undefined : value ? yes : no;

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function listSkillMarketAdminSkills(
  input: SkillMarketAdminListFilters & {
    cursor?: string | null;
    limit: number;
  },
): Promise<ListSkillMarketAdminSkillsResponse> {
  const cursor = input.cursor
    ? decodeSkillMarketAdminCursor(input.cursor)
    : null;
  if (input.cursor && !cursor) {
    throw new ContentError(400, "VALIDATION_ERROR", "Invalid cursor");
  }
  const q = input.q?.trim();
  const pattern = q ? `%${escapeLike(q.toLowerCase())}%` : null;
  const rows = await db
    .select({
      id: skillDefinitions.id,
      slug: skillDefinitions.slug,
      displayName: skillDefinitions.displayName,
      repoOwner: skillDefinitions.repoOwner,
      repoName: skillDefinitions.repoName,
      visibility: skillDefinitions.visibility,
      listingHold: skillDefinitions.listingHold,
      listingHoldBy: skillDefinitions.listingHoldBy,
      featured: skillDefinitions.featured,
      verified: skillDefinitions.verified,
      claimedAt: skillDefinitions.claimedAt,
      installCount: skillDefinitions.installCount,
      ratingAvg: skillDefinitions.ratingAvg,
      ratingCount: skillDefinitions.ratingCount,
      updatedAt: skillDefinitions.updatedAt,
      cursorAt: sql<string>`${skillDefinitions.updatedAt}::text`,
      flagCount: flagCount.mapWith(Number),
      openReportCount: openReportCount.mapWith(Number),
    })
    .from(skillDefinitions)
    .where(
      and(
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
        pattern
          ? or(
              sql`lower(${skillDefinitions.slug}) like ${pattern}`,
              sql`lower(${skillDefinitions.displayName}) like ${pattern}`,
              sql`(${skillDefinitions.repoOwner} || '/' || ${skillDefinitions.repoName}) like ${pattern}`,
            )
          : undefined,
        input.standing ? standingFilter(input.standing) : undefined,
        yesNo(
          input.featured,
          eq(skillDefinitions.featured, true),
          eq(skillDefinitions.featured, false),
        ),
        yesNo(
          input.verified,
          eq(skillDefinitions.verified, true),
          eq(skillDefinitions.verified, false),
        ),
        yesNo(
          input.claimed,
          isNotNull(skillDefinitions.claimedAt),
          isNull(skillDefinitions.claimedAt),
        ),
        yesNo(input.flagged, sql`${flagCount} > 0`, sql`${flagCount} = 0`),
        yesNo(
          input.reported,
          sql`${openReportCount} > 0`,
          sql`${openReportCount} = 0`,
        ),
        cursor
          ? sql`(${skillDefinitions.updatedAt}, ${skillDefinitions.id}) < (${cursor.updatedAt}::timestamptz, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(skillDefinitions.updatedAt), desc(skillDefinitions.id))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      repo:
        row.repoOwner && row.repoName
          ? `${row.repoOwner}/${row.repoName}`
          : null,
      // The registry only ever holds these two (`skill_definitions_scope_check`).
      visibility: row.visibility === "public" ? "public" : "restricted",
      listingHold: row.listingHold,
      listingHoldBy: row.listingHoldBy,
      featured: row.featured,
      verified: row.verified,
      claimed: row.claimedAt !== null,
      flagCount: row.flagCount,
      openReportCount: row.openReportCount,
      installCount: row.installCount,
      ratingAvg: row.ratingAvg,
      ratingCount: row.ratingCount,
      updatedAt: row.updatedAt.toISOString(),
    })),
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor({ updatedAt: last.cursorAt, id: last.id })
        : null,
  };
}
