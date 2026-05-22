import { ContentError } from "../../errors";
import { AGENT_TOOL_NAMES } from "../../agent/tool-names";
import {
  isAgentToolEnabledByDefault,
  isGeneratedImageArtifactToolName,
  isNotionToolName,
  isSkillActivatedAgentTool,
  isWebSearchToolName,
} from "../../agent/tool-registry";
import type { EnabledSkillDescriptor } from "../../skills/types";
import {
  normalizeArtifactToolSelection,
  normalizeGenerateImageToolSelection,
  type GenerateImageToolSelection,
} from "../../artifacts/types";
import type { ConnectorToolSelection, ThreadToolsSelection } from "./types";

export type McpToolSelection = {
  enabled?: boolean;
  installIds?: string[];
  toolIds?: string[];
};

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
  notionTools?: Record<string, ConnectorToolSelection>;
  mcpTools?: McpToolSelection;
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
    ...(input.notionTools ?? {}),
    ...(input.mcpTools ? { mcp: input.mcpTools } : {}),
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

function normalizeConnectorToolSelection(
  value: unknown,
): ConnectorToolSelection | undefined {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  const enabled =
    typeof record.enabled === "boolean" ? record.enabled : undefined;
  const connectorId =
    typeof record.connectorId === "string" && record.connectorId.trim()
      ? record.connectorId.trim()
      : undefined;
  if (enabled === undefined && connectorId === undefined) {
    return undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(connectorId ? { connectorId } : {}),
  };
}

export function resolveNotionToolSelections(
  tools?: ThreadToolsSelection,
): Record<string, ConnectorToolSelection> {
  const selections: Record<string, ConnectorToolSelection> = {};
  if (!tools) {
    return selections;
  }
  const rawTools = tools as Record<string, unknown>;
  for (const toolName of Object.values(AGENT_TOOL_NAMES)) {
    if (!isNotionToolName(toolName)) {
      continue;
    }
    const selection = normalizeConnectorToolSelection(rawTools[toolName]);
    if (selection) {
      selections[toolName] = selection;
    }
  }
  return selections;
}

export function resolveNotionToolSelectionsFromToolsMetadata(
  value: unknown,
): Record<string, ConnectorToolSelection> {
  const tools = toRecord(value);
  const selections: Record<string, ConnectorToolSelection> = {};
  if (!tools) {
    return selections;
  }
  for (const toolName of Object.values(AGENT_TOOL_NAMES)) {
    if (!isNotionToolName(toolName)) {
      continue;
    }
    const selection = normalizeConnectorToolSelection(tools[toolName]);
    if (selection) {
      selections[toolName] = selection;
    }
  }
  return selections;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

export function resolveMcpToolSelection(
  tools?: ThreadToolsSelection,
): McpToolSelection | undefined {
  const record = toRecord(tools?.mcp);
  if (!record) {
    return undefined;
  }
  const enabled =
    typeof record.enabled === "boolean" ? record.enabled : undefined;
  const installIds = normalizeStringArray(record.installIds);
  const toolIds = normalizeStringArray(record.toolIds);
  if (enabled === undefined && installIds.length === 0 && toolIds.length === 0) {
    return undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(installIds.length > 0 ? { installIds } : {}),
    ...(toolIds.length > 0 ? { toolIds } : {}),
  };
}

export function resolveMcpToolSelectionFromToolsMetadata(
  value: unknown,
): McpToolSelection | undefined {
  const tools = toRecord(value);
  const record = toRecord(tools?.mcp);
  if (!record) {
    return undefined;
  }
  const enabled =
    typeof record.enabled === "boolean" ? record.enabled : undefined;
  const installIds = normalizeStringArray(record.installIds);
  const toolIds = normalizeStringArray(record.toolIds);
  if (enabled === undefined && installIds.length === 0 && toolIds.length === 0) {
    return undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(installIds.length > 0 ? { installIds } : {}),
    ...(toolIds.length > 0 ? { toolIds } : {}),
  };
}

export function enableNotionToolSelection(
  tools: StreamThreadToolsSelectionLike,
  toolName: string,
) {
  if (!isNotionToolName(toolName)) {
    return tools;
  }
  const rawTools = (tools ?? {}) as Record<string, unknown>;
  return {
    ...(tools ?? {}),
    [toolName]: {
      ...normalizeConnectorToolSelection(rawTools[toolName]),
      enabled: true,
    },
  };
}

type StreamThreadToolsSelectionLike = ThreadToolsSelection | undefined;

export const testExports = {
  assertSelectedSkillsAllowedByTools,
};
