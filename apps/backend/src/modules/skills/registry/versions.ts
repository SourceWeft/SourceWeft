import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillVersions,
  skillVersionFiles,
  skillEntitlements,
  workspaceSkills,
  type SkillManifestJson,
} from "@sourceweft/db";
import type {
  RegistryVersion,
  RegistryVersionDetail,
  RegistryVersionsResponse,
} from "@sourceweft/contracts";
import { ContentError } from "../../content/errors";
import { readSkillVersionDocuments } from "../documents";
import {
  listSkillVersionFileManifest,
  skillEntitlementScopeCondition,
} from "../repository";
import { getSkillLogo } from "../logo";
import { isMarketAdmin } from "../../market/admin";
import { changelogVersion, diffSkillVersions } from "../market/changelog";
import { teamAuditService } from "../../team-audit";

export type RegistryViewer = {
  userId: string;
  teamId: string;
  workspaceId: string;
};
function missing(): never {
  throw new ContentError(
    404,
    "SKILL_NOT_FOUND",
    "Skill version is not available to this workspace",
  );
}
export function registryAccess(input: RegistryViewer) {
  // Grants follow the same scope rule as the catalog: a row naming a workspace
  // reaches that workspace only, a row without one reaches the whole team, and
  // the blank ids the admin route reads with reach nothing.
  return or(
    eq(skillDefinitions.visibility, "public"),
    eq(skillDefinitions.ownerUserId, input.userId),
    sql`${isMarketAdmin(input.userId)}`,
    sql`exists (select 1 from ${skillEntitlements} where ${skillEntitlements.skillId} = ${skillDefinitions.id}
      and ${skillEntitlementScopeCondition(input)}
      and (${skillEntitlements.expiresAt} is null or ${skillEntitlements.expiresAt} > now()))`,
  );
}
export async function requireRegistryDefinition(
  input: RegistryViewer,
  catalogId: string,
) {
  const skillId = catalogId.split(":")[0]!;
  const [definition] = await db
    .select()
    .from(skillDefinitions)
    .where(
      and(
        eq(skillDefinitions.id, skillId),
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
        registryAccess(input),
      ),
    )
    .limit(1);
  if (!definition) missing();
  return definition;
}
function mapVersion(
  version: typeof skillVersions.$inferSelect,
  privileged: boolean,
): RegistryVersion {
  const registry = version.manifestJson.registry;
  return {
    id: version.id,
    skillId: version.skillId,
    version: version.version,
    status: version.status,
    isCurrent: version.isCurrent,
    displayName: version.manifestJson.displayName,
    description: version.manifestJson.description,
    sourceUrl: registry?.sourceUrl ?? null,
    logo: getSkillLogo(version.manifestJson),
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
    flags: registry?.scan.flags ?? [],
    diagnostics: registry?.ingestion?.diagnostics ?? [],
    findings: registry?.ingestion?.findings ?? [],
    hasIngestion: !!registry?.ingestion,
    moderation: privileged ? (registry?.moderation ?? null) : null,
  };
}
export async function listRegistryVersions(
  input: RegistryViewer & { catalogId: string; limit: number; cursor?: string },
): Promise<RegistryVersionsResponse> {
  const definition = await requireRegistryDefinition(input, input.catalogId);
  const privileged =
    definition.ownerUserId === input.userId || isMarketAdmin(input.userId);
  const [installed] = await db
    .select({
      id: workspaceSkills.id,
      skillVersionId: workspaceSkills.skillVersionId,
      enabled: workspaceSkills.enabled,
    })
    .from(workspaceSkills)
    .where(
      and(
        eq(workspaceSkills.skillId, definition.id),
        eq(workspaceSkills.workspaceId, input.workspaceId),
        eq(workspaceSkills.teamId, input.teamId),
      ),
    )
    .limit(1);
  let before;
  if (input.cursor) {
    const [anchor] = await db
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.id, input.cursor),
          eq(skillVersions.skillId, definition.id),
        ),
      )
      .limit(1);
    if (!anchor)
      throw new ContentError(
        400,
        "INVALID_CURSOR",
        "Version cursor does not belong to this skill",
      );
    before = sql`(${skillVersions.createdAt}, ${skillVersions.id}) < (${anchor.createdAt}, ${anchor.id})`;
  }
  const rows = await db
    .select()
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, definition.id),
        privileged
          ? undefined
          : or(
              eq(skillVersions.status, "published"),
              installed
                ? eq(skillVersions.id, installed.skillVersionId)
                : undefined,
            ),
        before,
      ),
    )
    .orderBy(desc(skillVersions.createdAt), desc(skillVersions.id))
    .limit(input.limit + 1);
  const items = rows
    .slice(0, input.limit)
    .map((v) => mapVersion(v, privileged));
  return {
    items,
    nextCursor: rows.length > input.limit ? items.at(-1)!.id : null,
    installed: installed ?? null,
  };
}
export async function getRegistryVersionDetail(
  input: RegistryViewer & { catalogId: string; versionId: string },
): Promise<RegistryVersionDetail> {
  const definition = await requireRegistryDefinition(input, input.catalogId);
  const privileged =
    definition.ownerUserId === input.userId || isMarketAdmin(input.userId);
  const [version] = await db
    .select()
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.id, input.versionId),
        eq(skillVersions.skillId, definition.id),
        privileged ? undefined : eq(skillVersions.status, "published"),
      ),
    )
    .limit(1);
  if (!version) missing();
  // The manifest only: the diff below needs paths and digests, and the
  // documents come from `skill_md` plus one bounded README read.
  const files = await listSkillVersionFileManifest(version.id);
  const [previous] = await db
    .select()
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, definition.id),
        eq(skillVersions.status, "published"),
        lt(skillVersions.createdAt, version.createdAt),
      ),
    )
    .orderBy(desc(skillVersions.createdAt), desc(skillVersions.id))
    .limit(1);
  const older = previous
    ? await db
        .select({
          path: skillVersionFiles.path,
          contentHash: skillVersionFiles.contentHash,
        })
        .from(skillVersionFiles)
        .where(eq(skillVersionFiles.skillVersionId, previous.id))
    : [];
  const old = new Map(older.map((f) => [f.path, f.contentHash]));
  const current = new Map(files.map((f) => [f.path, f.contentHash]));
  return {
    version: mapVersion(version, privileged),
    ...(await readSkillVersionDocuments({ version, files })),
    files: files.map(({ path, contentHash, sizeBytes }) => ({
      path,
      contentHash,
      sizeBytes,
    })),
    changes: {
      added: files.filter((f) => !old.has(f.path)).map((f) => f.path),
      removed: older
        .filter((f) => !current.has(f.path))
        .map((f) => f.path)
        .sort(),
      changed: files
        .filter((f) => old.has(f.path) && old.get(f.path) !== f.contentHash)
        .map((f) => f.path),
    },
    // What the update notice summarises: the same comparison, plus the
    // scripts and scan flags this version adds and a GitHub compare link.
    changelog: previous
      ? diffSkillVersions(
          // A version indexed before files had rows of their own is read
          // from its manifest instead.
          changelogVersion({
            ...previous,
            files: older.length > 0 ? older : undefined,
          }),
          changelogVersion({
            ...version,
            files: files.length > 0 ? files : undefined,
          }),
        )
      : null,
  };
}
function sameConfigContract(
  a: SkillManifestJson,
  b: SkillManifestJson,
): boolean {
  // Public imports have no product config schema. Preserve arbitrary unchanged
  // configurations, but don't pretend to migrate between different contracts.
  return (
    JSON.stringify({
      options: a.options,
      tools: a.tools,
      defaultConfig: a.defaultConfig,
    }) ===
    JSON.stringify({
      options: b.options,
      tools: b.tools,
      defaultConfig: b.defaultConfig,
    })
  );
}
export type VersionEscalation = { addsScripts: boolean; newFlags: string[] };
/**
 * What a version can do that the installed one cannot. Moving a pin is
 * otherwise a quiet `skills.manage` action, so gaining scripts — or scan flags
 * nobody in this workspace has looked at — has to be said out loud first.
 * Downgrades and sideways moves return null.
 */
export function describeVersionEscalation(
  current: SkillManifestJson,
  target: SkillManifestJson,
): VersionEscalation | null {
  const addsScripts =
    target.registry?.capability === "executable" &&
    current.registry?.capability !== "executable";
  const known = new Set(current.registry?.scan.flags ?? []);
  const newFlags = [
    ...new Set(
      (target.registry?.scan.flags ?? []).filter((flag) => !known.has(flag)),
    ),
  ];
  return addsScripts || newFlags.length > 0 ? { addsScripts, newFlags } : null;
}
function escalationMessage(escalation: VersionEscalation): string {
  const parts = [
    escalation.addsScripts ? "adds executable scripts" : null,
    escalation.newFlags.length
      ? `carries new scan flags (${escalation.newFlags.join(", ")})`
      : null,
  ].filter(Boolean);
  return `This version ${parts.join(" and ")}. Acknowledge the change to switch to it.`;
}
export async function switchRegistryVersion(
  input: RegistryViewer & {
    workspaceSkillId: string;
    skillVersionId: string;
    acknowledgeEscalation?: boolean;
  },
) {
  const result = await db.transaction(async (tx) => {
    const [installed] = await tx
      .select()
      .from(workspaceSkills)
      .where(
        and(
          eq(workspaceSkills.id, input.workspaceSkillId),
          eq(workspaceSkills.workspaceId, input.workspaceId),
          eq(workspaceSkills.teamId, input.teamId),
        ),
      )
      .limit(1)
      .for("update");
    if (!installed) missing();
    const [definition] = await tx
      .select()
      .from(skillDefinitions)
      .where(
        and(
          eq(skillDefinitions.id, installed.skillId),
          eq(skillDefinitions.sourceType, "registry_github"),
          eq(skillDefinitions.status, "active"),
          registryAccess(input),
        ),
      )
      .limit(1)
      .for("share");
    if (!definition) missing();
    const [target] = await tx
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.id, input.skillVersionId),
          eq(skillVersions.skillId, installed.skillId),
          eq(skillVersions.status, "published"),
        ),
      )
      .limit(1)
      .for("share");
    if (!target) missing();
    const [previous] = await tx
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.id, installed.skillVersionId))
      .limit(1);
    if (!previous) missing();
    if (
      Object.keys(installed.configJson).length &&
      !sameConfigContract(previous.manifestJson, target.manifestJson)
    ) {
      throw new ContentError(
        409,
        "SKILL_CONFIG_INCOMPATIBLE",
        "This version changes the configuration contract. Update the workspace configuration before switching.",
      );
    }
    if (target.id === previous.id)
      return {
        workspaceSkill: installed,
        fromVersionId: previous.id,
        changed: false,
        escalation: null,
      };
    const escalation = describeVersionEscalation(
      previous.manifestJson,
      target.manifestJson,
    );
    if (escalation && input.acknowledgeEscalation !== true) {
      throw new ContentError(
        409,
        "SKILL_VERSION_ESCALATION",
        escalationMessage(escalation),
        { details: escalation },
      );
    }
    const [updated] = await tx
      .update(workspaceSkills)
      .set({ skillVersionId: target.id, updatedAt: new Date() })
      .where(eq(workspaceSkills.id, installed.id))
      .returning();
    return {
      workspaceSkill: updated!,
      fromVersionId: previous.id,
      changed: true,
      escalation,
    };
  });
  if (result.changed)
    await teamAuditService.record({
      teamId: input.teamId,
      actorUserId: input.userId,
      action: "skill.version_changed",
      targetType: "skill",
      targetId: result.workspaceSkill.skillId,
      metadata: {
        workspaceId: input.workspaceId,
        fromVersionId: result.fromVersionId,
        toVersionId: input.skillVersionId,
        // Only present when the switch was an acknowledged escalation, so the
        // audit trail shows who accepted scripts or new flags.
        ...(result.escalation
          ? { acknowledgedEscalation: result.escalation }
          : {}),
      },
    });
  return { workspaceSkill: result.workspaceSkill };
}
