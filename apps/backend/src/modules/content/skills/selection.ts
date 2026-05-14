import { ContentError } from "../errors";
import { loadBuiltinSkillBundle, listBuiltinSkills } from "./builtin";
import {
  findEnabledWorkspaceSkillRecordBySlug,
  listWorkspaceSkillRecordsByIds,
  loadSkillVersionBundle,
} from "./repository";
import { parseSkillCommands } from "./commands";
import type { EnabledSkillDescriptor } from "./types";

const MAX_SELECTED_SKILLS_PER_TURN = 5;

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

export async function resolveSkillIdsForSlashCommands(input: {
  teamId: string;
  workspaceId: string;
  commandNames: string[];
  findSkillBySlug?: typeof findEnabledWorkspaceSkillRecordBySlug;
}) {
  const findSkillBySlug =
    input.findSkillBySlug ?? findEnabledWorkspaceSkillRecordBySlug;
  const result: string[] = [];
  for (const commandName of input.commandNames) {
    const slug = skillSlugFromSlashCommand(commandName);
    if (!slug) {
      continue;
    }
    const record = await findSkillBySlug({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      slug,
    });
    if (!record || result.includes(record.id)) {
      continue;
    }
    result.push(record.id);
    if (result.length > MAX_SELECTED_SKILLS_PER_TURN) {
      break;
    }
  }
  return result;
}

export async function resolveSelectedSkills(input: {
  teamId: string;
  workspaceId: string;
  skillIds: string[];
}): Promise<EnabledSkillDescriptor[]> {
  const skillIds = normalizeSkillIds(input.skillIds);
  if (skillIds.length > MAX_SELECTED_SKILLS_PER_TURN) {
    throw new ContentError(
      400,
      "TOO_MANY_SELECTED_SKILLS",
      `At most ${MAX_SELECTED_SKILLS_PER_TURN} skills can be selected per turn`,
    );
  }
  if (skillIds.length === 0) {
    return [];
  }

  const records = await listWorkspaceSkillRecordsByIds({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    workspaceSkillIds: skillIds,
  });
  if (records.length !== skillIds.length) {
    throw new ContentError(
      404,
      "SKILL_NOT_FOUND",
      "One or more selected skills are not enabled in this workspace",
    );
  }

  const byId = new Map(records.map((record) => [record.id, record]));
  const result: EnabledSkillDescriptor[] = [];
  for (const workspaceSkillId of skillIds) {
    const record = byId.get(workspaceSkillId);
    if (!record) {
      throw new ContentError(404, "SKILL_NOT_FOUND", "Selected skill not found");
    }
    if (!record.enabled) {
      throw new ContentError(403, "SKILL_DISABLED", "Selected skill is disabled");
    }

    const bundle = await loadSkillVersionBundle({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: record.skillId,
      skillVersionId: record.skillVersionId,
    });
    if (!bundle) {
      throw new ContentError(404, "SKILL_NOT_FOUND", "Selected skill is no longer available to this workspace");
    }
    if (bundle.version.status !== "published") {
      throw new ContentError(403, "SKILL_NOT_PUBLISHED", "Selected skill version is not published");
    }

    const files = bundle.version.storageType === "repo_builtin"
      ? (await loadBuiltinSkillBundle(bundle.version.storagePointer))?.files
      : bundle.files;
    if (!files) {
      throw new ContentError(404, "SKILL_FILES_NOT_FOUND", "Selected skill files could not be loaded");
    }
    const commands = parseSkillCommands({
      files,
      skillSlug: bundle.definition.slug,
    });
    result.push({
      workspaceSkillId: record.id,
      sourceType: bundle.definition.sourceType,
      name: bundle.definition.slug,
      displayName: bundle.definition.displayName,
      version: bundle.version.version,
      description: bundle.definition.description,
      capabilities: bundle.version.manifestJson.capabilities,
      models: bundle.version.manifestJson.models,
      commands,
      tools: bundle.version.manifestJson.tools,
      slash: bundle.version.manifestJson.slash,
      slashConfig: bundle.version.manifestJson.slashConfig,
      defaultConfig: bundle.version.manifestJson.defaultConfig,
      files,
    });
  }

  return result;
}

export async function builtinCatalogKeys() {
  return new Set((await listBuiltinSkills()).map((skill) => skill.slug));
}

function skillSlugFromSlashCommand(commandName: string | undefined) {
  if (!commandName) {
    return null;
  }
  const raw = commandName.trim();
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const match = withSlash.match(
    /^\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?::[a-z0-9][a-z0-9.-]{0,127})?$/i,
  );
  return match?.[1]?.toLowerCase() ?? null;
}
