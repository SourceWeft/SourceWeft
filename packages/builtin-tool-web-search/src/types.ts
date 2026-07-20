import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  AgentToolCitationRegistry,
  AgentToolExternalCitation,
  AgentToolExternalCitationInput,
  AgentToolWebFetchInput,
  AgentToolWebFetchInputItem,
  AgentToolWebFetchResult,
  AgentToolWebFetchResultItem,
  AgentToolWebProvider,
  AgentToolWebSearchInput,
  AgentToolWebSearchResult,
  AgentToolWebSearchResultItem,
} from "@sourceweft/contracts/agent-tools";

export type WebToolRuntime = StructuredToolInterface;

export type WebProviderName = "anycrawl" | string;

/**
 * The provider and citation ports, under this package's own names.
 *
 * The declarations live in `@sourceweft/contracts` because both ends are
 * downstream of them: the host constructs the provider and owns the citation
 * ledger, this package consumes both. They were declared here first, which
 * forced the backend to import a capability package for a type it implements —
 * exactly the direction the boundary is not supposed to run.
 */
export type WebSearchProviderInput = AgentToolWebSearchInput;
export type WebSearchResultItem = AgentToolWebSearchResultItem;
export type WebSearchProviderResult = AgentToolWebSearchResult;
export type WebFetchProviderInputItem = AgentToolWebFetchInputItem;
export type WebFetchProviderInput = AgentToolWebFetchInput;
export type WebFetchResultItem = AgentToolWebFetchResultItem;
export type WebFetchProviderResult = AgentToolWebFetchResult;
export type WebProvider = AgentToolWebProvider;
export type WebExternalCitationInput = AgentToolExternalCitationInput;
export type WebExternalCitation = AgentToolExternalCitation;
export type WebCitationRegistry = AgentToolCitationRegistry;

export type CreateWebToolsInput = {
  readonly provider: WebProvider;
  readonly citationRegistry: WebCitationRegistry;
  readonly searchEnabled?: boolean;
};
