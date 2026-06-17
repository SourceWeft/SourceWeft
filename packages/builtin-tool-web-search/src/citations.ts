import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "@sourceweft/contracts/agent-tools";
import type {
  WebCitationRegistry,
  WebFetchResultItem,
  WebSearchResultItem,
} from "./types";

export function addSearchCitation(input: {
  readonly citationRegistry: WebCitationRegistry;
  readonly result: WebSearchResultItem;
}) {
  return input.citationRegistry.addExternal({
    origin: WEB_SEARCH_TOOL_NAME,
    externalUri: input.result.url,
    sourceTitle: input.result.title,
    content:
      input.result.markdown ||
      input.result.snippet ||
      input.result.title ||
      input.result.url,
    excerptContent:
      input.result.snippet || input.result.title || input.result.url,
    fullContent: input.result.markdown,
  });
}

export function addFetchCitation(input: {
  readonly citationRegistry: WebCitationRegistry;
  readonly result: WebFetchResultItem;
}) {
  return input.citationRegistry.addExternal({
    origin: WEB_FETCH_TOOL_NAME,
    externalUri: input.result.url,
    sourceTitle: input.result.title,
    content:
      input.result.markdown || input.result.description || input.result.url,
    excerptContent:
      input.result.description || input.result.title || input.result.url,
    fullContent: input.result.markdown,
  });
}
