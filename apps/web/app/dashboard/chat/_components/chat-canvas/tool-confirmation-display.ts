import { type ToolConfirmationRequest } from "@sourceweft/sdk";
import { getAgentToolSlashCommand } from "@sourceweft/agent-tool-registry";
import { compactText } from "./message-assets";

type ToolConfirmationDisplayInput = Pick<
  ToolConfirmationRequest,
  "action" | "preview" | "editableArgs"
>;

function formatBytes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "size not provided";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match: string) => match.toUpperCase());
}

function record(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function arrayRecord(value: unknown) {
  return Array.isArray(value) ? value.map(record) : [];
}

function sandboxRiskLine(confirmation: ToolConfirmationDisplayInput) {
  return `Risk: ${titleCase(confirmation.action.riskLevel ?? "unknown")}`;
}

function sandboxPrepareDetailLines(confirmation: ToolConfirmationDisplayInput) {
  const request = record(confirmation.preview.requestJson);
  const files = arrayRecord(request.files);
  const lines = [
    sandboxRiskLine(confirmation),
    `Prepare ${files.length || 0} file${files.length === 1 ? "" : "s"}`,
  ];
  for (const file of files) {
    const sourcePath =
      typeof file.sourcePath === "string" ? file.sourcePath : "unknown source";
    const sandboxPath =
      typeof file.sandboxPath === "string"
        ? file.sandboxPath
        : "unknown sandbox path";
    lines.push(
      `${sourcePath} -> ${sandboxPath} · ${formatBytes(file.sizeBytes)}`,
    );
  }
  lines.push(
    "Selected SourceWeft /workfiles Workfile content will be materialized as ordinary sandbox files.",
  );
  return lines;
}

export function sandboxExecuteCommandText(input: {
  confirmation: ToolConfirmationDisplayInput;
  toolCallInput?: Record<string, unknown>;
}) {
  // The confirmation's preview.requestJson and editableArgs are stripped
  // by normalizePublicToolConfirmationOutput before reaching the client.
  // Use toolCall.input.command as the primary data source, with the
  // confirmation fields as fallback.
  const toolCommand =
    typeof input.toolCallInput?.command === "string"
      ? input.toolCallInput.command
      : null;
  if (toolCommand) {
    return toolCommand;
  }
  const request = {
    ...record(input.confirmation.preview.requestJson),
    ...record(input.confirmation.editableArgs?.value),
  };
  const command = typeof request.command === "string" ? request.command : null;
  return command;
}

function sandboxExecuteSummary(command: string) {
  const firstLine = command.split("\n").find((line) => line.trim().length > 0);
  const trimmed = firstLine?.trim() ?? "";
  if (trimmed.length <= 120) {
    return trimmed;
  }
  const lineCount = command.split("\n").length;
  return `${trimmed.slice(0, 117)}... (${lineCount} lines, ${command.length} chars)`;
}

function sandboxExecuteDetailLines(
  confirmation: ToolConfirmationDisplayInput,
  toolCallInput?: Record<string, unknown>,
) {
  const command = sandboxExecuteCommandText({ confirmation, toolCallInput });
  const cwdRecord = record(confirmation.preview.requestJson).cwd;
  const cwd =
    typeof cwdRecord === "string" && cwdRecord ? cwdRecord : "/workspace";
  const summary = command
    ? sandboxExecuteSummary(command)
    : "command not provided";
  return [
    sandboxRiskLine(confirmation),
    `Command: ${summary}`,
    `CWD: ${cwd}`,
    "Review network, dependency, and secret-access risk before approving.",
    confirmation.editableArgs ? "Editable before approval" : null,
  ].filter((line): line is string => Boolean(line));
}

function sandboxCollectDetailLines(confirmation: ToolConfirmationDisplayInput) {
  const request = record(confirmation.preview.requestJson);
  const outputs = arrayRecord(request.outputs);
  const lines = [
    sandboxRiskLine(confirmation),
    `Collect ${outputs.length || 0} output${outputs.length === 1 ? "" : "s"}`,
  ];
  for (const output of outputs) {
    const target = record(output.target);
    const sandboxPath =
      typeof output.sandboxPath === "string"
        ? output.sandboxPath
        : "unknown sandbox path";
    const targetPath =
      typeof target.path === "string" ? target.path : "unknown target";
    const overwrite = target.overwrite === true ? "yes" : "no";
    lines.push(
      `${sandboxPath} -> ${targetPath} · overwrite: ${overwrite} · ${formatBytes(output.sizeBytes)}`,
    );
  }
  lines.push(
    "Outputs become durable only after collection into /workfiles or a supported artifact path.",
  );
  return lines;
}

function sandboxRequestDetailLines(
  confirmation: ToolConfirmationDisplayInput,
  toolCallInput?: Record<string, unknown>,
) {
  switch (confirmation.action.toolName) {
    case "prepare_sandbox_workspace":
      return sandboxPrepareDetailLines(confirmation);
    case "execute":
      return sandboxExecuteDetailLines(confirmation, toolCallInput);
    case "collect_sandbox_outputs":
      return sandboxCollectDetailLines(confirmation);
    default:
      return null;
  }
}

function formatActionTypeLabel(actionType: string) {
  return (
    actionType
      .split(".")
      .at(-1)
      ?.replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (match: string) => match.toUpperCase()) ?? actionType
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

export function requestDetailLines(
  confirmation: ToolConfirmationDisplayInput,
  toolCallInput?: Record<string, unknown>,
) {
  const sandboxLines = sandboxRequestDetailLines(confirmation, toolCallInput);
  if (sandboxLines) {
    return sandboxLines.map((line) => compactText(line, 160));
  }
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
