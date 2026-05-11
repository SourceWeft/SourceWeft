export type AgentToolDomain = "filesystem" | "retrieval" | "web" | "artifact";

export type AgentToolCapability =
  | "artifact"
  | "filesystem"
  | "workfile_write"
  | "generated_image_artifact"
  | "pattern_scope"
  | "oversized_current_turn"
  | "read_tool_output"
  | "retrieval"
  | "citable_source"
  | "web"
  | "web_page_fetch"
  | "web_query";

export type AgentToolRequirements = {
  provider?: "web";
  modelKind?: "image";
};

export type AgentToolActivation = {
  default: "always" | "off";
  userControl: "none" | "enable-disable" | "disable";
  skill: {
    declarable: boolean;
    activates: boolean;
  };
};

export type AgentToolConfiguration = {
  configurable: boolean;
  configKeys?: readonly string[];
};

export type AgentToolDefinitionShape = {
  id: string;
  name: string;
  domain: AgentToolDomain;
  capabilities: readonly AgentToolCapability[];
  requirements?: AgentToolRequirements;
  activation: AgentToolActivation;
  configuration?: AgentToolConfiguration;
};

export function defineAgentTool<const Tool extends AgentToolDefinitionShape>(
  tool: Tool,
) {
  return tool;
}
