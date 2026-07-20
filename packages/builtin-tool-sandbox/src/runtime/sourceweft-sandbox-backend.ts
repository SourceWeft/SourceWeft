import type {
  EditResult,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  SandboxBackendProtocolV2,
  WriteResult,
} from "deepagents";
import {
  assertExecuteCommandPathPolicy,
  assertExecuteCwd,
  assertSandboxReadPath,
  assertSandboxWritePath,
} from "./paths";
import type {
  SandboxProvider,
  SandboxProviderPathPolicy,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
} from "./types";
import { SandboxManager } from "./sandbox-manager";
import { redactSandboxText, sandboxRequestFingerprint } from "./redaction";

const TEXT_MIME_TYPE = "text/plain";
const EXECUTE_TOOL_NAME = "execute";
const READ_FILE_BINARY_UNSUPPORTED_CODE = "READ_FILE_BINARY_UNSUPPORTED";
const MAX_RECOVERABLE_TOOL_OUTPUT_CHARS = 2_000;
const RECOVERABLE_EXECUTE_ERROR_CODES = new Set([
  "SANDBOX_EXECUTE_COMMAND_DENIED",
  "SANDBOX_EXECUTE_CWD_DENIED",
  "SANDBOX_EXECUTE_VFS_PATH_DENIED",
]);

function hasControlChars(value: string) {
  return /[\x00-\x1f\x7f]/.test(value);
}

function hasDisallowedCommandControlChars(value: string) {
  return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value);
}

function escapeControlChars(value: string) {
  return value.replace(/[\x00-\x1f\x7f]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

function normalizePath(value: string) {
  if (hasControlChars(value)) {
    return value;
  }
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const withoutTrailingSlash = absolute.replace(/\/$/g, "");
  return withoutTrailingSlash || "/";
}

function assertSandboxBackendPath(
  value: string | null | undefined,
  policy: SandboxProviderPathPolicy,
) {
  const normalized = normalizePath(value || "/");
  if (normalized === "/") {
    return normalized;
  }
  return assertSandboxReadPath(normalized, policy);
}

function sandboxPathError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rootListings(policy: SandboxProviderPathPolicy) {
  return Array.from(new Set(policy.readWriteRoots.map(normalizePath))).map(
    (root) => ({
      path: `${root}/`,
      is_dir: true,
    }),
  );
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function inferMimeType(path: string) {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown"))
    return "text/markdown";
  if (lowerPath.endsWith(".json")) return "application/json";
  if (
    lowerPath.endsWith(".js") ||
    lowerPath.endsWith(".mjs") ||
    lowerPath.endsWith(".cjs")
  )
    return "application/javascript";
  if (lowerPath.endsWith(".html")) return "text/html";
  if (lowerPath.endsWith(".css")) return "text/css";
  if (lowerPath.endsWith(".csv")) return "text/csv";
  if (lowerPath.endsWith(".xml")) return "application/xml";
  if (lowerPath.endsWith(".yaml") || lowerPath.endsWith(".yml"))
    return "application/yaml";
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg"))
    return "image/jpeg";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".pdf")) return "application/pdf";
  if (lowerPath.endsWith(".zip")) return "application/zip";
  if (lowerPath.endsWith(".tar")) return "application/x-tar";
  if (lowerPath.endsWith(".gz")) return "application/gzip";
  if (lowerPath.endsWith(".mp4")) return "video/mp4";
  if (lowerPath.endsWith(".mov")) return "video/quicktime";
  if (lowerPath.endsWith(".webm")) return "video/webm";
  if (lowerPath.endsWith(".mp3")) return "audio/mpeg";
  if (lowerPath.endsWith(".wav")) return "audio/wav";
  if (lowerPath.endsWith(".pptx"))
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return TEXT_MIME_TYPE;
}

function isTextMimeType(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml"
  );
}

function readFileBinaryUnsupportedError(path: string, mimeType: string) {
  return `${READ_FILE_BINARY_UNSUPPORTED_CODE}: ${path} is ${mimeType}. read_file only supports UTF-8 text files. Use artifact preview, media-aware inspection, or publish_artifact for binary sandbox outputs.`;
}

function parseFindLine(line: string): FileInfo | null {
  const [type, size, mtime, ...pathParts] = line.split("\t");
  const path = pathParts.join("\t");
  if (!type || !path) return null;
  const isDir = type === "d";
  return {
    path: isDir ? `${path.replace(/\/$/g, "")}/` : path,
    is_dir: isDir,
    size: Number.isFinite(Number(size)) ? Number(size) : 0,
    modified_at: Number.isFinite(Number(mtime))
      ? new Date(Number(mtime) * 1000).toISOString()
      : "",
  };
}

function globToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "::DOUBLE_STAR_SLASH::")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/::DOUBLE_STAR_SLASH::/g, "(?:.*/)?")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function performStringReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
) {
  if (oldString.length === 0) {
    return "oldString must not be empty";
  }
  if (!content.includes(oldString)) {
    return `String not found: ${oldString}`;
  }
  const occurrences = content.split(oldString).length - 1;
  if (!replaceAll && occurrences > 1) {
    return `Found ${occurrences} occurrences of oldString. Set replaceAll=true to replace all occurrences.`;
  }
  return [
    replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString),
    replaceAll ? occurrences : 1,
  ] as const;
}

function normalizeFileDataContent(
  content: string | string[] | Uint8Array,
): string | Uint8Array {
  return Array.isArray(content) ? content.join("\n") : content;
}

function replayExecuteResult(result: Record<string, unknown>) {
  return {
    output: typeof result.output === "string" ? result.output : "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
    truncated: result.truncated === true,
  };
}

function redactExecuteResult(result: {
  output: string;
  exitCode: number | null;
  truncated: boolean;
}) {
  return {
    ...result,
    output: redactSandboxText(result.output),
  };
}

function compactError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compactRecoverableToolOutput(value: string) {
  const sanitized = value
    .replace(/\0/g, "\uFFFD")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  if (sanitized.length <= MAX_RECOVERABLE_TOOL_OUTPUT_CHARS) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_RECOVERABLE_TOOL_OUTPUT_CHARS).trimEnd()}\n[Output truncated.]`;
}

function sandboxErrorCode(message: string) {
  const match = message.match(/^([A-Z0-9_]+):/u);
  return match?.[1] ?? null;
}

function recoverableExecuteErrorCode(error: unknown) {
  const code = sandboxErrorCode(compactError(error));
  return code && RECOVERABLE_EXECUTE_ERROR_CODES.has(code) ? code : null;
}

function recoverableExecuteFailureHint(errorCode: string) {
  if (errorCode === "SANDBOX_EXECUTE_COMMAND_DENIED") {
    return "Use a non-empty command without NUL bytes or unsafe control characters. Multiline shell commands are allowed.";
  }
  if (errorCode === "SANDBOX_EXECUTE_CWD_DENIED") {
    return "Use the configured sandbox workspace as the working directory, or run commands with absolute paths under the sandbox workspace.";
  }
  if (errorCode === "SANDBOX_EXECUTE_VFS_PATH_DENIED") {
    return "Create or edit /workfiles/... with SourceWeft file tools, then use prepare_sandbox_workspace to materialize it under /workspace/...; rerun execute only against /workspace/... paths.";
  }
  return "Revise the execute request before trying again.";
}

function executeOperationRequest(command: string) {
  const commandFingerprint = sandboxRequestFingerprint({ command });
  if (!hasDisallowedCommandControlChars(command)) {
    return { command, commandFingerprint };
  }
  return {
    command: escapeControlChars(command),
    commandContainsControlCharacters: true,
    commandFingerprint,
  };
}

export class SourceWeftSandboxBackend implements SandboxBackendProtocolV2 {
  readonly id: string;
  private readonly executeFailureCountsByCommand = new Map<string, number>();
  private readonly executeFailureCountsByCode = new Map<string, number>();

  constructor(
    private readonly input: {
      manager: SandboxManager;
      context: SandboxRuntimeContext;
      limits: SandboxRuntimeLimits;
      /**
       * Wall-clock timeout for every command this backend runs, already
       * resolved and clamped from a named budget by
       * `createSandboxRuntimeForTurn`.
       *
       * SECURITY: it is a constructor field, not an `execute()` option, so the
       * value is fixed for the lifetime of the backend and no argument that
       * originates in a model tool call can change it. Turning this into a
       * per-call parameter would put the sandbox holding-time limit under model
       * control.
       */
      commandTimeoutMs: number;
      toolApprovalEnabled: boolean;
    },
  ) {
    this.id = `sourceweft-sandbox:${input.context.threadId}`;
  }

  private async sandboxRef() {
    return this.input.manager.getOrCreateThreadSandbox(this.input.context);
  }

  private pathPolicy() {
    return this.input.manager.providerForSandbox().pathPolicy;
  }

  private async runInternalCommand(command: string) {
    const sandbox = await this.sandboxRef();
    const provider = this.input.manager.providerForSandbox();
    const execute = provider.executeSystem
      ? provider.executeSystem.bind(provider)
      : provider.execute.bind(provider);
    return execute({
      providerSandboxId: sandbox.providerSandboxId,
      command,
      cwd: assertExecuteCwd(undefined, provider.pathPolicy),
      timeoutMs: this.input.commandTimeoutMs,
      maxOutputChars: this.input.limits.maxOutputChars,
    });
  }

  async ls(path: string): Promise<LsResult> {
    const policy = this.pathPolicy();
    let normalized: string;
    try {
      normalized = assertSandboxBackendPath(path || "/", policy);
    } catch (error) {
      return { error: sandboxPathError(error) };
    }
    if (normalized === "/") {
      return {
        files: rootListings(policy),
      };
    }
    const result = await this.runInternalCommand(
      [
        `dir=${shellQuote(normalized)}`,
        `[ -d "$dir" ] || exit 2`,
        `find "$dir" -mindepth 1 -maxdepth 1 -exec stat -c '%F\t%s\t%Y\t%n' {} \\; | awk -F '\\t' '{type=($1=="directory"?"d":"f"); print type "\\t" $2 "\\t" $3 "\\t" $4}'`,
      ].join("; "),
    );
    if (result.exitCode !== 0) {
      return { error: `ENOENT: no such directory, ls '${normalized}'` };
    }
    return {
      files: result.output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(parseFindLine)
        .filter((file): file is FileInfo => file !== null),
    };
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    let normalized: string;
    try {
      normalized = assertSandboxBackendPath(filePath, this.pathPolicy());
    } catch (error) {
      return { error: sandboxPathError(error) };
    }
    if (normalized === "/") {
      return { error: `EISDIR: is a directory, read_file '${normalized}'` };
    }
    const mimeType = inferMimeType(normalized);
    if (!isTextMimeType(mimeType)) {
      return {
        error: readFileBinaryUnsupportedError(normalized, mimeType),
        mimeType,
      };
    }
    const startLine = Math.max(1, Math.floor(offset) + 1);
    const endLine =
      startLine + Math.max(1, Math.min(Math.floor(limit), 1000)) - 1;
    const result = await this.runInternalCommand(
      `awk 'NR>=${startLine} && NR<=${endLine} {print $0}' ${shellQuote(normalized)}`,
    );
    if (result.exitCode !== 0) {
      return { error: `ENOENT: no such file, read_file '${normalized}'` };
    }
    return { content: result.output, mimeType };
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    let normalized: string;
    try {
      normalized = assertSandboxBackendPath(filePath, this.pathPolicy());
    } catch (error) {
      return { error: sandboxPathError(error) };
    }
    if (normalized === "/") {
      return { error: `EISDIR: is a directory, read_file '${normalized}'` };
    }
    const [result] = await this.downloadFiles([normalized]);
    if (result?.error || !result?.content) {
      return { error: `ENOENT: no such file, read_file '${normalized}'` };
    }
    const mimeType = inferMimeType(normalized);
    const now = new Date().toISOString();
    return {
      data: {
        content: isTextMimeType(mimeType)
          ? new TextDecoder().decode(result.content)
          : result.content,
        mimeType,
        created_at: now,
        modified_at: now,
      },
    };
  }

  async grep(
    pattern: string,
    path: string | null = "/",
    glob?: string | null,
  ): Promise<GrepResult> {
    const policy = this.pathPolicy();
    let normalized: string;
    try {
      normalized = assertSandboxBackendPath(path || policy.defaultCwd, policy);
    } catch (error) {
      return { error: sandboxPathError(error) };
    }
    if (normalized === "/") {
      return { matches: [] };
    }
    const result = await this.runInternalCommand(
      `grep -RIn -- ${shellQuote(pattern)} ${shellQuote(normalized)} || true`,
    );
    const matcher = glob ? globToRegExp(glob) : null;
    const matches: GrepMatch[] = [];
    for (const line of result.output.trim().split("\n").filter(Boolean)) {
      const parts = line.split(":");
      if (parts.length < 3) continue;
      const filePath = parts[0] ?? "";
      const lineNo = Number(parts[1]);
      if (!filePath || !Number.isFinite(lineNo)) continue;
      if (
        matcher &&
        !matcher.test(filePath.slice(normalized.length).replace(/^\//, ""))
      ) {
        continue;
      }
      matches.push({
        path: filePath,
        line: lineNo,
        text: parts.slice(2).join(":"),
      });
      if (matches.length >= 50) break;
    }
    return { matches };
  }

  async glob(pattern: string, path = "/"): Promise<GlobResult> {
    const policy = this.pathPolicy();
    let normalized: string;
    try {
      normalized = assertSandboxBackendPath(path, policy);
    } catch (error) {
      return { error: sandboxPathError(error) };
    }
    if (normalized === "/") {
      return {
        files: rootListings(policy),
      };
    }
    const patternMatcherTargetIsAbsolute = pattern.trim().startsWith("/");
    let normalizedPattern: string;
    try {
      normalizedPattern = patternMatcherTargetIsAbsolute
        ? assertSandboxReadPath(pattern, policy)
        : pattern;
    } catch (error) {
      return { error: sandboxPathError(error) };
    }
    const result = await this.runInternalCommand(
      `find ${shellQuote(normalized)} -exec stat -c '%F\t%s\t%Y\t%n' {} \\; | awk -F '\\t' '{type=($1=="directory"?"d":"f"); print type "\\t" $2 "\\t" $3 "\\t" $4}'`,
    );
    if (result.exitCode !== 0) {
      return { error: `ENOENT: no such directory, glob '${normalized}'` };
    }
    const matcher = globToRegExp(normalizedPattern);
    return {
      files: result.output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(parseFindLine)
        .filter((file): file is FileInfo => file !== null)
        .filter((file) => {
          const target = patternMatcherTargetIsAbsolute
            ? file.path.replace(/\/$/g, "")
            : file.path.startsWith(`${normalized}/`)
              ? file.path.slice(normalized.length + 1).replace(/\/$/g, "")
              : file.path.replace(/\/$/g, "");
          return matcher.test(target);
        }),
    };
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    let normalized: string;
    try {
      normalized = assertSandboxWritePath(filePath, this.pathPolicy());
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (normalized === "/") {
      return { error: `EISDIR: is a directory, write_file '${normalized}'` };
    }
    const existing = await this.downloadFiles([normalized]);
    if (existing[0]?.content !== null && !existing[0]?.error) {
      return {
        error: `Cannot write to ${normalized} because it already exists. Read and then make an edit, or write to a new path.`,
      };
    }
    const result = await this.uploadFiles([
      [normalized, new TextEncoder().encode(content)],
    ]);
    if (result[0]?.error) {
      return { error: `Failed to write to ${normalized}: ${result[0].error}` };
    }
    return { path: normalized, filesUpdate: null };
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<EditResult> {
    let normalized: string;
    try {
      normalized = assertSandboxWritePath(filePath, this.pathPolicy());
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (normalized === "/") {
      return { error: `EISDIR: is a directory, edit_file '${normalized}'` };
    }
    const raw = await this.readRaw(normalized);
    if (raw.error || !raw.data)
      return { error: raw.error ?? `File '${normalized}' not found` };
    if (typeof raw.data.content !== "string") {
      return { error: `Cannot edit binary file '${normalized}'` };
    }
    const replaced = performStringReplacement(
      raw.data.content,
      oldString,
      newString,
      replaceAll,
    );
    if (typeof replaced === "string") {
      return { error: replaced };
    }
    const [content, occurrences] = replaced;
    const result = await this.uploadFiles([
      [normalized, new TextEncoder().encode(content)],
    ]);
    if (result[0]?.error) {
      return { error: `Failed to edit ${normalized}: ${result[0].error}` };
    }
    return { path: normalized, filesUpdate: null, occurrences };
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const sandbox = await this.sandboxRef();
    const provider = this.input.manager.providerForSandbox();
    return Promise.all(
      paths.map(async (filePath) => {
        try {
          const normalized = assertSandboxBackendPath(
            filePath,
            provider.pathPolicy,
          );
          const content = await provider.downloadFile({
            providerSandboxId: sandbox.providerSandboxId,
            sandboxPath: normalized,
          });
          return { path: filePath, content, error: null };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            message.includes("SANDBOX_READ_PATH_DENIED") ||
            message.includes("SANDBOX_FILE_PATH_DENIED")
          ) {
            return {
              path: filePath,
              content: null,
              error: "permission_denied" as const,
            };
          }
          return {
            path: filePath,
            content: null,
            error: "file_not_found" as const,
          };
        }
      }),
    );
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const sandbox = await this.sandboxRef();
    const provider: SandboxProvider = this.input.manager.providerForSandbox();
    return Promise.all(
      files.map(async ([filePath, content]) => {
        let normalized: string;
        try {
          normalized = assertSandboxWritePath(filePath, provider.pathPolicy);
        } catch {
          return { path: filePath, error: "permission_denied" as const };
        }
        try {
          const dir = normalized.slice(0, normalized.lastIndexOf("/")) || "/";
          await provider.ensureDirectory({
            providerSandboxId: sandbox.providerSandboxId,
            directory: dir,
          });
          await provider.uploadFile({
            providerSandboxId: sandbox.providerSandboxId,
            sandboxPath: normalized,
            content,
          });
          return { path: filePath, error: null };
        } catch {
          return { path: filePath, error: "permission_denied" as const };
        }
      }),
    );
  }

  private executeToolCallId(input: { toolCallId?: string | null }) {
    if (this.input.toolApprovalEnabled) {
      const approvedToolCallId =
        this.input.context.sandboxExecuteToolCallId?.trim();
      if (!approvedToolCallId) {
        throw new Error(
          "SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED: sandbox execute requires an approved stable tool call id from HITL resume metadata.",
        );
      }
      return approvedToolCallId;
    }

    const currentToolCallId = input.toolCallId?.trim();
    if (!currentToolCallId) {
      throw new Error(
        "SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED: sandbox execute requires ToolRuntime.toolCallId when sandbox tool approval is disabled.",
      );
    }
    return currentToolCallId;
  }

  private recordRecoverableExecuteFailure(input: {
    commandFingerprint: string;
    failureCode: string;
  }) {
    const commandCount =
      (this.executeFailureCountsByCommand.get(input.commandFingerprint) ?? 0) +
      1;
    const codeCount =
      (this.executeFailureCountsByCode.get(input.failureCode) ?? 0) + 1;
    this.executeFailureCountsByCommand.set(
      input.commandFingerprint,
      commandCount,
    );
    this.executeFailureCountsByCode.set(input.failureCode, codeCount);
    return Math.max(commandCount, codeCount);
  }

  private recoverableExecuteFailureResult(input: {
    command: string;
    error: unknown;
  }) {
    const message = compactError(input.error);
    const failureCode =
      recoverableExecuteErrorCode(input.error) ??
      "SANDBOX_EXECUTE_REQUEST_DENIED";
    const commandFingerprint = sandboxRequestFingerprint({
      command: input.command,
    });
    const repeatCount = this.recordRecoverableExecuteFailure({
      commandFingerprint,
      failureCode,
    });
    const output = [
      message,
      `Hint: ${recoverableExecuteFailureHint(failureCode)}`,
      `Diagnostics: toolName=${EXECUTE_TOOL_NAME} commandFingerprint=${commandFingerprint} failureCode=${failureCode} repeatCount=${repeatCount} runId=${this.input.context.runId}`,
      ...(repeatCount > 1
        ? [
            `Repeated execute input failure detected (repeatCount=${repeatCount}). Stop retrying the same command form; change the approach before calling execute again.`,
          ]
        : []),
    ].join("\n");

    return {
      commandFingerprint,
      failureCode,
      repeatCount,
      result: {
        output,
        exitCode: 1,
        truncated: false,
      },
    };
  }

  private async completeRecoverableExecuteFailure(input: {
    command: string;
    error: unknown;
    operationId: string;
    startedAt: number;
  }) {
    const failure = this.recoverableExecuteFailureResult({
      command: input.command,
      error: input.error,
    });
    await this.input.manager.completeToolOperation({
      operationId: input.operationId,
      status: "succeeded",
      result: {
        ...failure.result,
        error: failure.result.output,
        errorCode: failure.failureCode,
        failureCode: failure.failureCode,
        commandFingerprint: failure.commandFingerprint,
        repeatCount: failure.repeatCount,
        runId: this.input.context.runId,
        toolName: EXECUTE_TOOL_NAME,
        outputChars: failure.result.output.length,
      },
      durationMs: Date.now() - input.startedAt,
    });
    return failure.result;
  }

  async execute(command: string, options: { toolCallId?: string | null } = {}) {
    const startedAt = Date.now();
    const toolCallId = this.executeToolCallId(options);
    const claim = await this.input.manager.beginToolOperation({
      context: this.input.context,
      operationType: "execute",
      toolCallId,
      request: executeOperationRequest(command),
    });
    if (claim.kind === "replay") {
      return replayExecuteResult(claim.result);
    }
    let sandboxId: string | null = null;
    try {
      try {
        assertExecuteCommandPathPolicy(command);
        assertExecuteCwd(
          undefined,
          this.input.manager.providerForSandbox().pathPolicy,
        );
      } catch (error) {
        if (recoverableExecuteErrorCode(error)) {
          return await this.completeRecoverableExecuteFailure({
            command,
            error,
            operationId: claim.operationId,
            startedAt,
          });
        }
        throw error;
      }
      const sandbox = await this.input.manager.getOrCreateThreadSandbox(
        this.input.context,
      );
      sandboxId = sandbox.id;
      const result = await this.input.manager.providerForSandbox().execute({
        providerSandboxId: sandbox.providerSandboxId,
        command,
        cwd: assertExecuteCwd(
          undefined,
          this.input.manager.providerForSandbox().pathPolicy,
        ),
        timeoutMs: this.input.commandTimeoutMs,
        maxOutputChars: this.input.limits.maxOutputChars,
      });
      const redactedResult = redactExecuteResult(result);
      await this.input.manager.completeToolOperation({
        operationId: claim.operationId,
        sandboxId: sandbox.id,
        status: "succeeded",
        result: {
          output: redactedResult.output,
          exitCode: redactedResult.exitCode,
          truncated: redactedResult.truncated,
          outputChars: redactedResult.output.length,
        },
        durationMs: Date.now() - startedAt,
      });
      return redactedResult;
    } catch (error) {
      const commandFingerprint = sandboxRequestFingerprint({ command });
      const errorCode = sandboxErrorCode(compactError(error));
      await this.input.manager.completeToolOperation({
        operationId: claim.operationId,
        sandboxId,
        status: "failed",
        result: {
          error: compactRecoverableToolOutput(redactSandboxText(compactError(error))),
          ...(errorCode ? { errorCode, failureCode: errorCode } : {}),
          commandFingerprint,
          runId: this.input.context.runId,
          toolName: EXECUTE_TOOL_NAME,
        },
        durationMs: Date.now() - startedAt,
      });
      await this.input.manager
        .releaseThreadSandboxLease({
          context: this.input.context,
          reason: "sandbox_execute_runtime_error",
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
