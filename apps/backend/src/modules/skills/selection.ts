import { ContentError } from "../content/errors";
import {
  getBuiltinSkillBySlug,
  loadBuiltinSkillBundle,
  type SkillBundleFile,
} from "./builtin";
import {
  findEnabledWorkspaceSkillRecordBySlug,
  listEnabledWorkspaceSkillRecords,
  listWorkspaceSkillRecordsByIds,
  loadSkillVersionBundle,
} from "./repository";
import { MAX_SELECTED_SKILLS_PER_TURN } from "@sourceweft/contracts/stream";
import type { EnabledSkillDescriptor, WorkspaceSkillRecord } from "./types";

const BUILTIN_SKILL_ID_PREFIX = "builtin:";

export function normalizeSkillIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ).slice(0, MAX_SELECTED_SKILLS_PER_TURN + 1);
}

export async function resolveSkillIdsWithSlashCommand(input: {
  teamId: string;
  workspaceId: string;
  skillIds: string[];
  commandName?: string;
  findSkillBySlug?: typeof findEnabledWorkspaceSkillRecordBySlug;
}) {
  const skillIds = normalizeSkillIds(input.skillIds);
  const slug = skillSlugFromSlashCommand(input.commandName);
  if (!slug) {
    return skillIds;
  }

  const builtinSelectionId = await runtimeBuiltinSkillSelectionId(slug);
  if (builtinSelectionId) {
    return skillIds.includes(builtinSelectionId)
      ? skillIds
      : [...skillIds, builtinSelectionId].slice(
          0,
          MAX_SELECTED_SKILLS_PER_TURN + 1,
        );
  }

  const findSkillBySlug =
    input.findSkillBySlug ?? findEnabledWorkspaceSkillRecordBySlug;
  const record = await findSkillBySlug({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    slug,
  });
  if (!record || skillIds.includes(record.id)) {
    return skillIds;
  }
  return [...skillIds, record.id].slice(0, MAX_SELECTED_SKILLS_PER_TURN + 1);
}

export async function resolveSelectedSkills(input: {
  teamId: string;
  workspaceId: string;
  skillIds: string[];
  listEnabledWorkspaceSkills?: typeof listEnabledWorkspaceSkillRecords;
  listWorkspaceSkillsByIds?: typeof listWorkspaceSkillRecordsByIds;
  loadWorkspaceSkillVersion?: typeof loadSkillVersionBundle;
}): Promise<EnabledSkillDescriptor[]> {
  const skillIds = normalizeSkillIds(input.skillIds);
  if (skillIds.length > MAX_SELECTED_SKILLS_PER_TURN) {
    throw new ContentError(
      400,
      "TOO_MANY_SELECTED_SKILLS",
      `At most ${MAX_SELECTED_SKILLS_PER_TURN} skills can be selected per turn`,
    );
  }
  const builtinIds = skillIds.filter(isBuiltinSkillSelectionId);
  const workspaceSkillIds = skillIds.filter(
    (skillId) => !isBuiltinSkillSelectionId(skillId),
  );

  const listWorkspaceSkillsByIds =
    input.listWorkspaceSkillsByIds ?? listWorkspaceSkillRecordsByIds;
  const listEnabledWorkspaceSkills =
    input.listEnabledWorkspaceSkills ?? listEnabledWorkspaceSkillRecords;
  const loadWorkspaceSkillVersion =
    input.loadWorkspaceSkillVersion ?? loadSkillVersionBundle;
  const [selectedRecords, enabledWorkspaceRecords] = await Promise.all([
    listWorkspaceSkillsByIds({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      workspaceSkillIds,
    }),
    listEnabledWorkspaceSkills({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
    }),
  ]);
  if (selectedRecords.length !== workspaceSkillIds.length) {
    throw new ContentError(
      404,
      "SKILL_NOT_FOUND",
      "One or more selected skills are not enabled in this workspace",
    );
  }

  const byId = new Map(selectedRecords.map((record) => [record.id, record]));
  const activeWorkspaceRecords = new Map(
    enabledWorkspaceRecords.map((record) => [record.id, record]),
  );
  for (const workspaceSkillId of workspaceSkillIds) {
    const record = byId.get(workspaceSkillId);
    if (!record) {
      throw new ContentError(
        404,
        "SKILL_NOT_FOUND",
        "Selected skill not found",
      );
    }
    if (!record.enabled) {
      throw new ContentError(
        403,
        "SKILL_DISABLED",
        "Selected skill is disabled",
      );
    }
    activeWorkspaceRecords.set(record.id, record);
  }

  const result: EnabledSkillDescriptor[] = [];
  for (const builtinId of builtinIds) {
    result.push(await resolveBuiltinRuntimeSkill(builtinId));
  }

  for (const record of activeWorkspaceRecords.values()) {
    const resolved = await resolveWorkspaceRuntimeSkill({
      record,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      loadWorkspaceSkillVersion,
    });
    result.push(resolved);
  }

  return result;
}

export function builtinSkillSelectionId(slug: string) {
  return `${BUILTIN_SKILL_ID_PREFIX}${slug}`;
}

function isBuiltinSkillSelectionId(value: string) {
  return value.startsWith(BUILTIN_SKILL_ID_PREFIX);
}

function slugFromBuiltinSkillSelectionId(value: string) {
  return value.slice(BUILTIN_SKILL_ID_PREFIX.length);
}

async function runtimeBuiltinSkillSelectionId(slug: string) {
  const skill = await getBuiltinSkillBySlug(slug);
  if (!skill) {
    return null;
  }
  // `managed` builtins (e.g. feynman) are opt-in: they behave like installed
  // workspace skills, so a slash command must resolve through the install-checked
  // workspace path rather than the always-on builtin selection id. Non-managed
  // builtins (always-on generators) keep resolving directly here.
  if (skill.manifestJson.managed === true) {
    return null;
  }
  return builtinSkillSelectionId(skill.slug);
}

async function resolveBuiltinRuntimeSkill(
  selectionId: string,
): Promise<EnabledSkillDescriptor> {
  const slug = slugFromBuiltinSkillSelectionId(selectionId);
  const skill = await getBuiltinSkillBySlug(slug);
  if (!skill) {
    throw new ContentError(
      404,
      "BUILTIN_SKILL_NOT_FOUND",
      "Selected builtin skill is not available",
    );
  }
  const bundle = await loadBuiltinSkillBundle(skill.storagePointer);
  if (!bundle) {
    throw new ContentError(
      404,
      "SKILL_FILES_NOT_FOUND",
      "Selected builtin skill files could not be loaded",
    );
  }
  return {
    workspaceSkillId: selectionId,
    selectionId,
    sourceType: "builtin",
    name: skill.slug,
    displayName: skill.displayName,
    version: skill.version,
    description: skill.description,
    defaultEnabled: skill.manifestJson.defaultEnabled,
    capabilities: skill.manifestJson.capabilities,
    models: skill.manifestJson.models,
    tools: skill.manifestJson.tools,
    options: skill.manifestJson.options,
    slash: skill.manifestJson.slash,
    slashConfig: skill.manifestJson.slashConfig,
    defaultConfig: skill.manifestJson.defaultConfig,
    files: bundle.files,
  };
}

async function resolveWorkspaceRuntimeSkill(input: {
  record: WorkspaceSkillRecord;
  teamId: string;
  workspaceId: string;
  loadWorkspaceSkillVersion: typeof loadSkillVersionBundle;
}): Promise<EnabledSkillDescriptor> {
  const bundle = await input.loadWorkspaceSkillVersion({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    skillId: input.record.skillId,
    skillVersionId: input.record.skillVersionId,
  });
  if (!bundle) {
    throw new ContentError(
      404,
      "SKILL_NOT_FOUND",
      "Selected skill is no longer available to this workspace",
    );
  }
  // Revocation gate — shared by every source: flipping a version to
  // `deprecated` (or archiving the definition, which `loadSkillVersionBundle`
  // filters out) revokes it here, registry skills included.
  if (bundle.version.status !== "published") {
    throw new ContentError(
      403,
      "SKILL_NOT_PUBLISHED",
      "Selected skill version is not published",
    );
  }

  let files: SkillBundleFile[] | undefined;
  if (bundle.version.storageType === "repo_builtin") {
    files = (await loadBuiltinSkillBundle(bundle.version.storagePointer))
      ?.files;
  } else {
    files = bundle.files;
  }
  if (!files) {
    throw new ContentError(
      404,
      "SKILL_FILES_NOT_FOUND",
      "Selected skill files could not be loaded",
    );
  }
  return {
    workspaceSkillId: input.record.id,
    selectionId: input.record.id,
    sourceType: bundle.definition.sourceType,
    name: bundle.definition.slug,
    displayName: bundle.definition.displayName,
    version: bundle.version.version,
    description: bundle.definition.description,
    defaultEnabled: bundle.version.manifestJson.defaultEnabled,
    capabilities: bundle.version.manifestJson.capabilities,
    models: bundle.version.manifestJson.models,
    tools: bundle.version.manifestJson.tools,
    options: bundle.version.manifestJson.options,
    slash: bundle.version.manifestJson.slash,
    slashConfig: bundle.version.manifestJson.slashConfig,
    defaultConfig: bundle.version.manifestJson.defaultConfig,
    files,
  };
}

function skillSlugFromSlashCommand(commandName: string | undefined) {
  if (!commandName) {
    return null;
  }
  const raw = commandName.trim();
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const match = withSlash.match(/^\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}
