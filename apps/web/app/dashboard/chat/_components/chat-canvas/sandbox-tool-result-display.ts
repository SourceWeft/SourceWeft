import type { ToolUIPart } from "ai";

export type SandboxToolResultDisplay = {
  code: string | null;
  message: string | null;
  ok: boolean | null;
  output: string | null;
  recoverable: boolean | null;
  status: string | null;
  totalBytes: number | null;
  filePaths: string[];
  outputPaths: string[];
  truncated: boolean | null;
  exitCode: number | null;
};

export type SandboxExecuteViewModel = {
  code: string | null;
  command: string;
  exitCode: number | null;
  message: string | null;
  output: string;
  recoverable: boolean | null;
  resultFailed: boolean;
  truncated: boolean;
};

export type SandboxTransferMapping = {
  key: string;
  sizeBytes: number | null;
  source: string;
  target: string;
};

export type SandboxTransferViewModel = {
  code: string | null;
  direction: "collect" | "prepare";
  mappings: SandboxTransferMapping[];
  message: string | null;
  recoverable: boolean | null;
  resultFailed: boolean;
  resultSucceeded: boolean;
  totalBytes: number | null;
};

export type SandboxToolResultDetail = {
  label: string;
  value: string;
};

export type SandboxToolOperationTimelineItem = {
  key: string;
  label: string;
  status: string | null;
  detail: string | null;
  duration: string | null;
  timestamp: string | null;
};

const SANDBOX_TOOL_NAMES = new Set([
  "prepare_sandbox_workspace",
  "execute",
  "collect_sandbox_outputs",
]);

const RECOVERABLE_EXECUTE_FAILURE_CODES = new Set([
  "SANDBOX_EXECUTE_COMMAND_DENIED",
  "SANDBOX_EXECUTE_CWD_DENIED",
  "SANDBOX_EXECUTE_VFS_PATH_DENIED",
  "SANDBOX_SKILL_STAGING_UNAVAILABLE",
]);

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayRecord(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(record)
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function trimmedStringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseResult(value: unknown) {
  if (typeof value !== "string") {
    const wrapper = record(value);
    const wrappedContent =
      stringValue(wrapper?.displayContent) ?? stringValue(wrapper?.content);
    if (wrappedContent) {
      try {
        const parsedContent: unknown = JSON.parse(wrappedContent);
        const parsedRecord = record(parsedContent);
        if (!parsedRecord) {
          return parsedContent;
        }
        return {
          ...parsedRecord,
          ...(Array.isArray(wrapper?.timeline)
            ? { timeline: wrapper.timeline }
            : {}),
          ...(Array.isArray(wrapper?.operations)
            ? { operations: wrapper.operations }
            : {}),
        };
      } catch {
        return value;
      }
    }
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function recoverableExecuteFailureCode(
  result: SandboxToolResultDisplay | null,
) {
  if (result?.exitCode !== 1 || !result.output) {
    return null;
  }
  const match = result.output.match(/^([A-Z0-9_]+):/u);
  const code = match?.[1] ?? null;
  return code && RECOVERABLE_EXECUTE_FAILURE_CODES.has(code) ? code : null;
}

function targetPath(value: Record<string, unknown>) {
  const target = record(value.target);
  return (
    stringValue(target?.path) ??
    stringValue(value.targetPath) ??
    stringValue(value.sandboxPath) ??
    stringValue(value.path)
  );
}

function prepareSourcePath(value: Record<string, unknown>) {
  const artifactId = stringValue(value.artifactId);
  return (
    stringValue(value.sourcePath) ??
    (artifactId ? `artifact:${artifactId}` : null) ??
    stringValue(value.path)
  );
}

function prepareSandboxPath(value: Record<string, unknown>) {
  return stringValue(value.sandboxPath) ?? stringValue(value.targetPath);
}

function formatPrepareMappingList(files: Record<string, unknown>[]) {
  if (files.length === 0) {
    return null;
  }
  const visible = files.slice(0, 3).map((file) => {
    const sourcePath = prepareSourcePath(file) ?? "unknown source";
    const sandboxPath = prepareSandboxPath(file) ?? "unknown sandbox path";
    return `${sourcePath} -> ${sandboxPath}`;
  });
  const remaining = files.length - visible.length;
  return remaining > 0
    ? `${visible.join(", ")}, +${remaining} more`
    : visible.join(", ");
}

export function parseSandboxToolResultDisplay(
  resultValue: unknown,
): SandboxToolResultDisplay | null {
  const parsed = parseResult(resultValue);
  const result = record(parsed);
  if (!result) {
    return null;
  }

  return {
    code: trimmedStringValue(result.code),
    message: trimmedStringValue(result.message),
    ok: booleanValue(result.ok),
    output: stringValue(result.output),
    recoverable: booleanValue(result.recoverable),
    status: trimmedStringValue(result.status),
    totalBytes: finiteNumber(result.totalBytes),
    filePaths: arrayRecord(result.files)
      .map(targetPath)
      .filter((path): path is string => Boolean(path)),
    outputPaths: arrayRecord(result.outputs)
      .map(targetPath)
      .filter((path): path is string => Boolean(path)),
    truncated: booleanValue(result.truncated),
    exitCode: finiteNumber(result.exitCode),
  };
}

function transferMapping(input: {
  fallbackKey: string;
  sizeBytes: number | null;
  source: string | null;
  target: string | null;
}): SandboxTransferMapping | null {
  if (!input.source && !input.target) {
    return null;
  }
  const source = input.source ?? "Unknown source";
  const target = input.target ?? "Unknown target";
  return {
    key: `${input.fallbackKey}:${source}->${target}`,
    sizeBytes: input.sizeBytes,
    source,
    target,
  };
}

function mergeTransferMappings(
  requested: SandboxTransferMapping[],
  completed: SandboxTransferMapping[],
) {
  if (requested.length === 0) {
    return completed;
  }

  const remaining = [...completed];
  const merged = requested.map((request) => {
    const matchIndex = remaining.findIndex(
      (item) =>
        (item.source === request.source && item.target === request.target) ||
        item.target === request.target,
    );
    if (matchIndex < 0) {
      return request;
    }
    const [match] = remaining.splice(matchIndex, 1);
    return {
      ...request,
      sizeBytes: match?.sizeBytes ?? request.sizeBytes,
    };
  });

  return [...merged, ...remaining];
}

export function getSandboxExecuteView(input: {
  input: unknown;
  output: unknown;
  toolName: string;
}): SandboxExecuteViewModel | null {
  if (input.toolName !== "execute") {
    return null;
  }

  const commandValue = record(input.input)?.command;
  const result = parseSandboxToolResultDisplay(input.output);
  const recoverableFailureCode = recoverableExecuteFailureCode(result);
  return {
    code: result?.code ?? recoverableFailureCode,
    command: typeof commandValue === "string" ? commandValue : "",
    exitCode: result?.exitCode ?? null,
    message: result?.message ?? null,
    output: result?.output ?? "",
    recoverable: result?.recoverable ?? (recoverableFailureCode ? true : null),
    resultFailed:
      result?.ok === false ||
      result?.status === "failed" ||
      recoverableFailureCode !== null,
    truncated: result?.truncated === true,
  };
}

export function getSandboxTransferView(input: {
  input: unknown;
  output: unknown;
  toolName: string;
}): SandboxTransferViewModel | null {
  if (
    input.toolName !== "prepare_sandbox_workspace" &&
    input.toolName !== "collect_sandbox_outputs"
  ) {
    return null;
  }

  const request = record(input.input);
  const resultRecord = record(parseResult(input.output));
  const result = parseSandboxToolResultDisplay(input.output);
  const direction =
    input.toolName === "prepare_sandbox_workspace" ? "prepare" : "collect";

  const requested = arrayRecord(
    direction === "prepare" ? request?.files : request?.outputs,
  )
    .map((item, index) =>
      transferMapping({
        fallbackKey: `requested-${index}`,
        sizeBytes: null,
        source:
          direction === "prepare"
            ? prepareSourcePath(item)
            : stringValue(item.sandboxPath),
        target:
          direction === "prepare" ? prepareSandboxPath(item) : targetPath(item),
      }),
    )
    .filter((item): item is SandboxTransferMapping => Boolean(item));

  const completed = arrayRecord(
    direction === "prepare" ? resultRecord?.files : resultRecord?.outputs,
  )
    .map((item, index) =>
      transferMapping({
        fallbackKey: `completed-${index}`,
        sizeBytes: finiteNumber(item.sizeBytes),
        source:
          direction === "prepare"
            ? prepareSourcePath(item)
            : stringValue(item.sandboxPath),
        target:
          direction === "prepare" ? prepareSandboxPath(item) : targetPath(item),
      }),
    )
    .filter((item): item is SandboxTransferMapping => Boolean(item));

  return {
    code: result?.code ?? null,
    direction,
    mappings: mergeTransferMappings(requested, completed),
    message: result?.message ?? null,
    recoverable: result?.recoverable ?? null,
    resultFailed: result?.ok === false || result?.status === "failed",
    resultSucceeded: result?.ok === true,
    totalBytes: result?.totalBytes ?? null,
  };
}

export function resolveSandboxToolUiState(input: {
  approvalState?: "approved" | "rejected";
  output: unknown;
  status: "running" | "approval_requested" | "completed" | "error";
  toolName: string;
}): ToolUIPart["state"] {
  if (input.approvalState === "rejected") {
    return "output-denied";
  }
  if (input.status === "approval_requested") {
    return "approval-requested";
  }
  if (
    input.status === "error" ||
    isSandboxToolResultFailure({
      output: input.output,
      toolName: input.toolName,
    })
  ) {
    return "output-error";
  }
  if (input.status === "completed") {
    return "output-available";
  }
  return "input-available";
}

export function isSandboxToolResultFailure(input: {
  output: unknown;
  toolName: string;
}) {
  if (!SANDBOX_TOOL_NAMES.has(input.toolName)) {
    return false;
  }
  const result = parseSandboxToolResultDisplay(input.output);
  return (
    result?.ok === false ||
    result?.status === "failed" ||
    (input.toolName === "execute" &&
      recoverableExecuteFailureCode(result) !== null)
  );
}

export function formatSandboxByteCount(value: number | null) {
  if (value === null) {
    return null;
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const kib = value / 1024;
  if (kib < 1024) {
    return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
  }
  const mib = kib / 1024;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

function formatPathList(paths: string[]) {
  if (paths.length === 0) {
    return null;
  }
  const visible = paths.slice(0, 3).join(", ");
  const remaining = paths.length - 3;
  return remaining > 0 ? `${visible}, +${remaining} more` : visible;
}

function formatSandboxFailureSummary(result: SandboxToolResultDisplay) {
  const parts = ["Failed"];
  if (result.code) {
    parts.push(result.code);
  }
  if (result.message) {
    parts.push(result.message);
  } else if (result.output) {
    parts.push(result.output);
  }
  return parts.join(" · ");
}

function appendSandboxFailureDetails(
  details: SandboxToolResultDetail[],
  result: SandboxToolResultDisplay,
) {
  if (result.ok !== false && result.status !== "failed") {
    return;
  }
  details.push({ label: "Status", value: "Failed" });
  if (result.code) {
    details.push({ label: "Code", value: result.code });
  }
  if (result.message) {
    details.push({ label: "Message", value: result.message });
  } else if (result.output) {
    details.push({ label: "Message", value: result.output });
  }
  if (result.recoverable !== null) {
    details.push({
      label: "Recoverable",
      value: result.recoverable ? "Yes" : "No",
    });
  }
}

function formatDurationMs(value: number | null) {
  if (value === null) {
    return null;
  }
  if (value < 1000) {
    return `${Math.max(1, Math.round(value))}ms`;
  }
  const seconds = value / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
}

function formatOperationLabel(value: string | null) {
  switch (value) {
    case "prepare":
    case "prepare_sandbox_workspace":
      return "Prepared workspace";
    case "execute":
      return "Executed command";
    case "collect":
    case "collect_sandbox_outputs":
      return "Collected outputs";
    case "create":
      return "Created sandbox";
    case "cleanup":
    case "delete":
      return "Cleaned up sandbox";
    default:
      return value
        ? value
            .replace(/[_-]+/g, " ")
            .replace(/\b\w/g, (match) => match.toUpperCase())
        : "Sandbox operation";
  }
}

function operationType(value: Record<string, unknown>) {
  return (
    trimmedStringValue(value.operationType) ??
    trimmedStringValue(value.type) ??
    trimmedStringValue(value.toolName)
  );
}

function operationTimestamp(value: Record<string, unknown>) {
  return (
    trimmedStringValue(value.createdAt) ??
    trimmedStringValue(value.startedAt) ??
    trimmedStringValue(value.completedAt)
  );
}

function operationDuration(value: Record<string, unknown>) {
  return finiteNumber(value.durationMs) ?? finiteNumber(value.latencyMs);
}

function plural(count: number, singular: string, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function resultDetailFromOperation(
  operation: Record<string, unknown>,
  type: string | null,
) {
  const explicitDetail =
    trimmedStringValue(operation.summary) ??
    trimmedStringValue(operation.detail) ??
    trimmedStringValue(operation.message) ??
    trimmedStringValue(operation.error);
  if (explicitDetail) {
    return explicitDetail;
  }

  const result = record(operation.result) ?? operation;
  const details: string[] = [];
  const byteCount = formatSandboxByteCount(finiteNumber(result.totalBytes));

  if (type === "prepare" || type === "prepare_sandbox_workspace") {
    const fileCount =
      finiteNumber(result.fileCount) ?? arrayRecord(result.files).length;
    if (fileCount > 0) {
      details.push(plural(fileCount, "file"));
    }
  } else if (type === "collect" || type === "collect_sandbox_outputs") {
    const outputCount =
      finiteNumber(result.outputCount) ?? arrayRecord(result.outputs).length;
    if (outputCount > 0) {
      details.push(plural(outputCount, "output"));
    }
  } else if (type === "execute") {
    const exitCode = finiteNumber(result.exitCode);
    const outputChars = finiteNumber(result.outputChars);
    if (exitCode !== null) {
      details.push(`Exit code ${exitCode}`);
    }
    if (outputChars !== null) {
      details.push(plural(outputChars, "output char"));
    }
    if (booleanValue(result.truncated)) {
      details.push("Output truncated");
    }
  }

  if (byteCount) {
    details.push(byteCount);
  }

  return details.length > 0 ? details.join(" · ") : null;
}

export function getSandboxToolResultSummary(input: {
  output: unknown;
  toolName: string;
}) {
  if (!SANDBOX_TOOL_NAMES.has(input.toolName)) {
    return null;
  }

  const result = parseSandboxToolResultDisplay(input.output);
  if (!result) {
    return null;
  }

  const parts: string[] = [];
  const byteCount = formatSandboxByteCount(result.totalBytes);

  if (result.ok === false || result.status === "failed") {
    return formatSandboxFailureSummary(result);
  }

  if (input.toolName === "prepare_sandbox_workspace") {
    parts.push(
      `Prepared ${result.filePaths.length} file${result.filePaths.length === 1 ? "" : "s"}`,
    );
    if (byteCount) {
      parts.push(byteCount);
    }
    const paths = formatPathList(result.filePaths);
    if (paths) {
      parts.push(paths);
    }
  } else if (input.toolName === "collect_sandbox_outputs") {
    parts.push(
      `Collected ${result.outputPaths.length} output${result.outputPaths.length === 1 ? "" : "s"}`,
    );
    if (byteCount) {
      parts.push(byteCount);
    }
    const paths = formatPathList(result.outputPaths);
    if (paths) {
      parts.push(paths);
    }
  } else {
    if (result.exitCode !== null) {
      parts.push(`Exit code ${result.exitCode}`);
    }
    if (result.truncated) {
      parts.push("Output truncated");
    }
    if (result.output) {
      parts.push(result.output);
    }
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

export function getSandboxToolResultDetails(input: {
  input?: unknown;
  output: unknown;
  toolName: string;
}): SandboxToolResultDetail[] {
  if (!SANDBOX_TOOL_NAMES.has(input.toolName)) {
    return [];
  }

  const result = parseSandboxToolResultDisplay(input.output);
  if (!result) {
    return [];
  }

  const details: SandboxToolResultDetail[] = [];
  const byteCount = formatSandboxByteCount(result.totalBytes);

  if (input.toolName === "prepare_sandbox_workspace") {
    const requestedFiles = arrayRecord(record(input.input)?.files);
    const inputCount = Math.max(result.filePaths.length, requestedFiles.length);
    details.push({ label: "Operation", value: "Prepared sandbox workspace" });
    appendSandboxFailureDetails(details, result);
    details.push({
      label: "Inputs",
      value: `${inputCount} file${inputCount === 1 ? "" : "s"}`,
    });
    if (byteCount) {
      details.push({ label: "Size", value: byteCount });
    }
    const paths = formatPathList(result.filePaths);
    if (paths) {
      details.push({ label: "Input paths", value: paths });
    }
    const requestedMappings = formatPrepareMappingList(requestedFiles);
    if (requestedMappings) {
      details.push({ label: "Requested transfer", value: requestedMappings });
    }
  } else if (input.toolName === "collect_sandbox_outputs") {
    details.push({ label: "Operation", value: "Collected sandbox outputs" });
    appendSandboxFailureDetails(details, result);
    details.push({
      label: "Outputs",
      value: `${result.outputPaths.length} file${result.outputPaths.length === 1 ? "" : "s"}`,
    });
    if (byteCount) {
      details.push({ label: "Size", value: byteCount });
    }
    const paths = formatPathList(result.outputPaths);
    if (paths) {
      details.push({ label: "Output paths", value: paths });
    }
  } else {
    details.push({ label: "Operation", value: "Executed sandbox command" });
    appendSandboxFailureDetails(details, result);
    if (result.exitCode !== null) {
      details.push({ label: "Exit code", value: String(result.exitCode) });
    }
    if (result.truncated !== null) {
      details.push({
        label: "Output",
        value: result.truncated ? "Truncated" : "Complete",
      });
    }
  }

  return details;
}

export function getSandboxCollectedWorkfilePaths(input: {
  output: unknown;
  toolName: string;
}) {
  if (input.toolName !== "collect_sandbox_outputs") {
    return [];
  }

  const result = parseSandboxToolResultDisplay(input.output);
  if (!result) {
    return [];
  }

  return Array.from(
    new Set(
      result.outputPaths.filter((path) => path.startsWith("/workfiles/")),
    ),
  );
}

export function getSandboxToolOperationTimeline(input: {
  output: unknown;
  toolName: string;
}): SandboxToolOperationTimelineItem[] {
  if (!SANDBOX_TOOL_NAMES.has(input.toolName)) {
    return [];
  }

  const parsed = parseResult(input.output);
  const result = record(parsed);
  if (!result) {
    return [];
  }

  const operations = arrayRecord(result.timeline);
  const fallbackOperations =
    operations.length > 0 ? operations : arrayRecord(result.operations);

  return fallbackOperations.map((operation, index) => {
    const type = operationType(operation);
    return {
      key: `${index}-${type ?? "operation"}`,
      label: formatOperationLabel(type),
      status: trimmedStringValue(operation.status),
      detail: resultDetailFromOperation(operation, type),
      duration: formatDurationMs(operationDuration(operation)),
      timestamp: operationTimestamp(operation),
    };
  });
}

function extractSandboxErrorCode(error: string) {
  const match = error.match(/\b(SANDBOX_[A-Z_]+)\b/);
  return match?.[1] ?? null;
}

const SANDBOX_SAFE_ERROR_MESSAGES: Record<string, string> = {
  SANDBOX_BINARY_OUTPUT_UNSUPPORTED:
    "This sandbox output appears to be binary. Binary output collection is not supported here yet; use a supported artifact flow when available.",
  SANDBOX_COLLECT_CONFLICT:
    "A target /workfiles file already exists. Choose a different destination or approve the operation again with overwrite enabled.",
  SANDBOX_COLLECT_PATH_DENIED:
    "The requested sandbox output path is outside the provider-allowed collection area. Use one of the sandbox collect source roots shown in the runtime instructions.",
  SANDBOX_COMMAND_TIMEOUT:
    "The sandbox command exceeded the configured timeout. Try a shorter command or split the work into smaller steps.",
  SANDBOX_DOWNLOAD_UNSUPPORTED_RESULT:
    "The sandbox returned an unsupported download result. Try collecting a plain text output file instead.",
  SANDBOX_EXECUTE_CWD_DENIED:
    "The command working directory must stay inside the provider sandbox workspace root.",
  SANDBOX_EXECUTE_COMMAND_DENIED:
    "The command was rejected before execution because it was empty or contained unsafe control characters. Revise the command and try again.",
  SANDBOX_EXECUTE_VFS_PATH_DENIED:
    "Execute commands referenced a SourceWeft VFS path that is not available in the sandbox. Create or edit Workfiles with file tools, prepare them into /workspace, then run the command against /workspace paths.",
  SANDBOX_FILE_NOT_FOUND:
    "The requested sandbox file was not found. Re-run the command or check the output path before collecting.",
  SANDBOX_SKILL_STAGING_UNAVAILABLE:
    "Skill files could not be staged into this sandbox, so /skills paths cannot be executed here. Read the skill file with file tools, save the needed content as a Workfile, prepare it into /workspace, then run that copy.",
  SANDBOX_FILE_TOO_LARGE:
    "The selected file exceeds the sandbox transfer limit. Reduce the file size or collect a smaller output.",
  SANDBOX_NOT_CONFIGURED:
    "Sandbox execution is not fully configured. Ask an operator to check the backend sandbox settings.",
  SANDBOX_NOT_FOUND_OR_EXPIRED:
    "The sandbox was not found or has expired. Retry the operation to create a fresh sandbox.",
  SANDBOX_PREPARE_PATH_DENIED:
    "Prepare requires sourcePath under SourceWeft DB-backed /workfiles and sandboxPath under a provider-allowed prepare target root.",
  SANDBOX_PROVIDER_AUTH_FAILED:
    "Sandbox credentials were rejected. Ask an operator to check the backend sandbox credentials.",
  SANDBOX_PROVIDER_ERROR:
    "The sandbox operation failed. Try again, or ask an operator to check backend sandbox logs.",
  SANDBOX_TOTAL_SIZE_EXCEEDED:
    "The selected files exceed the total sandbox transfer limit. Reduce the number or size of files and try again.",
};

export function getSandboxToolSafeErrorMessage(input: {
  error: string | null | undefined;
  toolName: string;
}) {
  if (!input.error || !SANDBOX_TOOL_NAMES.has(input.toolName)) {
    return input.error ?? null;
  }

  const code = extractSandboxErrorCode(input.error);
  if (!code) {
    const exitCodeMatch = input.error.match(
      /^Command failed with exit code -?\d+\.$/,
    );
    if (exitCodeMatch) {
      return input.error;
    }
    return "Sandbox operation failed. Review the operation details and try again.";
  }

  return (
    SANDBOX_SAFE_ERROR_MESSAGES[code] ??
    "Sandbox operation failed. Review the operation details and try again."
  );
}
