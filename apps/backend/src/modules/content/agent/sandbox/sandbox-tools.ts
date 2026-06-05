import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { BackendProtocolV2 } from "deepagents";
import { config } from "../../../../shared/config";
import { AGENT_TOOL_NAMES } from "../tool-names";
import { assertCollectSandboxPath, assertPrepareSandboxPath, assertSourceWorkPath, dirname } from "./paths";
import type { SandboxRuntimeContext } from "./types";
import { DaytonaSandboxManager } from "./daytona-manager";

function byteLength(content: string | string[] | Uint8Array) {
  if (Array.isArray(content)) {
    return Buffer.byteLength(content.join("\n"));
  }
  return typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
}

function toBytes(content: string | string[] | Uint8Array) {
  if (Array.isArray(content)) {
    return new TextEncoder().encode(content.join("\n"));
  }
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function compactError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function requireSandboxToolCallId(input: {
  operationType: "prepare" | "collect";
  runtime: ToolRuntime;
}) {
  const toolCallId = input.runtime.toolCallId?.trim();
  if (!toolCallId) {
    throw new Error(
      `SANDBOX_TOOL_CALL_ID_REQUIRED: sandbox ${input.operationType} requires ToolRuntime.toolCallId for replay-safe execution.`,
    );
  }
  return toolCallId;
}

function decodeSandboxTextOutput(content: Buffer, sandboxPath: string) {
  if (content.includes(0)) {
    throw new Error(
      `SANDBOX_BINARY_OUTPUT_UNSUPPORTED: ${sandboxPath} appears to be binary. Collect binary outputs through the artifact pipeline once supported.`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(
      `SANDBOX_BINARY_OUTPUT_UNSUPPORTED: ${sandboxPath} is not valid UTF-8 text. Collect binary outputs through the artifact pipeline once supported.`,
    );
  }
}

export function createSandboxTools(input: {
  filesystem: BackendProtocolV2;
  manager: DaytonaSandboxManager;
  context: SandboxRuntimeContext;
}) {
  const prepareSandboxWorkspace = tool(
    async (
      args: { files: Array<{ sourcePath: string; sandboxPath: string }> },
      runtime: ToolRuntime,
    ) => {
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
      const sandbox = await input.manager.getOrCreateThreadSandbox(input.context);
      let totalBytes = 0;
      const prepared: Array<{
        content: Uint8Array;
        sandboxPath: string;
        sizeBytes: number;
        sourcePath: string;
      }> = [];

      try {
        for (const file of args.files) {
          const sourcePath = assertSourceWorkPath(file.sourcePath);
          const sandboxPath = assertPrepareSandboxPath(file.sandboxPath);
          const raw = await input.filesystem.readRaw(sourcePath);
          if (raw.error || !raw.data) {
            throw new Error(raw.error || `Could not read ${sourcePath}`);
          }
          const sizeBytes = byteLength(raw.data.content);
          if (sizeBytes > config.sandbox.maxPrepareFileBytes) {
            throw new Error(`SANDBOX_FILE_TOO_LARGE: ${sourcePath} exceeds prepare file limit.`);
          }
          totalBytes += sizeBytes;
          if (totalBytes > config.sandbox.maxPrepareTotalBytes) {
            throw new Error("SANDBOX_TOTAL_SIZE_EXCEEDED: prepared files exceed total limit.");
          }
          prepared.push({
            content: toBytes(raw.data.content),
            sourcePath,
            sandboxPath,
            sizeBytes,
          });
        }

        for (const file of prepared) {
          await input.manager.adapterForSandbox().ensureDirectory({
            providerSandboxId: sandbox.providerSandboxId,
            directory: dirname(file.sandboxPath),
          });
          await input.manager.adapterForSandbox().uploadFile({
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
          sandboxId: sandbox.id,
          status: "succeeded",
          result,
          durationMs: Date.now() - startedAt,
        });
        return JSON.stringify(result);
      } catch (error) {
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId: sandbox.id,
          status: "failed",
          result: { error: compactError(error) },
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
    {
      name: AGENT_TOOL_NAMES.prepareSandboxWorkspace,
      description: "Prepare explicitly selected SourceWeft /work files inside the isolated sandbox runtime under /workspace/input or /workspace/work. Do not use this for /kb or /skills content.",
      schema: z.object({
        files: z.array(z.object({
          sourcePath: z.string().min(1),
          sandboxPath: z.string().min(1),
        })).min(1).max(20),
      }),
    },
  );

  const collectSandboxOutputs = tool(
    async (
      args: {
        outputs: Array<{
          sandboxPath: string;
          target: { kind: "workfile"; path: string; overwrite?: boolean };
        }>;
      },
      runtime: ToolRuntime,
    ) => {
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
      const sandbox = await input.manager.getOrCreateThreadSandbox(input.context);
      let totalBytes = 0;
      const collected: Array<{
        sandboxPath: string;
        sizeBytes: number;
        targetKind: string;
        targetPath: string;
        textContent: string;
      }> = [];
      try {
        for (const output of args.outputs) {
          const sandboxPath = assertCollectSandboxPath(output.sandboxPath);
          const targetPath = assertSourceWorkPath(output.target.path);
          const content = await input.manager.adapterForSandbox().downloadFile({
            providerSandboxId: sandbox.providerSandboxId,
            sandboxPath,
          });
          const sizeBytes = content.byteLength;
          if (sizeBytes > config.sandbox.maxCollectFileBytes) {
            throw new Error(`SANDBOX_FILE_TOO_LARGE: ${sandboxPath} exceeds collect file limit.`);
          }
          totalBytes += sizeBytes;
          if (totalBytes > config.sandbox.maxCollectTotalBytes) {
            throw new Error("SANDBOX_TOTAL_SIZE_EXCEEDED: collected outputs exceed total limit.");
          }
          const existing = await input.filesystem.readRaw(targetPath);
          if (existing.data && output.target.overwrite !== true) {
            throw new Error(`SANDBOX_COLLECT_CONFLICT: ${targetPath} already exists. Set overwrite=true or choose a new path.`);
          }
          const textContent = decodeSandboxTextOutput(content, sandboxPath);
          collected.push({ sandboxPath, targetKind: "workfile", targetPath, sizeBytes, textContent });
        }

        for (const output of collected) {
          const write = await input.filesystem.write(output.targetPath, output.textContent);
          if (write.error) {
            throw new Error(write.error);
          }
        }
        const result = {
          ok: true,
          outputs: collected.map(({ textContent: _textContent, ...output }) => output),
          totalBytes,
        };
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId: sandbox.id,
          status: "succeeded",
          result,
          durationMs: Date.now() - startedAt,
        });
        return JSON.stringify(result);
      } catch (error) {
        await input.manager.completeToolOperation({
          operationId: claim.operationId,
          sandboxId: sandbox.id,
          status: "failed",
          result: { error: compactError(error) },
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
    {
      name: AGENT_TOOL_NAMES.collectSandboxOutputs,
      description: "Collect selected isolated sandbox outputs from /workspace/output or /workspace/work back into SourceWeft /work. Artifact collection is not exposed until the artifact pipeline supports it.",
      schema: z.object({
        outputs: z.array(z.object({
          sandboxPath: z.string().min(1),
          target: z.object({
            kind: z.literal("workfile"),
            path: z.string().min(1),
            overwrite: z.boolean().optional(),
          }),
        })).min(1).max(20),
      }),
    },
  );

  return [prepareSandboxWorkspace, collectSandboxOutputs];
}
