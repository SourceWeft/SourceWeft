import { getSkillLogo } from "./logo";
import { randomUUID } from "node:crypto";
import { sha256 } from "./hash";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  db,
  skillDefinitions,
  skillEntitlements,
  type SkillManifestJson,
  skillVersionFiles,
  skillVersions,
  workspaceSkills,
} from "@sourceweft/db";
import { readSkillObjectFile } from "./file-content";
import type {
  SkillFileContent,
  WorkspaceInstalledSkillItem,
  WorkspaceSkillRecord,
} from "./types";
import type { ValidatedCustomSkillFile } from "./custom-validation";
// One source → storage rule for every version write site; it lives with the
// registry writer, which is where the third storage type (`object`) comes from.
import { assertSkillStorageInvariant } from "./registry/repository";

// Enough to show a person every collision on a short name without letting a
// common suffix pull an unbounded set.
const INSTALLABLE_NAME_MATCH_LIMIT = 20;

type WorkspaceSkillRow = typeof workspaceSkills.$inferSelect;
type SkillDefinitionRow = typeof skillDefinitions.$inferSelect;
type SkillVersionRow = typeof skillVersions.$inferSelect;
type SkillVersionFileRow = typeof skillVersionFiles.$inferSelect;


export function mapWorkspaceSkill(row: WorkspaceSkillRow): WorkspaceSkillRecord {
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
    installedVia: row.installedVia,
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

/**
 * An install pins one version; the skill moves on without it. "Update
 * available" means there is a published current version and it is not the
 * pinned one. A current version still under review (`draft`) is not an update
 * anyone can take, so it arrives here as `null` and reads as up to date.
 */
export function skillUpdateSignal(input: {
  installedVersionId: string;
  currentVersionId: string | null;
}) {
  return {
    currentVersionId: input.currentVersionId,
    updateAvailable:
      input.currentVersionId !== null &&
      input.currentVersionId !== input.installedVersionId,
  };
}

function mapWorkspaceInstalledSkill(row: {
  definition: SkillDefinitionRow;
  version: SkillVersionRow;
  workspaceSkill: WorkspaceSkillRow;
  currentVersionId: string | null;
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
    name: row.version.manifestJson.displayName,
    version: row.version.version,
    displayName: row.version.manifestJson.displayName,
    description: row.version.manifestJson.description,
    visibility: row.definition.visibility,
    logo: getSkillLogo(manifest),
    categories: Array.isArray(manifest.categories) ? manifest.categories : [],
    enabled: workspaceSkill.enabled,
    configJson: workspaceSkill.configJson,
    enabledBy: workspaceSkill.enabledBy,
    enabledAt: workspaceSkill.enabledAt,
    installedVia: workspaceSkill.installedVia,
    ...skillUpdateSignal({
      installedVersionId: row.version.id,
      currentVersionId: row.currentVersionId,
    }),
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

/**
 * Which `skill_entitlements` rows reach this workspace — shared by every
 * predicate that reads grants (`visibleSkillCondition` here, `registryAccess`
 * in the registry) so the two can never drift apart again.
 *
 * A row that names a workspace grants THAT workspace only; its `team_id` is
 * just the owning team, not a second scope. Only a row with no workspace is a
 * team-wide grant. Installing writes both columns, so matching on
 * `team_id OR workspace_id` let one workspace's install expose — and make
 * installable — a restricted skill in every workspace of the team.
 *
 * An empty id never matches: the registry admin route reads with blank ids,
 * and `team_id` has no foreign key that would rule out a blank row.
 */
export function skillEntitlementScopeCondition(input: {
  teamId: string;
  workspaceId: string;
}) {
  const scopes = [];
  if (input.workspaceId) {
    scopes.push(sql`${skillEntitlements.workspaceId} = ${input.workspaceId}`);
  }
  if (input.teamId) {
    scopes.push(
      sql`(${skillEntitlements.workspaceId} is null and ${skillEntitlements.teamId} = ${input.teamId})`,
    );
  }
  return scopes.length > 0 ? sql`(${sql.join(scopes, sql` or `)})` : sql`false`;
}

function visibleSkillCondition(input: { teamId: string; workspaceId: string }) {
  return or(
    eq(skillDefinitions.visibility, "public"),
    sql`${skillDefinitions.visibility} = 'restricted' and exists (
      select 1 from ${skillEntitlements}
      where ${skillEntitlements.skillId} = ${skillDefinitions.id}
        and ${skillEntitlementScopeCondition(input)}
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
  // The skill's published current version, next to the pinned one, in the same
  // query. `skill_versions_skill_current_uq` allows one current row per skill,
  // so this join can never multiply an install.
  const currentVersions = alias(skillVersions, "current_versions");
  const rows = await db
    .select({
      definition: skillDefinitions,
      version: skillVersions,
      workspaceSkill: workspaceSkills,
      currentVersionId: currentVersions.id,
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
    .leftJoin(
      currentVersions,
      and(
        eq(currentVersions.skillId, workspaceSkills.skillId),
        eq(currentVersions.isCurrent, true),
        eq(currentVersions.status, "published"),
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

/**
 * What a workspace is allowed to install — the ONE predicate every install
 * path goes through, whether it names the skill by id (the catalog UI) or by
 * slug (the agent's `install_skill`).
 *
 * The chat path used to resolve slugs with its own registry-only lookup that
 * skipped this check, and `upsertWorkspaceSkill` grants an entitlement as part
 * of installing — so naming someone else's `restricted` skill by its
 * (guessable) slug both installed it and granted access to it.
 */
function installableSkillCondition(input: {
  teamId: string;
  workspaceId: string;
  userId?: string;
}) {
  return and(
    // Builtins are installable only when explicitly `managed` (e.g. feynman);
    // always-on builtins (generators) stay non-installable.
    sql`(${skillDefinitions.sourceType} <> 'builtin' or ${skillVersions.manifestJson}->>'managed' = 'true')`,
    eq(skillDefinitions.status, "active"),
    eq(skillVersions.status, "published"),
    or(
      visibleSkillCondition(input),
      input.userId
        ? and(
            eq(skillDefinitions.sourceType, "registry_github"),
            eq(skillDefinitions.ownerUserId, input.userId),
          )
        : undefined,
    ),
  );
}

/**
 * Installable skills a person could mean by `name`: the exact slug, or — for
 * registry skills, whose slug is `gh-<owner>-<repo>-<name>` — the author's own
 * short name. An exact slug wins outright; short names can collide across
 * repositories, and the caller must surface that rather than pick one.
 */
export async function findInstallableSkillsByName(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  name: string;
}) {
  const name = input.name.trim().toLowerCase();
  if (!name) {
    return [];
  }
  const suffix = `%-${name.replace(/[\\%_]/g, (char) => `\\${char}`)}`;
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
    .where(
      and(
        eq(skillVersions.isCurrent, true),
        installableSkillCondition(input),
        or(
          eq(skillDefinitions.slug, name),
          and(
            eq(skillDefinitions.sourceType, "registry_github"),
            sql`${skillDefinitions.slug} like ${suffix}`,
          ),
        ),
      ),
    )
    .orderBy(skillDefinitions.slug)
    .limit(INSTALLABLE_NAME_MATCH_LIMIT);
  const exact = rows.filter((row) => row.definition.slug === name);
  return exact.length > 0 ? exact : rows;
}

/**
 * How many workspaces have each skill installed and switched on — the one
 * quality signal we can compute ourselves. LobeHub and skills.sh both lead
 * search results with an install count for the same reason: a description says
 * what a skill claims, adoption says whether anyone kept it.
 */
export async function countSkillInstalls(skillIds: string[]) {
  const counts = new Map<string, number>();
  if (skillIds.length === 0) {
    return counts;
  }
  const rows = await db
    .select({
      skillId: workspaceSkills.skillId,
      installs: sql<number>`count(distinct ${workspaceSkills.workspaceId})::int`,
    })
    .from(workspaceSkills)
    .where(
      and(
        inArray(workspaceSkills.skillId, skillIds),
        eq(workspaceSkills.enabled, true),
      ),
    )
    .groupBy(workspaceSkills.skillId);
  for (const row of rows) {
    counts.set(row.skillId, row.installs);
  }
  return counts;
}

export async function findCatalogSkillVersionForWorkspace(input: {
  teamId: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  userId?: string;
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
        installableSkillCondition(input),
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

/**
 * Gives a workspace — or, with no workspace, the whole team — the right to use
 * a skill it cannot otherwise see: a `restricted` community skill. Issued when
 * someone in that scope imports the same public repository an earlier
 * submitter already indexed: proving they can read the source is what the
 * entitlement stands for. Idempotent.
 */
export async function grantSkillAccess(input: {
  skillId: string;
  teamId: string;
  workspaceId: string | null;
  grantedBy: string;
}) {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: skillEntitlements.id })
      .from(skillEntitlements)
      .where(
        and(
          eq(skillEntitlements.skillId, input.skillId),
          eq(skillEntitlements.teamId, input.teamId),
          input.workspaceId
            ? eq(skillEntitlements.workspaceId, input.workspaceId)
            : isNull(skillEntitlements.workspaceId),
        ),
      )
      .limit(1);
    if (existing) return;
    await tx.insert(skillEntitlements).values({
      id: randomUUID(),
      skillId: input.skillId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      grantedBy: input.grantedBy,
    });
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
  /**
   * Set only by an INSTALL (catalog UI → `user`, `install_skill` → `agent`).
   * Left undefined by paths that merely switch a skill back on, so re-enabling
   * never rewrites who installed it.
   */
  installedVia?: "user" | "agent";
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
          ...(input.installedVia ? { installedVia: input.installedVia } : {}),
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
        installedVia: input.installedVia ?? "user",
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
  return db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(workspaceSkills)
      .where(
        and(
          eq(workspaceSkills.id, input.workspaceSkillId),
          eq(workspaceSkills.teamId, input.teamId),
          eq(workspaceSkills.workspaceId, input.workspaceId),
        ),
      )
      .returning({ skillId: workspaceSkills.skillId });
    if (!removed) {
      return false;
    }
    // Installing is what granted this workspace access (`grantSkillEntitlement`),
    // so uninstalling takes it back. Left behind, the grant kept a `restricted`
    // skill visible — and re-installable — to a workspace that had removed it.
    await tx
      .delete(skillEntitlements)
      .where(
        and(
          eq(skillEntitlements.skillId, removed.skillId),
          eq(skillEntitlements.teamId, input.teamId),
          eq(skillEntitlements.workspaceId, input.workspaceId),
        ),
      );
    return true;
  });
}

/**
 * A file's manifest row: everything but its bytes. `contentText` is filled only
 * for the version's documents (SKILL.md, README*) and only when the row stores
 * them inline (`db_text`), so the catalog and a turn get what they show up
 * front without any other body leaving the database.
 */
export type SkillVersionFileManifestRow = {
  path: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  objectKey: string | null;
  contentText: string | null;
};

/** `readSkillDocuments`' README pattern, in Postgres syntax (matched with `~*`). */
const README_PATH_PATTERN = "^readme(\\.[a-z0-9-]+)?\\.md$";

export async function listSkillVersionFileManifest(
  skillVersionId: string,
): Promise<SkillVersionFileManifestRow[]> {
  return db
    .select({
      path: skillVersionFiles.path,
      mimeType: skillVersionFiles.mimeType,
      sizeBytes: skillVersionFiles.sizeBytes,
      contentHash: skillVersionFiles.contentHash,
      objectKey: skillVersionFiles.objectKey,
      contentText: sql<
        string | null
      >`case when ${skillVersionFiles.path} = 'SKILL.md' or ${skillVersionFiles.path} ~* ${README_PATH_PATTERN} then ${skillVersionFiles.contentText} end`,
    })
    .from(skillVersionFiles)
    .where(eq(skillVersionFiles.skillVersionId, skillVersionId))
    .orderBy(skillVersionFiles.path);
}

/**
 * One file's content, bounded, from wherever its row keeps it: inline text
 * (`db_text`) or a blob (`object`). A binary blob is reported, never fetched.
 * Null when the version has no such path.
 */
export async function readSkillVersionFile(input: {
  skillVersionId: string;
  path: string;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<SkillFileContent | null> {
  const [row] = await db
    .select({
      contentText: skillVersionFiles.contentText,
      objectKey: skillVersionFiles.objectKey,
      mimeType: skillVersionFiles.mimeType,
      sizeBytes: skillVersionFiles.sizeBytes,
    })
    .from(skillVersionFiles)
    .where(
      and(
        eq(skillVersionFiles.skillVersionId, input.skillVersionId),
        eq(skillVersionFiles.path, input.path),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  if (row.contentText !== null) {
    return { text: row.contentText };
  }
  if (!row.objectKey) {
    // Unreachable under skill_version_files_content_location_check.
    throw new Error(`Skill file '${input.path}' has no stored content`);
  }
  return readSkillObjectFile({
    objectKey: row.objectKey,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/**
 * A version and its file MANIFEST — no bodies beyond the documents (see
 * `SkillVersionFileManifestRow`). Content is read one file at a time through
 * `readSkillVersionFile`. `repo_builtin` versions have no rows: their files are
 * on disk.
 */
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

  const files =
    versionRow.version.storageType === "repo_builtin"
      ? []
      : await listSkillVersionFileManifest(input.skillVersionId);

  return {
    definition: versionRow.definition,
    version: versionRow.version,
    files,
  };
}

/**
 * A builtin's slug is already held by a non-builtin skill. Typed so startup
 * can skip that one builtin instead of refusing to boot: slugs are global and
 * workspace-authored skills pick their own, so without this a single custom
 * skill named like a builtin we ship later would take the whole API down.
 */
export class BuiltinSkillSlugConflictError extends Error {
  readonly slug: string;
  readonly conflictingSourceType: string;
  constructor(slug: string, conflictingSourceType: string) {
    super(
      `Builtin skill slug '${slug}' conflicts with ${conflictingSourceType} skill`,
    );
    this.name = "BuiltinSkillSlugConflictError";
    this.slug = slug;
    this.conflictingSourceType = conflictingSourceType;
  }
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
  assertSkillStorageInvariant("builtin", "repo_builtin");
  const now = new Date();
  return db.transaction(async (tx) => {
    // Every API instance runs this at boot. Without the lock, two instances
    // starting together on a release that adds a builtin both see "no row" and
    // both insert; the loser dies on the slug unique constraint.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"builtin:" + input.slug}))`,
    );
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
      throw new BuiltinSkillSlugConflictError(input.slug, conflict.sourceType);
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
  assertSkillStorageInvariant("workspace_custom", "db_text");
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
  assertSkillStorageInvariant(definition.sourceType, "db_text");

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
  assertSkillStorageInvariant("workspace_custom", "db_text");
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
