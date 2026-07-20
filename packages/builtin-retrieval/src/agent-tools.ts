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
  readonly context?: Partial<Pick<AgentToolTurnContext, "isToolDenied">>;
  readonly services?: Partial<Pick<AgentToolHostServices, "retrieval">>;
};

const SEARCH_SOURCES_TOOL_ID = "search_sources";

function includesTool(input: CapabilityAgentToolFactoryInput, toolId: string) {
  return !input.toolIds || input.toolIds.includes(toolId);
}

export function createCapabilityAgentTools(
  input: CapabilityAgentToolFactoryInput,
) {
  const retrieval = input.services?.retrieval;
  if (
    !retrieval ||
    !includesTool(input, SEARCH_SOURCES_TOOL_ID) ||
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
