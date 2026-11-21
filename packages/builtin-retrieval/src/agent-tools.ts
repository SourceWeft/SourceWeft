import type {
  AgentToolHostServices,
  AgentToolTurnContext,
} from "@sourceweft/contracts/agent-tools";
import { createRetrievalTool } from "./tool-runtime";

/**
 * What this capability asks of the host, taken out of the shared contract
 * rather than restated here. Both halves are `Partial` because a host older
 * than this package — or a test standing one up — may pass less than the
 * contract promises; what matters is that nothing can be asked for that the
 * contract does not offer.
 */
type CapabilityAgentToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: Partial<
    Pick<AgentToolTurnContext, "isToolDenied" | "shouldBindAgentTool">
  >;
  readonly services?: Partial<Pick<AgentToolHostServices, "retrieval">>;
};

const SEARCH_SOURCES_TOOL_ID = "search_sources";

function includesTool(input: CapabilityAgentToolFactoryInput, toolId: string) {
  return !input.toolIds || input.toolIds.includes(toolId);
}

/**
 * The host hands the factory every tool id in the manifest; whether this turn
 * binds the tool is the turn's decision. Source search is on by default, but a
 * tool command turn binds only the tools its workflow names, and binding a tool
 * the turn did not select is a host error (CAPABILITY_TOOL_BINDING_UNEXPECTED).
 * A host that does not answer the question (an older one, a test) keeps the
 * default.
 */
function shouldBind(input: CapabilityAgentToolFactoryInput, toolId: string) {
  return input.context?.shouldBindAgentTool?.(toolId) ?? true;
}

export function createCapabilityAgentTools(
  input: CapabilityAgentToolFactoryInput,
) {
  const retrieval = input.services?.retrieval;
  if (
    !retrieval ||
    !includesTool(input, SEARCH_SOURCES_TOOL_ID) ||
    !shouldBind(input, SEARCH_SOURCES_TOOL_ID) ||
    input.context?.isToolDenied?.(SEARCH_SOURCES_TOOL_ID) === true
  ) {
    return { tools: [] };
  }

  return {
    tools: [
      {
        tool: createRetrievalTool({
          searchSources: retrieval.searchSources,
        }),
        categories: ["retrieval"] as const,
      },
    ],
  };
}
