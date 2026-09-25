import { type ToolConfirmationRequest } from "@sourceweft/sdk";
import type { useTranslations } from "next-intl";
import { getAgentToolSlashCommand } from "@sourceweft/agent-tool-registry";
import { compactText } from "./message-assets";

type Translate = ReturnType<typeof useTranslations>;

type ToolConfirmationDisplayInput = Pick<
  ToolConfirmationRequest,
  "action" | "preview" | "editableArgs"
>;

export function gmailSendReview(confirmation: ToolConfirmationDisplayInput) {
  if (confirmation.action.type !== "gmail.message.send") return null;
  const request = record(confirmation.preview.requestJson);
  const recipients = (value: unknown) =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value.join(", ")
      : null;
  const from = typeof request.from === "string" ? request.from : null;
  const to = recipients(request.to);
  const cc = recipients(request.cc);
  const bcc = recipients(request.bcc);
  const subject = typeof request.subject === "string" ? request.subject : null;
  const body = typeof request.body === "string" ? request.body : null;
  if (!from || !to || !subject || !body) return null;
  return { from, to, cc, bcc, subject, body };
}

function formatBytes(value: unknown, t: Translate) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return t("toolConfirmation.detail.sizeNotProvided");
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

function sandboxRiskLine(confirmation: ToolConfirmationDisplayInput, t: Translate) {
  return t("toolConfirmation.detail.risk", {
    level: titleCase(confirmation.action.riskLevel ?? "unknown"),
  });
}

function sandboxPrepareDetailLines(
  confirmation: ToolConfirmationDisplayInput,
  t: Translate,
) {
  const request = record(confirmation.preview.requestJson);
  const files = arrayRecord(request.files);
  const fileCount = files.length || 0;
  const lines = [
    sandboxRiskLine(confirmation, t),
    fileCount === 1
      ? t("toolConfirmation.detail.prepareFile", { count: fileCount })
      : t("toolConfirmation.detail.prepareFiles", { count: fileCount }),
  ];
  for (const file of files) {
    const sourcePath =
      typeof file.sourcePath === "string"
        ? file.sourcePath
        : t("toolConfirmation.detail.unknownSource");
    const sandboxPath =
      typeof file.sandboxPath === "string"
        ? file.sandboxPath
        : t("toolConfirmation.detail.unknownSandboxPath");
    lines.push(
      `${sourcePath} -> ${sandboxPath} · ${formatBytes(file.sizeBytes, t)}`,
    );
  }
  lines.push(t("toolConfirmation.detail.workfileMaterialized"));
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

function sandboxExecuteSummary(command: string, t: Translate) {
  const firstLine = command.split("\n").find((line) => line.trim().length > 0);
  const trimmed = firstLine?.trim() ?? "";
  if (trimmed.length <= 120) {
    return trimmed;
  }
  const lineCount = command.split("\n").length;
  return t("toolConfirmation.detail.execSummaryTruncated", {
    text: trimmed.slice(0, 117),
    lines: lineCount,
    chars: command.length,
  });
}

const WORKING_DIRECTORY_PREFIX_KEY =
  "toolConfirmation.detail.workingDirectoryPrefix";

function sandboxExecuteDetailLines(
  confirmation: ToolConfirmationDisplayInput,
  toolCallInput: Record<string, unknown> | undefined,
  t: Translate,
) {
  const command = sandboxExecuteCommandText({ confirmation, toolCallInput });
  const cwdRecord = record(confirmation.preview.requestJson).cwd;
  const cwd =
    typeof cwdRecord === "string" && cwdRecord
      ? cwdRecord
      : t("toolConfirmation.detail.conversationWorkingDir");
  const summary = command
    ? sandboxExecuteSummary(command, t)
    : t("toolConfirmation.detail.commandNotProvided");
  return [
    sandboxRiskLine(confirmation, t),
    t("toolConfirmation.detail.command", { summary }),
    `${t(WORKING_DIRECTORY_PREFIX_KEY)}${cwd}`,
    t("toolConfirmation.detail.reviewRisk"),
    confirmation.editableArgs
      ? t("toolConfirmation.detail.editableBeforeApproval")
      : null,
  ].filter((line): line is string => Boolean(line));
}

function sandboxCollectDetailLines(
  confirmation: ToolConfirmationDisplayInput,
  t: Translate,
) {
  const request = record(confirmation.preview.requestJson);
  const outputs = arrayRecord(request.outputs);
  const outputCount = outputs.length || 0;
  const lines = [
    sandboxRiskLine(confirmation, t),
    outputCount === 1
      ? t("toolConfirmation.detail.collectOutput", { count: outputCount })
      : t("toolConfirmation.detail.collectOutputs", { count: outputCount }),
  ];
  for (const output of outputs) {
    const target = record(output.target);
    const sandboxPath =
      typeof output.sandboxPath === "string"
        ? output.sandboxPath
        : t("toolConfirmation.detail.unknownSandboxPath");
    const targetPath =
      typeof target.path === "string"
        ? target.path
        : t("toolConfirmation.detail.unknownTarget");
    const overwrite =
      target.overwrite === true
        ? t("toolConfirmation.detail.overwriteYes")
        : t("toolConfirmation.detail.overwriteNo");
    lines.push(
      `${sandboxPath} -> ${targetPath} · ${t("toolConfirmation.detail.overwrite", { value: overwrite })} · ${formatBytes(output.sizeBytes, t)}`,
    );
  }
  lines.push(t("toolConfirmation.detail.outputsDurable"));
  return lines;
}

function sandboxRequestDetailLines(
  confirmation: ToolConfirmationDisplayInput,
  toolCallInput: Record<string, unknown> | undefined,
  t: Translate,
) {
  switch (confirmation.action.toolName) {
    case "prepare_sandbox_workspace":
      return sandboxPrepareDetailLines(confirmation, t);
    case "execute":
      return sandboxExecuteDetailLines(confirmation, toolCallInput, t);
    case "collect_sandbox_outputs":
      return sandboxCollectDetailLines(confirmation, t);
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

export function confirmationTitle(
  confirmation: ToolConfirmationDisplayInput,
  t: Translate,
) {
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
    t("toolConfirmation.detail.toolAction")
  );
}

export function requestSummary(
  confirmation: ToolConfirmationDisplayInput,
  t: Translate,
) {
  const summary = confirmation.preview.summary ?? confirmation.preview.title;
  if (!summary) {
    return null;
  }
  const actionPrefix = `${confirmation.action.type} on `;
  if (summary.startsWith(actionPrefix)) {
    return t("toolConfirmation.detail.target", {
      value: summary.slice(actionPrefix.length),
    });
  }
  if (summary === `${confirmation.action.type} connector action`) {
    return null;
  }
  return summary;
}

export function requestDetailLines(
  confirmation: ToolConfirmationDisplayInput,
  toolCallInput: Record<string, unknown> | undefined,
  t: Translate,
) {
  const sandboxLines = sandboxRequestDetailLines(
    confirmation,
    toolCallInput,
    t,
  );
  if (sandboxLines) {
    const workingDirectoryPrefix = t(WORKING_DIRECTORY_PREFIX_KEY);
    return sandboxLines.map((line) =>
      line.startsWith(workingDirectoryPrefix) ? line : compactText(line, 160),
    );
  }
  const toolMetadata = confirmationToolMetadata(confirmation);
  const lines = [
    requestSummary(confirmation, t),
    confirmation.action.description ?? toolMetadata?.description,
    confirmation.preview.target?.label
      ? t("toolConfirmation.detail.target", {
          value: confirmation.preview.target.label,
        })
      : null,
  ];
  const seen = new Set<string>();
  return lines
    .map((line) => (line ? compactText(line, 160) : null))
    .filter((line): line is string => {
      if (
        !line ||
        seen.has(line) ||
        line === confirmationTitle(confirmation, t)
      ) {
        return false;
      }
      seen.add(line);
      return true;
    });
}
