import { createHash } from "node:crypto";
import {
  isSandboxInstanceMissingError,
  SANDBOX_REPLACED_NOTICE,
} from "./errors";
import { tool, type ToolRuntime } from "langchain";
import type { BackendProtocolV2 } from "deepagents";
import {
  collectSandboxOutputsSchema,
  buildSandboxToolDescriptions,
  prepareSandboxWorkspaceSchema,
  type CollectSandboxOutputsInput,
  type PrepareSandboxWorkspaceInput,
} from "../sandbox-tools";
import {
  PREPARE_SANDBOX_TOOL_NAME,
  COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
  resolveAgentToolHostInvocationSignal,
} from "@sourceweft/contracts/agent-tools";
import {
  assertCollectSandboxPath,
  assertPrepareSandboxPath,
  assertSourceWorkPath,
} from "./paths";
import type { SandboxRuntimeContext, SandboxRuntimeLimits } from "./types";
import { SandboxManager } from "./sandbox-manager";
import type { TrustedSandboxHostAdapter } from "./trusted-host-adapter";

function byteLength(content: string | string[] | Uint8Array) {
  if (Array.isArray(content)) {
    return Buffer.byteLength(content.join("\n"));
  }
  return typeof content === "string"
    ? Buffer.byteLength(content)
    : content.byteLength;
}

function toBytes(content: string | string[] | Uint8Array) {
  if (Array.isArray(content)) {
    return new TextEncoder().encode(content.join("\n"));
  }
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
}

function compactError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compactRecoverableToolError(error: unknown) {
  const message = compactError(error)
    .replace(/\0/g, "\uFFFD")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
  if (message.length <= 2_000) {
    return message;
  }
  return `${message.slice(0, 2_000).trimEnd()}\n[Output truncated.]`;
}

function sandboxErrorCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  const match = compactError(error).match(/^([A-Z0-9_]+):/u);
  return match?.[1] ?? "SANDBOX_TOOL_FAILED";
}

const SANDBOX_CONTROL_FLOW_ERROR_CODES = new Set([
  "SANDBOX_INSTANCE_CHANGED",
  "SANDBOX_EXECUTION_RESULT_DISCARDED",
  "SANDBOX_HOST_OPERATION_CANCELLED",
  "SANDBOX_HOST_OPERATION_TIMED_OUT",
  "SANDBOX_TERMINATION_UNKNOWN",
]);

function cancellationControlError(input: {
  error: unknown;
  signal?: AbortSignal;
}) {
  const errorCode = sandboxErrorCode(input.error);
  if (SANDBOX_CONTROL_FLOW_ERROR_CODES.has(errorCode)) {
    return input.error;
  }
  if (!input.signal?.aborted) return null;
  return (
    input.signal.reason ??
    new DOMException("Sandbox tool invocation was cancelled.", "AbortError")
  );
}

function throwIfInvocationAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw (
    signal.reason ??
    new DOMException("Sandbox tool invocation was cancelled.", "AbortError")
  );
}

class SandboxCollectUnsupportedOutputError extends Error {
  readonly code = "SANDBOX_BINARY_OUTPUT_UNSUPPORTED";

  constructor(
    message: string,
    readonly sandboxPath: string,
  ) {
    super(message);
    this.name = "SandboxCollectUnsupportedOutputError";
  }
}

function toRecoverableCollectErrorOutput(
  error: SandboxCollectUnsupportedOutputError,
) {
  return {
    ok: false,
    type: "sandbox_collect_error" as const,
    status: "failed" as const,
    code: error.code,
    message: error.message,
    sandboxPath: error.sandboxPath,
    recoverable: true as const,
  };
}

function toRecoverableSandboxToolErrorOutput(input: {
  error: unknown;
  operationType: "prepare" | "collect";
}) {
  return {
    ok: false,
    type: `sandbox_${input.operationType}_error` as const,
    status: "failed" as const,
    code: sandboxErrorCode(input.error),
    message: compactRecoverableToolError(input.error),
    recoverable: true as const,
  };
}

/**
 * The first model-visible result produced on a replacement generation
 * carries the one-shot notice: /workspace is empty again. For prepare that
 * is informational (it just refilled it); for collect it explains a missing
 * output without a misleading "file not found".
 */
function withReplacementDiagnostics<T extends Record<string, unknown>>(
  result: T,
  replaced: boolean,
): T {
  return replaced
    ? { ...result, diagnostics: `sandbox replaced. ${SANDBOX_REPLACED_NOTICE}` }
    : result;
}

function requireSandboxToolCallId(input: {
  operationType: "prepare" | "collect";
  runtime: ToolRuntime;
}) {
  const runtimeRecord = input.runtime as ToolRuntime & {
    config?: { toolCall?: { id?: unknown } };
    toolCall?: { id?: unknown };
    toolCallId?: unknown;
  };
  const candidate =
    runtimeRecord.toolCallId ??
    runtimeRecord.toolCall?.id ??
    runtimeRecord.config?.toolCall?.id;
  const toolCallId = typeof candidate === "string" ? candidate.trim() : "";
  if (!toolCallId) {
    throw new Error(
      `SANDBOX_TOOL_CALL_ID_REQUIRED: sandbox ${input.operationType} requires ToolRuntime.toolCallId for replay-safe execution.`,
    );
  }
  return toolCallId;
}

function decodeSandboxTextOutput(content: Buffer, sandboxPath: string) {
  if (content.includes(0)) {
    throw new SandboxCollectUnsupportedOutputError(
      `SANDBOX_BINARY_OUTPUT_UNSUPPORTED: ${sandboxPath} appears to be binary. Use publish_artifact with artifactType=slides for PPTX decks or artifactType=file for generic downloadable files.`,
      sandboxPath,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new SandboxCollectUnsupportedOutputError(
      `SANDBOX_BINARY_OUTPUT_UNSUPPORTED: ${sandboxPath} is not valid UTF-8 text. Use publish_artifact with artifactType=slides for PPTX decks or artifactType=file for generic downloadable files.`,
      sandboxPath,
    );
  }
}

/**
 * Reads a ready workspace artifact's primary bytes for staging into the
 * sandbox. Host-provided and workspace-scoped: the closure carries the turn's
 * team/workspace, so an artifactId from tool input can only reach rows the
 * turn could already see. Absent in runtimes that have no artifact store.
 */
export type SandboxArtifactReader = {
  /** Named files require immutable identity; private/source access is host-authorized. */
  readVersionFileBytes?(input: {
    artifactId: string;
    artifactVersionId: string;
    fileName: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<{
    bytes: Uint8Array;
    fileName: string;
    artifactVersionId: string;
    versionNo: number;
    contentDigest: string;
  } | null>;
  readPrimaryBytes(input: {
    artifactId: string;
    artifactVersionId?: string;
  }): Promise<{
    bytes: Uint8Array;
    fileName?: string;
    artifactVersionId?: string;
    versionNo?: number;
    contentDigest?: string;
  } | null>;
};

export function createSandboxTools(input: {
  filesystem: BackendProtocolV2;
  manager: SandboxManager;
  context: SandboxRuntimeContext;
  limits: SandboxRuntimeLimits;
  trustedHost: Pick<
    TrustedSandboxHostAdapter,
    "downloadCurrentFile" | "uploadCurrentFiles"
  >;
  artifacts?: SandboxArtifactReader;
}) {
  const toolDescriptions = buildSandboxToolDescriptions(
    input.manager.providerForSandbox().pathPolicy,
  );
  const prepareSandboxWorkspace = tool(
    async (args: PrepareSandboxWorkspaceInput, runtime: ToolRuntime) => {
      const signal = resolveAgentToolHostInvocationSignal(runtime);
      throwIfInvocationAborted(signal);
      const startedAt = Date.now();
      const toolCallId = requireSandboxToolCallId({
        operationType: "prepare",
        runtime,
      });
      const readNamedArtifact = async (
        file: PrepareSandboxWorkspaceInput["files"][number],
        maxBytes: number,
      ) => {
        const reader = input.artifacts?.readVersionFileBytes;
        if (!reader)
          throw new Error(
            "SANDBOX_ARTIFACT_SOURCE_UNAVAILABLE: named artifact staging is not available in this runtime.",
          );
        if (
          !file.artifactId ||
          !file.artifactVersionId ||
          !file.artifactFileName
        )
          throw new Error(
            "SANDBOX_ARTIFACT_SOURCE_INVALID: a named attachment requires artifact and version identity.",
          );
        throwIfInvocationAborted(signal);
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
          throw new Error(
            "SANDBOX_TOTAL_SIZE_EXCEEDED: no preparation budget remains for the named file.",
          );
        const result = await reader({
          artifactId: file.artifactId,
          artifactVersionId: file.artifactVersionId,
          fileName: file.artifactFileName,
          maxBytes,
          signal,
        });
        throwIfInvocationAborted(signal);
        if (!result)
          throw new Error(
            "SANDBOX_ARTIFACT_NOT_FOUND: the named version file is not available in this workspace.",
          );
        if (
          result.artifactVersionId !== file.artifactVersionId ||
          result.fileName !== file.artifactFileName
        )
          throw new Error(
            "SANDBOX_ARTIFACT_SOURCE_INVALID: the reader did not return the requested version file.",
          );
        if (
          !Number.isSafeInteger(result.versionNo) ||
          result.versionNo <= 0 ||
          !/^sha256:[a-f0-9]{64}$/.test(result.contentDigest) ||
          `sha256:${createHash("sha256").update(result.bytes).digest("hex")}` !==
            result.contentDigest
        ) {
          throw new Error(
            "SANDBOX_ARTIFACT_SOURCE_INVALID: the reader returned invalid version or digest metadata.",
          );
        }
        if (result.bytes.byteLength > maxBytes)
          throw new Error(
            "SANDBOX_FILE_TOO_LARGE: the named file exceeds the preparation limit.",
          );
        return result;
      };
      const claim = await input.manager.beginToolOperation({
        context: input.context,
        operationType: "prepare",
        toolCallId,
        request: { files: args.files },
      });
      if (claim.kind === "replay") {
        // Receipts are idempotent, but never an authorization grant for private sources.
        try {
          let replayBytes = 0;
          const receiptFiles = Array.isArray(claim.result.files)
            ? claim.result.files
            : [];
          for (const [index, file] of args.files.entries()) {
            if (!file.artifactFileName) {
              const size = receiptFiles[index]?.sizeBytes;
              if (args.files.some((item) => item.artifactFileName)) {
                if (!Number.isSafeInteger(size) || size < 0)
                  throw new Error(
                    "SANDBOX_ARTIFACT_SOURCE_INVALID: the receipt has no valid preparation size.",
                  );
                replayBytes += size;
              }
            } else {
              const result = await readNamedArtifact(
                file,
                Math.min(
                  input.limits.maxPrepareFileBytes,
                  input.limits.maxPrepareTotalBytes - replayBytes,
                ),
              );
              replayBytes += result.bytes.byteLength;
            }
            if (replayBytes > input.limits.maxPrepareTotalBytes)
              throw new Error(
                "SANDBOX_TOTAL_SIZE_EXCEEDED: prepared files exceed the preparation limit.",
              );
          }
          return JSON.stringify(claim.result);
        } catch (error) {
          const controlError = cancellationControlError({ error, signal });
          if (controlError) throw controlError;
          return JSON.stringify(
            toRecoverableSandboxToolErrorOutput({
              error,
              operationType: "prepare",
            }),
          );
        }
      }
      let sandboxId: string | null = null;
      let replaced = false;
      let totalBytes = 0;
      const prepared: Array<{
        content: Uint8Array;
        sandboxPath: string;
        sizeBytes: number;
        sourcePath: string;
        sourceArtifact?: {
          artifactId: string;
          artifactVersionId: string;
          versionNo: number;
          contentDigest?: string;
          fileName?: string;
        };
      }> = [];

      try {
        const sandbox = await input.manager.getOrCreateThreadSandbox(
          input.context,
          { ...(signal ? { signal } : {}) },
        );
        sandboxId = sandbox.id;
        replaced = input.manager.consumeReplacementNotice();
        for (const file of args.files) {
          throwIfInvocationAborted(signal);
          const sandboxPath = assertPrepareSandboxPath(
            file.sandboxPath,
            input.manager.providerForSandbox().pathPolicy,
          );
          let content: Uint8Array;
          let sourceLabel: string;
          let sourceArtifact:
            | {
                artifactId: string;
                artifactVersionId: string;
                versionNo: number;
                contentDigest?: string;
                fileName?: string;
              }
            | undefined;
          if (file.artifactId) {
            const reader = input.artifacts?.readPrimaryBytes;
            if (!file.artifactFileName && !reader) {
              throw new Error(
                "SANDBOX_ARTIFACT_SOURCE_UNAVAILABLE: artifact staging is not available in this runtime.",
              );
            }
            const artifact = file.artifactFileName
              ? await readNamedArtifact(
                  file,
                  Math.min(
                    input.limits.maxPrepareFileBytes,
                    input.limits.maxPrepareTotalBytes - totalBytes,
                  ),
                )
              : await reader!({
                  artifactId: file.artifactId,
                  ...(file.artifactVersionId
                    ? { artifactVersionId: file.artifactVersionId }
                    : {}),
                });
            throwIfInvocationAborted(signal);
            if (!artifact) {
              throw new Error(
                `SANDBOX_ARTIFACT_NOT_FOUND: ${file.artifactId} is not a ready artifact in this workspace.`,
              );
            }
            content = artifact.bytes;
            if (artifact.artifactVersionId && artifact.versionNo !== undefined)
              sourceArtifact = {
                artifactId: file.artifactId,
                artifactVersionId: artifact.artifactVersionId,
                versionNo: artifact.versionNo,
                contentDigest: artifact.contentDigest,
                ...(artifact.fileName ? { fileName: artifact.fileName } : {}),
              };
            sourceLabel = `artifact:${file.artifactId}`;
          } else {
            const sourcePath = assertSourceWorkPath(file.sourcePath ?? "");
            const raw = await input.filesystem.readRaw(sourcePath);
            throwIfInvocationAborted(signal);
            if (raw.error || !raw.data) {
              throw new Error(
                raw.error ||
                  `Could not read ${sourcePath}. Create the Workfile first, or use a provider sandbox path when the file already exists inside the sandbox.`,
              );
            }
            content = toBytes(raw.data.content);
            sourceLabel = sourcePath;
          }
          const sizeBytes = byteLength(content);
          if (sizeBytes > input.limits.maxPrepareFileBytes) {
            throw new Error(
              `SANDBOX_FILE_TOO_LARGE: ${sourceLabel} exceeds prepare file limit.`,
            );
          }
          totalBytes += sizeBytes;
          if (totalBytes > input.limits.maxPrepareTotalBytes) {
            throw new Error(
              "SANDBOX_TOTAL_SIZE_EXCEEDED: prepared files exceed total limit.",
            );
          }
          prepared.push({
            content,
            sourcePath: sourceLabel,
            ...(sourceArtifact ? { sourceArtifact } : {}),
            sandboxPath,
            sizeBytes,
          });
        }

        await input.trustedHost.uploadCurrentFiles(
          prepared.map((file) => ({
            path: file.sandboxPath,
            bytes: file.content,
          })),
          { signal },
        );
        throwIfInvocationAborted(signal);
        const result = withReplacementDiagnostics(
          {
            ok: true,
            files: prepared.map(({ content: _content, ...file }) => file),
            totalBytes,
          },
          replaced,
        );
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId,
          status: "succeeded",
          result,
          durationMs: Date.now() - startedAt,
        });
        return JSON.stringify(result);
      } catch (error) {
        const controlError = cancellationControlError({ error, signal });
        if (controlError) {
          await input.manager.completeToolOperation({
            operationId: claim.operationId,
            sandboxId,
            status: "failed",
            result: {
              error: compactRecoverableToolError(controlError),
              errorCode: sandboxErrorCode(controlError),
              resultDiscarded: true,
            },
            durationMs: Date.now() - startedAt,
          });
          throw controlError;
        }
        const result = withReplacementDiagnostics(
          toRecoverableSandboxToolErrorOutput({
            error,
            operationType: "prepare",
          }),
          replaced,
        );
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId,
          status: "succeeded",
          result,
          durationMs: Date.now() - startedAt,
        });
        // Only a confirmed-gone instance shortens the lease; a transient
        // or input error leaves a healthy sandbox on its full TTL (same
        // policy as execute).
        if (isSandboxInstanceMissingError(error)) {
          await input.manager
            .releaseThreadSandboxLease({
              context: input.context,
              reason: "sandbox_prepare_runtime_error",
            })
            .catch(() => undefined);
        }
        if (sandboxId && isSandboxInstanceMissingError(error)) {
          await input.manager
            .expireThreadSandbox({ sandboxId })
            .catch(() => undefined);
        }
        return JSON.stringify(result);
      }
    },
    {
      name: PREPARE_SANDBOX_TOOL_NAME,
      description: toolDescriptions.prepareSandboxWorkspace,
      schema: prepareSandboxWorkspaceSchema,
    },
  );

  const collectSandboxOutputs = tool(
    async (args: CollectSandboxOutputsInput, runtime: ToolRuntime) => {
      const signal = resolveAgentToolHostInvocationSignal(runtime);
      throwIfInvocationAborted(signal);
      const startedAt = Date.now();
      const toolCallId = requireSandboxToolCallId({
        operationType: "collect",
        runtime,
      });
      const claim = await input.manager.beginToolOperation({
        context: input.context,
        operationType: "collect",
        toolCallId,
        request: { outputs: args.outputs },
      });
      if (claim.kind === "replay") {
        return JSON.stringify(claim.result);
      }
      let sandboxId: string | null = null;
      let replaced = false;
      let totalBytes = 0;
      const collected: Array<{
        sandboxPath: string;
        sizeBytes: number;
        targetKind: string;
        targetPath: string;
        textContent: string;
      }> = [];
      try {
        const sandbox = await input.manager.getOrCreateThreadSandbox(
          input.context,
          { ...(signal ? { signal } : {}) },
        );
        sandboxId = sandbox.id;
        replaced = input.manager.consumeReplacementNotice();
        for (const output of args.outputs) {
          throwIfInvocationAborted(signal);
          const sandboxPath = assertCollectSandboxPath(
            output.sandboxPath,
            input.manager.providerForSandbox().pathPolicy,
          );
          const targetPath = assertSourceWorkPath(output.target.path);
          const content = Buffer.from(
            await input.trustedHost.downloadCurrentFile({
              sandboxPath,
              signal,
            }),
          );
          throwIfInvocationAborted(signal);
          const sizeBytes = content.byteLength;
          if (sizeBytes > input.limits.maxCollectFileBytes) {
            throw new Error(
              `SANDBOX_FILE_TOO_LARGE: ${sandboxPath} exceeds collect file limit.`,
            );
          }
          totalBytes += sizeBytes;
          if (totalBytes > input.limits.maxCollectTotalBytes) {
            throw new Error(
              "SANDBOX_TOTAL_SIZE_EXCEEDED: collected outputs exceed total limit.",
            );
          }
          const existing = await input.filesystem.readRaw(targetPath);
          throwIfInvocationAborted(signal);
          if (existing.data && output.target.overwrite !== true) {
            throw new Error(
              `SANDBOX_COLLECT_CONFLICT: ${targetPath} already exists. Set overwrite=true or choose a new path.`,
            );
          }
          const textContent = decodeSandboxTextOutput(content, sandboxPath);
          collected.push({
            sandboxPath,
            targetKind: "workfile",
            targetPath,
            sizeBytes,
            textContent,
          });
        }

        for (const output of collected) {
          throwIfInvocationAborted(signal);
          const write = await input.filesystem.write(
            output.targetPath,
            output.textContent,
          );
          throwIfInvocationAborted(signal);
          if (write.error) {
            throw new Error(write.error);
          }
        }
        const result = withReplacementDiagnostics(
          {
            ok: true,
            outputs: collected.map(
              ({ textContent: _textContent, ...output }) => output,
            ),
            totalBytes,
          },
          replaced,
        );
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId,
          status: "succeeded",
          result,
          durationMs: Date.now() - startedAt,
        });
        return JSON.stringify(result);
      } catch (error) {
        const controlError = cancellationControlError({ error, signal });
        if (controlError) {
          await input.manager.completeToolOperation({
            operationId: claim.operationId,
            sandboxId,
            status: "failed",
            result: {
              error: compactRecoverableToolError(controlError),
              errorCode: sandboxErrorCode(controlError),
              resultDiscarded: true,
            },
            durationMs: Date.now() - startedAt,
          });
          throw controlError;
        }
        if (error instanceof SandboxCollectUnsupportedOutputError) {
          const result = toRecoverableCollectErrorOutput(error);
          await input.manager.completeToolOperation({
            operationId: claim.operationId,
            sandboxId,
            status: "succeeded",
            result,
            durationMs: Date.now() - startedAt,
          });
          return JSON.stringify(result);
        }
        const result = withReplacementDiagnostics(
          toRecoverableSandboxToolErrorOutput({
            error,
            operationType: "collect",
          }),
          replaced,
        );
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId,
          status: "succeeded",
          result,
          durationMs: Date.now() - startedAt,
        });
        // Only a confirmed-gone instance shortens the lease; a transient
        // or input error leaves a healthy sandbox on its full TTL (same
        // policy as execute).
        if (isSandboxInstanceMissingError(error)) {
          await input.manager
            .releaseThreadSandboxLease({
              context: input.context,
              reason: "sandbox_collect_runtime_error",
            })
            .catch(() => undefined);
        }
        if (sandboxId && isSandboxInstanceMissingError(error)) {
          await input.manager
            .expireThreadSandbox({ sandboxId })
            .catch(() => undefined);
        }
        return JSON.stringify(result);
      }
    },
    {
      name: COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
      description: toolDescriptions.collectSandboxOutputs,
      schema: collectSandboxOutputsSchema,
    },
  );

  return [prepareSandboxWorkspace, collectSandboxOutputs];
}
