import { z } from "zod";
import type { ArtifactProgressProtocol } from "../artifact-progress";
import type { AgentToolModelCatalogAnnotation } from "./model-catalog";
import type { AgentToolPresentation } from "./presentation";
import type { AgentToolTurnPreflight } from "./turn-preflight";
import type { AgentToolTurnSelection } from "./turn-selection";
import { agentToolExecutionTimeoutMsSchema } from "./timeout";

export type AgentToolDomain =
  | "filesystem"
  | "retrieval"
  | "web"
  | "artifact"
  | "connector"
  | "sandbox"
  | "interaction";

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
  modelKind?: "image" | "tts" | "vision";
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
export const agentToolExecutionScopeSchema = z.enum([
  "root_only",
  "inheritable",
]);
export type AgentToolExecutionScope = z.infer<
  typeof agentToolExecutionScopeSchema
>;

export const agentToolTerminalResultSpecSchema = z
  .object({
    kind: z.literal("committed_artifact"),
    artifactType: z.string().trim().min(1),
  })
  .strict();
export type AgentToolTerminalResultSpec = z.infer<
  typeof agentToolTerminalResultSpecSchema
>;

/**
 * Standard, host-verifiable terminal output for tools that committed an
 * artifact version. A model-authored `{ status: "ready" }` is deliberately not
 * assignable to this shape: success includes the exact version and committed
 * conversation block identities.
 */
export const committedArtifactToolResultSchema = z
  .object({
    status: z.literal("ready"),
    type: z.literal("committed_artifact_result"),
    artifactType: z.string().trim().min(1),
    artifactId: z.string().trim().min(1),
    artifactVersionId: z.string().trim().min(1),
    artifactOutputBlockId: z.string().trim().min(1),
    workflowVersion: z.string().trim().min(1),
  })
  .strict();
export type CommittedArtifactToolResult = z.infer<
  typeof committedArtifactToolResultSchema
>;
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
  /**
   * Tool-level wall-clock budget requested by this registered definition.
   * The host applies its own hard ceiling; invocation arguments cannot alter
   * this value.
   */
  executionTimeoutMs?: number;
  /**
   * Whether child Agents may inherit this tool. Definitions that omit the
   * field keep the historical behavior (`inheritable`).
   */
  executionScope?: AgentToolExecutionScope;
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
  /**
   * How the capability regularizes the user's per-turn options into its tool
   * input. Declared here — like `presentation` — so the turn pipeline can ask
   * every registered tool the same question instead of naming capabilities.
   */
  turnSelection?: AgentToolTurnSelection;
  /**
   * The asynchronous half of the same story: what the capability must settle
   * against the workspace before the agent runs. Separate from `turnSelection`
   * because it awaits host lookups instead of rewriting a record in place.
   */
  turnPreflight?: AgentToolTurnPreflight;
  /**
   * Platform-managed binaries that must be present before this tool can run.
   * Names are catalog identities resolved by the host; capabilities never
   * provide download URLs, object keys, or executable paths.
   */
  sandboxRuntimeAssets?: readonly string[];
  /**
   * What the capability contributes to model-catalog rows of its declared
   * model kind, so the catalog builder never imports a capability to describe
   * what a model of that kind can do.
   */
  modelCatalog?: AgentToolModelCatalogAnnotation;
  /** Host-verified success contract, independent from initial tool selection. */
  terminalResult?: AgentToolTerminalResultSpec;
};

export type DefinedAgentTool<Tool extends AgentToolDefinitionShape> = Omit<
  Tool,
  "executionScope"
> & {
  readonly executionScope: Tool["executionScope"] extends AgentToolExecutionScope
    ? Tool["executionScope"]
    : "inheritable";
};

export function resolveAgentToolExecutionScope(
  tool: Pick<AgentToolDefinitionShape, "executionScope">,
): AgentToolExecutionScope {
  return tool.executionScope ?? "inheritable";
}

export function defineAgentTool<const Tool extends AgentToolDefinitionShape>(
  tool: Tool,
): DefinedAgentTool<Tool> {
  if (tool.executionTimeoutMs !== undefined) {
    agentToolExecutionTimeoutMsSchema.parse(tool.executionTimeoutMs);
  }

  return {
    ...tool,
    executionScope: resolveAgentToolExecutionScope(tool),
  } as DefinedAgentTool<Tool>;
}
