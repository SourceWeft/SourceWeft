import type {
  AgentToolCapability,
  AgentToolConfiguration,
  AgentToolDefaultPermission,
  AgentToolDefinitionShape,
  AgentToolDomain,
  AgentToolRequirements,
  AgentToolRiskLevel,
  AgentToolSlashCommand,
} from "@sourceweft/contracts/agent-tools";
import type {
  ArtifactProgressOutputRole,
  ArtifactProgressProtocol,
} from "@sourceweft/contracts/artifact-progress";
import type {
  AgentToolModelCatalogAnnotation,
  AgentToolPresentation,
  AgentToolTurnPreflight,
  AgentToolTurnSelection,
} from "@sourceweft/contracts/agent-tools";
import { filesystemAgentToolDefs } from "@sourceweft/builtin-vfs/agent-tool-defs";
import { webAgentToolDefs } from "@sourceweft/builtin-tool-web-search/agent-tool-defs";
import { sandboxAgentToolDefs } from "@sourceweft/builtin-tool-sandbox/agent-tool-defs";
import { retrievalAgentToolDefs } from "@sourceweft/builtin-retrieval/agent-tool-defs";
import { generateImageAgentToolDefs } from "@sourceweft/builtin-tool-generate-image/agent-tool-defs";
import { publishArtifactAgentToolDefs } from "@sourceweft/builtin-tool-publish-artifact/agent-tool-defs";
import { videoPresentationAgentToolDefs } from "@sourceweft/builtin-tool-video-presentation/agent-tool-defs";
import { pptDeckAgentToolDefs } from "@sourceweft/builtin-skill-ppt-deck/agent-tool-defs";
import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

/**
 * Proactive clarifying-question tool. It interrupts from inside its own tool
 * body (LangGraph `interrupt()`), so it is never gated through `interruptOn`
 * and carries no external side effect. Defined locally rather than in a builtin
 * package because it is implemented as agent middleware, not a capability
 * package. See docs/architecture/proactive-ask-user.md.
 */
export const askUserAgentTool = defineAgentTool({
  id: "askUser",
  name: "askUser",
  domain: "interaction",
  capabilities: [],
  activation: {
    default: "off",
    userControl: "none",
    skill: {
      declarable: false,
      activates: false,
    },
  },
  defaultPermission: "allow",
  riskLevel: "low",
});

/** Tools implemented by the host agent stack rather than a capability package. */
export const LOCAL_AGENT_TOOLS = [askUserAgentTool] as const;

export const AGENT_TOOLS = [
  ...filesystemAgentToolDefs,
  ...generateImageAgentToolDefs,
  ...retrievalAgentToolDefs,
  ...webAgentToolDefs,
  ...publishArtifactAgentToolDefs,
  ...videoPresentationAgentToolDefs,
  ...pptDeckAgentToolDefs,
  ...sandboxAgentToolDefs,
  ...LOCAL_AGENT_TOOLS,
] as const;

export type AgentToolDefinition = (typeof AGENT_TOOLS)[number];
export type AgentToolId = AgentToolDefinition["id"];
export type AgentToolName = AgentToolDefinition["name"];
export type AgentToolDomainName = AgentToolDefinition["domain"];
export type AgentToolModelKind = Extract<
  AgentToolDefinition,
  { requirements: { modelKind: string } }
>["requirements"]["modelKind"];

export const AGENT_TOOL_NAMES = Object.fromEntries(
  AGENT_TOOLS.map((tool) => [tool.id, tool.name]),
) as {
  [Tool in AgentToolDefinition as Tool["id"]]: Tool["name"];
};

const AGENT_TOOL_REGISTRY = Object.fromEntries(
  AGENT_TOOLS.map((tool) => [tool.name, tool]),
) as {
  [Tool in AgentToolDefinition as Tool["name"]]: Tool;
};

// ---------------------------------------------------------------------------
// Runtime-registered connector tools
// ---------------------------------------------------------------------------

const registeredTools: AgentToolDefinitionShape[] = [];

/**
 * Register agent tool definitions at runtime (e.g. connector tools from
 * {@link package-adapters.ts}).  Idempotent — re-registering the same tool
 * name is a no-op.
 */
export function registerAgentTools(tools: readonly AgentToolDefinitionShape[]) {
  for (const tool of tools) {
    if (getAgentToolDefinition(tool.name)) continue;
    registeredTools.push(tool);
  }
}

/** Return the combined set of built-in and runtime-registered tools. */
function allAgentTools(): readonly AgentToolDefinitionShape[] {
  return [...AGENT_TOOLS, ...registeredTools] as AgentToolDefinitionShape[];
}

export function isAgentToolName(value: string): value is AgentToolName {
  return (
    value in AGENT_TOOL_REGISTRY ||
    registeredTools.some((t) => t.name === value)
  );
}

export function getAgentToolDefinition(
  name: string,
): AgentToolDefinitionShape | null {
  if (name in AGENT_TOOL_REGISTRY)
    return AGENT_TOOL_REGISTRY[name as AgentToolName];
  return registeredTools.find((t) => t.name === name) ?? null;
}

function getAgentToolRequirements(
  tool: AgentToolDefinitionShape,
): AgentToolRequirements | undefined {
  return "requirements" in tool ? tool.requirements : undefined;
}

function getAgentToolConfiguration(
  tool: AgentToolDefinitionShape | null,
): AgentToolConfiguration | undefined {
  return tool && "configuration" in tool ? tool.configuration : undefined;
}

export function getAgentToolSlashCommand(
  value: string,
): AgentToolSlashCommand | null {
  const tool = getAgentToolDefinition(value);
  if (!tool || !("slash" in tool)) {
    return null;
  }
  const slash = tool.slash as AgentToolSlashCommand | undefined;
  if (slash?.enabled === false) {
    return null;
  }
  return {
    displayName: slash?.displayName ?? tool.name,
    ...(slash?.description ? { description: slash.description } : {}),
    ...(slash?.aliases ? { aliases: slash.aliases } : {}),
    ...(slash?.iconName ? { iconName: slash.iconName } : {}),
    ...(slash?.iconTone ? { iconTone: slash.iconTone } : {}),
    ...(slash?.supportsCommand !== undefined
      ? { supportsCommand: slash.supportsCommand }
      : {}),
    enabled: true,
  };
}

export function isConfigurableAgentTool(value: string) {
  return (
    getAgentToolConfiguration(getAgentToolDefinition(value))?.configurable ===
    true
  );
}

export function hasAgentToolCapability(
  value: string,
  capability: AgentToolCapability,
): value is AgentToolName {
  const capabilities = getAgentToolDefinition(value)?.capabilities as
    readonly AgentToolCapability[] | undefined;
  return capabilities?.includes(capability) === true;
}

export function isAgentToolDomain(
  value: string,
  domain: AgentToolDomain,
): value is AgentToolName {
  return getAgentToolDefinition(value)?.domain === domain;
}

export function isSkillDeclarableAgentTool(
  value: string,
): value is AgentToolName {
  return getAgentToolDefinition(value)?.activation.skill.declarable === true;
}

export function isSkillActivatedAgentTool(
  value: string,
): value is AgentToolName {
  return getAgentToolDefinition(value)?.activation.skill.activates === true;
}

export function isAgentToolEnabledByDefault(
  value: string,
): value is AgentToolName {
  return getAgentToolDefinition(value)?.activation.default === "always";
}

export function isAgentToolUserDisableSupported(
  value: string,
): value is AgentToolName {
  const userControl = getAgentToolDefinition(value)?.activation.userControl;
  return userControl === "disable" || userControl === "enable-disable";
}

export function isAgentToolUserEnableSupported(
  value: string,
): value is AgentToolName {
  return (
    getAgentToolDefinition(value)?.activation.userControl === "enable-disable"
  );
}

export function agentToolNamesByCapability(capability: AgentToolCapability) {
  return allAgentTools()
    .filter((tool) =>
      (tool.capabilities as readonly string[]).includes(capability),
    )
    .map((tool) => tool.name);
}

export function agentToolRequiredForModelKind(kind: AgentToolModelKind) {
  return (
    allAgentTools().find(
      (tool) => getAgentToolRequirements(tool)?.modelKind === kind,
    )?.name ?? null
  );
}

/**
 * Generic connector-related capabilities that are not connector type identifiers.
 * Connector type capabilities (like "notion", "slack") are added to
 * {@link AgentToolCapability} per connector and resolved dynamically.
 */
const GENERIC_CONNECTOR_CAPABILITIES = new Set([
  "connector",
  "connector_read",
  "connector_write",
  "connector_create",
  "connector_update",
  "connector_delete",
  "connector_append",
  "connector_upload",
  "connector_move",
  "connector_archive",
  "connector_comment",
  "artifact",
]);

/**
 * Resolve the connector type from a tool name by inspecting its capabilities.
 * Returns `null` when the tool is not a connector tool or its type cannot be
 * determined.
 */
export function getAgentToolConnectorType(toolName: string): string | null {
  const def = getAgentToolDefinition(toolName);
  if (!def || def.domain !== "connector") return null;
  const caps = def.capabilities as readonly string[];
  return caps.find((cap) => !GENERIC_CONNECTOR_CAPABILITIES.has(cap)) ?? null;
}

export function getAgentToolConfigKeys(value: string): readonly string[] {
  return (
    getAgentToolConfiguration(getAgentToolDefinition(value))?.configKeys ?? []
  );
}

/**
 * Retrieve the artifact progress protocol for a tool.
 * Returns null if the tool doesn't support artifact progress tracking.
 */
export function getArtifactProgressProtocol(
  toolName: string,
): ArtifactProgressProtocol | null {
  const tool = getAgentToolDefinition(toolName);
  if (!tool || !("artifactProgress" in tool)) {
    return null;
  }
  return (
    (tool.artifactProgress as ArtifactProgressProtocol | undefined) ?? null
  );
}

export type {
  AgentToolCapability,
  AgentToolDefaultPermission,
  AgentToolDefinitionShape,
  AgentToolDomain,
  AgentToolRiskLevel,
};

/**
 * Whether a structured tool-output `type` belongs to any capability that
 * contributes artifact progress. Callers use this instead of hardcoding a
 * capability's output type names, so adding a deliverable needs no edit here.
 */
export function isArtifactProgressOutputType(
  type: string | null | undefined,
): boolean {
  if (!type) {
    return false;
  }
  return getArtifactProgressOutputRole(type) !== null;
}

/**
 * The role a structured tool-output `type` plays in its capability's progress
 * protocol, or null when no capability claims the type. Callers that need to
 * tell a finished job from a queued one ask for the role instead of matching
 * a capability's `type` names, so adding a deliverable needs no edit here.
 */
function getArtifactProgressOutputRole(
  type: string | null | undefined,
): ArtifactProgressOutputRole | null {
  if (!type) {
    return null;
  }
  for (const tool of allAgentTools()) {
    const protocol = (tool as { artifactProgress?: ArtifactProgressProtocol })
      .artifactProgress;
    const role = protocol?.outputTypeRoles[type];
    if (role) {
      return role;
    }
  }
  return null;
}

/**
 * Whether the output reports a finished job — the record carrying the final
 * status, success or failure.
 */
export function isArtifactProgressTerminalOutputType(
  type: string | null | undefined,
): boolean {
  return getArtifactProgressOutputRole(type) === "terminal";
}

/**
 * Whether the output reports a job accepted and now running in the background.
 */
export function isArtifactProgressProcessingOutputType(
  type: string | null | undefined,
): boolean {
  return getArtifactProgressOutputRole(type) === "processing";
}

/**
 * Whether the output is a result record — the job was either accepted or has
 * finished — as opposed to an intermediate progress tick that reports no
 * outcome of its own.
 */
export function isArtifactProgressResultOutputType(
  type: string | null | undefined,
): boolean {
  const role = getArtifactProgressOutputRole(type);
  return role === "processing" || role === "terminal";
}

/**
 * The capability's own presentation, if it declares one. Callers that render a
 * tool call ask here instead of branching on capability tags to pick copy.
 */
export function getAgentToolPresentation(
  toolName: string,
): AgentToolPresentation | null {
  return getAgentToolDefinition(toolName)?.presentation ?? null;
}

/**
 * The capability whose progress this stream event belongs to, or null when no
 * capability claims the event type.
 */
export function findAgentToolForProgressEventType(
  eventType: string | null | undefined,
): { name: string; presentation: AgentToolPresentation } | null {
  if (!eventType) {
    return null;
  }
  for (const tool of allAgentTools()) {
    const presentation = tool.presentation;
    if (presentation?.progressEventTypes?.includes(eventType)) {
      return { name: tool.name, presentation };
    }
  }
  return null;
}

/**
 * The capability's own turn-selection hook, if it declares one. Callers that
 * prepare a turn ask here instead of importing a capability's normalizer.
 */
export function getAgentToolTurnSelection(
  toolName: string,
): AgentToolTurnSelection | null {
  return getAgentToolDefinition(toolName)?.turnSelection ?? null;
}

/**
 * Every registered tool that regularizes its own per-turn selection. The turn
 * pipeline iterates this instead of calling capability-specific resolvers, so
 * adding a capability needs no edit there.
 */
export function agentToolTurnSelections(): readonly {
  readonly name: string;
  readonly turnSelection: AgentToolTurnSelection;
}[] {
  return allAgentTools().flatMap((tool) =>
    tool.turnSelection
      ? [{ name: tool.name, turnSelection: tool.turnSelection }]
      : [],
  );
}

/**
 * Every registered tool that has work to settle before the agent runs, paired
 * with the model kind it declared. The turn pipeline iterates this and injects
 * host services scoped to that kind, so no capability is named there.
 */
export function agentToolTurnPreflights(): readonly {
  readonly name: string;
  readonly modelKind: string | null;
  readonly defaultEnabled: boolean;
  readonly turnPreflight: AgentToolTurnPreflight;
}[] {
  return allAgentTools().flatMap((tool) =>
    tool.turnPreflight
      ? [
          {
            name: tool.name,
            modelKind: getAgentToolRequirements(tool)?.modelKind ?? null,
            defaultEnabled: tool.activation.default === "always",
            turnPreflight: tool.turnPreflight,
          },
        ]
      : [],
  );
}

/**
 * The preflight hook a single tool declares, if any. Callers holding a tool
 * name — a streaming tool call, a bind-time lookup — ask here instead of
 * importing the capability that owns the name.
 */
export function getAgentToolTurnPreflight(
  toolName: string,
): AgentToolTurnPreflight | null {
  return getAgentToolDefinition(toolName)?.turnPreflight ?? null;
}

/**
 * Every annotation a capability contributes to model-catalog rows of the given
 * model kind. The catalog builder folds these into a row's `capabilities`
 * record without knowing what any of them mean.
 */
export function agentToolModelCatalogAnnotations(
  modelKind: string,
): readonly AgentToolModelCatalogAnnotation[] {
  return allAgentTools().flatMap((tool) =>
    tool.modelCatalog && getAgentToolRequirements(tool)?.modelKind === modelKind
      ? [tool.modelCatalog]
      : [],
  );
}

/**
 * The artifact-block key a tool renders its finished result as, or null when
 * the tool has no special artifact rendering (it shows as a plain tool card).
 * Callers use presence to decide "artifact block vs tool block" and the value
 * to pick a body renderer — without knowing which capabilities exist.
 */
export function getAgentToolRenderAs(toolName: string): string | null {
  return getAgentToolDefinition(toolName)?.presentation?.renderAs ?? null;
}
