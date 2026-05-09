import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { AgentCitationRegistry } from "../citation-registry";
import type {
  WebFetchResultItem,
  WebProvider,
  WebSearchResultItem,
} from "../../web";

const WEB_SEARCH_QUERY_MAX_CHARS = 240;
const WEB_SEARCH_LIMIT_DEFAULT = 10;
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

function normalizeToolFailureMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return fallback;
}

function addSearchCitation(input: {
  citationRegistry: AgentCitationRegistry;
  result: WebSearchResultItem;
}) {
  return input.citationRegistry.addExternal({
    origin: "web_search",
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

function addFetchCitation(input: {
  citationRegistry: AgentCitationRegistry;
  result: WebFetchResultItem;
}) {
  return input.citationRegistry.addExternal({
    origin: "web_fetch",
    externalUri: input.result.url,
    sourceTitle: input.result.title,
    content:
      input.result.markdown || input.result.description || input.result.url,
    excerptContent:
      input.result.description || input.result.title || input.result.url,
    fullContent: input.result.markdown,
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
      ...(result.wordCount !== undefined
        ? [`word_count='${result.wordCount}'`]
        : []),
      ...(result.truncated !== undefined
        ? [`truncated='${result.truncated}'`]
        : []),
    ].join(" ");
    return `<web_result ${attributes}>${[
      snippet ? `<snippet>${escapeText(snippet)}</snippet>` : "",
      markdown ? `<main_content>${escapeText(markdown)}</main_content>` : "",
    ]
      .filter(Boolean)
      .join("\n")}</web_result>`;
  })
  .join("\n\n")}`;
}

function formatWebSearchFailure(input: {
  provider: string;
  query: string;
  error: string;
}) {
  return `web_search failed. Continue without web evidence if possible, or explain that live web search is currently unavailable.

<web_tool_error tool='web_search' provider='${escapeAttribute(input.provider)}' query='${escapeAttribute(input.query)}' error='${escapeAttribute(input.error)}'></web_tool_error>`;
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
  searchEnabled?: boolean;
}) {
  const webSearchTool = tool(
    async (
      args: {
        query: string;
        fresh?: boolean;
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
        throw new Error(
          "Search query is too long. Retry with concise search terms.",
        );
      }

      const search = await input.provider
        .search({
          query,
          limit: WEB_SEARCH_LIMIT_DEFAULT,
          includeContent: true,
          fresh: args.fresh === true,
          ...(args.lang ? { lang: args.lang } : {}),
          ...(args.country ? { country: args.country } : {}),
        })
        .catch((error: unknown) => ({
          error: normalizeToolFailureMessage(error, "Web search failed."),
        }));
      if ("error" in search) {
        return formatWebSearchFailure({
          provider: input.provider.name,
          query,
          error: search.error,
        });
      }

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
        "Search the public web for real-time, current, or external information. Use specific, descriptive search terms. Search results include titles, snippets, URLs, citations, and may include extracted main page content. Set fresh=true for current, latest, live, today, or otherwise time-sensitive searches; omit it when cached search content is acceptable. Use web_fetch only when search result content is insufficient, conflicting, or the user needs a specific page read in full.",
      schema: z.object({
        query: z.string().min(1).max(WEB_SEARCH_QUERY_MAX_CHARS),
        fresh: z.boolean().optional(),
        lang: z.string().min(1).max(16).optional(),
        country: z.string().min(1).max(16).optional(),
      }),
    },
  );

  const webFetchTool = tool(
    async (
      args: {
        fresh?: boolean;
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

      const fetched = await input.provider
        .fetch({
          items,
          fresh: args.fresh === true,
        })
        .catch((error: unknown) => {
          const message = normalizeToolFailureMessage(
            error,
            "Failed to fetch web pages.",
          );
          return {
            provider: input.provider.name,
            count: 0,
            results: items.map((item) => ({
              url: item.url,
              markdown: "",
              wordCount: 0,
              truncated: false,
              error: message,
            })),
          };
        });
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
        "Fetch and read full web page content from URLs. Use when the user provides a URL, asks for full-page analysis, or web_search evidence is insufficient or conflicting. Set fresh=true when the page content is current, latest, live, today, or otherwise time-sensitive; omit it when cached page content is acceptable.",
      schema: z.object({
        fresh: z.boolean().optional(),
        items: z
          .array(
            z.object({
              url: z.string().url(),
              prompt: z.string().max(1000).optional(),
            }),
          )
          .min(1)
          .max(WEB_FETCH_MAX_ITEMS),
      }),
    },
  );

  return input.searchEnabled === true
    ? [webSearchTool, webFetchTool]
    : [webFetchTool];
}
