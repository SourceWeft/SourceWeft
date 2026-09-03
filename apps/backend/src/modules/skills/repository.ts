import { randomUUID } from "node:crypto";
import { sha256 } from "./hash";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillEntitlements,
  type SkillManifestJson,
  skillVersionFiles,
  skillVersions,
  workspaceSkills,
} from "@sourceweft/db";
import type { SkillBundleFile } from "./builtin";
import type {
  WorkspaceInstalledSkillItem,
  WorkspaceSkillRecord,
} from "./types";
import type { ValidatedCustomSkillFile } from "./custom-validation";

type WorkspaceSkillRow = typeof workspaceSkills.$inferSelect;
type SkillDefinitionRow = typeof skillDefinitions.$inferSelect;
type SkillVersionRow = typeof skillVersions.$inferSelect;
type SkillVersionFileRow = typeof skillVersionFiles.$inferSelect;

/**
 * Hard invariant (docs/architecture/skill-registry-index.md §0): `repo_builtin`
 * storage and the `builtin` source are strictly co-extensive — each is used by
 * the other and by nothing else. A builtin's bodies live on disk in the repo, so
 * letting any other source claim `repo_builtin` would point it at files we ship,
 * and letting a builtin claim `db_text` would shadow those files with rows.
 * The DB CHECK constraints can only see one column at a time, so this
 * cross-column biconditional lives in code, called at every skill_versions
 * write entry.
 *
 * Registry (`registry_github`) skills are deliberately NOT special-cased: they
 * store their bundle in `skill_version_files` exactly like custom skills do.
 * What keeps us an indexer rather than a redistributor is not withholding the
 * bytes — the model is served them either way — but refusing to expose any
 * endpoint that hands a skill's content back out as a retrievable artifact.
 * Attribution rides along in `manifestJson.registry` (`sourceUrl`, `repoUrl`,
 * `license`) and the pinned commit in `storagePointer`.
 */
export function assertRegistryStorageInvariant(
  sourceType: SkillDefinitionRow["sourceType"],
  storageType: SkillVersionRow["storageType"],
): void {
  const isRepoBuiltin = storageType === "repo_builtin";
  const isBuiltin = sourceType === "builtin";
  if (isRepoBuiltin !== isBuiltin) {
    throw new Error(
      `Skill storage invariant violated: storageType='${storageType}' with sourceType='${sourceType}' (repo_builtin ⇔ builtin)`,
    );
  }
}

function mapWorkspaceSkill(row: WorkspaceSkillRow): WorkspaceSkillRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    skillId: row.skillId,
    skillVersionId: row.skillVersionId,
    enabled: row.enabled,
    configJson: row.configJson ?? {},
    enabledBy: row.enabledBy,
    enabledAt: row.enabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSkillDefinition(row: SkillDefinitionRow) {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    sourceType: row.sourceType,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    visibility: row.visibility,
    status: row.status,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSkillVersion(row: SkillVersionRow) {
  return {
    id: row.id,
    skillId: row.skillId,
    version: row.version,
    status: row.status,
    storageType: row.storageType,
    storagePointer: row.storagePointer,
    isCurrent: row.isCurrent,
    contentHash: row.contentHash,
    manifestJson: row.manifestJson,
    createdBy: row.createdBy,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSkillVersionFile(row: SkillVersionFileRow) {
  return {
    id: row.id,
    skillVersionId: row.skillVersionId,
    path: row.path,
    contentText: row.contentText,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapWorkspaceInstalledSkill(row: {
  definition: SkillDefinitionRow;
  version: SkillVersionRow;
  workspaceSkill: WorkspaceSkillRow;
}): WorkspaceInstalledSkillItem {
  const manifest = row.version.manifestJson;
  const workspaceSkill = mapWorkspaceSkill(row.workspaceSkill);
  return {
    workspaceSkillId: workspaceSkill.id,
    selectionId: workspaceSkill.id,
    catalogId: `${row.definition.id}:${row.version.id}`,
    sourceType: row.definition.sourceType,
    skillId: row.definition.id,
    skillVersionId: row.version.id,
    slug: row.definition.slug,
    name: row.definition.displayName,
    version: row.version.version,
    displayName: row.definition.displayName,
    description: row.definition.description,
    visibility: row.definition.visibility,
    categories: Array.isArray(manifest.categories) ? manifest.categories : [],
    enabled: workspaceSkill.enabled,
    configJson: workspaceSkill.configJson,
    enabledBy: workspaceSkill.enabledBy,
    enabledAt: workspaceSkill.enabledAt,
    ...(manifest.registry?.capability
      ? { registryCapability: manifest.registry.capability }
      : {}),
    capabilities: manifest.capabilities,
    models: manifest.models,
    commands: manifest.commands,
    tools: manifest.tools,
    options: manifest.options,
    slash: manifest.slash,
    slashConfig: manifest.slashConfig,
    defaultConfig: manifest.defaultConfig,
    createdAt: workspaceSkill.createdAt,
    updatedAt: workspaceSkill.updatedAt,
  };
}

function skillManifestJson(input: {
  slug: string;
  displayName: string;
  version: string;
  description: string;
  visibility: "workspace" | "team";
}) {
  return {
    slug: input.slug,
    displayName: input.displayName,
    version: input.version,
    description: input.description,
    visibility: input.visibility,
    categories: [],
  } satisfies SkillManifestJson;
}

function visibleSkillCondition(input: { teamId: string; workspaceId: string }) {
  return or(
    eq(skillDefinitions.visibility, "public"),
    sql`${skillDefinitions.visibility} = 'restricted' and exists (
      select 1 from ${skillEntitlements}
      where ${skillEntitlements.skillId} = ${skillDefinitions.id}
        and (${skillEntitlements.teamId} = ${input.teamId} or ${skillEntitlements.workspaceId} = ${input.workspaceId})
        and (${skillEntitlements.expiresAt} is null or ${skillEntitlements.expiresAt} > now())
    )`,
    and(
      eq(skillDefinitions.visibility, "team"),
      eq(skillDefinitions.teamId, input.teamId),
    ),
    and(
      eq(skillDefinitions.visibility, "workspace"),
      eq(skillDefinitions.teamId, input.teamId),
      eq(skillDefinitions.workspaceId, input.workspaceId),
    ),
  );
}

export async function listWorkspaceInstalledSkills(input: {
  teamId: string;
  workspaceId: string;
}) {
  const rows = await db
    .select({
      definition: skillDefinitions,
      version: skillVersions,
      workspaceSkill: workspaceSkills,
    })
    .from(workspaceSkills)
    .innerJoin(
      skillDefinitions,
      eq(skillDefinitions.id, workspaceSkills.skillId),
    )
    .innerJoin(
      skillVersions,
      and(
        eq(skillVersions.id, workspaceSkills.skillVersionId),
        eq(skillVersions.skillId, workspaceSkills.skillId),
      ),
    )
    .where(
      and(
        eq(workspaceSkills.teamId, input.teamId),
        eq(workspaceSkills.workspaceId, input.workspaceId),
        // A workspace_skills row can only exist for an installable skill (custom,
        // or a `managed` builtin like feynman), so no explicit builtin guard here.
        eq(skillDefinitions.status, "active"),
        visibleSkillCondition(input),
      ),
    );
  return rows.map(mapWorkspaceInstalledSkill);
}

export async function listWorkspaceSkillRecordsByIds(input: {
  teamId: string;
  workspaceId: string;
  workspaceSkillIds: string[];
}) {
  if (input.workspaceSkillIds.length === 0) {
    return [] as WorkspaceSkillRecord[];
  }
  const rows = await db
    .select()
    .from(workspaceSkills)
    .where(
      and(
        eq(workspaceSkills.teamId, input.teamId),
        eq(workspaceSkills.workspaceId, input.workspaceId),
        inArray(workspaceSkills.id, input.workspaceSkillIds),
      ),
    );
  return rows.map(mapWorkspaceSkill);
}

export async function listEnabledWorkspaceSkillRecords(input: {
  teamId: string;
  workspaceId: string;
}) {
  const rows = await db
    .select({ workspaceSkill: workspaceSkills })
    .from(workspaceSkills)
    .innerJoin(
      skillDefinitions,
      eq(skillDefinitions.id, workspaceSkills.skillId),
    )
    .where(
      and(
        eq(workspaceSkills.teamId, input.teamId),
        eq(workspaceSkills.workspaceId, input.workspaceId),
        eq(workspaceSkills.enabled, true),
        // An install row implies the skill is installable (custom or `managed`
        // builtin); always-on builtins never get a workspace_skills row.
        eq(skillDefinitions.status, "active"),
        visibleSkillCondition(input),
      ),
    );
  return rows.map((row) => mapWorkspaceSkill(row.workspaceSkill));
}

export async function findEnabledWorkspaceSkillRecordBySlug(input: {
  teamId: string;
  workspaceId: string;
  slug: string;
}) {
  const [row] = await db
    .select({ workspaceSkill: workspaceSkills })
    .from(workspaceSkills)
    .innerJoin(
      skillDefinitions,
      eq(skillDefinitions.id, workspaceSkills.skillId),
    )
    .where(
      and(
        eq(workspaceSkills.teamId, input.teamId),
        eq(workspaceSkills.workspaceId, input.workspaceId),
        eq(workspaceSkills.enabled, true),
        eq(skillDefinitions.slug, input.slug),
        eq(skillDefinitions.status, "active"),
        visibleSkillCondition(input),
      ),
    )
    .limit(1);
  return row ? mapWorkspaceSkill(row.workspaceSkill) : null;
}

export async function listCatalogSkillVersionsForWorkspace(input: {
  teamId: string;
  workspaceId: string;
}) {
  return db
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
    .where(
      and(
        eq(skillDefinitions.status, "active"),
        eq(skillVersions.status, "published"),
        eq(skillVersions.isCurrent, true),
        visibleSkillCondition(input),
      ),
    );
}

export async function findCatalogSkillVersionForWorkspace(input: {
  teamId: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
}) {
  const [row] = await db
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
    .where(
      and(
        eq(skillDefinitions.id, input.skillId),
        eq(skillVersions.id, input.skillVersionId),
        eq(skillVersions.skillId, input.skillId),
        // Builtins are installable only when explicitly `managed` (e.g. feynman);
        // always-on builtins (generators) stay non-installable.
        sql`(${skillDefinitions.sourceType} <> 'builtin' or ${skillVersions.manifestJson}->>'managed' = 'true')`,
        eq(skillDefinitions.status, "active"),
        eq(skillVersions.status, "published"),
        visibleSkillCondition(input),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Grant a workspace access to a skill definition, idempotently.
 *
 * `visibleSkillCondition` treats a `restricted` definition as invisible unless
 * an entitlement names the team or workspace — and every registry skill starts
 * restricted, by the trust firewall. Nothing used to write this table, so an
 * installed registry skill produced a `workspace_skills` row that no runtime
 * query could see: it never mounted and never reached the model. Installing a
 * skill into a workspace IS the grant, so it is issued here, in the same
 * transaction, rather than left to an admin step that does not exist.
 */
async function grantSkillEntitlement(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    skillId: string;
    teamId: string;
    workspaceId: string;
    grantedBy: string;
  },
) {
  const [existing] = await tx
    .select({ id: skillEntitlements.id })
    .from(skillEntitlements)
    .where(
      and(
        eq(skillEntitlements.skillId, input.skillId),
        eq(skillEntitlements.teamId, input.teamId),
        eq(skillEntitlements.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (existing) {
    return;
  }
  await tx.insert(skillEntitlements).values({
    id: randomUUID(),
    skillId: input.skillId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    grantedBy: input.grantedBy,
  });
}

export async function upsertWorkspaceSkill(input: {
  teamId: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  enabledBy: string;
  configJson?: Record<string, unknown>;
  /**
   * Defaults to true — installing is normally the act of enabling. Agent-driven
   * installs pass `false` for a skill that ships executable scripts, so nobody
   * ends up running third-party code they never chose to turn on.
   */
  enabled?: boolean;
}) {
  const enabled = input.enabled ?? true;
  const now = new Date();
  return db.transaction(async (tx) => {
    await grantSkillEntitlement(tx, {
      grantedBy: input.enabledBy,
      skillId: input.skillId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
    });

    const [existing] = await tx
      .select()
      .from(workspaceSkills)
      .where(
        and(
          eq(workspaceSkills.teamId, input.teamId),
          eq(workspaceSkills.workspaceId, input.workspaceId),
          eq(workspaceSkills.skillId, input.skillId),
        ),
      )
      .limit(1);

    if (existing) {
      const [row] = await tx
        .update(workspaceSkills)
        .set({
          skillVersionId: input.skillVersionId,
          enabled,
          configJson: input.configJson ?? {},
          enabledBy: input.enabledBy,
          enabledAt: now,
          updatedAt: now,
        })
        .where(eq(workspaceSkills.id, existing.id))
        .returning();
      if (!row) {
        throw new Error("Failed to enable skill");
      }
      return mapWorkspaceSkill(row);
    }

    const [row] = await tx
      .insert(workspaceSkills)
      .values({
        id: randomUUID(),
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        skillId: input.skillId,
        skillVersionId: input.skillVersionId,
        enabled,
        configJson: input.configJson ?? {},
        enabledBy: input.enabledBy,
        enabledAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to enable skill");
    }
    return mapWorkspaceSkill(row);
  });
}

export async function updateWorkspaceSkillRecord(input: {
  teamId: string;
  workspaceId: string;
  workspaceSkillId: string;
  enabled?: boolean;
  configJson?: Record<string, unknown>;
  userId?: string;
}) {
  const now = new Date();
  const updates: Partial<typeof workspaceSkills.$inferInsert> & {
    updatedAt: Date;
  } = {
    updatedAt: now,
  };
  if (input.enabled !== undefined) {
    updates.enabled = input.enabled;
    updates.enabledAt = input.enabled ? now : null;
    updates.enabledBy = input.enabled ? (input.userId ?? null) : null;
  }
  if (input.configJson !== undefined) {
    updates.configJson = input.configJson;
  }

  const [row] = await db
    .update(workspaceSkills)
    .set(updates)
    .where(
      and(
        eq(workspaceSkills.id, input.workspaceSkillId),
        eq(workspaceSkills.teamId, input.teamId),
        eq(workspaceSkills.workspaceId, input.workspaceId),
      ),
    )
    .returning();
  return row ? mapWorkspaceSkill(row) : null;
}

export async function deleteWorkspaceSkillRecord(input: {
  teamId: string;
  workspaceId: string;
  workspaceSkillId: string;
}) {
  const rows = await db
    .delete(workspaceSkills)
    .where(
      and(
        eq(workspaceSkills.id, input.workspaceSkillId),
        eq(workspaceSkills.teamId, input.teamId),
        eq(workspaceSkills.workspaceId, input.workspaceId),
      ),
    )
    .returning({ id: workspaceSkills.id });
  return rows.length > 0;
}

export async function loadSkillVersionBundle(input: {
  teamId: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
}) {
  const [versionRow] = await db
    .select({
      definition: skillDefinitions,
      version: skillVersions,
    })
    .from(skillVersions)
    .innerJoin(skillDefinitions, eq(skillDefinitions.id, skillVersions.skillId))
    .where(
      and(
        eq(skillVersions.id, input.skillVersionId),
        eq(skillVersions.skillId, input.skillId),
        eq(skillDefinitions.status, "active"),
        visibleSkillCondition(input),
      ),
    )
    .limit(1);

  if (!versionRow) {
    return null;
  }

  const fileRows =
    versionRow.version.storageType === "db_text"
      ? await db
          .select()
          .from(skillVersionFiles)
          .where(eq(skillVersionFiles.skillVersionId, input.skillVersionId))
      : [];

  const files: SkillBundleFile[] = fileRows.map((file) => ({
    path: file.path,
    contentText: file.contentText,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    contentHash: file.contentHash,
  }));

  return {
    definition: versionRow.definition,
    version: versionRow.version,
    files,
  };
}

export async function syncBuiltinSkillMetadata(input: {
  slug: string;
  displayName: string;
  description: string;
  visibility: "public" | "restricted";
  version: string;
  storagePointer: string;
  contentHash: string;
  manifestJson: SkillManifestJson;
}) {
  assertRegistryStorageInvariant("builtin", "repo_builtin");
  const now = new Date();
  return db.transaction(async (tx) => {
    const [conflict] = await tx
      .select({
        id: skillDefinitions.id,
        sourceType: skillDefinitions.sourceType,
      })
      .from(skillDefinitions)
      .where(
        and(
          eq(skillDefinitions.slug, input.slug),
          sql`${skillDefinitions.sourceType} <> 'builtin'`,
        ),
      )
      .limit(1);
    if (conflict) {
      throw new Error(
        `Builtin skill slug '${input.slug}' conflicts with ${conflict.sourceType} skill`,
      );
    }

    const [existing] = await tx
      .select()
      .from(skillDefinitions)
      .where(
        and(
          eq(skillDefinitions.slug, input.slug),
          eq(skillDefinitions.sourceType, "builtin"),
        ),
      )
      .limit(1);

    const skillId = existing?.id ?? randomUUID();
    const [definition] = existing
      ? await tx
          .update(skillDefinitions)
          .set({
            teamId: null,
            workspaceId: null,
            displayName: input.displayName,
            description: input.description,
            visibility: input.visibility,
            status: "active",
            updatedAt: now,
          })
          .where(eq(skillDefinitions.id, skillId))
          .returning()
      : await tx
          .insert(skillDefinitions)
          .values({
            id: skillId,
            teamId: null,
            workspaceId: null,
            sourceType: "builtin",
            slug: input.slug,
            displayName: input.displayName,
            description: input.description,
            visibility: input.visibility,
            status: "active",
            createdAt: now,
            updatedAt: now,
          })
          .returning();
    if (!definition) {
      throw new Error(`Failed to sync builtin skill '${input.slug}'`);
    }

    await tx
      .update(skillVersions)
      .set({
        isCurrent: false,
        updatedAt: now,
      })
      .where(eq(skillVersions.skillId, skillId));

    const [existingVersion] = await tx
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, skillId),
          eq(skillVersions.version, input.version),
        ),
      )
      .limit(1);
    if (existingVersion) {
      await tx
        .update(skillVersions)
        .set({
          status: "published",
          storageType: "repo_builtin",
          storagePointer: input.storagePointer,
          isCurrent: true,
          contentHash: input.contentHash,
          manifestJson: input.manifestJson,
          publishedAt: existingVersion.publishedAt ?? now,
          updatedAt: now,
        })
        .where(eq(skillVersions.id, existingVersion.id));
    } else {
      await tx.insert(skillVersions).values({
        id: randomUUID(),
        skillId,
        version: input.version,
        status: "published",
        storageType: "repo_builtin",
        storagePointer: input.storagePointer,
        isCurrent: true,
        contentHash: input.contentHash,
        manifestJson: input.manifestJson,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    return mapSkillDefinition(definition);
  });
}

export async function createWorkspaceCustomSkillDraft(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  name: string;
  displayName: string;
  description: string;
  version?: string;
}) {
  assertRegistryStorageInvariant("workspace_custom", "db_text");
  const now = new Date();
  return db.transaction(async (tx) => {
    const skillId = randomUUID();
    const versionId = randomUUID();
    const [definition] = await tx
      .insert(skillDefinitions)
      .values({
        id: skillId,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        sourceType: "workspace_custom",
        slug: input.name,
        displayName: input.displayName,
        description: input.description,
        visibility: "workspace",
        status: "active",
        ownerUserId: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!definition) {
      throw new Error("Failed to create custom skill");
    }

    const versionLabel = input.version ?? "0.1.0";
    const [version] = await tx
      .insert(skillVersions)
      .values({
        id: versionId,
        skillId,
        version: versionLabel,
        status: "draft",
        storageType: "db_text",
        storagePointer: versionId,
        isCurrent: false,
        contentHash: sha256(""),
        manifestJson: skillManifestJson({
          slug: input.name,
          displayName: input.displayName,
          version: versionLabel,
          description: input.description,
          visibility: "workspace",
        }),
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!version) {
      throw new Error("Failed to create custom skill version");
    }

    return {
      definition: mapSkillDefinition(definition),
      version: mapSkillVersion(version),
    };
  });
}

export async function createNextCustomSkillVersionDraft(input: {
  teamId: string;
  workspaceId: string;
  skillId: string;
  userId: string;
  version: string;
}) {
  const now = new Date();
  const [definition] = await db
    .select()
    .from(skillDefinitions)
    .where(
      and(
        eq(skillDefinitions.id, input.skillId),
        eq(skillDefinitions.teamId, input.teamId),
        eq(skillDefinitions.workspaceId, input.workspaceId),
        eq(skillDefinitions.sourceType, "workspace_custom"),
        eq(skillDefinitions.status, "active"),
      ),
    )
    .limit(1);
  if (!definition) {
    return null;
  }
  // `definition.sourceType` is read from the DB (not a constant), so this is a
  // real biconditional check: a registry_github definition must never mint a
  // db_text version.
  assertRegistryStorageInvariant(definition.sourceType, "db_text");

  const versionId = randomUUID();
  const [version] = await db
    .insert(skillVersions)
    .values({
      id: versionId,
      skillId: input.skillId,
      version: input.version,
      status: "draft",
      storageType: "db_text",
      storagePointer: versionId,
      isCurrent: false,
      contentHash: sha256(""),
      manifestJson: skillManifestJson({
        slug: definition.slug,
        displayName: definition.displayName,
        version: input.version,
        description: definition.description,
        visibility:
          definition.sourceType === "team_custom" ? "team" : "workspace",
      }),
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!version) {
    throw new Error("Failed to create custom skill version");
  }

  return {
    definition: mapSkillDefinition(definition),
    version: mapSkillVersion(version),
  };
}

export async function findWorkspaceCustomDraftVersion(input: {
  teamId: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
}) {
  const [row] = await db
    .select({
      definition: skillDefinitions,
      version: skillVersions,
    })
    .from(skillVersions)
    .innerJoin(skillDefinitions, eq(skillDefinitions.id, skillVersions.skillId))
    .where(
      and(
        eq(skillDefinitions.id, input.skillId),
        eq(skillDefinitions.teamId, input.teamId),
        eq(skillDefinitions.workspaceId, input.workspaceId),
        eq(skillDefinitions.sourceType, "workspace_custom"),
        eq(skillDefinitions.status, "active"),
        eq(skillVersions.id, input.skillVersionId),
        eq(skillVersions.status, "draft"),
      ),
    )
    .limit(1);
  return row
    ? {
        definition: mapSkillDefinition(row.definition),
        version: mapSkillVersion(row.version),
      }
    : null;
}

export async function updateWorkspaceCustomDraftMetadata(input: {
  teamId: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  displayName?: string;
  description?: string;
}) {
  const draft = await findWorkspaceCustomDraftVersion(input);
  if (!draft) {
    return null;
  }
  if (input.displayName === undefined && input.description === undefined) {
    return draft;
  }

  const now = new Date();
  const [definition] = await db
    .update(skillDefinitions)
    .set({
      displayName: input.displayName ?? draft.definition.displayName,
      description: input.description ?? draft.definition.description,
      updatedAt: now,
    })
    .where(
      and(
        eq(skillDefinitions.id, input.skillId),
        eq(skillDefinitions.teamId, input.teamId),
        eq(skillDefinitions.workspaceId, input.workspaceId),
        eq(skillDefinitions.sourceType, "workspace_custom"),
        eq(skillDefinitions.status, "active"),
      ),
    )
    .returning();
  if (!definition) {
    return null;
  }

  return {
    definition: mapSkillDefinition(definition),
    version: draft.version,
  };
}

export async function deleteCustomSkillVersionFileRecord(input: {
  teamId: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  path: string;
}) {
  const draft = await findWorkspaceCustomDraftVersion(input);
  if (!draft) {
    return false;
  }

  const rows = await db
    .delete(skillVersionFiles)
    .where(
      and(
        eq(skillVersionFiles.skillVersionId, input.skillVersionId),
        eq(skillVersionFiles.path, input.path),
      ),
    )
    .returning({ id: skillVersionFiles.id });
  return rows.length > 0;
}

export async function upsertCustomSkillVersionFile(input: {
  teamId: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  file: ValidatedCustomSkillFile;
}) {
  const draft = await findWorkspaceCustomDraftVersion(input);
  if (!draft) {
    return null;
  }
  const [row] = await db
    .insert(skillVersionFiles)
    .values({
      id: randomUUID(),
      skillVersionId: input.skillVersionId,
      path: input.file.path,
      contentText: input.file.contentText,
      mimeType: input.file.mimeType,
      sizeBytes: input.file.sizeBytes,
      contentHash: input.file.contentHash,
    })
    .onConflictDoUpdate({
      target: [skillVersionFiles.skillVersionId, skillVersionFiles.path],
      set: {
        contentText: input.file.contentText,
        mimeType: input.file.mimeType,
        sizeBytes: input.file.sizeBytes,
        contentHash: input.file.contentHash,
      },
    })
    .returning();
  if (!row) {
    throw new Error("Failed to write custom skill file");
  }
  return mapSkillVersionFile(row);
}

export async function listCustomSkillVersionFileRecords(input: {
  skillVersionId: string;
}) {
  const files = await db
    .select()
    .from(skillVersionFiles)
    .where(eq(skillVersionFiles.skillVersionId, input.skillVersionId));
  return files.map(mapSkillVersionFile);
}

export async function publishWorkspaceCustomSkillVersion(input: {
  teamId: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  name: string;
  displayName?: string;
  description: string;
  version: string;
  contentHash: string;
  manifestJson: SkillManifestJson;
}) {
  assertRegistryStorageInvariant("workspace_custom", "db_text");
  const now = new Date();
  return db.transaction(async (tx) => {
    const [draftVersion] = await tx
      .select({ id: skillVersions.id })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.id, input.skillVersionId),
          eq(skillVersions.skillId, input.skillId),
          eq(skillVersions.status, "draft"),
        ),
      )
      .limit(1);
    if (!draftVersion) {
      return null;
    }

    const [definition] = await tx
      .update(skillDefinitions)
      .set({
        displayName: input.displayName ?? input.name,
        description: input.description,
        updatedAt: now,
      })
      .where(
        and(
          eq(skillDefinitions.id, input.skillId),
          eq(skillDefinitions.teamId, input.teamId),
          eq(skillDefinitions.workspaceId, input.workspaceId),
          eq(skillDefinitions.sourceType, "workspace_custom"),
          eq(skillDefinitions.status, "active"),
        ),
      )
      .returning();
    if (!definition) {
      return null;
    }

    await tx
      .update(skillVersions)
      .set({
        isCurrent: false,
        updatedAt: now,
      })
      .where(
        and(
          eq(skillVersions.skillId, input.skillId),
          sql`${skillVersions.id} <> ${input.skillVersionId}`,
        ),
      );

    const [version] = await tx
      .update(skillVersions)
      .set({
        version: input.version,
        status: "published",
        storageType: "db_text",
        storagePointer: input.skillVersionId,
        isCurrent: true,
        contentHash: input.contentHash,
        manifestJson: input.manifestJson,
        publishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(skillVersions.id, input.skillVersionId),
          eq(skillVersions.skillId, input.skillId),
          eq(skillVersions.status, "draft"),
        ),
      )
      .returning();
    if (!version) {
      return null;
    }

    return {
      definition: mapSkillDefinition(definition),
      version: mapSkillVersion(version),
    };
  });
}
