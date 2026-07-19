import type { ArtifactProgressProtocol } from "../artifact-progress";
import type { AgentToolPresentation } from "./presentation";

export type AgentToolDomain =
  | "filesystem"
  | "retrieval"
  | "web"
  | "artifact"
  | "connector"
  | "sandbox";

export type AgentToolCapability =
  | "artifact"
  | "filesystem"
  | "workfile_write"
  | "generated_image_artifact"
  | "presentation_artifact"
  | "video_presentation_artifact"
  | "pattern_scope"
  | "oversized_current_turn"
  | "read_tool_output"
  | "retrieval"
  | "citable_source"
  | "connector"
  | "notion"
  | "connector_write"
  | "connector_read"
  | "web"
  | "web_page_fetch"
  | "web_query"
  | "sandbox"
  | "sandbox_execute"
  | "sandbox_file_transfer"
  // Allow any string for dynamically registered connector types (e.g. "slack").
  // TypeScript preserves autocomplete for the known literals listed above.
  | string;

export type AgentToolRequirements = {
  provider?: "web";
  modelKind?: "image" | "tts";
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

export type AgentToolDefaultPermission = "allow" | "ask" | "deny";
export type AgentToolRiskLevel = "low" | "medium" | "high";
export type GlobalIconName = string;
export type GlobalIconTone = "brand" | "mono";

export type AgentToolSlashCommand = {
  aliases?: readonly string[];
  description?: string;
  displayName: string;
  enabled?: boolean;
  iconName?: GlobalIconName;
  iconTone?: GlobalIconTone;
  supportsCommand?: boolean;
};

export type AgentToolDefinitionShape = {
  id: string;
  name: string;
  domain: AgentToolDomain;
  capabilities: readonly AgentToolCapability[];
  requirements?: AgentToolRequirements;
  activation: AgentToolActivation;
  configuration?: AgentToolConfiguration;
  defaultPermission?: AgentToolDefaultPermission;
  riskLevel?: AgentToolRiskLevel;
  slash?: AgentToolSlashCommand;
  /**
   * Progress reading for capabilities that produce an artifact through a
   * background pipeline. Declared here rather than relied on as an excess
   * property so a typo fails the build instead of silently disabling progress.
   */
  artifactProgress?: ArtifactProgressProtocol;
  /** User-facing titles and summaries owned by the capability. */
  presentation?: AgentToolPresentation;
};

export function defineAgentTool<const Tool extends AgentToolDefinitionShape>(
  tool: Tool,
) {
  return tool;
}
