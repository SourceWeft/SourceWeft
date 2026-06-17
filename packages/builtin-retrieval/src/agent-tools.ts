import { createRetrievalTool } from "./tool-runtime";
import type { RetrievalChunk } from "./tool-format";

type CapabilityAgentToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: {
    readonly isToolDenied?: (toolName: string) => boolean;
  };
  readonly services?: {
    readonly retrieval?: {
      readonly searchSources: (
        query: string,
        runtime?: { toolCallId?: string; toolName?: string },
      ) => Promise<RetrievalChunk[]>;
    };
  };
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
