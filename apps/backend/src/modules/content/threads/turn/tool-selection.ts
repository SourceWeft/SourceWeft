import { ContentError } from "../../errors";
import { AGENT_TOOL_NAMES } from "../../agent/tool-names";
import {
  isAgentToolEnabledByDefault,
  isGeneratedImageArtifactToolName,
  isSkillActivatedAgentTool,
  isWebSearchToolName,
} from "../../agent/tool-registry";
import type { EnabledSkillDescriptor } from "../../skills/types";
import {
  normalizeArtifactToolSelection,
  normalizeGenerateImageToolSelection,
  type GenerateImageToolSelection,
} from "../../artifacts/types";
import type { ThreadToolsSelection } from "./types";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function skillActivatesTool(
  skill: EnabledSkillDescriptor,
  predicate: (toolName: string) => boolean,
) {
  return skill.tools?.some(
    (toolName) => isSkillActivatedAgentTool(toolName) && predicate(toolName),
  ) === true;
}

export function resolveWebSearchEnabled(input: {
  tools?: ThreadToolsSelection;
  enabledSkills: EnabledSkillDescriptor[];
}) {
  const explicitEnabled =
    input.tools?.[AGENT_TOOL_NAMES.webSearch]?.enabled ??
    input.tools?.webSearchEnabled;
  if (typeof explicitEnabled === "boolean") {
    return explicitEnabled;
  }

  return (
    isAgentToolEnabledByDefault(AGENT_TOOL_NAMES.webSearch) ||
    input.enabledSkills.some((skill) =>
      skillActivatesTool(skill, isWebSearchToolName),
    )
  );
}

export function resolveGenerateImageToolSelection(
  tools?: ThreadToolsSelection,
): GenerateImageToolSelection | undefined {
  const selection = normalizeGenerateImageToolSelection(
    tools?.[AGENT_TOOL_NAMES.generateImage],
  );
  const legacySelection = normalizeArtifactToolSelection(tools?.artifact);
  if (!legacySelection) {
    return selection;
  }

  return {
    ...(selection ?? {}),
    ...(legacySelection.modelAlias && !selection?.modelAlias
      ? { modelAlias: legacySelection.modelAlias }
      : {}),
    ...(selection?.execution ? { execution: selection.execution } : {}),
    ...(legacySelection.image && !selection?.config
      ? { config: legacySelection.image }
      : {}),
  };
}

export function buildThreadToolsMetadata(input: {
  invokedSkillIds?: string[];
  skillIds: string[];
  webSearchEnabled: boolean;
  generateImageTool?: GenerateImageToolSelection;
}) {
  return {
    skillIds: input.skillIds,
    ...(input.invokedSkillIds?.length
      ? { invokedSkillIds: input.invokedSkillIds }
      : {}),
    [AGENT_TOOL_NAMES.webSearch]: {
      enabled: input.webSearchEnabled,
    },
    ...(input.generateImageTool
      ? { [AGENT_TOOL_NAMES.generateImage]: input.generateImageTool }
      : {}),
  };
}

export function assertSelectedSkillsAllowedByTools(input: {
  enabledSkills: EnabledSkillDescriptor[];
  generateImageTool?: GenerateImageToolSelection;
}) {
  if (input.generateImageTool?.enabled !== false) {
    return;
  }

  const blockedSkill = input.enabledSkills.find((skill) =>
    skillActivatesTool(skill, isGeneratedImageArtifactToolName),
  );
  if (!blockedSkill) {
    return;
  }

  throw new ContentError(
    403,
    "SKILL_TOOL_DISABLED",
    `Selected skill '${blockedSkill.name}' requires ${AGENT_TOOL_NAMES.generateImage}, which is disabled for this turn`,
  );
}

export function resolveWebSearchEnabledFromToolsMetadata(value: unknown) {
  const tools = toRecord(value);
  const webSearch = toRecord(tools?.[AGENT_TOOL_NAMES.webSearch]);
  if (typeof webSearch?.enabled === "boolean") {
    return webSearch.enabled;
  }
  return tools?.webSearchEnabled === true;
}

export function resolveGenerateImageToolFromToolsMetadata(value: unknown) {
  const tools = toRecord(value);
  const selection = normalizeGenerateImageToolSelection(
    tools?.[AGENT_TOOL_NAMES.generateImage],
  );
  const legacySelection = normalizeArtifactToolSelection(tools?.artifact);
  if (!legacySelection) {
    return selection;
  }

  return {
    ...(selection ?? {}),
    ...(legacySelection.modelAlias && !selection?.modelAlias
      ? { modelAlias: legacySelection.modelAlias }
      : {}),
    ...(selection?.execution ? { execution: selection.execution } : {}),
    ...(legacySelection.image && !selection?.config
      ? { config: legacySelection.image }
      : {}),
  };
}

export const testExports = {
  assertSelectedSkillsAllowedByTools,
};
