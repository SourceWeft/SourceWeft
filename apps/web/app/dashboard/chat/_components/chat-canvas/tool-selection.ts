import {
  AGENT_TOOL_NAMES,
  agentToolNamesByCapability,
  getAgentToolDefinition,
  hasAgentToolCapability,
  isSkillActivatedAgentTool,
  isAgentToolUserDisableSupported,
  isAgentToolUserEnableSupported,
} from "@sourceweft/agent-tool-registry";
import { filterModelSupportedOptionValues } from "@sourceweft/contracts/agent-tools";
import { MAX_SELECTED_SKILLS_PER_TURN } from "@sourceweft/contracts/stream";
import type {
  CapabilityCatalogTool,
  CapabilityToolOption,
  SkillOption,
} from "@sourceweft/sdk";
import type {
  ChatSkillItem,
  ChatToolSelection,
  ChatToolsSelection,
  ThinkingEffort,
} from "./types";

const WEB_ACCESS_TOOL_NAMES = new Set<string>([
  AGENT_TOOL_NAMES.webSearch,
  AGENT_TOOL_NAMES.webFetch,
]);

/**
 * The values the composer should offer for one configurable option.
 *
 * Capability-tool options and skill-targeted options are the same problem and
 * get the same answer: start from everything the capability declared, then drop
 * whatever the selected model does not advertise. Which annotation holds that
 * answer, and where inside it, is stated by the option's own `modelValues`
 * pointer — so this stays blind to what any option means. An option without the
 * pointer, or a model that advertises nothing for it, is simply unconstrained.
 *
 * This wrapper exists so both composer call sites and this module's tests share
 * one path; the resolution itself lives in @sourceweft/contracts next to the
 * model-catalog annotation it reads.
 */
export function composerOptionValues(
  option: CapabilityToolOption | SkillOption,
  modelCapabilities: Record<string, unknown> | undefined,
) {
  return filterModelSupportedOptionValues(
    option.values ?? [],
    option.modelValues,
    modelCapabilities,
  );
}

/** Re-exported so the composer and the API boundary cannot drift apart. */
export const MAX_SELECTED_SKILL_IDS_PER_TURN = MAX_SELECTED_SKILLS_PER_TURN;

export const SKILL_SELECTION_LIMIT_MESSAGE = `You can enable at most ${MAX_SELECTED_SKILLS_PER_TURN} skills per message.`;

export function normalizeSkillIdsForRequest(skillIds: readonly string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const skillId of skillIds) {
    const trimmed = skillId.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= MAX_SELECTED_SKILL_IDS_PER_TURN) {
      break;
    }
  }
  return normalized;
}

export function coerceSkillIdsSelection(skillIds: readonly string[]) {
  const normalized = normalizeSkillIdsForRequest(skillIds);
  const uniqueRequested = new Set(
    skillIds.map((skillId) => skillId.trim()).filter(Boolean),
  );
  return {
    skillIds: normalized,
    wasLimited: normalized.length < uniqueRequested.size,
  };
}

export function toggleSkillSelection(input: {
  currentSkillIds: readonly string[];
  selected: boolean;
  skillId: string;
}) {
  if (!input.selected) {
    return {
      skillIds: input.currentSkillIds.filter((id) => id !== input.skillId),
      wasLimited: false,
    };
  }
  if (input.currentSkillIds.includes(input.skillId)) {
    return {
      skillIds: [...input.currentSkillIds],
      wasLimited: false,
    };
  }
  const nextSkillIds = normalizeSkillIdsForRequest([
    ...input.currentSkillIds,
    input.skillId,
  ]);
  return {
    skillIds: nextSkillIds,
    wasLimited: nextSkillIds.length === input.currentSkillIds.length,
  };
}

/**
 * Return agent tool names that belong to a connector type.
 * Uses capability tags (e.g. "notion") to discover tools dynamically.
 */
export function getConnectorAgentToolNames(
  connectorType: string,
): readonly string[] {
  return agentToolNamesByCapability(connectorType);
}

export function buildChatToolsRequest(input: {
  invokedSkillIds?: string[];
  skillIds?: string[];
  searchEnabled?: boolean;
  tools?: ChatToolsSelection;
}) {
  const entries = Object.fromEntries(
    Object.entries(input.tools ?? {}).map(([toolName, sel]) => [
      toolName,
      sel ?? { enabled: false },
    ]),
  );
  const webAccessSelection =
    typeof input.searchEnabled === "boolean"
      ? {
          [AGENT_TOOL_NAMES.webSearch]: { enabled: input.searchEnabled },
          [AGENT_TOOL_NAMES.webFetch]: { enabled: input.searchEnabled },
        }
      : {};

  const skillIds = normalizeSkillIdsForRequest(input.skillIds ?? []);
  const invokedSkillIds = input.invokedSkillIds?.length
    ? normalizeSkillIdsForRequest(input.invokedSkillIds)
    : [];

  return {
    skillIds,
    ...(invokedSkillIds.length > 0
      ? { invokedSkillIds }
      : {}),
    ...entries,
    ...webAccessSelection,
  };
}

export function isCapabilityToolVisibleInComposerOptions(
  tool: Pick<CapabilityCatalogTool, "toolName">,
) {
  if (WEB_ACCESS_TOOL_NAMES.has(tool.toolName)) {
    return false;
  }
  const definition = getAgentToolDefinition(tool.toolName);
  if (definition?.domain === "sandbox" || definition?.domain === "retrieval") {
    return false;
  }
  if (!definition) {
    return true;
  }
  return (
    isAgentToolUserDisableSupported(tool.toolName) ||
    isAgentToolUserEnableSupported(tool.toolName)
  );
}

export const thinkingEffortOptions: Array<{
  value: ThinkingEffort;
  label: string;
}> = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Standard" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

export function buildComposerToolsSelection(input: {
  disabledToolNames: string[];
  selectedSkills: ChatSkillItem[];
  activeConnectorIds?: Record<string, string | null>;
  connectorToolsEnabled?: Record<string, boolean>;
}): ChatToolsSelection | undefined {
  const tools: ChatToolsSelection = {};

  // Generic multi-connector path
  const connectorIds = input.activeConnectorIds ?? {};
  const connectorEnabled = input.connectorToolsEnabled ?? {};
  for (const [connectorType, connectorId] of Object.entries(connectorIds)) {
    if (!connectorId) continue;
    const enabled = connectorEnabled[connectorType];
    if (enabled === undefined) continue;
    for (const toolName of getConnectorAgentToolNames(connectorType)) {
      tools[toolName] = { connectorId, enabled };
    }
  }

  return Object.keys(tools).length > 0 ? tools : undefined;
}

type SkillOptionValue = string | number | boolean;
type SkillOptionOverrides = Record<
  string,
  Record<string, SkillOptionValue | undefined>
>;
type CapabilityToolEnabledOverrides = Record<string, boolean | undefined>;

function isSafeSelectionPath(path: string) {
  return path
    .split(".")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "__proto__" &&
        segment !== "constructor" &&
        segment !== "prototype",
    );
}

function setValueAtSelectionPath(
  target: Record<string, unknown>,
  path: string,
  value: SkillOptionValue,
) {
  const segments = path.split(".");
  if (segments.length === 0 || !isSafeSelectionPath(path)) {
    return false;
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child === undefined) {
      const nextChild: Record<string, unknown> = {};
      current[segment] = nextChild;
      current = nextChild;
      continue;
    }
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      return false;
    }
    current = child as Record<string, unknown>;
  }
  const leaf = segments.at(-1);
  if (!leaf) {
    return false;
  }
  current[leaf] = value;
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergePlainRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
) {
  const next = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = next[key];
    next[key] =
      isPlainRecord(existing) && isPlainRecord(value)
        ? mergePlainRecords(existing, value)
        : value;
  }
  return next;
}

export function mergeChatToolsSelection(
  left: ChatToolsSelection | undefined,
  right: ChatToolsSelection | undefined,
): ChatToolsSelection | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const next: ChatToolsSelection = { ...left };
  for (const [toolName, selection] of Object.entries(right)) {
    if (!selection) {
      continue;
    }
    const existing = next[toolName];
    next[toolName] =
      isPlainRecord(existing) && isPlainRecord(selection)
        ? (mergePlainRecords(existing, selection) as ChatToolSelection)
        : selection;
  }
  return next;
}

export function buildSkillOptionToolsSelection(input: {
  selectedSkills: readonly ChatSkillItem[];
  overrides: SkillOptionOverrides;
}): ChatToolsSelection | undefined {
  const selections: ChatToolsSelection = {};
  const skillRuntimeConfig: Record<string, Record<string, unknown>> = {};
  const selectionRecord = selections as Record<
    string,
    ChatToolSelection | undefined
  >;
  for (const skill of input.selectedSkills) {
    const skillOverrides = input.overrides[skill.id];
    if (!skillOverrides) {
      continue;
    }
    for (const option of skill.options ?? []) {
      const value = skillOverrides[option.id];
      if (value === undefined) {
        continue;
      }
      const toolName = option.target.toolName;
      if (!toolName) {
        if (option.target.path.startsWith("config.")) {
          const skillConfig = { ...(skillRuntimeConfig[skill.id] ?? {}) };
          const configPath = option.target.path.slice("config.".length);
          if (setValueAtSelectionPath(skillConfig, configPath, value)) {
            skillRuntimeConfig[skill.id] = skillConfig;
          }
        }
        continue;
      }
      const selection: ChatToolSelection = {
        ...(selectionRecord[toolName] ?? {}),
        enabled: true,
      };
      if (setValueAtSelectionPath(selection, option.target.path, value)) {
        selectionRecord[toolName] = selection;
      }
    }
  }
  if (Object.keys(skillRuntimeConfig).length > 0) {
    selections.skillRuntimeConfig = skillRuntimeConfig;
  }
  return Object.keys(selections).length > 0 ? selections : undefined;
}

export function buildCapabilityOptionToolsSelection(input: {
  catalogTools: readonly CapabilityCatalogTool[];
  overrides: SkillOptionOverrides;
}): ChatToolsSelection | undefined {
  const selections: ChatToolsSelection = {};
  for (const tool of input.catalogTools) {
    const toolOverrides = input.overrides[tool.toolName];
    if (!toolOverrides) {
      continue;
    }
    const selection: ChatToolSelection = { enabled: true };
    let changed = false;
    for (const option of tool.options) {
      const value = toolOverrides[option.id];
      if (value === undefined || !option.target?.path) {
        continue;
      }
      if (setValueAtSelectionPath(selection, option.target.path, value)) {
        changed = true;
      }
    }
    if (changed) {
      selections[tool.toolName] = selection;
    }
  }
  return Object.keys(selections).length > 0 ? selections : undefined;
}

export function buildCapabilityToolToggleSelection(input: {
  catalogTools: readonly CapabilityCatalogTool[];
  overrides: CapabilityToolEnabledOverrides;
}): ChatToolsSelection | undefined {
  const selections: ChatToolsSelection = {};
  for (const tool of input.catalogTools) {
    const enabled = input.overrides[tool.toolName];
    if (enabled === undefined) {
      continue;
    }
    selections[tool.toolName] = { enabled };
  }
  return Object.keys(selections).length > 0 ? selections : undefined;
}

export function resolveDefaultActiveSkillIds(input: {
  availableSkills: readonly Pick<ChatSkillItem, "defaultEnabled" | "id">[];
  currentSkillIds: readonly string[];
  maxSkills?: number;
}) {
  const availableIds = new Set(input.availableSkills.map((skill) => skill.id));
  const defaultSkillIds = input.availableSkills
    .filter((skill) => skill.defaultEnabled)
    .map((skill) => skill.id);
  const defaultAndCurrentSkillIds = Array.from(
    new Set([
      ...defaultSkillIds,
      ...input.currentSkillIds.filter((id) => availableIds.has(id)),
    ]),
  );
  const maxSkills = input.maxSkills ?? MAX_SELECTED_SKILL_IDS_PER_TURN;
  if (defaultSkillIds.length >= maxSkills) {
    return normalizeSkillIdsForRequest(
      defaultAndCurrentSkillIds.filter((id) => defaultSkillIds.includes(id)),
    );
  }
  const extraSlots = maxSkills - defaultSkillIds.length;
  const currentSkillIds = defaultAndCurrentSkillIds.filter(
    (id) => !defaultSkillIds.includes(id),
  );
  return normalizeSkillIdsForRequest([
    ...defaultSkillIds,
    ...currentSkillIds.slice(0, extraSlots),
  ]);
}

export function skillSupportsConnector(
  skill: ChatSkillItem,
  connectorType: string,
) {
  return (
    skill.tools?.some(
      (toolName) =>
        isSkillActivatedAgentTool(toolName) &&
        hasAgentToolCapability(toolName, connectorType),
    ) === true
  );
}

/**
 * Return the activated tool names for a skill.
 * These are tools the skill declares and that are marked as skill-activatable.
 */
export function skillActivatedToolNames(skill: ChatSkillItem): string[] {
  return (skill.tools ?? []).filter((name) => isSkillActivatedAgentTool(name));
}

/**
 * Check whether a skill is still viable given the current set of disabled tools.
 * A skill is viable if at least one of its activated tools is NOT disabled,
 * OR if it has no activated tools (in which case it's always viable).
 */
export function isSkillViable(
  skill: ChatSkillItem,
  disabledToolNames: Set<string>,
): boolean {
  const activated = skillActivatedToolNames(skill);
  if (activated.length === 0) return true;
  return activated.some((name) => !disabledToolNames.has(name));
}
