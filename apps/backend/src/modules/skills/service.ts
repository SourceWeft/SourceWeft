import { getSkillLogo } from "./logo";
import { ContentError } from "../content/errors";
import {
  getBuiltinSkillBySlug,
  listBuiltinSkills,
  loadBuiltinSkillBundle,
  validateBuiltinSkills,
} from "./builtin";
import {
  BuiltinSkillSlugConflictError,
  countSkillInstalls,
  createNextCustomSkillVersionDraft,
  createWorkspaceCustomSkillDraft,
  deleteCustomSkillVersionFileRecord,
  deleteWorkspaceSkillRecord,
  findCatalogSkillVersionForWorkspace,
  findInstallableSkillsByName,
  findWorkspaceCustomDraftVersion,
  listCatalogSkillVersionsForWorkspace,
  listCustomSkillVersionFileRecords,
  listWorkspaceInstalledSkills,
  loadSkillVersionBundle,
  mapWorkspaceSkill,
  publishWorkspaceCustomSkillVersion,
  syncBuiltinSkillMetadata,
  updateWorkspaceCustomDraftMetadata,
  updateWorkspaceSkillRecord,
  upsertCustomSkillVersionFile,
  upsertWorkspaceSkill,
} from "./repository";
import {
  scanCustomSkillBundle,
  validateCustomSkillBundle,
  validateCustomSkillFileInput,
} from "./custom-validation";
import { and, asc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { SKILLS_CATALOG_DEFAULT_PAGE_SIZE } from "@sourceweft/contracts";
import {
  db,
  skillDefinitions,
  type SkillManifestJson,
  skillVersions,
  workspaceSkills,
} from "@sourceweft/db";
import type {
  SkillCatalogItem,
  SkillSourceType,
  WorkspaceSkillRecord,
} from "./types";
import { builtinSkillSelectionId } from "./selection";
import { submitRegistrySkillFromGitHub } from "./registry/submit";
import { getRegistryVersionDetail, registryAccess } from "./registry/versions";
import { readSkillDocuments } from "./documents";
import { getRegistrySkillBySlug } from "./registry/repository";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";

// Lexical registry search tuning. Kept small — the registry catalog is a
// curated index, not a document corpus (skill-registry-index.md §4).
const REGISTRY_SEARCH_MIN_QUERY_LENGTH = 2;
const REGISTRY_SEARCH_RESULT_LIMIT = 25;
// Fetch cap before in-process relevance ranking. Bounded so a broad ILIKE
// match set can't balloon memory; ranking happens over this window.
const REGISTRY_CATALOG_QUERY_LIMIT = 100;

// Where a page of the registry catalog left off: the (displayName, id) of its
// last row. A keyset rather than an offset, so a skill indexed or withdrawn
// while someone pages neither repeats nor skips an entry.
type RegistryCatalogCursor = { name: string; id: string };

function encodeSkillCatalogCursor(cursor: RegistryCatalogCursor) {
  return Buffer.from(JSON.stringify([cursor.name, cursor.id])).toString(
    "base64url",
  );
}

/** null for anything that is not a cursor `listCatalog` handed out. */
export function decodeSkillCatalogCursor(
  cursor: string,
): RegistryCatalogCursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      parsed[1].length > 0
    ) {
      return { name: parsed[0], id: parsed[1] };
    }
  } catch {
    // Not base64url JSON — falls through to null.
  }
  return null;
}

// A catalog row as produced by `listCatalogSkillVersionsForWorkspace` and by
// the inline registry query below (identical select shape) so both feed the
// same `mapCatalogRow`.
type CatalogRow = {
  definition: typeof skillDefinitions.$inferSelect;
  version: typeof skillVersions.$inferSelect;
  enabled: typeof workspaceSkills.$inferSelect | null;
};

function displayNameFromName(name: string) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Registry catalog visibility (skill-registry-index.md §5.5): a `registry_github`
// entry is teamId/workspaceId-NULL, so `public` is universal while `restricted`
// (still under review) is visible ONLY to the user who submitted it. A
// restricted entry must never leak to a non-submitter.
function isRegistryRowVisibleToViewer(input: {
  visibility: string;
  ownerUserId: string | null;
  viewerUserId: string;
}) {
  if (input.visibility === "public") {
    return true;
  }
  if (input.visibility === "restricted") {
    return (
      input.ownerUserId !== null && input.ownerUserId === input.viewerUserId
    );
  }
  return false;
}

// UI-facing attribution + trust surface for a registry entry, derived purely
// from its manifest. `publisher` is always "Community" and `verified` always
// false — trust is admin-granted, never self-asserted (the trust firewall,
// skill-registry-index.md §0/§3). `flagged` mirrors the ingest scan verdict.
function registryCatalogFields(manifest: SkillManifestJson) {
  const registry = manifest.registry;
  return {
    publisher: "Community",
    verified: false,
    sourceUrl: registry?.sourceUrl ?? null,
    license: registry?.license ?? null,
    flagged: registry?.scan?.reviewRequired ?? false,
  };
}

// Lexical relevance for registry search. Lower = more relevant: exact name (0)
// < name prefix (1) < name substring (2) < description substring (3) < no match
// (4). The DB does the ILIKE filter; this re-ranks the matched window.
function skillSearchRelevanceRank(input: {
  displayName: string;
  description: string;
  query: string;
}) {
  const query = input.query.trim().toLowerCase();
  if (!query) {
    return 4;
  }
  const name = input.displayName.toLowerCase();
  const description = input.description.toLowerCase();
  if (name === query) {
    return 0;
  }
  if (name.startsWith(query)) {
    return 1;
  }
  if (name.includes(query)) {
    return 2;
  }
  if (description.includes(query)) {
    return 3;
  }
  return 4;
}

function compareSkillSearchRelevance(query: string) {
  return (a: SkillCatalogItem, b: SkillCatalogItem) => {
    const rankA = skillSearchRelevanceRank({
      displayName: a.displayName,
      description: a.description,
      query,
    });
    const rankB = skillSearchRelevanceRank({
      displayName: b.displayName,
      description: b.description,
      query,
    });
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return a.displayName.localeCompare(b.displayName);
  };
}

// Maps a DB catalog row (custom / managed builtin / registry) to a catalog item.
// Registry rows additionally carry the Community publisher + attribution/trust
// fields. Non-registry rows are unchanged from the prior inline mapping.
function mapCatalogRow(row: CatalogRow): SkillCatalogItem {
  const manifest = row.version.manifestJson;
  const base: SkillCatalogItem = {
    catalogId: `${row.definition.id}:${row.version.id}`,
    selectionId: row.enabled?.id ?? null,
    sourceType: row.definition.sourceType as SkillSourceType,
    skillId: row.definition.id,
    skillVersionId: row.version.id,
    slug: row.definition.slug,
    name: row.definition.displayName,
    version: row.version.version,
    displayName: row.definition.displayName,
    description: row.definition.description,
    visibility: row.definition.visibility,
    categories: Array.isArray(manifest.categories) ? manifest.categories : [],
    enabledWorkspaceSkillId: row.enabled?.id ?? null,
    enabled: row.enabled?.enabled ?? false,
    installable: true,
    defaultEnabled: manifest.defaultEnabled,
    logo: getSkillLogo(manifest),
    hasReadme: false,
    capabilities: manifest.capabilities,
    models: manifest.models,
    commands: manifest.commands,
    tools: manifest.tools,
    options: manifest.options,
    slash: manifest.slash,
    slashConfig: manifest.slashConfig,
    defaultConfig: manifest.defaultConfig,
  };
  if (row.definition.sourceType === "registry_github") {
    return { ...base, displayName: manifest.displayName, description: manifest.description, installable: row.version.status === "published", ...registryCatalogFields(manifest) };
  }
  return base;
}

// An always-on builtin (generators like ppt/video/image, `managed: false`) has
// no install state: it is read from disk and rendered as non-installable.
function mapBuiltinSkillToCatalogItem(
  skill: Awaited<ReturnType<typeof listBuiltinSkills>>[number],
): SkillCatalogItem {
  return {
    catalogId: `builtin:${skill.slug}`,
    selectionId: builtinSkillSelectionId(skill.slug),
    sourceType: "builtin",
    skillId: `builtin:${skill.slug}`,
    skillVersionId: `builtin:${skill.slug}:${skill.version}`,
    slug: skill.slug,
    name: skill.displayName,
    version: skill.version,
    displayName: skill.displayName,
    description: skill.description,
    visibility: skill.visibility,
    categories: skill.categories,
    enabledWorkspaceSkillId: null,
    enabled: true,
    installable: false,
    defaultEnabled: skill.manifestJson.defaultEnabled,
    hasReadme: false,
    capabilities: skill.manifestJson.capabilities,
    models: skill.manifestJson.models,
    commands: skill.manifestJson.commands,
    tools: skill.manifestJson.tools,
    options: skill.manifestJson.options,
    slash: skill.manifestJson.slash,
    slashConfig: skill.manifestJson.slashConfig,
    defaultConfig: skill.manifestJson.defaultConfig,
  };
}

function catalogItemMatchesQuery(item: SkillCatalogItem, query: string) {
  const needle = query.toLowerCase();
  return `${item.slug} ${item.displayName} ${item.description}`
    .toLowerCase()
    .includes(needle);
}

const REGISTRY_SLUG_PREFIX = "gh-";

/** drizzle wraps the driver error, so the pg fields may sit on `cause`. */
function isSkillSlugUniqueViolation(error: unknown): boolean {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    const pg = candidate as { code?: string; constraint?: string } | undefined;
    if (pg?.code === "23505" && pg.constraint === "skill_definitions_slug_uq") {
      return true;
    }
  }
  return false;
}

function skillSourceTrustRank(sourceType: string) {
  if (sourceType === "builtin") {
    return 0;
  }
  return sourceType === "registry_github" ? 2 : 1;
}

const SKILL_SEARCH_MAX_TERMS = 8;

/** The whole query plus its individual words, lowercased, shortest dropped. */
function skillSearchTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < REGISTRY_SEARCH_MIN_QUERY_LENGTH) {
    return [];
  }
  const words = normalized
    .split(/[\s,，、;；/|]+/u)
    .filter((word) => word.length >= REGISTRY_SEARCH_MIN_QUERY_LENGTH);
  return [...new Set([normalized, ...words])].slice(0, SKILL_SEARCH_MAX_TERMS);
}

export type InstalledSkillResult = {
  slug: string;
  displayName: string;
  description: string;
  sourceType: SkillSourceType;
  capability: "prompt-only" | "executable";
  license: string | null;
  flagged: boolean;
  sourceUrl: string | null;
  /**
   * `already_installed`: on and at this version already, nothing written.
   * `queued`: indexed but held for review, so not installed.
   */
  status: "installed" | "already_installed" | "queued";
  workspaceSkill: WorkspaceSkillRecord | null;
};

function describeInstallableRow(
  row: CatalogRow,
): Omit<InstalledSkillResult, "status" | "workspaceSkill"> {
  const registry = row.version.manifestJson.registry;
  return {
    slug: row.definition.slug,
    displayName: row.definition.displayName,
    description: row.definition.description,
    sourceType: row.definition.sourceType as SkillSourceType,
    capability: registry?.capability ?? "prompt-only",
    license: registry?.license ?? null,
    flagged: registry?.scan?.reviewRequired ?? false,
    sourceUrl: registry?.sourceUrl ?? null,
  };
}

const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const OWN_SKILL_PAGE_PATTERN = /^\/dashboard\/skills\/([^/]+)\/?$/;

/**
 * What an `install_skill` source string refers to. A bare name is looked up in
 * the catalog; anything path- or URL-shaped is a GitHub reference, except a
 * link to this deployment's own skill page, which is just another way to name a
 * catalog entry. Other hosts are refused outright rather than handed to the
 * GitHub reader: a third-party directory page is not a source we can pin, scan
 * or attribute, and what such pages tell an agent to do is not ours to follow.
 */
function parseSkillInstallSource(
  raw: string,
): { kind: "name"; name: string } | { kind: "github"; reference: string } {
  const source = raw.trim();
  if (!source) {
    throw new ContentError(
      400,
      "SKILL_SOURCE_REQUIRED",
      "A skill source is required",
    );
  }
  if (SKILL_NAME_PATTERN.test(source.toLowerCase())) {
    return { kind: "name", name: source.toLowerCase() };
  }
  let url: URL | null = null;
  try {
    url = new URL(source);
  } catch {
    // Not a URL — `owner/repo`, left to the GitHub reader to validate.
  }
  if (url) {
    const ownPage =
      url.origin === new URL(config.auth.webBaseUrl).origin
        ? url.pathname.match(OWN_SKILL_PAGE_PATTERN)
        : null;
    if (ownPage?.[1]) {
      return {
        kind: "name",
        name: decodeURIComponent(ownPage[1]).toLowerCase(),
      };
    }
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
      throw new ContentError(
        400,
        "SKILL_SOURCE_UNSUPPORTED",
        "Only a catalog slug, a SourceWeft skill link, or a github.com repository can be installed",
      );
    }
  }
  return { kind: "github", reference: source };
}

function ambiguousSkillName(
  name: string,
  candidates: Array<{ slug: string; description: string }>,
) {
  return new ContentError(
    409,
    "SKILL_NAME_AMBIGUOUS",
    `'${name}' matches ${candidates.length} skills. Use the full slug of the one you mean:\n${candidates
      .map((candidate) => `- ${candidate.slug} — ${candidate.description}`)
      .join("\n")}`,
  );
}

function pickInstallableByName(rows: CatalogRow[], name: string): CatalogRow {
  if (rows.length > 1) {
    throw ambiguousSkillName(
      name,
      rows.map((row) => ({
        slug: row.definition.slug,
        description: row.definition.description,
      })),
    );
  }
  const [row] = rows;
  if (!row) {
    throw new ContentError(
      404,
      "SKILL_NOT_FOUND",
      `No skill named '${name}' is available to this workspace. Use search_skills to see what is, or give a GitHub repository to add a new one.`,
    );
  }
  return row;
}

export class ContentSkillsService {
  async syncBuiltinCatalog() {
    await validateBuiltinSkills();
    const synced = [];
    const skipped: string[] = [];
    for (const skill of await listBuiltinSkills()) {
      try {
        synced.push(
          await syncBuiltinSkillMetadata({
            slug: skill.slug,
            displayName: skill.displayName,
            description: skill.description,
            visibility: skill.visibility,
            version: skill.version,
            storagePointer: skill.storagePointer,
            contentHash: skill.contentHash,
            manifestJson: skill.manifestJson,
          }),
        );
      } catch (error) {
        // This runs at API boot. A slug collision costs that ONE builtin its
        // catalog row (a `managed` one is not installable until it is
        // resolved); anything else — the database being down — still fails
        // the boot.
        if (!(error instanceof BuiltinSkillSlugConflictError)) {
          throw error;
        }
        skipped.push(skill.slug);
        logger.error("Builtin skill not synced: its slug is taken", {
          slug: error.slug,
          conflictingSourceType: error.conflictingSourceType,
        });
      }
    }
    return { items: synced, skipped };
  }

  async validateBuiltinCatalog() {
    await validateBuiltinSkills();
  }

  /**
   * One page of the catalog. Everything that is not a registry skill — managed
   * builtins, the workspace's and team's own skills, always-on builtins — is a
   * small bounded set and rides whole on the FIRST page; `limit` and `cursor`
   * page through the registry, which is the part that grows without bound.
   * Registry rows come last so a following page simply appends.
   */
  async listCatalog(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    limit?: number;
    cursor?: string;
    query?: string;
  }) {
    const after = input.cursor
      ? decodeSkillCatalogCursor(input.cursor)
      : undefined;
    if (after === null) {
      throw new ContentError(
        400,
        "INVALID_CURSOR",
        "Catalog cursor is not valid",
      );
    }
    const query = input.query?.trim() || undefined;
    const limit = input.limit ?? SKILLS_CATALOG_DEFAULT_PAGE_SIZE;

    const items: SkillCatalogItem[] = after
      ? []
      : (await this.listBoundedCatalogItems(input)).filter(
          (item) => !query || catalogItemMatchesQuery(item, query),
        );

    // Registry catalog entries: Community publisher, unverified, with
    // public / submitter-owned-restricted visibility (skill-registry-index.md
    // §0/§5.5). Same DB-row → `SkillCatalogItem` convergence as the rest. One
    // row past the page tells us whether another page exists without a count.
    const registryRows = await this.listRegistryCatalogRows({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      query,
      after,
      limit: limit + 1,
    });
    const pageRows = registryRows.slice(0, limit);
    items.push(...pageRows.map(mapCatalogRow));
    const last = pageRows.at(-1);
    // `hasReadme` is deliberately left false here. Resolving it per item meant
    // loading every skill's *entire* bundle — for builtins that is a fresh
    // capability discovery scan plus a full read of every file — to answer one
    // boolean the list view never renders. The only consumer is the skill
    // detail page, and getCatalogSkillDetail fills it in from files it has
    // already read.
    return {
      items,
      nextCursor:
        registryRows.length > limit && last
          ? encodeSkillCatalogCursor({
              name: last.definition.displayName,
              id: last.definition.id,
            })
          : null,
    };
  }

  /** The non-registry part of the catalog: a handful of rows, never paged. */
  private async listBoundedCatalogItems(input: {
    teamId: string;
    workspaceId: string;
  }) {
    // The catalog is synced once at API startup (api/main.ts), which writes a
    // definition/version row for every builtin. `managed` builtins (e.g. feynman)
    // flow through the DB-row path below so they get a real skillId/versionId and
    // an opt-in install state from workspace_skills — identical to custom skills.
    // `always-on` builtins (generators like ppt/video/image, `managed: false`)
    // are read from the filesystem further down and rendered as non-installable.
    const rows = await listCatalogSkillVersionsForWorkspace(input);

    // Registry (`registry_github`) skills are surfaced by their own paged query
    // (own visibility rule + attribution), so they are excluded from the
    // shared DB-row path here to avoid double-emitting.
    const installableRows = rows.filter(
      (row) =>
        row.definition.sourceType !== "registry_github" &&
        (row.definition.sourceType !== "builtin" ||
          row.version.manifestJson.managed === true) &&
        row.version.manifestJson.listing !== "hidden",
    );

    const items: SkillCatalogItem[] = installableRows.map(mapCatalogRow);

    // Builtins already surfaced via the DB-row path above (managed ones) must not
    // be emitted a second time from disk.
    const managedBuiltinSlugs = new Set(
      installableRows
        .filter((row) => row.definition.sourceType === "builtin")
        .map((row) => row.definition.slug),
    );
    for (const skill of await listBuiltinSkills()) {
      if (skill.manifestJson.listing === "hidden") {
        continue;
      }
      if (managedBuiltinSlugs.has(skill.slug)) {
        continue;
      }
      items.push(mapBuiltinSkillToCatalogItem(skill));
    }
    return items;
  }

  /**
   * Registry catalog rows (`sourceType='registry_github'`) for a viewer.
   *
   * Kept inline here (rather than in repository.ts) deliberately: R3 scopes the
   * registry catalog/search surface to this service, so the query lives beside
   * its consumers; it can migrate to repository.ts when the registry gains its
   * own repository module. Visibility is enforced in SQL AND re-checked in
   * process (defense-in-depth) so a restricted entry never reaches a
   * non-submitter. Pass `query` to additionally ILIKE-filter name/description.
   *
   * Rows come back in (displayName, id) order — the id breaks ties, so the
   * order is total and `after` can resume it exactly. Without an order the
   * LIMIT below used to pick an arbitrary window once the registry outgrew it.
   */
  private async listRegistryCatalogRows(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    query?: string;
    /** Match ANY of these instead of `query` as one phrase. */
    terms?: string[];
    /** Only this slug — the direct lookup behind a skill's own page. */
    slug?: string;
    /** Resume strictly after this row. */
    after?: RegistryCatalogCursor;
    limit?: number;
  }): Promise<CatalogRow[]> {
    const conditions = [
      eq(skillDefinitions.sourceType, "registry_github"),
      eq(skillDefinitions.status, "active"),
      // In SQL rather than after the fetch, so a hidden entry does not use up
      // a slot of the page.
      sql`${skillVersions.manifestJson}->>'listing' is distinct from 'hidden'`,
      or(
        and(eq(skillVersions.status, "published"), eq(skillVersions.isCurrent, true)),
        and(eq(skillDefinitions.ownerUserId, input.userId),
          sql`not exists (select 1 from skill_versions current_version where current_version.skill_id = ${skillDefinitions.id} and current_version.is_current = true)`,
          sql`${skillVersions.id} = (select latest_version.id from skill_versions latest_version where latest_version.skill_id = ${skillDefinitions.id} order by latest_version.created_at desc, latest_version.id desc limit 1)`),
      ),
      or(
        eq(skillDefinitions.visibility, "public"),
        and(
          eq(skillDefinitions.visibility, "restricted"),
          eq(skillDefinitions.ownerUserId, input.userId),
        ),
      ),
    ];
    if (input.slug) {
      conditions.push(eq(skillDefinitions.slug, input.slug));
    }
    if (input.after) {
      conditions.push(
        sql`(${skillDefinitions.displayName}, ${skillDefinitions.id}) > (${input.after.name}, ${input.after.id})`,
      );
    }
    const terms = input.terms ?? (input.query ? [input.query] : []);
    if (terms.length > 0) {
      conditions.push(
        or(
          ...terms.flatMap((term) => {
            const like = `%${term}%`;
            return [
              ilike(skillDefinitions.displayName, like),
              ilike(skillDefinitions.description, like),
              // The slug matters as much as the prose: it carries the author's
              // own name for the skill, which is what someone types when they
              // already know what they want ("internal-comms"). Matching only
              // display name and description made that exact search miss, and
              // the caller then had to guess at synonyms.
              ilike(skillDefinitions.slug, like),
            ];
          }),
        ),
      );
    }

    const rows = await db
      .select({
        definition: skillDefinitions,
        version: skillVersions,
        enabled: workspaceSkills,
      })
      .from(skillDefinitions)
      .innerJoin(skillVersions, eq(skillVersions.skillId, skillDefinitions.id))
      .leftJoin(
        workspaceSkills,
        and(
          eq(workspaceSkills.teamId, input.teamId),
          eq(workspaceSkills.workspaceId, input.workspaceId),
          eq(workspaceSkills.skillId, skillDefinitions.id),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(skillDefinitions.displayName), asc(skillDefinitions.id))
      .limit(input.limit ?? REGISTRY_CATALOG_QUERY_LIMIT);

    // Defense-in-depth: re-apply the visibility predicate in process so a
    // restricted entry can never leak even if the SQL guard ever regresses.
    return rows.filter((row) =>
      isRegistryRowVisibleToViewer({
        visibility: row.definition.visibility,
        ownerUserId: row.definition.ownerUserId,
        viewerUserId: input.userId,
      }),
    );
  }

  /**
   * Lexical search over the registry index (skill-registry-index.md §4).
   * ILIKE over displayName + description (the same drizzle-`ilike` posture the
   * MCP market read-repository uses), re-ranked by relevance. No vector search.
   */
  async searchRegistry(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    query: string;
  }) {
    const query = input.query.trim();
    if (query.length < REGISTRY_SEARCH_MIN_QUERY_LENGTH) {
      return { items: [] as SkillCatalogItem[], query };
    }
    const rows = await this.listRegistryCatalogRows({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      query,
    });
    const items = rows
      .filter((row) => row.version.manifestJson.listing !== "hidden")
      .map(mapCatalogRow)
      .sort(compareSkillSearchRelevance(query))
      .slice(0, REGISTRY_SEARCH_RESULT_LIMIT);
    return { items, query };
  }

  /**
   * Search everything this workspace can install — the agent's `search_skills`.
   *
   * `searchRegistry` alone made the workspace's own skills, its team's, and the
   * opt-in builtins invisible to the agent: it could be asked for "our
   * meeting-notes skill" and truthfully report that nothing matched. Registry
   * rows keep their SQL filter (that index is the large one); the rest of the
   * catalog is a handful of rows and is matched in process.
   *
   * Matching is per TERM, not per phrase. Measured live: a model searches the
   * way it thinks — "费曼学习法 Feynman technique explain" — and a whole-phrase
   * ILIKE answered "nothing" for a catalog that had `feynman` in it. Any term
   * may match; the more terms an entry matches, the higher it ranks.
   */
  async searchCatalog(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    query: string;
  }) {
    const query = input.query.trim();
    const terms = skillSearchTerms(query);
    if (terms.length === 0) {
      return {
        items: [] as Array<SkillCatalogItem & { installCount: number }>,
        query,
        total: 0,
      };
    }
    const matchCount = (item: SkillCatalogItem) => {
      const haystack =
        `${item.slug} ${item.displayName} ${item.description}`.toLowerCase();
      return terms.filter((term) => haystack.includes(term)).length;
    };
    const registryItems = (
      await this.listRegistryCatalogRows({ ...input, terms })
    )
      .filter((row) => row.version.manifestJson.listing !== "hidden")
      .map(mapCatalogRow);
    const ownItems = (await listCatalogSkillVersionsForWorkspace(input))
      .filter(
        (row) =>
          row.definition.sourceType !== "registry_github" &&
          (row.definition.sourceType !== "builtin" ||
            row.version.manifestJson.managed === true) &&
          row.version.manifestJson.listing !== "hidden",
      )
      .map(mapCatalogRow);
    const matched = [...ownItems, ...registryItems]
      .map((item) => ({ item, matches: matchCount(item) }))
      .filter((entry) => entry.matches > 0);
    const installs = await countSkillInstalls(
      matched.map((entry) => entry.item.skillId),
    );
    const byRelevance = compareSkillSearchRelevance(query);
    const items = matched
      .sort(
        (a, b) =>
          b.matches - a.matches ||
          skillSearchRelevanceRank({ ...a.item, query }) -
            skillSearchRelevanceRank({ ...b.item, query }) ||
          // Same textual fit: first-party before the workspace's own before
          // third-party, then whatever more workspaces actually keep on.
          skillSourceTrustRank(a.item.sourceType) -
            skillSourceTrustRank(b.item.sourceType) ||
          (installs.get(b.item.skillId) ?? 0) -
            (installs.get(a.item.skillId) ?? 0) ||
          byRelevance(a.item, b.item),
      )
      .slice(0, REGISTRY_SEARCH_RESULT_LIMIT)
      .map((entry) => ({
        ...entry.item,
        installCount: installs.get(entry.item.skillId) ?? 0,
      }));
    return { items, query, total: matched.length };
  }

  /**
   * Install a skill into a workspace — the ONE install path. The catalog UI
   * names the skill by id (`ref.kind === "version"`); the agent's
   * `install_skill` names it by `source`, which accepts what a person would
   * naturally give: a catalog slug, the author's short name ("pdf"), a link to
   * this deployment's own skill page, a GitHub URL (optionally deep-linked to
   * one skill's directory), or the `owner/repo` shorthand.
   *
   * Every form resolves to a catalog row through `installableSkillCondition`,
   * so a workspace can only install what its catalog shows it: builtins marked
   * `managed`, its own and its team's skills, public skills, and registry
   * skills the caller submitted. The slug path used to skip that check and
   * could install — and thereby entitle — another submitter's `restricted`
   * skill by guessing its slug.
   *
   * A GitHub reference that is not indexed yet goes through the submit pipeline
   * first (scan + triage included); `skill` narrows a multi-skill repository to
   * the one that was asked for, mirroring `lh skill install <repo> --skill`. The
   * whole repo is still INDEXED — that is what makes the rest searchable — only
   * the install narrows. A submission the scan held for review is reported as
   * `queued` and not installed: a draft version is not selectable, so
   * installing it would be a dead reference.
   *
   * Installing enables (product decision, 2026-09): whatever the catalog offers
   * a workspace can be put to work in one step, by a person or by the agent.
   * The gates are upstream of this method — the scan and review queue at
   * ingest, and visibility here — not a second approval at install time.
   */
  async installSkill(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    ref:
      | { kind: "version"; skillId: string; skillVersionId: string }
      | { kind: "source"; source: string; skill?: string };
    configJson?: Record<string, unknown>;
    /** Who is installing; recorded on the row. Defaults to a person. */
    installedVia?: "user" | "agent";
  }): Promise<{ skills: InstalledSkillResult[] }> {
    const scope = {
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
    };
    const install = async (row: CatalogRow): Promise<InstalledSkillResult> => {
      // Same version, already on: nothing to write. Saying "installed" again
      // would have the agent announce an install that did not happen.
      if (
        row.enabled?.enabled &&
        row.enabled.skillVersionId === row.version.id &&
        input.configJson === undefined
      ) {
        return {
          ...describeInstallableRow(row),
          status: "already_installed",
          workspaceSkill: mapWorkspaceSkill(row.enabled),
        };
      }
      const workspaceSkill = await upsertWorkspaceSkill({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        skillId: row.definition.id,
        skillVersionId: row.version.id,
        enabledBy: input.userId,
        // Re-installing must not wipe the config of a skill already in place.
        configJson: input.configJson ?? row.enabled?.configJson,
        installedVia: input.installedVia ?? "user",
      });
      return {
        ...describeInstallableRow(row),
        status: "installed",
        workspaceSkill,
      };
    };

    if (input.ref.kind === "version") {
      const row = await findCatalogSkillVersionForWorkspace({
        ...scope,
        skillId: input.ref.skillId,
        skillVersionId: input.ref.skillVersionId,
      });
      if (!row) {
        throw new ContentError(
          404,
          "SKILL_NOT_FOUND",
          "Skill not found or not available to this workspace",
        );
      }
      return { skills: [await install(row)] };
    }

    const source = parseSkillInstallSource(input.ref.source);
    if (source.kind === "name") {
      const row = pickInstallableByName(
        await findInstallableSkillsByName({ ...scope, name: source.name }),
        source.name,
      );
      return { skills: [await install(row)] };
    }

    const submitted = await submitRegistrySkillFromGitHub({
      repoUrl: source.reference,
      userId: input.userId,
    });
    const accepted = submitted.skills.flatMap((item) =>
      item.status !== "failed" && item.slug && item.name
        ? [{ slug: item.slug, name: item.name, status: item.status }]
        : [],
    );
    // Match the author's frontmatter name — what a person actually says ("the
    // pdf skill") rather than `gh-<owner>-<repo>-<name>`. A full slug works too.
    const wanted = input.ref.skill?.trim().toLowerCase();
    const selected = wanted
      ? accepted.filter(
          (entry) =>
            entry.name.toLowerCase() === wanted ||
            entry.slug.toLowerCase() === wanted,
        )
      : accepted;
    if (wanted && selected.length === 0) {
      throw new ContentError(
        404,
        "SKILL_NOT_FOUND",
        `'${source.reference}' has no skill named '${input.ref.skill}'. It ships: ${accepted
          .map((entry) => entry.name)
          .slice(0, 30)
          .join(", ")}`,
      );
    }

    const skills: InstalledSkillResult[] = [];
    for (const entry of selected) {
      const [row] =
        entry.status === "indexed"
          ? await findInstallableSkillsByName({ ...scope, name: entry.slug })
          : [];
      if (row) {
        skills.push(await install(row));
        continue;
      }
      const held = await getRegistrySkillBySlug(entry.slug);
      if (held && held.definition.ownerUserId === input.userId) {
        skills.push({
          ...describeInstallableRow({ ...held, enabled: null }),
          status: "queued",
          workspaceSkill: null,
        });
      }
    }
    if (skills.length === 0) {
      throw new ContentError(
        404,
        "SKILL_NOT_FOUND",
        `No installable skill was found at '${source.reference}'`,
      );
    }
    return { skills };
  }

  /**
   * Switch an installed skill back on, by slug.
   *
   * Installing already enables, so this only matters for a skill somebody
   * deliberately switched off — which is why its tool still asks a person
   * first: the model overriding that choice on its own is a different act from
   * installing something new.
   */
  async enableWorkspaceSkillBySlug(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    slug: string;
  }) {
    const slug = input.slug.trim().toLowerCase();
    const installed = await listWorkspaceInstalledSkills({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
    });
    const exact = installed.filter((item) => item.slug === slug);
    // Accept the author's own name too — it is what a person says out loud,
    // and the same handle `install_skill` takes.
    const matches =
      exact.length > 0
        ? exact
        : installed.filter(
            (item) =>
              item.sourceType === "registry_github" &&
              item.slug.endsWith(`-${slug}`),
          );
    if (matches.length > 1) {
      throw ambiguousSkillName(
        input.slug,
        matches.map((item) => ({
          slug: item.slug,
          description: item.description,
        })),
      );
    }
    const match = matches[0];
    if (!match) {
      throw new ContentError(
        404,
        "SKILL_NOT_FOUND",
        `'${input.slug}' is not installed in this workspace. Install it first with install_skill.`,
      );
    }
    if (match.enabled) {
      return { skill: match, alreadyEnabled: true };
    }
    await upsertWorkspaceSkill({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: match.skillId,
      skillVersionId: match.skillVersionId,
      enabledBy: input.userId,
      configJson: match.configJson,
      enabled: true,
    });
    return { skill: match, alreadyEnabled: false };
  }

  async listWorkspaceSkills(input: { teamId: string; workspaceId: string }) {
    return { items: await listWorkspaceInstalledSkills(input) };
  }

  /**
   * Slugs of `managed` builtins that are NOT installed+enabled in this workspace.
   * The capability catalog hides these so the composer never offers a slash
   * command (e.g. /feynman) for an uninstalled opt-in builtin. Always-on builtins
   * (managed !== true) are never hidden.
   */
  async listHiddenManagedBuiltinSlugs(input: {
    teamId: string;
    workspaceId: string;
  }) {
    const [builtins, installed] = await Promise.all([
      listBuiltinSkills(),
      listWorkspaceInstalledSkills(input),
    ]);
    const enabledBuiltinSlugs = new Set(
      installed
        .filter((item) => item.sourceType === "builtin" && item.enabled)
        .map((item) => item.slug),
    );
    return builtins
      .filter(
        (skill) =>
          skill.manifestJson.managed === true &&
          !enabledBuiltinSlugs.has(skill.slug),
      )
      .map((skill) => skill.slug);
  }

  async getCatalogSkillDetail(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    catalogId: string;
  }) {
    return this.describeCatalogItem(
      input,
      await this.findCatalogItemById(input, input.catalogId),
    );
  }

  /**
   * The same detail, addressed by slug — what a skill's own page has. It used
   * to list the whole catalog and search it, so a skill past the catalog's
   * window read as "not found". Slugs are unique across every source type.
   */
  async getCatalogSkillDetailBySlug(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    slug: string;
  }) {
    // Stored rows first, then disk: the order `listCatalog` emits them in.
    const item =
      (await this.findStoredCatalogItemBySlug(input, input.slug)) ??
      (await this.findDiskBuiltinCatalogItem(input, input.slug));
    return this.describeCatalogItem(input, item);
  }

  private async describeCatalogItem(
    viewer: { teamId: string; workspaceId: string; userId: string },
    item: SkillCatalogItem | null,
  ) {
    if (!item) {
      throw new ContentError(404, "SKILL_NOT_FOUND", "Skill not found");
    }

    // Registry previews use the same viewer/version authorization as version details.
    // Runtime bundle access remains governed by workspace entitlements.
    const documents = item.sourceType === "registry_github"
      ? await getRegistryVersionDetail({ ...viewer, catalogId: item.catalogId, versionId: item.skillVersionId })
      : readSkillDocuments(await this.getSkillFiles(viewer, item));
    return {
      skill: { ...item, hasReadme: documents.readmeContent !== null },
      readmeContent: documents.readmeContent,
      readmePath: documents.readmePath,
      skillContent: documents.skillContent,
    };
  }

  /**
   * Resolve a catalogId — `<skillId>:<versionId>` or `builtin:<slug>` — with a
   * direct query, never by listing the catalog.
   */
  private async findCatalogItemById(
    viewer: { teamId: string; workspaceId: string; userId: string },
    catalogId: string,
  ): Promise<SkillCatalogItem | null> {
    if (catalogId.startsWith("builtin:")) {
      const slug = catalogId.slice("builtin:".length);
      return slug ? this.findDiskBuiltinCatalogItem(viewer, slug) : null;
    }
    const [skillId, versionId, ...rest] = catalogId.split(":");
    if (!skillId || !versionId || rest.length > 0) {
      return null;
    }
    const ids = { skillId, versionId };
    const [registryItem, ownItem] = await Promise.all([
      this.findRegistryCatalogItemByIds(viewer, ids),
      this.findOwnCatalogItemByIds(viewer, ids),
    ]);
    return registryItem ?? ownItem;
  }

  /**
   * Wider than the catalog listing on purpose: a registry version that is not
   * the current one (an installed older version, the owner's draft) has a
   * detail page too, under the same access rule as the version endpoints.
   */
  private async findRegistryCatalogItemByIds(
    viewer: { teamId: string; workspaceId: string; userId: string },
    ids: { skillId: string; versionId: string },
  ) {
    const [row] = await db.select({ definition: skillDefinitions, version: skillVersions, enabled: workspaceSkills })
      .from(skillDefinitions).innerJoin(skillVersions, eq(skillVersions.skillId, skillDefinitions.id))
      .leftJoin(workspaceSkills, and(eq(workspaceSkills.skillId, skillDefinitions.id), eq(workspaceSkills.workspaceId, viewer.workspaceId), eq(workspaceSkills.teamId, viewer.teamId)))
      .where(and(eq(skillDefinitions.id, ids.skillId), eq(skillVersions.id, ids.versionId), eq(skillDefinitions.sourceType, "registry_github"), eq(skillDefinitions.status, "active"), registryAccess(viewer),
        or(eq(skillVersions.status, "published"), eq(skillDefinitions.ownerUserId, viewer.userId)))).limit(1);
    return row ? mapCatalogRow(row) : null;
  }

  /** A workspace/team skill or a managed builtin, as the catalog lists it. */
  private async findOwnCatalogItemByIds(
    viewer: { teamId: string; workspaceId: string },
    ids: { skillId: string; versionId: string },
  ) {
    // Without a userId the repository predicate stays on plain workspace
    // visibility; the registry has its own rule above.
    const row = await findCatalogSkillVersionForWorkspace({
      teamId: viewer.teamId,
      workspaceId: viewer.workspaceId,
      skillId: ids.skillId,
      skillVersionId: ids.versionId,
    });
    if (
      !row ||
      row.definition.sourceType === "registry_github" ||
      !row.version.isCurrent ||
      row.version.manifestJson.listing === "hidden"
    ) {
      return null;
    }
    return mapCatalogRow(row);
  }

  /** A DB-backed catalog entry by slug, under the rules the catalog lists by. */
  private async findStoredCatalogItemBySlug(
    viewer: { teamId: string; workspaceId: string; userId: string },
    slug: string,
  ): Promise<SkillCatalogItem | null> {
    const [registryRow] = await this.listRegistryCatalogRows({
      ...viewer,
      slug,
      limit: 1,
    });
    if (registryRow) {
      return mapCatalogRow(registryRow);
    }
    // Inline for the same reason as the registry query. It only turns the slug
    // into ids; whether this workspace may see the skill is still decided by
    // the repository's predicate in `findOwnCatalogItemByIds`.
    const [current] = await db
      .select({ skillId: skillDefinitions.id, versionId: skillVersions.id })
      .from(skillDefinitions)
      .innerJoin(skillVersions, eq(skillVersions.skillId, skillDefinitions.id))
      .where(
        and(
          eq(skillDefinitions.slug, slug),
          ne(skillDefinitions.sourceType, "registry_github"),
          eq(skillVersions.isCurrent, true),
        ),
      )
      .limit(1);
    return current ? this.findOwnCatalogItemByIds(viewer, current) : null;
  }

  /**
   * A builtin the catalog serves from disk. A `managed` builtin is listed
   * under its DB row instead whenever this workspace can see that row, so the
   * disk form only answers for it when there is none — as in `listCatalog`.
   */
  private async findDiskBuiltinCatalogItem(
    viewer: { teamId: string; workspaceId: string; userId: string },
    slug: string,
  ) {
    const skill = await getBuiltinSkillBySlug(slug);
    if (!skill || skill.manifestJson.listing === "hidden") {
      return null;
    }
    if (skill.manifestJson.managed === true) {
      const stored = await this.findStoredCatalogItemBySlug(viewer, slug);
      if (stored?.sourceType === "builtin") {
        return null;
      }
    }
    return mapBuiltinSkillToCatalogItem(skill);
  }

  private async getSkillFiles(
    input: { teamId: string; workspaceId: string },
    item: SkillCatalogItem,
  ) {
    if (!item.installable && item.sourceType === "builtin") {
      const skill = await getBuiltinSkillBySlug(item.slug);
      return skill
        ? ((await loadBuiltinSkillBundle(skill.storagePointer))?.files ?? [])
        : [];
    }
    const bundle = await loadSkillVersionBundle({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: item.skillId,
      skillVersionId: item.skillVersionId,
    });
    if (!bundle) {
      return [];
    }
    if (bundle.version.storageType === "repo_builtin") {
      return (
        (await loadBuiltinSkillBundle(bundle.version.storagePointer))?.files ??
        []
      );
    }
    return bundle.files;
  }

  async createWorkspaceCustomSkill(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    name: string;
    displayName?: string;
    description: string;
    version?: string;
  }) {
    // Slugs are global. `gh-…` is the registry's namespace — a custom skill
    // there blocks that repository's skill from ever being indexed — and a
    // builtin's name would shadow it (see `syncBuiltinCatalog`).
    if (
      input.name.startsWith(REGISTRY_SLUG_PREFIX) ||
      (await getBuiltinSkillBySlug(input.name))
    ) {
      throw new ContentError(
        409,
        "SKILL_NAME_RESERVED",
        `'${input.name}' is reserved. Choose another name.`,
      );
    }
    try {
      return {
        customSkill: await createWorkspaceCustomSkillDraft({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          name: input.name,
          displayName: input.displayName ?? displayNameFromName(input.name),
          description: input.description,
          version: input.version,
        }),
      };
    } catch (error) {
      if (isSkillSlugUniqueViolation(error)) {
        // Was an unhandled 23505 → HTTP 500.
        throw new ContentError(
          409,
          "SKILL_NAME_TAKEN",
          `A skill named '${input.name}' already exists. Choose another name.`,
        );
      }
      throw error;
    }
  }

  async createWorkspaceCustomSkillVersion(input: {
    teamId: string;
    workspaceId: string;
    skillId: string;
    userId: string;
    version: string;
  }) {
    const customSkill = await createNextCustomSkillVersionDraft(input);
    if (!customSkill) {
      throw new ContentError(
        404,
        "CUSTOM_SKILL_NOT_FOUND",
        "Custom skill not found",
      );
    }
    return { customSkill };
  }

  async updateWorkspaceCustomSkillVersion(input: {
    teamId: string;
    workspaceId: string;
    skillId: string;
    skillVersionId: string;
    displayName?: string;
    description?: string;
  }) {
    const draft = await updateWorkspaceCustomDraftMetadata(input);
    if (!draft) {
      throw new ContentError(
        404,
        "CUSTOM_SKILL_DRAFT_NOT_FOUND",
        "Custom skill draft version not found",
      );
    }
    return { customSkill: draft };
  }

  async putWorkspaceCustomSkillVersionFile(input: {
    teamId: string;
    workspaceId: string;
    skillId: string;
    skillVersionId: string;
    path: string;
    contentText: string;
    mimeType?: string | null;
  }) {
    const file = validateCustomSkillFileInput({
      path: input.path,
      contentText: input.contentText,
      mimeType: input.mimeType,
    });
    const saved = await upsertCustomSkillVersionFile({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
      file,
    });
    if (!saved) {
      throw new ContentError(
        404,
        "CUSTOM_SKILL_DRAFT_NOT_FOUND",
        "Custom skill draft version not found",
      );
    }
    return { file: saved };
  }

  async deleteWorkspaceCustomSkillVersionFile(input: {
    teamId: string;
    workspaceId: string;
    skillId: string;
    skillVersionId: string;
    path: string;
  }) {
    const file = validateCustomSkillFileInput({
      path: input.path,
      contentText: "",
    });
    const deleted = await deleteCustomSkillVersionFileRecord({
      ...input,
      path: file.path,
    });
    if (!deleted) {
      throw new ContentError(
        404,
        "CUSTOM_SKILL_FILE_NOT_FOUND",
        "Custom skill draft file not found",
      );
    }
    return { deleted: true as const, path: file.path };
  }

  async publishWorkspaceCustomSkillVersion(input: {
    teamId: string;
    workspaceId: string;
    skillId: string;
    skillVersionId: string;
  }) {
    const draft = await findWorkspaceCustomDraftVersion(input);
    if (!draft) {
      throw new ContentError(
        404,
        "CUSTOM_SKILL_DRAFT_NOT_FOUND",
        "Custom skill draft version not found",
      );
    }
    const files = await listCustomSkillVersionFileRecords({
      skillVersionId: input.skillVersionId,
    });
    const bundle = validateCustomSkillBundle({
      files: files.map((file) => ({
        path: file.path,
        contentText: file.contentText,
        mimeType: file.mimeType,
      })),
    });
    const expectedVisibility =
      draft.definition.sourceType === "team_custom" ? "team" : "workspace";
    if (bundle.manifestJson.visibility !== expectedVisibility) {
      throw new ContentError(
        400,
        "CUSTOM_SKILL_VISIBILITY_MISMATCH",
        "Custom skill manifest visibility does not match its scope",
      );
    }
    if (bundle.name !== draft.definition.slug) {
      throw new ContentError(
        400,
        "CUSTOM_SKILL_SLUG_MISMATCH",
        "Custom skill manifest slug cannot change after creation",
      );
    }

    const customSkill = await publishWorkspaceCustomSkillVersion({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
      name: bundle.name,
      displayName: bundle.displayName,
      description: bundle.description,
      version: bundle.version,
      contentHash: bundle.contentHash,
      // Same scan a community skill gets, but only recorded: the author is a
      // member of this workspace, so flags neither block nor queue the publish.
      manifestJson: {
        ...bundle.manifestJson,
        customScan: scanCustomSkillBundle({ files: bundle.files }),
      },
    });
    if (!customSkill) {
      throw new ContentError(
        404,
        "CUSTOM_SKILL_DRAFT_NOT_FOUND",
        "Custom skill draft version not found",
      );
    }
    return { customSkill };
  }

  async updateWorkspaceSkill(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    workspaceSkillId: string;
    enabled?: boolean;
    configJson?: Record<string, unknown>;
  }) {
    const workspaceSkill = await updateWorkspaceSkillRecord(input);
    if (!workspaceSkill) {
      throw new ContentError(
        404,
        "WORKSPACE_SKILL_NOT_FOUND",
        "Workspace skill not found",
      );
    }
    return { workspaceSkill };
  }

  async deleteWorkspaceSkill(input: {
    teamId: string;
    workspaceId: string;
    workspaceSkillId: string;
  }) {
    const deleted = await deleteWorkspaceSkillRecord(input);
    if (!deleted) {
      throw new ContentError(
        404,
        "WORKSPACE_SKILL_NOT_FOUND",
        "Workspace skill not found",
      );
    }
    return { deleted: true as const, workspaceSkillId: input.workspaceSkillId };
  }
}

export const contentSkillsService = new ContentSkillsService();

export const testExports = {
  isRegistryRowVisibleToViewer,
  registryCatalogFields,
  skillSearchRelevanceRank,
  compareSkillSearchRelevance,
  mapCatalogRow,
  parseSkillInstallSource,
  pickInstallableByName,
  skillSearchTerms,
  isSkillSlugUniqueViolation,
};
