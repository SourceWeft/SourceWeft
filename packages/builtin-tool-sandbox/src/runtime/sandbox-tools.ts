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
} from "@sourceweft/contracts/agent-tools";
import {
  assertCollectSandboxPath,
  assertPrepareSandboxPath,
  assertSourceWorkPath,
  dirname,
} from "./paths";
import type { SandboxRuntimeContext, SandboxRuntimeLimits } from "./types";
import { SandboxManager } from "./sandbox-manager";

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

function shouldExpireSandboxAfterToolError(error: unknown) {
  const message = compactError(error).toLowerCase();
  return (
    message.includes("sandbox_not_found_or_expired") ||
    message.includes("sandbox_not_ready_or_unhealthy")
  );
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
      `SANDBOX_BINARY_OUTPUT_UNSUPPORTED: ${sandboxPath} appears to be binary. Use publish_sandbox_artifact for supported binary artifacts such as PPTX files.`,
      sandboxPath,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new SandboxCollectUnsupportedOutputError(
      `SANDBOX_BINARY_OUTPUT_UNSUPPORTED: ${sandboxPath} is not valid UTF-8 text. Use publish_sandbox_artifact for supported binary artifacts such as PPTX files.`,
      sandboxPath,
    );
  }
}

export function createSandboxTools(input: {
  filesystem: BackendProtocolV2;
  manager: SandboxManager;
  context: SandboxRuntimeContext;
  limits: SandboxRuntimeLimits;
}) {
  const toolDescriptions = buildSandboxToolDescriptions(
    input.manager.providerForSandbox().pathPolicy,
  );
  const prepareSandboxWorkspace = tool(
    async (args: PrepareSandboxWorkspaceInput, runtime: ToolRuntime) => {
      const startedAt = Date.now();
      const toolCallId = requireSandboxToolCallId({
        operationType: "prepare",
        runtime,
      });
      const claim = await input.manager.beginToolOperation({
        context: input.context,
        operationType: "prepare",
        toolCallId,
        request: { files: args.files },
      });
      if (claim.kind === "replay") {
        return JSON.stringify(claim.result);
      }
      let sandboxId: string | null = null;
      let totalBytes = 0;
      const prepared: Array<{
        content: Uint8Array;
        sandboxPath: string;
        sizeBytes: number;
        sourcePath: string;
      }> = [];

      try {
        const sandbox = await input.manager.getOrCreateThreadSandbox(
          input.context,
        );
        sandboxId = sandbox.id;
        for (const file of args.files) {
          const sourcePath = assertSourceWorkPath(file.sourcePath);
          const sandboxPath = assertPrepareSandboxPath(
            file.sandboxPath,
            input.manager.providerForSandbox().pathPolicy,
          );
          const raw = await input.filesystem.readRaw(sourcePath);
          if (raw.error || !raw.data) {
            throw new Error(
              raw.error ||
                `Could not read ${sourcePath}. Create the Workfile first, or use a provider sandbox path when the file already exists inside the sandbox.`,
            );
          }
          const sizeBytes = byteLength(raw.data.content);
          if (sizeBytes > input.limits.maxPrepareFileBytes) {
            throw new Error(
              `SANDBOX_FILE_TOO_LARGE: ${sourcePath} exceeds prepare file limit.`,
            );
          }
          totalBytes += sizeBytes;
          if (totalBytes > input.limits.maxPrepareTotalBytes) {
            throw new Error(
              "SANDBOX_TOTAL_SIZE_EXCEEDED: prepared files exceed total limit.",
            );
          }
          prepared.push({
            content: toBytes(raw.data.content),
            sourcePath,
            sandboxPath,
            sizeBytes,
          });
        }

        for (const file of prepared) {
          await input.manager.providerForSandbox().ensureDirectory({
            providerSandboxId: sandbox.providerSandboxId,
            directory: dirname(file.sandboxPath),
          });
          await input.manager.providerForSandbox().uploadFile({
            providerSandboxId: sandbox.providerSandboxId,
            sandboxPath: file.sandboxPath,
            content: file.content,
          });
        }
        const result = {
          ok: true,
          files: prepared.map(({ content: _content, ...file }) => file),
          totalBytes,
        };
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId,
          status: "succeeded",
          result,
          durationMs: Date.now() - startedAt,
        });
        return JSON.stringify(result);
      } catch (error) {
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId,
          status: "failed",
          result: { error: compactError(error) },
          durationMs: Date.now() - startedAt,
        });
        await input.manager
          .releaseThreadSandboxLease({
            context: input.context,
            reason: "sandbox_prepare_runtime_error",
          })
          .catch(() => undefined);
        if (sandboxId && shouldExpireSandboxAfterToolError(error)) {
          await input.manager
            .expireThreadSandbox({ sandboxId })
            .catch(() => undefined);
        }
        throw error;
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
        );
        sandboxId = sandbox.id;
        for (const output of args.outputs) {
          const sandboxPath = assertCollectSandboxPath(
            output.sandboxPath,
            input.manager.providerForSandbox().pathPolicy,
          );
          const targetPath = assertSourceWorkPath(output.target.path);
          const content = await input.manager
            .providerForSandbox()
            .downloadFile({
              providerSandboxId: sandbox.providerSandboxId,
              sandboxPath,
            });
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
          const write = await input.filesystem.write(
            output.targetPath,
            output.textContent,
          );
          if (write.error) {
            throw new Error(write.error);
          }
        }
        const result = {
          ok: true,
          outputs: collected.map(
            ({ textContent: _textContent, ...output }) => output,
          ),
          totalBytes,
        };
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId,
          status: "succeeded",
          result,
          durationMs: Date.now() - startedAt,
        });
        return JSON.stringify(result);
      } catch (error) {
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
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId,
          status: "failed",
          result: { error: compactError(error) },
          durationMs: Date.now() - startedAt,
        });
        await input.manager
          .releaseThreadSandboxLease({
            context: input.context,
            reason: "sandbox_collect_runtime_error",
          })
          .catch(() => undefined);
        if (sandboxId && shouldExpireSandboxAfterToolError(error)) {
          await input.manager
            .expireThreadSandbox({ sandboxId })
            .catch(() => undefined);
        }
        throw error;
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
