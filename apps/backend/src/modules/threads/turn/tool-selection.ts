import {
  AGENT_TOOL_NAMES,
  agentToolNamesByCapability,
  hasAgentToolCapability,
  isAgentToolEnabledByDefault,
  isSkillActivatedAgentTool,
} from "@sourceweft/agent-tool-registry";
import {
  normalizeGenerateImageToolSelection,
  type GenerateImageToolSelection,
} from "@sourceweft/builtin-tool-generate-image";
import { normalizeGenerateVideoPresentationToolSelection } from "../../artifacts/types";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type {
  ConnectorToolSelection,
  PreparedRuntimeTool,
  ThreadToolsSelection,
  TurnOptionsSnapshot,
} from "./types";
import type { ToolPermission } from "./command-registry";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

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
      const record = toRecord(value);
      return [key, record ? { ...record } : value];
    }),
  ) as ThreadToolsSelection;
}

function normalizeSelectedToolRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  const record = toRecord(value);
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
  const webSearch = toRecord(tools?.[AGENT_TOOL_NAMES.webSearch]);
  if (typeof webSearch?.enabled === "boolean") {
    return webSearch.enabled;
  }
  const webFetch = toRecord(tools?.[AGENT_TOOL_NAMES.webFetch]);
  return typeof webFetch?.enabled === "boolean" ? webFetch.enabled : undefined;
}

export function readSkillRuntimeConfig(
  tools?: ThreadToolsSelection,
): Record<string, Record<string, unknown>> {
  const config = toRecord(tools?.skillRuntimeConfig);
  if (!config) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(config).flatMap(([skillId, value]) => {
      const record = toRecord(value);
      return record ? [[skillId, record]] : [];
    }),
  );
}

export function resolveGenerateImageToolSelection(
  tools?: ThreadToolsSelection,
): GenerateImageToolSelection | undefined {
  return normalizeGenerateImageToolSelection(
    tools?.[AGENT_TOOL_NAMES.generateImage],
  );
}

function setSelectionPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
) {
  const segments = path.split(".");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "__proto__" ||
        segment === "constructor" ||
        segment === "prototype",
    )
  ) {
    return;
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      const next: Record<string, unknown> = {};
      current[segment] = next;
      current = next;
      continue;
    }
    current = child as Record<string, unknown>;
  }
  const leaf = segments.at(-1);
  if (leaf) {
    current[leaf] = value;
  }
}

function videoSelectionFromRuntimeConfig(config: Record<string, unknown>) {
  const nestedConfig = toRecord(config.config);
  const source = nestedConfig ? { ...nestedConfig, ...config } : config;
  const selection: Record<string, unknown> = {};
  const directPaths: Record<string, string> = {
    canvasFps: "canvas.fps",
    durationTarget: "renderProfile.durationTarget",
    language: "renderProfile.language",
    motionPacing: "motion.pacing",
    narrationEnabled: "narration.enabled",
    slideCount: "slideCount",
    stylePreset: "renderProfile.stylePreset",
    visualDensity: "renderProfile.visualDensity",
    visualDirection: "visualDirection",
  };
  for (const [key, path] of Object.entries(directPaths)) {
    if (source[key] !== undefined) {
      setSelectionPath(selection, path, source[key]);
    }
  }
  for (const key of ["brand", "canvas", "motion", "renderProfile"]) {
    if (source[key] !== undefined) {
      selection[key] = source[key];
    }
  }
  return normalizeGenerateVideoPresentationToolSelection(selection);
}

function mergeOptionalRecord(
  first: Record<string, unknown> | undefined,
  second: Record<string, unknown> | undefined,
) {
  const merged = { ...(first ?? {}), ...(second ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveGenerateVideoPresentationToolSelection(
  tools?: ThreadToolsSelection,
): ThreadToolsSelection[typeof AGENT_TOOL_NAMES.generateVideoPresentation] {
  const explicit = normalizeGenerateVideoPresentationToolSelection(
    tools?.[AGENT_TOOL_NAMES.generateVideoPresentation],
  );
  const runtimeConfig = readSkillRuntimeConfig(tools);
  const runtimeSelection = videoSelectionFromRuntimeConfig(
    runtimeConfig["builtin:video-presentation"] ?? {},
  );
  if (!explicit && !runtimeSelection) {
    return undefined;
  }
  return {
    ...(runtimeSelection ?? {}),
    ...(explicit ?? {}),
    ...(() => {
      const renderProfile = mergeOptionalRecord(
        runtimeSelection?.renderProfile,
        explicit?.renderProfile,
      );
      return renderProfile ? { renderProfile } : {};
    })(),
    ...(() => {
      const brand = mergeOptionalRecord(runtimeSelection?.brand, explicit?.brand);
      return brand ? { brand } : {};
    })(),
    ...(() => {
      const motion = mergeOptionalRecord(runtimeSelection?.motion, explicit?.motion);
      return motion ? { motion } : {};
    })(),
    ...(() => {
      const canvas = mergeOptionalRecord(runtimeSelection?.canvas, explicit?.canvas);
      return canvas ? { canvas } : {};
    })(),
    ...(() => {
      const narration = mergeOptionalRecord(
        runtimeSelection?.narration,
        explicit?.narration,
      );
      return narration ? { narration } : {};
    })(),
  };
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
  const options = toRecord(value);
  const tools = toRecord(options?.tools);
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
    const selection = toRecord(value);
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

export function resolveConnectorToolSelectionsFromToolsMetadata(
  value: unknown,
  connectorType: string,
): Record<string, ConnectorToolSelection> {
  const tools = toRecord(value);
  const selections: Record<string, ConnectorToolSelection> = {};
  if (!tools) {
    return selections;
  }
  for (const toolName of agentToolNamesByCapability(connectorType)) {
    const selection = normalizeConnectorToolSelection(tools[toolName]);
    if (selection) {
      selections[toolName] = selection;
    }
  }
  return selections;
}

export function enableConnectorToolSelection(
  tools: ThreadToolsSelection | undefined,
  toolName: string,
  connectorType: string,
) {
  if (!hasAgentToolCapability(toolName, connectorType)) {
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

export const testExports = {};
