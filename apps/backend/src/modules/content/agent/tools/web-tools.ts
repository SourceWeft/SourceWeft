import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { AgentCitationRegistry } from "../citation-registry";
import type { WebFetchResultItem, WebProvider, WebSearchResultItem } from "../../web";

const WEB_SEARCH_QUERY_MAX_CHARS = 240;
const WEB_SEARCH_LIMIT_DEFAULT = 20;
const WEB_FETCH_MAX_ITEMS = 5;

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function addSearchCitation(input: {
  citationRegistry: AgentCitationRegistry;
  result: WebSearchResultItem;
}) {
  return input.citationRegistry.addExternal({
    origin: "web_search",
    externalUri: input.result.url,
    sourceTitle: input.result.title,
    content: input.result.markdown || input.result.snippet || input.result.title || input.result.url,
  });
}

function addFetchCitation(input: {
  citationRegistry: AgentCitationRegistry;
  result: WebFetchResultItem;
}) {
  return input.citationRegistry.addExternal({
    origin: "web_fetch",
    externalUri: input.result.url,
    sourceTitle: input.result.title,
    content: input.result.markdown || input.result.description || input.result.url,
  });
}

function formatWebSearchResults(input: {
  provider: string;
  query: string;
  results: Array<WebSearchResultItem & { citation: string }>;
}) {
  if (input.results.length === 0) {
    return `No web search results found for query: ${input.query}`;
  }

  return `Use these web search results internally. Results may include extracted main page content in addition to titles and snippets. Every factual claim from these results MUST cite the exact citation id in the form [citation:cN]. Use web_fetch only for a specific page or when the search result content is insufficient or conflicting.

${input.results
    .map((result, index) => {
      const snippet = compactWhitespace(result.snippet ?? "").slice(0, 1200);
      const markdown = compactWhitespace(result.markdown ?? "").slice(0, 6000);
      const attributes = [
        `id='${result.citation}'`,
        `rank='${index + 1}'`,
        `url='${escapeAttribute(result.url)}'`,
        `title='${escapeAttribute(result.title)}'`,
        ...(result.wordCount !== undefined ? [`word_count='${result.wordCount}'`] : []),
        ...(result.truncated !== undefined ? [`truncated='${result.truncated}'`] : []),
      ].join(" ");
      return `<web_result ${attributes}>${[
        snippet ? `<snippet>${escapeText(snippet)}</snippet>` : "",
        markdown ? `<main_content>${escapeText(markdown)}</main_content>` : "",
      ].filter(Boolean).join("\n")}</web_result>`;
    })
    .join("\n\n")}`;
}

function formatWebFetchResults(input: {
  provider: string;
  results: Array<WebFetchResultItem & { citation?: string }>;
}) {
  if (input.results.length === 0) {
    return "No web pages were fetched.";
  }

  return `Use these fetched web pages internally. Every factual claim from these pages MUST cite the exact citation id in the form [citation:cN].

${input.results
    .map((result, index) => {
      if (result.error) {
        return `<web_page rank='${index + 1}' url='${escapeAttribute(result.url)}' error='${escapeAttribute(result.error)}'></web_page>`;
      }

      return `<web_page id='${result.citation}' rank='${index + 1}' url='${escapeAttribute(result.url)}' title='${escapeAttribute(result.title ?? result.url)}' truncated='${result.truncated}'>${escapeText(result.markdown)}</web_page>`;
    })
    .join("\n\n")}`;
}

export function createWebTools(input: {
  provider: WebProvider;
  citationRegistry: AgentCitationRegistry;
}) {
  const webSearchTool = tool(
    async (
      args: {
        query: string;
        lang?: string;
        country?: string;
      },
      _runtime: ToolRuntime,
    ) => {
      const query = compactWhitespace(args.query);
      if (!query) {
        throw new Error("Search query is required.");
      }
      if (query.length > WEB_SEARCH_QUERY_MAX_CHARS) {
        throw new Error("Search query is too long. Retry with concise search terms.");
      }

      const search = await input.provider.search({
        query,
        limit: WEB_SEARCH_LIMIT_DEFAULT,
        ...(args.lang ? { lang: args.lang } : {}),
        ...(args.country ? { country: args.country } : {}),
      });
      const results = search.results.map((result) => ({
        ...result,
        citation: addSearchCitation({
          citationRegistry: input.citationRegistry,
          result,
        }).citation,
      }));

      return formatWebSearchResults({
        provider: search.provider,
        query: search.query,
        results,
      });
    },
    {
      name: "web_search",
      description:
        "Search the public web for real-time, current, or external information. Use specific, descriptive search terms. Search results include titles, snippets, URLs, citations, and may include extracted main page content. Use web_fetch only when search result content is insufficient, conflicting, or the user needs a specific page read in full.",
      schema: z.object({
        query: z.string().min(1).max(WEB_SEARCH_QUERY_MAX_CHARS),
        lang: z.string().min(1).max(16).optional(),
        country: z.string().min(1).max(16).optional(),
      }),
    },
  );

  const webFetchTool = tool(
    async (
      args: {
        items: Array<{
          url: string;
          prompt?: string;
        }>;
      },
      _runtime: ToolRuntime,
    ) => {
      const items = args.items.slice(0, WEB_FETCH_MAX_ITEMS);
      if (items.length === 0) {
        throw new Error("At least one URL is required.");
      }

      const fetched = await input.provider.fetch({ items });
      const results = fetched.results.map((result) => {
        if (result.error) {
          return result;
        }
        return {
          ...result,
          citation: addFetchCitation({
            citationRegistry: input.citationRegistry,
            result,
          }).citation,
        };
      });

      return formatWebFetchResults({
        provider: fetched.provider,
        results,
      });
    },
    {
      name: "web_fetch",
      description:
        "Fetch and read full web page content from URLs. Use when the user provides a URL, asks for full-page analysis, or web_search evidence is insufficient or conflicting.",
      schema: z.object({
        items: z.array(z.object({
          url: z.string().url(),
          prompt: z.string().max(1000).optional(),
        })).min(1).max(WEB_FETCH_MAX_ITEMS),
      }),
    },
  );

  return [webSearchTool, webFetchTool];
}
