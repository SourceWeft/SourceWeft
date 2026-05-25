import {
  getAgentToolSlashCommand,
  type ToolConfirmationRequest,
} from "@sourceweft/sdk";
import { compactText } from "./message-assets";

type ToolConfirmationDisplayInput = Pick<
  ToolConfirmationRequest,
  "action" | "preview"
>;

function formatActionTypeLabel(actionType: string) {
  return (
    actionType
      .split(".")
      .at(-1)
      ?.replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase()) ?? actionType
  );
}

export function confirmationToolMetadata(
  confirmation: ToolConfirmationDisplayInput,
) {
  return getAgentToolSlashCommand(confirmation.action.toolName);
}

export function confirmationTitle(confirmation: ToolConfirmationDisplayInput) {
  const toolMetadata = confirmationToolMetadata(confirmation);
  const actionLabel = confirmation.action.label;
  const generatedActionLabel = formatActionTypeLabel(confirmation.action.type);
  if (
    toolMetadata?.displayName &&
    (actionLabel === confirmation.action.type ||
      actionLabel === generatedActionLabel)
  ) {
    return toolMetadata.displayName;
  }
  return (
    actionLabel ??
    toolMetadata?.displayName ??
    confirmation.preview.title ??
    confirmation.preview.summary ??
    "Tool action"
  );
}

export function requestSummary(confirmation: ToolConfirmationDisplayInput) {
  const summary = confirmation.preview.summary ?? confirmation.preview.title;
  if (!summary) {
    return null;
  }
  const actionPrefix = `${confirmation.action.type} on `;
  if (summary.startsWith(actionPrefix)) {
    return `Target: ${summary.slice(actionPrefix.length)}`;
  }
  if (summary === `${confirmation.action.type} connector action`) {
    return null;
  }
  return summary;
}

export function requestDetailLines(confirmation: ToolConfirmationDisplayInput) {
  const toolMetadata = confirmationToolMetadata(confirmation);
  const lines = [
    requestSummary(confirmation),
    confirmation.action.description ?? toolMetadata?.description,
    confirmation.preview.target?.label
      ? `Target: ${confirmation.preview.target.label}`
      : null,
  ];
  const seen = new Set<string>();
  return lines
    .map((line) => (line ? compactText(line, 160) : null))
    .filter((line): line is string => {
      if (!line || seen.has(line) || line === confirmationTitle(confirmation)) {
        return false;
      }
      seen.add(line);
      return true;
    });
}
