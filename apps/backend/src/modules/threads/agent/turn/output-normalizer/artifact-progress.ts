/**
 * Reading the failure of a background deliverable back out of its
 * artifact-progress output record.
 */
import { isArtifactProgressTerminalOutputType } from "@sourceweft/agent-tool-registry";
import { extractToolOutputField } from "./json";

/**
 * The failure message of a background deliverable, if its output is a terminal
 * record reporting failure. Which `type` values are terminal is the
 * capability's business, so ask the registry rather than naming them here.
 */
export function getArtifactProgressToolOutputError(output: unknown) {
  if (output === undefined) {
    return null;
  }
  const type = extractToolOutputField(output, "type")?.toLowerCase().trim();
  const status = extractToolOutputField(output, "status")?.toLowerCase().trim();
  if (!isArtifactProgressTerminalOutputType(type) || status !== "failed") {
    return null;
  }
  const error =
    extractToolOutputField(output, "error") ??
    extractToolOutputField(output, "error_message") ??
    extractToolOutputField(output, "errorMessage");
  return error && error.trim().length > 0 ? error.trim() : null;
}
