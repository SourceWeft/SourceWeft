import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type {
  SkillCatalogCapability,
  SkillCatalogCategory,
  SkillCatalogInstalled,
  SkillCatalogSort,
  SkillCatalogTrust,
} from "@sourceweft/contracts";
import {
  db,
  skillCategories,
  skillDefinitionCategories,
  skillDefinitions,
  skillVersions,
  workspaceSkills,
} from "@sourceweft/db";
import { skillCategoryDefinitions } from "./taxonomy";

/**
 * The SQL half of the workspace catalog's market surface: how community skills
 * are filtered, ordered and paged, and how many of them sit in each category.
 *
 * The pieces here are fragments, not a query: `service.ts` owns the catalog
 * query (its joins and its visibility rule) and composes these into it, so the
 * aliases they name — `skill_definitions`, the joined `skill_versions` row and
 * the left-joined `workspace_skills` row — are the ones that query sets up.
 */

export type SkillCatalogFilters = {
  category?: string;
  trust: SkillCatalogTrust;
  capability: SkillCatalogCapability;
  installed: SkillCatalogInstalled;
};

export const NO_SKILL_CATALOG_FILTERS: SkillCatalogFilters = {
  trust: "all",
  capability: "all",
  installed: "all",
};

// ---------------------------------------------------------------------------
// LIKE escaping
// ---------------------------------------------------------------------------

/**
 * A search term as a literal inside a LIKE/ILIKE pattern. Unescaped, a `%` or
 * `_` someone typed is a wildcard — "100%" matched every skill — and a lone
 * `\` swallows the wildcard the caller appends. PostgreSQL's default LIKE
 * escape character is the backslash, so no ESCAPE clause is needed.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// ---------------------------------------------------------------------------
// Sort + keyset cursor
// ---------------------------------------------------------------------------

/**
 * `listed_at` as whole microseconds since the epoch, NULL read as the epoch.
 *
 * Two things at once. A skill only its submitter can see has never been listed
 * and has no `listed_at`; reading that as the epoch gives it a definite place —
 * after every listed skill — instead of leaving it to NULL ordering, which a
 * row comparison cannot resume from. And the cursor has to carry the key
 * exactly: PostgreSQL keeps microseconds, a JS Date keeps milliseconds, and a
 * key rounded on its way through the cursor skips the rows that fall inside the
 * rounding. A bigint survives the trip as a string. (`extract(epoch …)` is
 * exact `numeric` from PostgreSQL 14 on.)
 */
const listedAtMicros = sql<string>`(extract(epoch from coalesce(${skillDefinitions.listedAt}, 'epoch'::timestamptz)) * 1000000)::bigint`;

/** Selected beside each catalog row so the page's last row can be resumed. */
export const skillCatalogSortKeyColumns = { listedAtMicros };

/**
 * Where a page of the registry catalog left off: the sort it was walking and
 * that sort's key for its last row. A keyset rather than an offset, so a skill
 * indexed or withdrawn while someone pages neither repeats nor skips an entry.
 * Every sort ends in the id, which makes its order total.
 */
export type SkillCatalogCursor =
  | { sort: "name"; name: string; id: string }
  | { sort: "popular"; installCount: number; id: string }
  | { sort: "new"; listedAtMicros: string; id: string }
  | { sort: "stars"; repoStars: number; id: string }
  | {
      sort: "recommended";
      featured: boolean;
      verified: boolean;
      rankScore: number;
      listedAtMicros: string;
      id: string;
    };

/** What a catalog row contributes to a cursor. */
export type SkillCatalogSortKeyRow = {
  definition: {
    id: string;
    displayName: string;
    featured: boolean;
    verified: boolean;
    installCount: number;
    rankScore: number;
    repoStars: number;
  };
  listedAtMicros: string | number | bigint;
};

export function skillCatalogCursorForRow(
  sort: SkillCatalogSort,
  row: SkillCatalogSortKeyRow,
): SkillCatalogCursor {
  const {
    id,
    displayName,
    featured,
    verified,
    installCount,
    rankScore,
    repoStars,
  } = row.definition;
  const micros = String(row.listedAtMicros);
  switch (sort) {
    case "name":
      return { sort, name: displayName, id };
    case "popular":
      return { sort, installCount, id };
    case "new":
      return { sort, listedAtMicros: micros, id };
    case "stars":
      return { sort, repoStars, id };
    case "recommended":
      return {
        sort,
        featured,
        verified,
        rankScore,
        listedAtMicros: micros,
        id,
      };
  }
}

/**
 * Marks the current shape of the `recommended` cursor: featured, verified, the
 * rank score, the listing time. Each earlier shape (keyed by the install count,
 * then by verified and the rank score without featured) resumed a different
 * order; without a new mark an old cursor would decode and quietly resume at
 * the wrong place. Under any other mark it is refused as a bad cursor, which
 * clients already handle by starting over from the first page.
 */
const RANK_CURSOR_MARK = "featured-rank";

export function encodeSkillCatalogCursor(cursor: SkillCatalogCursor): string {
  const keys: Array<string | number | boolean> = (() => {
    switch (cursor.sort) {
      case "name":
        return [cursor.name];
      case "popular":
        return [cursor.installCount];
      case "new":
        return [cursor.listedAtMicros];
      case "stars":
        return [cursor.repoStars];
      case "recommended":
        return [
          RANK_CURSOR_MARK,
          cursor.featured,
          cursor.verified,
          cursor.rankScore,
          cursor.listedAtMicros,
        ];
    }
  })();
  return Buffer.from(
    JSON.stringify([cursor.sort, ...keys, cursor.id]),
  ).toString("base64url");
}

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
// Both end up as SQL parameters cast to a number type; anything that would
// fail that cast is refused here as a bad cursor rather than there as a 500.
const isInstallCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 2_147_483_647;
const isMicros = (value: unknown): value is string =>
  typeof value === "string" && /^-?\d{1,18}$/.test(value);

/** null for anything that is not a cursor `listCatalog` handed out. */
export function decodeSkillCatalogCursor(
  cursor: string,
): SkillCatalogCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  // Before cursors named their sort there was one sort, by name, and its
  // cursor was the bare `[name, id]`. Still honored, as a name cursor.
  if (parsed.length === 2) {
    const [name, id] = parsed;
    return typeof name === "string" && isId(id)
      ? { sort: "name", name, id }
      : null;
  }
  const [sort, ...keys] = parsed;
  switch (sort) {
    case "name": {
      const [name, id] = keys;
      return keys.length === 2 && typeof name === "string" && isId(id)
        ? { sort, name, id }
        : null;
    }
    case "popular": {
      const [installCount, id] = keys;
      return keys.length === 2 && isInstallCount(installCount) && isId(id)
        ? { sort, installCount, id }
        : null;
    }
    case "new": {
      const [micros, id] = keys;
      return keys.length === 2 && isMicros(micros) && isId(id)
        ? { sort, listedAtMicros: micros, id }
        : null;
    }
    case "stars": {
      const [repoStars, id] = keys;
      return keys.length === 2 && isInstallCount(repoStars) && isId(id)
        ? { sort, repoStars, id }
        : null;
    }
    case "recommended": {
      const [mark, featured, verified, rankScore, micros, id] = keys;
      return keys.length === 6 &&
        mark === RANK_CURSOR_MARK &&
        typeof featured === "boolean" &&
        typeof verified === "boolean" &&
        isInstallCount(rankScore) &&
        isMicros(micros) &&
        isId(id)
        ? { sort, featured, verified, rankScore, listedAtMicros: micros, id }
        : null;
    }
    default:
      return null;
  }
}

/**
 * ORDER BY for a sort. The SQL form of "recommended" — featured publishers,
 * then verified, then the rank score, then newest — is the registry slice of the ordering `rank.ts`
 * defines, over the score the scheduler stores; a database test holds the two
 * together.
 */
export function skillCatalogOrderBy(sort: SkillCatalogSort): SQL[] {
  switch (sort) {
    case "name":
      return [asc(skillDefinitions.displayName), asc(skillDefinitions.id)];
    case "popular":
      return [desc(skillDefinitions.installCount), desc(skillDefinitions.id)];
    case "new":
      return [desc(listedAtMicros), desc(skillDefinitions.id)];
    case "stars":
      return [desc(skillDefinitions.repoStars), desc(skillDefinitions.id)];
    case "recommended":
      // Leads with the columns of `skill_definitions_market_rank_idx`, in its
      // directions, so the index can serve the page.
      return [
        desc(skillDefinitions.featured),
        desc(skillDefinitions.verified),
        desc(skillDefinitions.rankScore),
        desc(listedAtMicros),
        desc(skillDefinitions.id),
      ];
  }
}

/**
 * "Strictly after this row", in the cursor's sort. Each sort runs one way
 * across all its keys, so a single row comparison expresses it; the casts pin
 * the parameter types, which a row comparison does not infer.
 */
export function skillCatalogKeysetCondition(cursor: SkillCatalogCursor): SQL {
  switch (cursor.sort) {
    case "name":
      return sql`(${skillDefinitions.displayName}, ${skillDefinitions.id}) > (${cursor.name}, ${cursor.id})`;
    case "popular":
      return sql`(${skillDefinitions.installCount}, ${skillDefinitions.id}) < (${cursor.installCount}::integer, ${cursor.id})`;
    case "new":
      return sql`(${listedAtMicros}, ${skillDefinitions.id}) < (${cursor.listedAtMicros}::bigint, ${cursor.id})`;
    case "stars":
      return sql`(${skillDefinitions.repoStars}, ${skillDefinitions.id}) < (${cursor.repoStars}::integer, ${cursor.id})`;
    case "recommended":
      return sql`(${skillDefinitions.featured}, ${skillDefinitions.verified}, ${skillDefinitions.rankScore}, ${listedAtMicros}, ${skillDefinitions.id}) < (${cursor.featured}::boolean, ${cursor.verified}::boolean, ${cursor.rankScore}::integer, ${cursor.listedAtMicros}::bigint, ${cursor.id})`;
  }
}

// ---------------------------------------------------------------------------
// Search box
// ---------------------------------------------------------------------------

const SKILL_CATALOG_SEARCH_MAX_WORDS = 8;

/**
 * The words of a search box query. Browsing filters rather than ranks: an entry
 * matches when EVERY word is somewhere in its slug, name or description — so
 * "pdf form" finds a skill described as "fill in forms in a PDF", which the
 * phrase as one needle would not. One definition, so the dashboard and the
 * public site find the same skills for the same text. (The agent's
 * `searchCatalog` differs on purpose: ANY word, ranked by how many.)
 */
export function skillCatalogQueryWords(query: string): string[] {
  return [
    ...new Set(
      query
        .trim()
        .toLowerCase()
        .split(/[\s,，、;；/|]+/u)
        .filter(Boolean),
    ),
  ].slice(0, SKILL_CATALOG_SEARCH_MAX_WORDS);
}

/**
 * One condition per word. Each word is text to find, not a pattern: what it
 * contains of LIKE's own syntax is escaped.
 */
export function skillCatalogSearchConditions(words: string[]): SQL[] {
  return words.map((word) => {
    const like = `%${escapeLikePattern(word)}%`;
    return or(
      ilike(skillDefinitions.displayName, like),
      ilike(skillDefinitions.description, like),
      // The slug carries the author's own name for the skill, which is what
      // someone types when they already know what they want.
      ilike(skillDefinitions.slug, like),
    )!;
  });
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Whether these filters leave any community skill to look for. `trust=builtin`
 * asks for ours alone, so the registry query is not run at all.
 */
export function skillCatalogFiltersExcludeRegistry(
  filters: SkillCatalogFilters,
): boolean {
  return filters.trust === "builtin";
}

/**
 * The market filters as WHERE conditions of the registry catalog query. In SQL
 * so that a page is `limit` matching skills, not `limit` skills of which some
 * match.
 */
export function skillCatalogFilterConditions(
  filters: SkillCatalogFilters,
): SQL[] {
  const conditions: SQL[] = [];
  if (filters.category) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(skillDefinitionCategories)
          .innerJoin(
            skillCategories,
            eq(skillCategories.id, skillDefinitionCategories.categoryId),
          )
          .where(
            and(
              eq(skillDefinitionCategories.skillId, skillDefinitions.id),
              eq(skillCategories.slug, filters.category),
            ),
          ),
      ),
    );
  }
  if (filters.trust === "featured") {
    conditions.push(eq(skillDefinitions.featured, true));
  } else if (filters.trust === "verified") {
    conditions.push(eq(skillDefinitions.verified, true));
  } else if (filters.trust === "community") {
    // The rest: nothing about who publishes it or who vouched for it sets it
    // apart. A featured skill that is also verified is in both of those.
    conditions.push(
      eq(skillDefinitions.featured, false),
      eq(skillDefinitions.verified, false),
    );
  }
  if (filters.capability !== "all") {
    // Of the version the row shows. A version that records no capability
    // matches neither value rather than being guessed into one.
    conditions.push(
      sql`${skillVersions.manifestJson}->'registry'->>'capability' = ${filters.capability}`,
    );
  }
  if (filters.installed === "installed") {
    conditions.push(isNotNull(workspaceSkills.id));
  } else if (filters.installed === "not_installed") {
    conditions.push(isNull(workspaceSkills.id));
  }
  return conditions;
}

/**
 * The same filters over the bounded part of the catalog — builtins and the
 * workspace's and team's own skills — which is filtered in process. Those
 * skills are not on the market: they have no market category, no recorded
 * capability, no featured mark and no verified grant, so any filter on one of
 * those leaves none of them. An always-on builtin has no install row but is in every workspace,
 * and counts as installed.
 */
export function boundedCatalogItemMatchesFilters(
  item: {
    sourceType: string;
    installable: boolean;
    enabledWorkspaceSkillId: string | null;
  },
  filters: SkillCatalogFilters,
): boolean {
  if (filters.category || filters.capability !== "all") {
    return false;
  }
  if (
    filters.trust === "featured" ||
    filters.trust === "verified" ||
    filters.trust === "community"
  ) {
    return false;
  }
  if (filters.trust === "builtin" && item.sourceType !== "builtin") {
    return false;
  }
  if (filters.installed === "all") {
    return true;
  }
  const installed =
    item.enabledWorkspaceSkillId !== null ||
    (item.sourceType === "builtin" && !item.installable);
  return filters.installed === "installed" ? installed : !installed;
}

// ---------------------------------------------------------------------------
// Category counts
// ---------------------------------------------------------------------------

/**
 * Every market category with the number of community skills this viewer would
 * find under it: public ones, plus restricted ones they submitted, whose
 * current version is published and not hidden. One grouped query; categories
 * nobody is filed under come back with 0 so the list keeps its shape.
 */
export async function listSkillCatalogCategoryCounts(input: {
  userId: string;
}): Promise<SkillCatalogCategory[]> {
  const rows = await db
    .select({
      slug: skillCategories.slug,
      count: sql<number>`count(*)::int`,
    })
    .from(skillDefinitionCategories)
    .innerJoin(
      skillCategories,
      eq(skillCategories.id, skillDefinitionCategories.categoryId),
    )
    .innerJoin(
      skillDefinitions,
      eq(skillDefinitions.id, skillDefinitionCategories.skillId),
    )
    .innerJoin(
      skillVersions,
      and(
        eq(skillVersions.skillId, skillDefinitions.id),
        eq(skillVersions.isCurrent, true),
        eq(skillVersions.status, "published"),
      ),
    )
    .where(
      and(
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
        sql`${skillVersions.manifestJson}->>'listing' is distinct from 'hidden'`,
        sql`(${skillDefinitions.visibility} = 'public' or (${skillDefinitions.visibility} = 'restricted' and ${skillDefinitions.ownerUserId} = ${input.userId}))`,
      ),
    )
    .groupBy(skillCategories.slug);
  const counts = new Map(rows.map((row) => [row.slug, Number(row.count)]));
  return skillCategoryDefinitions.map((definition) => ({
    slug: definition.slug,
    name: definition.name,
    description: definition.description,
    count: counts.get(definition.slug) ?? 0,
  }));
}
