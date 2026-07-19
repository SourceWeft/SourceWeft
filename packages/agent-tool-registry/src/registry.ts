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
import type { ArtifactProgressProtocol } from "@sourceweft/contracts/artifact-progress";
import type { AgentToolPresentation } from "@sourceweft/contracts/agent-tools";
import { filesystemAgentToolDefs } from "@sourceweft/builtin-vfs";
import { webAgentToolDefs } from "@sourceweft/builtin-tool-web-search";
import { sandboxAgentToolDefs } from "@sourceweft/builtin-tool-sandbox";
import { retrievalAgentToolDefs } from "@sourceweft/builtin-retrieval";
import { generateImageAgentToolDefs } from "@sourceweft/builtin-tool-generate-image";
import { publishArtifactAgentToolDefs } from "@sourceweft/builtin-tool-publish-artifact";
import { generateVideoPresentationAgentToolDefs } from "@sourceweft/builtin-tool-video-presentation";
export const AGENT_TOOLS = [
  ...filesystemAgentToolDefs,
  ...generateImageAgentToolDefs,
  ...retrievalAgentToolDefs,
  ...webAgentToolDefs,
  ...publishArtifactAgentToolDefs,
  ...generateVideoPresentationAgentToolDefs,
  ...sandboxAgentToolDefs,
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

export const AGENT_TOOL_REGISTRY = Object.fromEntries(
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
export function registerAgentTools(
  tools: readonly AgentToolDefinitionShape[],
) {
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
  return value in AGENT_TOOL_REGISTRY || registeredTools.some((t) => t.name === value);
}

export function getAgentToolDefinition(
  name: string,
): AgentToolDefinitionShape | null {
  if (name in AGENT_TOOL_REGISTRY) return AGENT_TOOL_REGISTRY[name as AgentToolName];
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

export function isAgentToolSlashCommandSupported(value: string) {
  return getAgentToolSlashCommand(value) !== null;
}

export function isConfigurableAgentTool(value: string) {
  return getAgentToolConfiguration(getAgentToolDefinition(value))?.configurable === true;
}

export function hasAgentToolCapability(
  value: string,
  capability: AgentToolCapability,
): value is AgentToolName {
  const capabilities = getAgentToolDefinition(value)?.capabilities as
    | readonly AgentToolCapability[]
    | undefined;
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

export function agentToolNamesEnabledByDefault() {
  return allAgentTools()
    .filter((tool) => tool.activation.default === "always")
    .map((tool) => tool.name);
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
  return getAgentToolConfiguration(getAgentToolDefinition(value))?.configKeys ?? [];
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
  return (tool.artifactProgress as ArtifactProgressProtocol | undefined) ?? null;
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
  return allAgentTools().some((tool) => {
    const protocol = (tool as { artifactProgress?: ArtifactProgressProtocol })
      .artifactProgress;
    return protocol?.outputTypes.includes(type) ?? false;
  });
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
 * The artifact-block key a tool renders its finished result as, or null when
 * the tool has no special artifact rendering (it shows as a plain tool card).
 * Callers use presence to decide "artifact block vs tool block" and the value
 * to pick a body renderer — without knowing which capabilities exist.
 */
export function getAgentToolRenderAs(toolName: string): string | null {
  return getAgentToolDefinition(toolName)?.presentation?.renderAs ?? null;
}
