import { randomUUID } from "node:crypto";
import { ContentError } from "../content/errors";
import { and, eq, isNull } from "drizzle-orm";
import { db, localDevices, localThreadBindings, threads } from "@sourceweft/db";
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
  // Reserve identity from authenticated host metadata, without contacting the PC.
  // The physical directory is created/verified only when a tool acquires it.
  let root = binding.workspacePath;
  let id = binding.localWorkspaceId;
  if (!root || !id) {
    const device = await db.query.localDevices.findFirst({
      where: eq(localDevices.id, binding.deviceId),
    });
    if (!device?.workspaceBase)
      throw new ContentError(
        409,
        "LOCAL_HOST_UPGRADE_REQUIRED",
        "请在目标 PC 登录一次以恢复本机目录信息。",
      );
    const reservedId = randomUUID();
    const [saved] = await db
      .update(localThreadBindings)
      .set({
        localWorkspaceId: reservedId,
        workspacePath: `${device.workspaceBase}/${reservedId}/files`,
      })
      .where(
        and(
          eq(localThreadBindings.threadId, context.threadId),
          isNull(localThreadBindings.localWorkspaceId),
        ),
      )
      .returning();
    const reserved =
      saved ??
      (await db.query.localThreadBindings.findFirst({
        where: eq(localThreadBindings.threadId, context.threadId),
      }));
    root = reserved?.workspacePath ?? null;
    id = reserved?.localWorkspaceId ?? null;
  }
  if (!root || !id)
    throw new ContentError(
      409,
      "LOCAL_BINDING_INVALID",
      "本地目录绑定不可用。",
    );
  const workspaceRoot = root;
  const workspaceId = id;
  const dispatch = (
    action: string,
    payload: Record<string, unknown>,
    extra: { id?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ) =>
    localCall({
      ...extra,
      caller: context.localCaller,
      deviceId: binding.deviceId,
      userId: context.userId,
      threadId: context.threadId,
      runId: context.runId,
      action,
      payload,
    });
  let initialized: Promise<Record<string, unknown>> | undefined;
  const ensure = () =>
    (initialized ??= (async () => {
      const value = await dispatch("workspace.ensure", {
        workspaceId,
        folderId: binding.folderId ?? undefined,
      });
      if (value.id !== workspaceId || value.path !== workspaceRoot)
        throw new ContentError(
          409,
          "LOCAL_WORKSPACE_MISMATCH",
          "本机返回的目录与对话绑定不一致。",
        );
      return value;
    })());
  const call = async (
    action: string,
    payload: Record<string, unknown>,
    extra: { id?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ) => {
    if (action === "workspace.ensure") return ensure();
    if (action !== "command.cancel") await ensure();
    return dispatch(action, payload, extra);
  };
  const relative = (path: string) => {
    if (path === workspaceRoot) return ".";
    if (!path.startsWith(`${workspaceRoot}/`))
      throw new Error(
        "LOCAL_PATH_DENIED: Path is outside the bound workspace.",
      );
    const result = path.slice(workspaceRoot.length + 1);
    if (result.split("/").some((part) => part === ".."))
      throw new Error("LOCAL_PATH_DENIED");
    return result;
  };
  const observed = new Map<string, string>();
  const provider: SandboxProvider = {
    id: "local",
    cancellationScope: "command",
    pathPolicy: {
      skillsRoot: `${workspaceRoot}/.sourceweft-skills`,
      workspaceRoot,
      defaultCwd: workspaceRoot,
      prepareTargetRoots: [workspaceRoot],
      collectSourceRoots: [workspaceRoot],
      readWriteRoots: [workspaceRoot],
    },
    createSandbox: async () => {
      await ensure();
      return { id: workspaceId };
    },
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
    uploadFile: async (input) => {
      const content = Buffer.from(input.content).toString("base64");
      const result = await call("file.write", {
        workspaceId: id,
        path: relative(input.sandboxPath),
        content: Buffer.from(input.content).toString("base64"),
        expectedContent: observed.get(input.sandboxPath),
      });
      observed.set(input.sandboxPath, content);
      return result;
    },
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
      observed.set(input.sandboxPath, String(result.content ?? ""));
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(String(result.content ?? ""), "base64"),
      );
    },
    writeTextFile: async (input) => {
      const content = Buffer.from(input.content).toString("base64");
      const result = await call("file.write", {
        workspaceId: id,
        path: relative(input.sandboxPath),
        content: Buffer.from(input.content).toString("base64"),
        expectedContent: observed.get(input.sandboxPath),
      });
      observed.set(input.sandboxPath, content);
      return result;
    },
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
