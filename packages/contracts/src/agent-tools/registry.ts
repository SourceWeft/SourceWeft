import type {
  AgentToolCapability,
  AgentToolConfiguration,
  AgentToolDefinitionShape,
  AgentToolDomain,
  AgentToolRequirements,
  AgentToolSlashCommand,
} from "./define";
import { artifactTools } from "./tools/generate-image";
import { filesystemTools } from "./tools/filesystem";
import { notionTools } from "./tools/notion";
import { retrievalTools } from "./tools/retrieval";
import { webTools } from "./tools/web";

export const AGENT_TOOLS = [
  ...filesystemTools,
  ...artifactTools,
  ...retrievalTools,
  ...webTools,
  ...notionTools,
] as const;

export type AgentToolDefinition = (typeof AGENT_TOOLS)[number];
export type AgentToolId = AgentToolDefinition["id"];
export type AgentToolName = AgentToolDefinition["name"];
export type AgentToolDomainName = AgentToolDefinition["domain"];
export type AgentToolModelKind = Extract<
  AgentToolDefinition,
  { requirements: { modelKind: string } }
>["requirements"]["modelKind"];

export type AgentToolFamily = AgentToolDomainName;
export type AgentToolTrait = AgentToolCapability;

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

export function isAgentToolName(value: string): value is AgentToolName {
  return value in AGENT_TOOL_REGISTRY;
}

export function getAgentToolDefinition(name: string) {
  return isAgentToolName(name) ? AGENT_TOOL_REGISTRY[name] : null;
}

function getAgentToolRequirements(
  tool: AgentToolDefinition,
): AgentToolRequirements | undefined {
  return "requirements" in tool ? tool.requirements : undefined;
}

function getAgentToolConfiguration(
  tool: AgentToolDefinition | null,
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

export const hasAgentToolTrait = hasAgentToolCapability;

export function isAgentToolDomain(
  value: string,
  domain: AgentToolDomain,
): value is AgentToolName {
  return getAgentToolDefinition(value)?.domain === domain;
}

export const isAgentToolFamily = isAgentToolDomain;

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
  return AGENT_TOOLS.filter(
    (tool) => tool.activation.default === "always",
  ).map((tool) => tool.name);
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
  return AGENT_TOOLS.filter((tool) =>
    (tool.capabilities as readonly AgentToolCapability[]).includes(capability),
  ).map((tool) => tool.name);
}

export const agentToolNamesByTrait = agentToolNamesByCapability;

export function agentToolRequiredForModelKind(kind: AgentToolModelKind) {
  return (
    AGENT_TOOLS.find((tool) => getAgentToolRequirements(tool)?.modelKind === kind)
      ?.name ?? null
  );
}

export function getAgentToolConfigKeys(value: string): readonly string[] {
  return getAgentToolConfiguration(getAgentToolDefinition(value))?.configKeys ?? [];
}

export function isWebToolName(value: string): value is AgentToolName {
  return isAgentToolDomain(value, "web");
}

export function isWebSearchToolName(value: string): value is AgentToolName {
  return hasAgentToolCapability(value, "web_query");
}

export function isWebFetchToolName(value: string): value is AgentToolName {
  return hasAgentToolCapability(value, "web_page_fetch");
}

export function isGeneratedImageArtifactToolName(
  value: string,
): value is AgentToolName {
  return hasAgentToolCapability(value, "generated_image_artifact");
}

export function isReadToolOutputToolName(value: string): value is AgentToolName {
  return hasAgentToolCapability(value, "read_tool_output");
}

export function isWorkfileWriteToolName(value: string): value is AgentToolName {
  return hasAgentToolCapability(value, "workfile_write");
}

export function isRetrievalToolName(value: string): value is AgentToolName {
  return isAgentToolDomain(value, "retrieval");
}

export function isPatternScopeToolName(value: string): value is AgentToolName {
  return hasAgentToolCapability(value, "pattern_scope");
}

export function isOversizedCurrentTurnToolName(
  value: string,
): value is AgentToolName {
  return hasAgentToolCapability(value, "oversized_current_turn");
}

export type { AgentToolCapability, AgentToolDefinitionShape, AgentToolDomain };
