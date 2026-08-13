import { ContentError } from "../content/errors";
import {
  getBuiltinSkillBySlug,
  listBuiltinSkills,
  loadBuiltinSkillBundle,
  validateBuiltinSkills,
} from "./builtin";
import {
  createNextCustomSkillVersionDraft,
  createWorkspaceCustomSkillDraft,
  deleteCustomSkillVersionFileRecord,
  deleteWorkspaceSkillRecord,
  findCatalogSkillVersionForWorkspace,
  findWorkspaceCustomDraftVersion,
  listCatalogSkillVersionsForWorkspace,
  listCustomSkillVersionFileRecords,
  listWorkspaceInstalledSkills,
  loadSkillVersionBundle,
  publishWorkspaceCustomSkillVersion,
  syncBuiltinSkillMetadata,
  updateWorkspaceCustomDraftMetadata,
  updateWorkspaceSkillRecord,
  upsertCustomSkillVersionFile,
  upsertWorkspaceSkill,
} from "./repository";
import {
  validateCustomSkillBundle,
  validateCustomSkillFileInput,
} from "./custom-validation";
import { and, eq, ilike, or } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  type SkillManifestJson,
  skillVersions,
  workspaceSkills,
} from "@sourceweft/db";
import type { SkillCatalogItem, SkillSourceType } from "./types";
import { builtinSkillSelectionId } from "./selection";

// Lexical registry search tuning. Kept small — the registry catalog is a
// curated index, not a document corpus (skill-registry-index.md §4).
const REGISTRY_SEARCH_MIN_QUERY_LENGTH = 2;
const REGISTRY_SEARCH_RESULT_LIMIT = 25;
// Fetch cap before in-process relevance ranking. Bounded so a broad ILIKE
// match set can't balloon memory; ranking happens over this window.
const REGISTRY_CATALOG_QUERY_LIMIT = 100;

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

function isBuiltinSkillDefaultEnabled(skill: {
  slug: string;
  visibility: string;
}) {
  // `restricted` builtin skills are internal capabilities (e.g. ppt-deck) that
  // stay enabled by default without appearing in the public gallery.
  return skill.visibility === "restricted";
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
    return { ...base, ...registryCatalogFields(manifest) };
  }
  return base;
}

export class ContentSkillsService {
  async syncBuiltinCatalog() {
    await validateBuiltinSkills();
    const synced = [];
    for (const skill of await listBuiltinSkills()) {
      synced.push(await syncBuiltinSkillMetadata({
        slug: skill.slug,
        displayName: skill.displayName,
        description: skill.description,
        visibility: skill.visibility,
        version: skill.version,
        storagePointer: skill.storagePointer,
        contentHash: skill.contentHash,
        manifestJson: skill.manifestJson,
      }));
    }
    return { items: synced };
  }

  async validateBuiltinCatalog() {
    await validateBuiltinSkills();
  }

  async listCatalog(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
  }) {
    // The catalog is synced once at API startup (api/main.ts), which writes a
    // definition/version row for every builtin. `managed` builtins (e.g. feynman)
    // flow through the DB-row path below so they get a real skillId/versionId and
    // an opt-in install state from workspace_skills — identical to custom skills.
    // `always-on` builtins (generators like ppt/video/image, `managed: false`)
    // are read from the filesystem further down and rendered as non-installable.
    const rows = await listCatalogSkillVersionsForWorkspace(input);

    // Registry (`registry_github`) skills are surfaced by a dedicated query
    // below (own visibility rule + attribution), so they are excluded from the
    // shared DB-row path here to avoid double-emitting.
    const installableRows = rows.filter(
      (row) =>
        row.definition.sourceType !== "registry_github" &&
        (row.definition.sourceType !== "builtin" ||
          row.version.manifestJson.managed === true) &&
        row.version.manifestJson.listing !== "hidden",
    );

    const items: SkillCatalogItem[] = installableRows.map(mapCatalogRow);

    // Registry catalog entries: Community publisher, unverified, with
    // public / submitter-owned-restricted visibility (skill-registry-index.md
    // §0/§5.5). Same DB-row → `SkillCatalogItem` convergence as above.
    const registryRows = await this.listRegistryCatalogRows(input);
    for (const row of registryRows) {
      if (row.version.manifestJson.listing === "hidden") {
        continue;
      }
      items.push(mapCatalogRow(row));
    }
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
      items.push({
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
        defaultEnabled: isBuiltinSkillDefaultEnabled(skill) ? true : undefined,
        hasReadme: false,
        capabilities: skill.manifestJson.capabilities,
        models: skill.manifestJson.models,
        commands: skill.manifestJson.commands,
        tools: skill.manifestJson.tools,
        options: skill.manifestJson.options,
        slash: skill.manifestJson.slash,
        slashConfig: skill.manifestJson.slashConfig,
        defaultConfig: skill.manifestJson.defaultConfig,
      });
    }
    // `hasReadme` is deliberately left false here. Resolving it per item meant
    // loading every skill's *entire* bundle — for builtins that is a fresh
    // capability discovery scan plus a full read of every file — to answer one
    // boolean the list view never renders. The only consumer is the skill
    // detail page, and getCatalogSkillDetail fills it in from files it has
    // already read.
    return { items };
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
   */
  private async listRegistryCatalogRows(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    query?: string;
  }): Promise<CatalogRow[]> {
    const conditions = [
      eq(skillDefinitions.sourceType, "registry_github"),
      eq(skillDefinitions.status, "active"),
      eq(skillVersions.status, "published"),
      eq(skillVersions.isCurrent, true),
      or(
        eq(skillDefinitions.visibility, "public"),
        and(
          eq(skillDefinitions.visibility, "restricted"),
          eq(skillDefinitions.ownerUserId, input.userId),
        ),
      ),
    ];
    if (input.query) {
      const like = `%${input.query}%`;
      conditions.push(
        or(
          ilike(skillDefinitions.displayName, like),
          ilike(skillDefinitions.description, like),
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
      .limit(REGISTRY_CATALOG_QUERY_LIMIT);

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
    const catalog = await this.listCatalog(input);
    const item = catalog.items.find((candidate) => candidate.catalogId === input.catalogId);
    if (!item) {
      throw new ContentError(404, "SKILL_NOT_FOUND", "Skill not found");
    }

    const files = await this.getSkillFiles(input, item);
    const readmeContent =
      files.find((file) => file.path === "README.md")?.contentText ?? null;
    return {
      skill: { ...item, hasReadme: readmeContent !== null },
      readmeContent,
      skillContent: files.find((file) => file.path === "SKILL.md")?.contentText ?? null,
    };
  }

  private async getSkillFiles(
    input: { teamId: string; workspaceId: string },
    item: SkillCatalogItem,
  ) {
    if (!item.installable && item.sourceType === "builtin") {
      const skill = await getBuiltinSkillBySlug(item.slug);
      return skill
        ? (await loadBuiltinSkillBundle(skill.storagePointer))?.files ?? []
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
      return (await loadBuiltinSkillBundle(bundle.version.storagePointer))
        ?.files ?? [];
    }
    return bundle.files;
  }

  async enableSkill(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    skillId: string;
    skillVersionId: string;
    configJson?: Record<string, unknown>;
  }) {
    const skill = await findCatalogSkillVersionForWorkspace(input);
    if (!skill) {
      throw new ContentError(404, "SKILL_NOT_FOUND", "Skill not found or not available to this workspace");
    }
    return {
      workspaceSkill: await upsertWorkspaceSkill({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        skillId: input.skillId,
        skillVersionId: input.skillVersionId,
        enabledBy: input.userId,
        configJson: input.configJson,
      }),
    };
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
      throw new ContentError(404, "CUSTOM_SKILL_NOT_FOUND", "Custom skill not found");
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
      throw new ContentError(404, "CUSTOM_SKILL_DRAFT_NOT_FOUND", "Custom skill draft version not found");
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
      throw new ContentError(404, "CUSTOM_SKILL_DRAFT_NOT_FOUND", "Custom skill draft version not found");
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
      throw new ContentError(404, "CUSTOM_SKILL_FILE_NOT_FOUND", "Custom skill draft file not found");
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
      throw new ContentError(404, "CUSTOM_SKILL_DRAFT_NOT_FOUND", "Custom skill draft version not found");
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
    const expectedVisibility = draft.definition.sourceType === "team_custom" ? "team" : "workspace";
    if (bundle.manifestJson.visibility !== expectedVisibility) {
      throw new ContentError(400, "CUSTOM_SKILL_VISIBILITY_MISMATCH", "Custom skill manifest visibility does not match its scope");
    }
    if (bundle.name !== draft.definition.slug) {
      throw new ContentError(400, "CUSTOM_SKILL_SLUG_MISMATCH", "Custom skill manifest slug cannot change after creation");
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
      manifestJson: bundle.manifestJson,
    });
    if (!customSkill) {
      throw new ContentError(404, "CUSTOM_SKILL_DRAFT_NOT_FOUND", "Custom skill draft version not found");
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
      throw new ContentError(404, "WORKSPACE_SKILL_NOT_FOUND", "Workspace skill not found");
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
      throw new ContentError(404, "WORKSPACE_SKILL_NOT_FOUND", "Workspace skill not found");
    }
    return { deleted: true as const, workspaceSkillId: input.workspaceSkillId };
  }
}

export const contentSkillsService = new ContentSkillsService();

export const testExports = {
  isBuiltinSkillDefaultEnabled,
  isRegistryRowVisibleToViewer,
  registryCatalogFields,
  skillSearchRelevanceRank,
  compareSkillSearchRelevance,
  mapCatalogRow,
};
