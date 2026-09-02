/**
 * Private helpers shared by more than one sibling module in this directory.
 *
 * Nothing here is part of the `output-normalizer` public surface — the barrel
 * deliberately does not re-export this file. Helpers land here only when two
 * sibling modules both need them, so that neither has to import the other.
 */
import { isArtifactProgressOutputType } from "@sourceweft/agent-tool-registry";

function decodeXmlAttribute(value: string) {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function extractXmlAttributes(value: string) {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([a-zA-Z_][\w:-]*)='([^']*)'/g)) {
    const key = match[1];
    const rawValue = match[2];
    if (key && rawValue !== undefined) {
      attributes[key] = decodeXmlAttribute(rawValue);
    }
  }
  return attributes;
}

/**
 * Whether a structured tool output belongs to a capability that reports
 * artifact progress. The registry owns which `type` values those are — the
 * capability declares them alongside its progress protocol — so this stays
 * true for any deliverable added later.
 */
export function isArtifactProgressToolOutputRecord(
  record: Record<string, unknown>,
) {
  return isArtifactProgressOutputType(
    typeof record.type === "string" ? record.type.trim().toLowerCase() : "",
  );
}

export function extractWebToolError(outputText: string) {
  const match = outputText.match(/<web_tool_error\b([^>]*)>/);
  if (!match) {
    return null;
  }
  const attributes = extractXmlAttributes(match[1] ?? "");
  const error = attributes.error?.trim();
  if (!error) {
    return null;
  }
  const query = attributes.query?.trim();
  return {
    error,
    ...(query ? { query } : {}),
  };
}
