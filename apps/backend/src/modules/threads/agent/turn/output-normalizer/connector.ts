/**
 * Reading errors back out of connector tool output, including the HITL replay
 * mismatch that has to surface as a `ContentError` rather than a tool failure.
 */
import { toObjectRecord } from "../../../../../shared/records";
import { ContentError } from "../../../../content/errors";
import { extractToolOutputText } from "./json";

function getConnectorToolErrorRecord(output: unknown) {
  const record = toObjectRecord(output);
  if (record?.type === "connector_tool_error") {
    return record;
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return null;
  }
  try {
    const parsed = JSON.parse(outputText);
    const parsedRecord = toObjectRecord(parsed);
    return parsedRecord?.type === "connector_tool_error" ? parsedRecord : null;
  } catch {
    return null;
  }
}

export function getConnectorToolOutputError(output: unknown) {
  const record = getConnectorToolErrorRecord(output);
  if (
    record &&
    typeof record.message === "string" &&
    record.message.trim().length > 0
  ) {
    return record.message.trim();
  }
  return null;
}

export function getConnectorToolOutputContentError(output: unknown) {
  const record = getConnectorToolErrorRecord(output);
  const outputText = extractToolOutputText(output) ?? "";
  if (record?.code !== "CONNECTOR_ACTION_NOT_APPROVED") {
    if (
      !outputText.includes("CONNECTOR_ACTION_NOT_APPROVED") &&
      !outputText.includes(
        "Connector action must be approved before execution",
      ) &&
      !outputText.includes(
        "Approved action was not found for this resumed tool call",
      )
    ) {
      return null;
    }
  }
  return new ContentError(
    409,
    "CONNECTOR_ACTION_APPROVAL_MISMATCH",
    "The approved connector action could not be matched during HITL replay. Please retry the latest confirmation.",
  );
}

export function getConnectorToolErrorTextContentError(errorText: string) {
  if (
    !errorText.includes("CONNECTOR_ACTION_NOT_APPROVED") &&
    !errorText.includes("Connector action must be approved before execution") &&
    !errorText.includes(
      "Approved action was not found for this resumed tool call",
    )
  ) {
    return null;
  }
  return new ContentError(
    409,
    "CONNECTOR_ACTION_APPROVAL_MISMATCH",
    "The approved connector action could not be matched during HITL replay. Please retry the latest confirmation.",
  );
}
