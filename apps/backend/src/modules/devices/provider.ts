import { ContentError } from "../content/errors";
import { and, eq } from "drizzle-orm";
import { db, localThreadBindings, threads } from "@sourceweft/db";
import type {
  SandboxProvider,
  SandboxProviderFactory,
  SandboxRuntimeContext,
} from "@sourceweft/builtin-tool-sandbox";
import { localCall } from "./service";

export async function localProviderForTurn(
  context: SandboxRuntimeContext,
): Promise<SandboxProviderFactory | null> {
  const thread = await db.query.threads.findFirst({
    where: and(
      eq(threads.id, context.threadId),
      eq(threads.workspaceId, context.workspaceId),
      eq(threads.teamId, context.teamId),
    ),
  });
  if (!thread)
    throw new ContentError(404, "THREAD_NOT_FOUND", "Conversation not found.");
  const binding = await db.query.localThreadBindings.findFirst({
    where: eq(localThreadBindings.threadId, context.threadId),
  });
  if (thread.executionTargetJson.kind === "cloud") {
    if (binding)
      throw new ContentError(
        409,
        "LOCAL_BINDING_INVALID",
        "Cloud conversation has a conflicting local binding.",
      );
    return null;
  }
  if (thread.createdBy !== context.userId || thread.visibility !== "private")
    throw new ContentError(
      403,
      "LOCAL_THREAD_FORBIDDEN",
      "This local conversation is private to its owner.",
    );
  if (
    !binding ||
    binding.userId !== context.userId ||
    binding.deviceId !== thread.executionTargetJson.deviceId
  ) {
    throw new ContentError(
      409,
      "LOCAL_BINDING_INVALID",
      "The local binding is missing or inconsistent. Cloud execution is not allowed.",
    );
  }
  const call = (
    action: string,
    payload: Record<string, unknown>,
    extra: { id?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ) =>
    localCall({
      ...extra,
      deviceId: binding.deviceId,
      userId: context.userId,
      threadId: context.threadId,
      runId: context.runId,
      action,
      payload,
    });
  const workspace = await call("workspace.ensure", {});
  if (
    typeof workspace.id !== "string" ||
    typeof workspace.path !== "string" ||
    !workspace.path.startsWith("/")
  )
    throw new Error("INVALID_LOCAL_WORKSPACE");
  const root = workspace.path;
  const id = workspace.id;
  await db
    .update(localThreadBindings)
    .set({ localWorkspaceId: id, workspacePath: root })
    .where(eq(localThreadBindings.threadId, context.threadId));
  const relative = (path: string) => {
    if (path === root) return ".";
    if (!path.startsWith(`${root}/`))
      throw new Error(
        "LOCAL_PATH_DENIED: Path is outside the bound workspace.",
      );
    const result = path.slice(root.length + 1);
    if (result.split("/").some((part) => part === ".."))
      throw new Error("LOCAL_PATH_DENIED");
    return result;
  };
  const provider: SandboxProvider = {
    id: "local",
    cancellationScope: "command",
    pathPolicy: {
      workspaceRoot: root,
      defaultCwd: root,
      prepareTargetRoots: [root],
      collectSourceRoots: [root],
      readWriteRoots: [root],
    },
    createSandbox: async () => ({ id }),
    getSandbox: async () => call("workspace.ensure", {}),
    checkSandboxHealth: async () => call("workspace.ensure", {}),
    deleteSandbox: async () => ({ persistentWorkspacePreserved: true }),
    execute: async (input) => {
      if (input.providerSandboxId !== id)
        throw new Error("LOCAL_WORKSPACE_MISMATCH");
      const executionId = input.executionId
        ? `${binding.deviceId}:${input.executionId}`
        : undefined;
      const result = await call(
        "command.execute",
        {
          workspaceId: id,
          command: input.command,
          cwd: input.cwd ? relative(input.cwd) : ".",
          timeoutMs: Math.min(input.timeoutMs, 120_000),
          maxOutputChars: input.maxOutputChars,
        },
        {
          id: executionId,
          timeoutMs: Math.min(input.timeoutMs, 120_000) + 10_000,
          signal: input.signal,
        },
      );
      return {
        output: String(result.output ?? ""),
        exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
        truncated: result.truncated === true,
      };
    },
    cancelExecution: async (input) => {
      const result = await call("command.cancel", {
        executionId: `${binding.deviceId}:${input.executionId}`,
      });
      return result.confirmed === true
        ? { confirmed: true, mode: "command" }
        : { confirmed: false, mode: "unknown" };
    },
    uploadFile: async (input) =>
      call("file.write", {
        workspaceId: id,
        path: relative(input.sandboxPath),
        content: Buffer.from(input.content).toString("base64"),
      }),
    downloadFile: async (input) => {
      const result = await call(
        "file.read",
        { workspaceId: id, path: relative(input.sandboxPath) },
        { signal: input.signal },
      );
      return Buffer.from(String(result.content ?? ""), "base64");
    },
    ensureDirectory: async (input) =>
      call("file.mkdir", { workspaceId: id, path: relative(input.directory) }),
    listFiles: async (input) => {
      const result = await call("file.list", {
        workspaceId: id,
        path: relative(input.sandboxPath),
      });
      return (
        result.files as Array<{ path: string; is_dir?: boolean; size?: number }>
      ).map((file) => ({ ...file, path: `${root}/${file.path}` }));
    },
    readTextFile: async (input) => {
      const result = await call("file.read", {
        workspaceId: id,
        path: relative(input.sandboxPath),
      });
      return Buffer.from(String(result.content ?? ""), "base64").toString(
        "utf8",
      );
    },
    writeTextFile: async (input) =>
      call("file.write", {
        workspaceId: id,
        path: relative(input.sandboxPath),
        content: Buffer.from(input.content).toString("base64"),
      }),
  };
  return {
    id: "local",
    createProvider: () => provider,
    getConfigurationStatus: () => ({
      configured: true,
      missing: [],
      metadata: { defaultSandboxEnvironmentAvailable: false },
    }),
  };
}
