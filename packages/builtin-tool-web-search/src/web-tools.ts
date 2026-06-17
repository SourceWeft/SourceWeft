import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "@sourceweft/contracts/agent-tools";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import { addFetchCitation, addSearchCitation } from "./citations";
import {
  compactWhitespace,
  formatWebFetchResults,
  formatWebSearchFailure,
  formatWebSearchResults,
  normalizeToolFailureMessage,
} from "./format";
import type { CreateWebToolsInput, WebToolRuntime } from "./types";

const WEB_SEARCH_QUERY_MAX_CHARS = 240;
const WEB_SEARCH_LIMIT_DEFAULT = 10;
const WEB_FETCH_MAX_ITEMS = 5;

export function createWebTools(
  input: CreateWebToolsInput,
): readonly WebToolRuntime[] {
  const webSearchTool = tool(
    async (
      args: {
        readonly query: string;
        readonly fresh?: boolean;
        readonly lang?: string;
        readonly country?: string;
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
        query: search.query,
        results,
      });
    },
    {
      name: WEB_SEARCH_TOOL_NAME,
      description:
        `Search the public web for real-time, current, or external information. Use specific, descriptive search terms. Search results include titles, snippets, URLs, citations, and may include extracted main page content. Set fresh=true for current, latest, live, today, or otherwise time-sensitive searches; omit it when cached search content is acceptable. Use ${WEB_FETCH_TOOL_NAME} only when search result content is insufficient, conflicting, or the user needs a specific page read in full.`,
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
        readonly fresh?: boolean;
        readonly items: readonly {
          readonly url: string;
          readonly prompt?: string;
        }[];
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

      return formatWebFetchResults({ results });
    },
    {
      name: WEB_FETCH_TOOL_NAME,
      description:
        `Fetch and read full web page content from URLs. Use when the user provides a URL, asks for full-page analysis, or ${WEB_SEARCH_TOOL_NAME} evidence is insufficient or conflicting. Set fresh=true when the page content is current, latest, live, today, or otherwise time-sensitive; omit it when cached page content is acceptable.`,
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

  return input.searchEnabled === true ? [webSearchTool, webFetchTool] : [];
}
