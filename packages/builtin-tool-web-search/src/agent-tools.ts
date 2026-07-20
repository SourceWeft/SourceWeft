import type {
  AgentToolHostServices,
  AgentToolTurnContext,
} from "@sourceweft/contracts/agent-tools";
import { createWebTools } from "./web-tools";

/** What this capability asks of the host, taken out of the shared contract. */
type CapabilityAgentToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: Partial<
    Pick<AgentToolTurnContext, "isToolDenied" | "webAccessEnabled">
  >;
  readonly services?: Partial<
    Pick<AgentToolHostServices, "citationRegistry" | "webProvider">
  >;
};

const WEB_SEARCH_TOOL_ID = "web_search";
const WEB_FETCH_TOOL_ID = "web_fetch";

function includesTool(input: CapabilityAgentToolFactoryInput, toolId: string) {
  return !input.toolIds || input.toolIds.includes(toolId);
}

function isDenied(input: CapabilityAgentToolFactoryInput, toolId: string) {
  return input.context?.isToolDenied?.(toolId) === true;
}

export function createCapabilityAgentTools(
  input: CapabilityAgentToolFactoryInput,
) {
  const provider = input.services?.webProvider;
  const citationRegistry = input.services?.citationRegistry;
  if (!provider || !citationRegistry) {
    return { tools: [] };
  }

  const tools = createWebTools({
    provider,
    citationRegistry,
    searchEnabled:
      input.context?.webAccessEnabled === true &&
      includesTool(input, WEB_SEARCH_TOOL_ID) &&
      !isDenied(input, WEB_SEARCH_TOOL_ID),
  }).filter(
    (tool) =>
      includesTool(input, tool.name) &&
      !isDenied(input, tool.name) &&
      (tool.name !== WEB_SEARCH_TOOL_ID ||
        includesTool(input, WEB_SEARCH_TOOL_ID)) &&
      (tool.name !== WEB_FETCH_TOOL_ID ||
        includesTool(input, WEB_FETCH_TOOL_ID)),
  );

  return {
    tools: tools.map((tool) => ({ tool, categories: ["web"] as const })),
  };
}
