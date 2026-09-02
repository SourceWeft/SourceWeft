/**
 * Titles, input metadata and output metadata for the web tool family, read back
 * out of the XML-ish envelope the web tools return.
 */
import { toObjectRecord } from "../../../../../shared/records";
import { hasAgentToolCapability } from "@sourceweft/agent-tool-registry";
import { extractToolOutputText } from "./json";
import { extractWebToolError } from "./shared";

export function extractWebFetchUrls(input: Record<string, unknown>) {
  const items = input.items;
  if (!Array.isArray(items)) {
    return [] as string[];
  }

  return items
    .map((item) => {
      const record = toObjectRecord(item);
      return typeof record?.url === "string" ? record.url.trim() : "";
    })
    .filter((url) => url.length > 0)
    .slice(0, 5);
}

export function getWebToolStartTitle(toolName: string) {
  if (hasAgentToolCapability(toolName, "web_query")) {
    return "Searching the web";
  }
  if (hasAgentToolCapability(toolName, "web_page_fetch")) {
    return "Fetching web pages";
  }
  return null;
}

export function getWebToolEndTitle(toolName: string) {
  if (hasAgentToolCapability(toolName, "web_query")) {
    return "Searched the web";
  }
  if (hasAgentToolCapability(toolName, "web_page_fetch")) {
    return "Fetched web pages";
  }
  return null;
}

export function getWebToolInputMetadata(
  toolName: string,
  input: Record<string, unknown>,
) {
  if (hasAgentToolCapability(toolName, "web_query")) {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const fresh = input.fresh === true;
    return {
      ...(query ? { query } : {}),
      ...(fresh ? { fresh: true } : {}),
    };
  }

  if (hasAgentToolCapability(toolName, "web_page_fetch")) {
    const urls = extractWebFetchUrls(input);
    const fresh = input.fresh === true;
    return {
      urlCount: urls.length,
      ...(fresh ? { fresh: true } : {}),
    };
  }

  return {};
}

export function getWebToolMetadata(output: unknown) {
  const outputText = extractToolOutputText(output);
  const metadata: Record<string, unknown> = {};
  if (!outputText) {
    return metadata;
  }

  const webResultMatches = outputText.match(/<web_result /g);
  const webPageMatches = outputText.match(/<web_page /g);
  const toolErrorMatches = outputText.match(/<web_tool_error /g);
  if (webResultMatches) {
    metadata.resultCount = webResultMatches.length;
  }
  if (toolErrorMatches) {
    metadata.errorCount = toolErrorMatches.length;
  }
  if (webPageMatches) {
    metadata.resultCount = webPageMatches.length;
    metadata.pageCount = webPageMatches.length;
    const errorMatches = outputText.match(/<web_page [^>]* error=/g);
    if (errorMatches) {
      metadata.errorCount = errorMatches.length;
      metadata.successCount = Math.max(
        0,
        webPageMatches.length - errorMatches.length,
      );
    }
  }
  metadata.truncated = outputText.includes("truncated='true'");
  return metadata;
}

export function getWebToolOutputError(output: unknown) {
  const record = toObjectRecord(output);
  if (
    record &&
    typeof record.error === "string" &&
    record.error.trim().length > 0
  ) {
    return record.error.trim();
  }
  const pages = Array.isArray(record?.pages) ? record.pages : [];
  if (pages.length > 0) {
    const pageErrors = pages
      .map((page) => {
        const pageRecord = toObjectRecord(page);
        const error = pageRecord?.error;
        return typeof error === "string" && error.trim().length > 0
          ? error.trim()
          : null;
      })
      .filter((error): error is string => error !== null);
    if (pageErrors.length === pages.length) {
      return pageErrors[0] ?? "Web tool failed.";
    }
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return null;
  }

  return extractWebToolError(outputText)?.error ?? null;
}
