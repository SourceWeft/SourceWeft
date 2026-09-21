import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type {
  GetMarketSkillResponse,
  ListMarketSkillCategoriesResponse,
  ListMarketSkillsRequest,
  ListMarketSkillsResponse,
  MarketSkillSummary,
} from "@sourceweft/market-contracts";
import {
  db,
  skillCategories,
  skillDefinitionCategories,
  skillDefinitions,
  skillVersionFiles,
  skillVersions,
} from "@sourceweft/db";
import type { SkillManifestJson } from "@sourceweft/db";
import { ContentError } from "../../content/errors";
import { getSkillLogo } from "../logo";
import { parseGithubStoragePointer } from "../storage/source-pointer";
import {
  NO_SKILL_CATALOG_FILTERS,
  decodeSkillCatalogCursor,
  encodeSkillCatalogCursor,
  skillCatalogCursorForRow,
  skillCatalogFilterConditions,
  skillCatalogKeysetCondition,
  skillCatalogOrderBy,
  skillCatalogQueryWords,
  skillCatalogSearchConditions,
  skillCatalogSortKeyColumns,
} from "./catalog-query";
import { listSkillCategorySlugs } from "./listing";
import { skillCategoryDefinitions } from "./taxonomy";

/**
 * The public skill market's reads: what anyone, signed in or not, can list,
 * count and open. Nothing here takes a viewer — there is none — so nothing
 * here can show a skill because of who is asking.
 */

// A gallery grid of 2, 3 or 4 columns fills its last row with 24.
export const MARKET_SKILLS_DEFAULT_PAGE_SIZE = 24;

// A skill re-indexed on every upstream commit grows a long tail of versions;
// the public page shows the recent ones.
const MARKET_SKILL_VERSIONS_LIMIT = 50;

// ---------------------------------------------------------------------------
// The one public predicate
// ---------------------------------------------------------------------------

/**
 * What makes a skill part of the public market — the only definition of it.
 * The list, the category counts and the detail all read through this, over
 * `skill_definitions` joined to its `skill_versions` rows, so they cannot
 * disagree about what is public.
 *
 * It is a rule about visibility, never about where a skill came from: anything
 * that manages to be `public` and is not one of ours shows up, with no list of
 * source types to keep in step. Builtins are the product's own and appear in
 * the dashboard only.
 */
export function publicMarketSkillCondition(): SQL {
  return and(
    eq(skillDefinitions.visibility, "public"),
    sql`${skillDefinitions.sourceType} <> 'builtin'`,
    eq(skillDefinitions.status, "active"),
    eq(skillVersions.status, "published"),
    eq(skillVersions.isCurrent, true),
    sql`${skillVersions.manifestJson}->>'listing' is distinct from 'hidden'`,
  )!;
}

const onSkillVersion = eq(skillVersions.skillId, skillDefinitions.id);

// ---------------------------------------------------------------------------
// Summary mapping
// ---------------------------------------------------------------------------

/**
 * The owner and repository a repository URL names: "anthropics" and "skills"
 * for `https://github.com/anthropics/skills`. Accepts the forms such a URL is
 * written in (https, ssh, scp-style `git@host:owner/repo`, a trailing `.git`);
 * null for anything that does not name both, rather than a guess.
 */
export function repositoryFromUrl(
  repoUrl: string | null | undefined,
): { owner: string; repo: string } | null {
  if (typeof repoUrl !== "string") return null;
  const trimmed = repoUrl.trim();
  if (!trimmed) return null;
  let path: string;
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(trimmed);
  if (scp) {
    path = scp[1]!;
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!url.hostname) return null;
    path = url.pathname;
  }
  const [owner, repo] = path.split("/").filter(Boolean);
  const name = repo?.replace(/\.git$/i, "");
  if (!owner || !name) return null;
  // What an account or repository name is made of. Anything else — an encoded
  // slash, markup — is not a name to print as someone's.
  const isName = (value: string) => /^[\w.-]+$/.test(value);
  return isName(owner) && isName(name) ? { owner, repo: name } : null;
}

/** The account a repository lives under; null when it cannot be told. */
export function repositoryOwnerFromUrl(
  repoUrl: string | null | undefined,
): string | null {
  return repositoryFromUrl(repoUrl)?.owner ?? null;
}

/**
 * The author's own short name for the skill. A manifest that records one is
 * believed; today's registry manifests do not, but the name is what the slug
 * ends in — `gh-<owner>-<repo>-<name>` — so it is read back from there. A slug
 * with no dash has no tail and stands for itself.
 */
export function marketSkillName(input: {
  slug: string;
  manifest: SkillManifestJson;
}): string {
  const recorded = (input.manifest as { name?: unknown }).name;
  if (typeof recorded === "string" && recorded.trim()) return recorded.trim();
  const repo = repositoryFromUrl(input.manifest.registry?.repoUrl);
  if (repo) {
    const prefix = `gh-${slugSegment(repo.owner)}-${slugSegment(repo.repo)}-`;
    if (input.slug.startsWith(prefix) && input.slug.length > prefix.length) {
      return input.slug.slice(prefix.length);
    }
  }
  return input.slug.slice(input.slug.lastIndexOf("-") + 1) || input.slug;
}

// The registry's slug segments: lowercase, runs of anything else become "-".
function slugSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type MarketSkillRow = {
  definition: {
    id: string;
    slug: string;
    verified: boolean;
    installCount: number;
    listedAt: Date | null;
    createdAt: Date;
  };
  version: {
    version: string;
    publishedAt: Date | null;
    manifestJson: SkillManifestJson;
  };
};

/** The catalog's own logo rule, without the path it keeps for the dashboard. */
function marketSkillLogo(
  manifest: SkillManifestJson,
): MarketSkillSummary["logo"] {
  const logo = getSkillLogo(manifest);
  return logo ? { url: logo.url, source: logo.source } : null;
}

export function mapMarketSkillSummary(
  row: MarketSkillRow,
  categorySlugs: string[],
): MarketSkillSummary {
  const manifest = row.version.manifestJson;
  const registry = manifest.registry;
  return {
    slug: row.definition.slug,
    name: marketSkillName({ slug: row.definition.slug, manifest }),
    // As the catalog does for a community skill: the version on show speaks
    // for itself, the definition row being only the last one indexed.
    displayName: manifest.displayName,
    description: manifest.description,
    logo: marketSkillLogo(manifest),
    categories: categorySlugs,
    verified: row.definition.verified,
    capability: registry?.capability ?? null,
    license: registry?.license ?? null,
    author: repositoryOwnerFromUrl(registry?.repoUrl),
    repoUrl: registry?.repoUrl ?? null,
    sourceUrl: registry?.sourceUrl ?? null,
    installCount: row.definition.installCount,
    // Listing dates a skill before it flips it public, so a public row has
    // one; the fallback only keeps the contract's promise for a row made
    // public some other way.
    listedAt: (
      row.definition.listedAt ?? row.definition.createdAt
    ).toISOString(),
    version: row.version.version,
    updatedAt: row.version.publishedAt?.toISOString() ?? null,
  };
}

/**
 * The commit a version is pinned to: the manifest's own record of it where it
 * has one, else the storage pointer's.
 */
export function marketSkillCommitSha(version: {
  storagePointer: string;
  manifestJson: SkillManifestJson;
}): string | null {
  const recorded = (
    version.manifestJson.registry as { commitSha?: unknown } | undefined
  )?.commitSha;
  if (typeof recorded === "string" && /^[0-9a-fA-F]{40}$/.test(recorded)) {
    return recorded.toLowerCase();
  }
  return parseGithubStoragePointer(version.storagePointer)?.commitSha ?? null;
}

/**
 * A stored sha256 as the contract writes one: 64 lowercase hex characters.
 * Tolerates the spellings a hash is stored in (`sha256:` in front, upper
 * case); null for anything that is not a sha256 at all, because a client
 * verifies downloads against this and a made-up value would fail every one.
 */
export function normalizeSha256(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const hex = value
    .trim()
    .replace(/^sha-?256[:=-]/i, "")
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const summaryColumns = {
  definition: {
    id: skillDefinitions.id,
    slug: skillDefinitions.slug,
    displayName: skillDefinitions.displayName,
    verified: skillDefinitions.verified,
    installCount: skillDefinitions.installCount,
    listedAt: skillDefinitions.listedAt,
    createdAt: skillDefinitions.createdAt,
  },
  // Not the whole row: `skill_md` is the full document and a list has no use
  // for it.
  version: {
    id: skillVersions.id,
    version: skillVersions.version,
    publishedAt: skillVersions.publishedAt,
    storagePointer: skillVersions.storagePointer,
    manifestJson: skillVersions.manifestJson,
  },
};

export async function listMarketSkills(
  input: ListMarketSkillsRequest,
): Promise<ListMarketSkillsResponse> {
  const sort = input.sort ?? "recommended";
  const limit = input.limit ?? MARKET_SKILLS_DEFAULT_PAGE_SIZE;
  const after = input.cursor
    ? decodeSkillCatalogCursor(input.cursor)
    : undefined;
  if (after === null) {
    throw new ContentError(400, "INVALID_CURSOR", "Skill cursor is not valid");
  }
  // Resuming one order from a position in another would skip and repeat
  // skills without any sign of it, so it is refused rather than guessed at.
  if (after && after.sort !== sort) {
    throw new ContentError(
      400,
      "INVALID_CURSOR",
      `Skill cursor belongs to the '${after.sort}' sort, not '${sort}'`,
    );
  }

  const conditions: Array<SQL | undefined> = [
    publicMarketSkillCondition(),
    ...skillCatalogFilterConditions({
      ...NO_SKILL_CATALOG_FILTERS,
      category: input.category,
      trust:
        input.verified === undefined
          ? "all"
          : input.verified
            ? "verified"
            : "community",
      capability: input.capability ?? "all",
    }),
  ];
  if (after) {
    conditions.push(skillCatalogKeysetCondition(after));
  }
  conditions.push(
    ...skillCatalogSearchConditions(skillCatalogQueryWords(input.query ?? "")),
  );

  const rows = await db
    .select({ ...summaryColumns, ...skillCatalogSortKeyColumns })
    .from(skillDefinitions)
    .innerJoin(skillVersions, onSkillVersion)
    .where(and(...conditions))
    .orderBy(...skillCatalogOrderBy(sort))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const categories = await listSkillCategorySlugs(
    pageRows.map((row) => row.definition.id),
  );
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) =>
      mapMarketSkillSummary(row, categories.get(row.definition.id) ?? []),
    ),
    nextCursor:
      rows.length > limit && last
        ? encodeSkillCatalogCursor(skillCatalogCursorForRow(sort, last))
        : null,
  };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Every market category, in taxonomy order, with how many public skills are
 * filed under it — 0 included, so the list keeps its shape. `total` counts
 * skills, not filings: one in two categories is one skill.
 */
export async function listMarketSkillCategories(): Promise<ListMarketSkillCategoriesResponse> {
  const [rows, [totals]] = await Promise.all([
    db
      .select({ slug: skillCategories.slug, count: count() })
      .from(skillDefinitionCategories)
      .innerJoin(
        skillCategories,
        eq(skillCategories.id, skillDefinitionCategories.categoryId),
      )
      .innerJoin(
        skillDefinitions,
        eq(skillDefinitions.id, skillDefinitionCategories.skillId),
      )
      .innerJoin(skillVersions, onSkillVersion)
      .where(publicMarketSkillCondition())
      .groupBy(skillCategories.slug),
    db
      .select({ total: count() })
      .from(skillDefinitions)
      .innerJoin(skillVersions, onSkillVersion)
      .where(publicMarketSkillCondition()),
  ]);
  const counts = new Map(rows.map((row) => [row.slug, Number(row.count)]));
  return {
    items: skillCategoryDefinitions.map((definition) => ({
      slug: definition.slug,
      name: definition.name,
      description: definition.description,
      count: counts.get(definition.slug) ?? 0,
    })),
    total: Number(totals?.total ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

type RegistryFileManifest = NonNullable<
  SkillManifestJson["registry"]
>["fileManifest"];

/**
 * The version's complete file manifest — scripts and binaries included, since
 * a client installs exactly what is named here and checks each file against
 * its hash. Metadata only. The file rows are the manifest; a version indexed
 * before files had rows of their own still lists what it is made of in its
 * manifest JSON, without a type.
 *
 * A hash that is not a sha256 is not repaired from thin air: the row's own is
 * tried, then the manifest's for the same path, and failing both it goes out
 * as stored and the response is refused as not conforming — loudly, rather
 * than a manifest that silently leaves a file unverifiable or unlisted.
 */
export function marketSkillFiles(
  rows: ReadonlyArray<{
    path: string;
    sizeBytes: number;
    mimeType: string | null;
    contentHash: string;
  }>,
  fileManifest: RegistryFileManifest,
): GetMarketSkillResponse["files"] {
  if (rows.length === 0) {
    return [...fileManifest]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(({ path, sizeBytes, sha256 }) => ({
        path,
        sizeBytes,
        mimeType: null,
        contentHash: normalizeSha256(sha256) ?? sha256,
      }));
  }
  const recorded = new Map(
    fileManifest.map((file) => [file.path, file.sha256]),
  );
  return rows.map(({ path, sizeBytes, mimeType, contentHash }) => ({
    path,
    sizeBytes,
    mimeType,
    contentHash:
      normalizeSha256(contentHash) ??
      normalizeSha256(recorded.get(path)) ??
      contentHash,
  }));
}

/**
 * One public skill by slug, or null — for a slug nobody has and for a skill
 * that exists but is not public alike, so the answer never confirms that a
 * private skill is there.
 *
 * SKILL.md comes from the database (`skill_md`, else the version's inline
 * SKILL.md row); no bundle or blob is opened for an anonymous request. Files
 * are listed by path, size and type only.
 */
export async function findMarketSkill(
  slug: string,
): Promise<GetMarketSkillResponse | null> {
  const [row] = await db
    .select({ ...summaryColumns, skillMd: skillVersions.skillMd })
    .from(skillDefinitions)
    .innerJoin(skillVersions, onSkillVersion)
    .where(and(publicMarketSkillCondition(), eq(skillDefinitions.slug, slug)))
    .limit(1);
  if (!row) return null;

  const [categories, files, versions] = await Promise.all([
    listSkillCategorySlugs([row.definition.id]),
    db
      .select({
        path: skillVersionFiles.path,
        sizeBytes: skillVersionFiles.sizeBytes,
        mimeType: skillVersionFiles.mimeType,
        contentHash: skillVersionFiles.contentHash,
        // The one file whose text is public here, and only as a fallback for
        // a version that does not carry it in `skill_md`.
        skillMd: sql<
          string | null
        >`case when ${skillVersionFiles.path} = 'SKILL.md' then ${skillVersionFiles.contentText} end`,
      })
      .from(skillVersionFiles)
      .where(eq(skillVersionFiles.skillVersionId, row.version.id))
      .orderBy(skillVersionFiles.path),
    db
      .select({
        version: skillVersions.version,
        isCurrent: skillVersions.isCurrent,
        publishedAt: skillVersions.publishedAt,
        storagePointer: skillVersions.storagePointer,
        manifestJson: skillVersions.manifestJson,
      })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, row.definition.id),
          eq(skillVersions.status, "published"),
        ),
      )
      .orderBy(desc(skillVersions.createdAt), desc(skillVersions.id))
      .limit(MARKET_SKILL_VERSIONS_LIMIT),
  ]);

  const registry = row.version.manifestJson.registry;
  return {
    skill: mapMarketSkillSummary(row, categories.get(row.definition.id) ?? []),
    skillMd:
      row.skillMd ??
      files.find((file) => file.skillMd !== null)?.skillMd ??
      null,
    files: marketSkillFiles(files, registry?.fileManifest ?? []),
    versions: versions.map((version) => ({
      version: version.version,
      isCurrent: version.isCurrent,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      commitSha: marketSkillCommitSha(version),
      committedAt: version.manifestJson.registry?.committedAt ?? null,
    })),
    source: {
      repoUrl: registry?.repoUrl ?? null,
      sourceUrl: registry?.sourceUrl ?? null,
      commitSha: marketSkillCommitSha(row.version),
      committedAt: registry?.committedAt ?? null,
      repoSubpath:
        parseGithubStoragePointer(row.version.storagePointer)?.repoSubpath ??
        null,
    },
    scanFlags: registry?.scan?.flags ?? [],
  };
}

export { parseGithubStoragePointer };
