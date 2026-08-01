import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  AgentToolHostServices,
  AgentToolTurnContext,
} from "@sourceweft/contracts/agent-tools";
import type { DiscoveredCapabilityRecord } from "@sourceweft/capability-runtime";
import type { AgentSandboxRuntimeForTurn } from "@sourceweft/builtin-tool-sandbox";
import type { AgentToolBilledGatewaySurface } from "../../../../shared/model-gateway";
import type { ContentBillingPort } from "../../../content/billing-port";
import type { LlmExecutionConfig } from "../../../content/model-gateway-audit";
import type { PreparedThreadTurn } from "../..";
import type { RunCancellationGate } from "../../run-cancellation";
import type { TraceContext } from "../../../llm-observability";
import type { ArtifactToolRuntimePromptProvider } from "../prompts/tool-prompt-provider";
import type { TurnRuntime } from "../turn/turn-runtime";
import type { FilesystemBackend } from "../turn/turn-assembly";

/**
 * The host's own binding of the shared services bag.
 *
 * Everything a capability may reach is declared in
 * `@sourceweft/contracts/agent-tools`; the only thing fixed here is which
 * gateway surface the host happens to expose, because that is the one part of
 * the bag whose request and result shapes belong to the gateway package.
 */
export type CapabilityAgentToolHostServices =
  AgentToolHostServices<AgentToolBilledGatewaySurface>;

export type CapabilityAgentToolTurnContext = AgentToolTurnContext;

export type CapabilityAgentToolCategory = "artifact" | "retrieval" | "web";

export type CapabilityAgentToolEntry =
  | StructuredToolInterface
  | {
      readonly categories?: readonly CapabilityAgentToolCategory[];
      readonly tool: StructuredToolInterface;
    };

export type CapabilityAgentToolFactoryResult =
  | readonly CapabilityAgentToolEntry[]
  | {
      readonly promptProviders?: readonly ArtifactToolRuntimePromptProvider[];
      readonly tools?: readonly CapabilityAgentToolEntry[];
    };

/**
 * What the host passes a capability's factory. `context` and `services` are the
 * named contract types rather than the untyped bags they used to be: a
 * capability that asks for something the host does not provide now fails to
 * compile in its own package instead of failing to bind at runtime.
 */
export type CapabilityAgentToolFactoryInput = {
  readonly manifest: DiscoveredCapabilityRecord["manifest"];
  readonly toolIds: readonly string[];
  readonly context: CapabilityAgentToolTurnContext;
  readonly services: CapabilityAgentToolHostServices;
};

export type CapabilityAgentToolModule = {
  readonly createCapabilityAgentTools?: (
    input: CapabilityAgentToolFactoryInput,
  ) =>
    | CapabilityAgentToolFactoryResult
    | Promise<CapabilityAgentToolFactoryResult>;
};

export type AgentTurnTool = StructuredToolInterface;

export type CapabilityAgentToolsForTurnInput = {
  readonly billing: ContentBillingPort;
  readonly llm?: LlmExecutionConfig;
  readonly prepared: PreparedThreadTurn;
  readonly filesystemBackend?: FilesystemBackend;
  readonly runtime: TurnRuntime;
  readonly sandboxRuntime: AgentSandboxRuntimeForTurn | null;
  readonly traceContext?: TraceContext;
  /**
   * Refuses capability writes once the turn is cancelled. Absent on the
   * non-durable paths that have no run to cancel; the durable worker wires it.
   */
  readonly runCancellation?: RunCancellationGate;
};

export type CapabilityAgentToolsForTurn = {
  readonly artifactTools: readonly AgentTurnTool[];
  readonly promptProviders: readonly ArtifactToolRuntimePromptProvider[];
  readonly retrievalTools: readonly AgentTurnTool[];
  readonly tools: readonly AgentTurnTool[];
  readonly webTools: readonly AgentTurnTool[];
};
