import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "@sourceweft/contracts/agent-tools";
import type { WebFetchResultItem, WebSearchResultItem } from "./types";

export function compactWhitespace(value: string) {
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

export function normalizeToolFailureMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return fallback;
}

export function formatWebSearchResults(input: {
  readonly query: string;
  readonly results: readonly (WebSearchResultItem & { readonly citation: string })[];
}) {
  if (input.results.length === 0) {
    return `No web search results found for query: ${input.query}`;
  }

  return `Use these web search results internally. Results may include extracted main page content in addition to titles and snippets. Every factual claim from these results MUST cite the exact citation id in the form [citation:cN]. Use ${WEB_FETCH_TOOL_NAME} only for a specific page or when the search result content is insufficient or conflicting.

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

export function formatWebSearchFailure(input: {
  readonly provider: string;
  readonly query: string;
  readonly error: string;
}) {
  return `${WEB_SEARCH_TOOL_NAME} failed. Continue without web evidence if possible, or explain that live web search is currently unavailable.

<web_tool_error tool='${WEB_SEARCH_TOOL_NAME}' provider='${escapeAttribute(input.provider)}' query='${escapeAttribute(input.query)}' error='${escapeAttribute(input.error)}'></web_tool_error>`;
}

export function formatWebFetchResults(input: {
  readonly results: readonly (WebFetchResultItem & { readonly citation?: string })[];
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
