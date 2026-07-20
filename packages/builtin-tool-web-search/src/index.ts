export { webFetchAgentTool, webSearchAgentTool, webAgentToolDefs } from "./agent-tool-defs";

export const builtinWebSearchCapability = {
  id: "sourceweft/web-search",
} as const;

export { createCapabilityAgentTools } from "./agent-tools";
export { createHostWebProvider } from "./host-services";
export { createWebTools } from "./web-tools";
export { validatePublicHttpUrl } from "./url-safety";
export type {
  CreateWebToolsInput,
  WebCitationRegistry,
  WebExternalCitation,
  WebExternalCitationInput,
  WebFetchProviderInput,
  WebFetchProviderInputItem,
  WebFetchProviderResult,
  WebFetchResultItem,
  WebProvider,
  WebProviderName,
  WebSearchProviderInput,
  WebSearchProviderResult,
  WebSearchResultItem,
  WebToolRuntime,
} from "./types";
