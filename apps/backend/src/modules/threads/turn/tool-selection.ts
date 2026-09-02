import {
  AGENT_TOOL_NAMES,
  agentToolNamesByCapability,
  agentToolTurnSelections,
  hasAgentToolCapability,
  isAgentToolEnabledByDefault,
  isSkillActivatedAgentTool,
} from "@sourceweft/agent-tool-registry";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type {
  ConnectorToolSelection,
  PreparedRuntimeTool,
  ThreadToolsSelection,
  TurnOptionsSnapshot,
} from "./types";
import type { ToolPermission } from "./command-registry";
import { toObjectRecord } from "../../../shared/records";

const RESERVED_TOOL_SELECTION_KEYS = new Set([
  "invokedSkillIds",
  "skillRuntimeConfig",
  "skillIds",
]);

function cloneToolSelection(
  tools: ThreadToolsSelection | undefined,
): ThreadToolsSelection {
  if (!tools) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(tools).map(([key, value]) => {
      const record = toObjectRecord(value);
      return [key, record ? { ...record } : value];
    }),
  ) as ThreadToolsSelection;
}

function normalizeSelectedToolRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  const record = toObjectRecord(value);
  if (!record) {
    return undefined;
  }
  return {
    ...record,
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
  };
}

function optionsFromSelection(
  selection: Record<string, unknown>,
): Record<string, unknown> {
  const { enabled: _enabled, ...options } = selection;
  return options;
}

function skillActivatesTool(
  skill: EnabledSkillDescriptor,
  predicate: (toolName: string) => boolean,
) {
  return (
    skill.tools?.some(
      (toolName) => isSkillActivatedAgentTool(toolName) && predicate(toolName),
    ) === true
  );
}

export function resolveWebSearchEnabled(input: {
  tools?: ThreadToolsSelection;
  enabledSkills: readonly EnabledSkillDescriptor[];
}) {
  const explicitEnabled = readWebAccessOverride(input.tools);
  if (typeof explicitEnabled === "boolean") {
    return explicitEnabled;
  }

  return (
    isAgentToolEnabledByDefault(AGENT_TOOL_NAMES.webSearch) ||
    input.enabledSkills.some((skill) =>
      skillActivatesTool(skill, (name) =>
        hasAgentToolCapability(name, "web_query"),
      ),
    )
  );
}

export function readWebAccessOverride(
  tools?: ThreadToolsSelection,
): boolean | undefined {
  const webSearch = toObjectRecord(tools?.[AGENT_TOOL_NAMES.webSearch]);
  if (typeof webSearch?.enabled === "boolean") {
    return webSearch.enabled;
  }
  const webFetch = toObjectRecord(tools?.[AGENT_TOOL_NAMES.webFetch]);
  return typeof webFetch?.enabled === "boolean" ? webFetch.enabled : undefined;
}

export function readSkillRuntimeConfig(
  tools?: ThreadToolsSelection,
): Record<string, Record<string, unknown>> {
  const config = toObjectRecord(tools?.skillRuntimeConfig);
  if (!config) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(config).flatMap(([skillId, value]) => {
      const record = toObjectRecord(value);
      return record ? [[skillId, record]] : [];
    }),
  );
}

/**
 * Ask every registered tool that owns a turn-selection hook to regularize its
 * own slice of the request, keyed by tool name. The pipeline never names a
 * capability: what a selection means, and which values survive, is decided
 * inside the capability that will receive it.
 *
 * Tools that declare no hook are absent from the result, which the caller reads
 * as "nothing to override" — their raw selection passes through untouched.
 */
export function resolveTurnToolSelections(
  tools?: ThreadToolsSelection,
): Record<string, unknown> {
  const context = { skillRuntimeConfig: readSkillRuntimeConfig(tools) };
  const selections: Record<string, unknown> = {};
  for (const { name, turnSelection } of agentToolTurnSelections()) {
    const normalized = turnSelection.normalize(tools?.[name], context);
    if (normalized !== undefined) {
      selections[name] = normalized;
    }
  }
  return selections;
}

export function buildEffectiveToolsSelection(input: {
  baseTools?: ThreadToolsSelection;
  invokedSkillIds?: string[];
  skillIds: string[];
  toolOverrides?: Record<string, unknown>;
  webAccessEnabled: boolean;
}): ThreadToolsSelection {
  const tools = cloneToolSelection(input.baseTools);

  for (const [toolName, value] of Object.entries(tools)) {
    if (RESERVED_TOOL_SELECTION_KEYS.has(toolName)) {
      continue;
    }
    const normalized = normalizeSelectedToolRecord(value);
    if (normalized) {
      tools[toolName] = normalized;
    }
  }

  for (const [toolName, value] of Object.entries(input.toolOverrides ?? {})) {
    const normalized = normalizeSelectedToolRecord(value);
    if (normalized) {
      tools[toolName] = normalized;
    } else {
      delete tools[toolName];
    }
  }

  return {
    ...tools,
    skillIds: input.skillIds,
    ...(input.invokedSkillIds?.length
      ? { invokedSkillIds: input.invokedSkillIds }
      : {}),
    [AGENT_TOOL_NAMES.webSearch]: { enabled: input.webAccessEnabled },
    [AGENT_TOOL_NAMES.webFetch]: { enabled: input.webAccessEnabled },
  };
}

export function buildTurnOptionsSnapshot(input: {
  tools: ThreadToolsSelection;
}): TurnOptionsSnapshot {
  return {
    version: 1,
    tools: input.tools,
  };
}

export function readTurnOptionsSnapshotTools(
  value: unknown,
): ThreadToolsSelection | undefined {
  const options = toObjectRecord(value);
  const tools = toObjectRecord(options?.tools);
  if (options?.version === 1 && tools) {
    return tools as ThreadToolsSelection;
  }
  return undefined;
}

export function buildRuntimeTools(input: {
  tools: ThreadToolsSelection;
  toolPermissions: Record<string, ToolPermission>;
}): Record<string, PreparedRuntimeTool> {
  const runtimeTools: Record<string, PreparedRuntimeTool> = {};
  for (const [toolName, value] of Object.entries(input.tools)) {
    if (RESERVED_TOOL_SELECTION_KEYS.has(toolName)) {
      continue;
    }
    const selection = toObjectRecord(value);
    if (!selection) {
      continue;
    }
    const enabled = selection.enabled !== false;
    const permission = input.toolPermissions[toolName] ?? "allow";
    runtimeTools[toolName] = {
      toolName,
      enabled,
      permission,
      shouldBind: enabled && permission !== "deny",
      selection,
      options: optionsFromSelection(selection),
    };
  }
  return runtimeTools;
}

function normalizeConnectorToolSelection(
  value: unknown,
): ConnectorToolSelection | undefined {
  const record = toObjectRecord(value);
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

export function resolveConnectorToolSelections(
  tools: ThreadToolsSelection | undefined,
  connectorType: string,
): Record<string, ConnectorToolSelection> {
  const selections: Record<string, ConnectorToolSelection> = {};
  if (!tools) {
    return selections;
  }
  const rawTools = tools as Record<string, unknown>;
  for (const toolName of agentToolNamesByCapability(connectorType)) {
    const selection = normalizeConnectorToolSelection(rawTools[toolName]);
    if (selection) {
      selections[toolName] = selection;
    }
  }
  return selections;
}
