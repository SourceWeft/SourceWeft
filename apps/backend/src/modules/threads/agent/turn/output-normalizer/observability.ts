/**
 * Tool-output normalization for the observability sink.
 *
 * The per-domain normalizers below exist only to feed
 * `normalizeToolOutputForObservability`; they are the observability view of a
 * web, connector or artifact-progress output, not those domains' own logic,
 * which is why they live beside their caller rather than in `web.ts` or
 * `connector.ts`.
 */
import { toObjectRecord } from "../../../../../shared/records";
import {
  getAgentToolConnectorType,
  getArtifactProgressProtocol,
  hasAgentToolCapability,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import {
  collectToolOutputRecords,
  extractToolOutputText,
  getPublicStringField,
} from "./json";
import { redactFilesystemToolOutputForClient } from "./filesystem";
import {
  extractWebToolError,
  extractXmlAttributes,
  isArtifactProgressToolOutputRecord,
} from "./shared";

const MAX_OBSERVABLE_TOOL_CONTENT_CHARS = 8_000;

function compactObservableToolContent(value: string) {
  const sanitized = value
    .replace(/\0/g, "\uFFFD")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  if (sanitized.length <= MAX_OBSERVABLE_TOOL_CONTENT_CHARS) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_OBSERVABLE_TOOL_CONTENT_CHARS).trimEnd()}\n[Output truncated for display.]`;
}

function parseJsonObject(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    return toObjectRecord(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

/**
 * Traces of a deliverable tool keep the structured progress record itself, not
 * the wrapper it arrived in, so observability shows what the capability said.
 */
function normalizeArtifactProgressToolOutputForObservability(
  output: unknown,
): unknown {
  const records = collectToolOutputRecords(output);
  for (const record of records) {
    if (isArtifactProgressToolOutputRecord(record)) {
      return record;
    }
  }
  return output;
}

export function normalizeToolOutputForObservability(
  toolName: string,
  output: unknown,
  input?: Record<string, unknown>,
) {
  const redactedOutput = redactFilesystemToolOutputForClient(
    toolName,
    input,
    output,
  );
  if (redactedOutput !== output) {
    return redactedOutput;
  }

  // The collapsing below is defined by the artifact-progress protocol, so every
  // pipeline-backed capability should get it, not just the first one that did.
  if (getArtifactProgressProtocol(toolName)) {
    return normalizeArtifactProgressToolOutputForObservability(output);
  }

  if (isAgentToolDomain(toolName, "web")) {
    return normalizeWebToolOutput(toolName, output);
  }

  if (isAgentToolDomain(toolName, "connector")) {
    return normalizeConnectorToolOutput(toolName, output);
  }

  if (!hasAgentToolCapability(toolName, "read_tool_output")) {
    return output;
  }

  const outputText = extractToolOutputText(output);
  if (outputText) {
    return { content: compactObservableToolContent(outputText) };
  }

  const record = toObjectRecord(output);
  if (typeof record?.error === "string") {
    return { error: compactObservableToolContent(record.error) };
  }

  return output;
}

function normalizeWebToolOutput(toolName: string, output: unknown) {
  if (!isAgentToolDomain(toolName, "web")) {
    return output;
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return output;
  }

  const urls = [...outputText.matchAll(/url='([^']+)'/g)]
    .map((match) => match[1])
    .filter((url): url is string => typeof url === "string");
  const webResultMatches = outputText.match(/<web_result /g);
  const webPageMatches = outputText.match(/<web_page /g);
  const errorMatches = outputText.match(/<web_page [^>]* error=/g);
  const toolError = extractWebToolError(outputText);
  const pages = extractWebToolPages(outputText);

  return {
    ...(webResultMatches ? { resultCount: webResultMatches.length } : {}),
    ...(webPageMatches ? { pageCount: webPageMatches.length } : {}),
    ...(errorMatches || toolError
      ? { errorCount: (errorMatches?.length ?? 0) + (toolError ? 1 : 0) }
      : {}),
    ...(toolError ? { error: toolError.error, query: toolError.query } : {}),
    urlCount: urls.length,
    urls: urls.slice(0, 10),
    ...(pages.length > 0 ? { pages } : {}),
    truncated: outputText.includes("truncated='true'"),
  };
}

function extractWebToolPages(outputText: string) {
  return [...outputText.matchAll(/<(web_result|web_page)\b([^>]*)>/g)]
    .map((match) => {
      const tagName = match[1];
      const attributesText = match[2] ?? "";
      const attributes = extractXmlAttributes(attributesText);
      const url = attributes.url?.trim();
      if (!url) {
        return null;
      }

      const rank = Number(attributes.rank);
      const wordCount = Number(attributes.word_count);
      const title = attributes.title?.trim();
      const error = attributes.error?.trim();
      return {
        url,
        ...(title ? { title } : {}),
        ...(Number.isFinite(rank) ? { rank } : {}),
        ...(attributes.id ? { citation: attributes.id } : {}),
        ...(Number.isFinite(wordCount) ? { wordCount } : {}),
        ...(error ? { error } : {}),
        ...(attributes.truncated === "true" ? { truncated: true } : {}),
        hasContent: tagName === "web_page" || Number.isFinite(wordCount),
      };
    })
    .filter((page): page is NonNullable<typeof page> => page !== null)
    .slice(0, 20);
}

function normalizeConnectorToolOutput(toolName: string, output: unknown) {
  const record = toObjectRecord(output);
  const outputText = extractToolOutputText(output);
  const parsedTextRecord = outputText ? parseJsonObject(outputText) : null;
  const publicRecord = parsedTextRecord ?? record;
  if (publicRecord?.type === "connector_tool_error") {
    return publicRecord;
  }
  if (publicRecord?.type === "tool_confirmation_request") {
    return sanitizeToolConfirmationForObservability(publicRecord);
  }

  const actionType = getPublicStringField(publicRecord, "actionType");
  const outputToolName =
    getPublicStringField(publicRecord, "toolName") ?? toolName;
  const title = getPublicStringField(publicRecord, "title");
  const url = getPublicStringField(publicRecord, "url");
  const pageId = getPublicStringField(publicRecord, "pageId");
  const query = getPublicStringField(publicRecord, "query");
  const resultCount =
    typeof publicRecord?.resultCount === "number" &&
    Number.isFinite(publicRecord.resultCount)
      ? publicRecord.resultCount
      : null;
  const pages = normalizeConnectorPageSummaries(publicRecord?.pages);
  const connectorType =
    getAgentToolConnectorType(toolName) ??
    getAgentToolConnectorType(outputToolName) ??
    "connector";
  return {
    type: "connector_tool_result",
    connector: connectorType,
    toolName: outputToolName,
    ...(actionType ? { actionType } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(pageId ? { pageId } : {}),
    ...(query ? { query } : {}),
    ...(resultCount !== null ? { resultCount } : {}),
    ...(pages.length > 0 ? { pages } : {}),
  };
}

function normalizeConnectorPageSummaries(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = toObjectRecord(item);
      if (!record) {
        return null;
      }
      const pageId =
        typeof record.pageId === "string" && record.pageId.trim().length > 0
          ? record.pageId.trim()
          : null;
      const title =
        typeof record.title === "string" && record.title.trim().length > 0
          ? record.title.trim()
          : null;
      const url =
        typeof record.url === "string" && record.url.trim().length > 0
          ? record.url.trim()
          : null;
      const lastEditedTime =
        typeof record.lastEditedTime === "string" &&
        record.lastEditedTime.trim().length > 0
          ? record.lastEditedTime.trim()
          : null;
      if (!pageId && !title && !url) {
        return null;
      }
      return {
        ...(pageId ? { pageId } : {}),
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
        ...(lastEditedTime ? { lastEditedTime } : {}),
      };
    })
    .filter((item): item is Record<string, string> => item !== null);
}

function sanitizeToolConfirmationForObservability(
  confirmation: Record<string, unknown>,
) {
  const preview = toObjectRecord(confirmation.preview);
  const sanitized = {
    ...confirmation,
    preview: preview
      ? Object.fromEntries(
          Object.entries(preview).filter(([key]) => key !== "requestJson"),
        )
      : confirmation.preview,
  } as Record<string, unknown>;
  delete sanitized.editableArgs;
  return sanitized;
}
