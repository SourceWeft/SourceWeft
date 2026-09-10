import { randomUUID } from "node:crypto";
import { readLocalBinaryFile } from "./read-binary-file";
import { grepLocalFilePaths } from "./native-grep";
import { logger } from "../../shared/logger";
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
  context: Pick<
    SandboxRuntimeContext,
    "teamId" | "workspaceId" | "threadId" | "userId"
  > &
    Partial<Pick<SandboxRuntimeContext, "runId" | "localCaller" | "messageId">>,
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
  // Reserve identity from authenticated host metadata, without contacting the PC.
  // The physical directory is created/verified only when a tool acquires it.
  let root = binding.workspacePath;
  let id = binding.localWorkspaceId;
  if ((!root || !id) && thread.executionTargetJson.directoryGrantId) {
    const workspace = await dispatch("workspace.ensure", {
      directoryGrantId: thread.executionTargetJson.directoryGrantId,
    });
    if (
      typeof workspace.id !== "string" ||
      typeof workspace.path !== "string" ||
      !workspace.path.startsWith("/")
    )
      throw new ContentError(
        409,
        "LOCAL_WORKSPACE_MISMATCH",
        "The computer returned an invalid working directory.",
      );
    const [saved] = await db
      .update(localThreadBindings)
      .set({ localWorkspaceId: workspace.id, workspacePath: workspace.path })
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
    if (root !== workspace.path || id !== workspace.id)
      throw new ContentError(
        409,
        "LOCAL_WORKSPACE_MISMATCH",
        "The computer returned a different working directory.",
      );
  }
  if (!root || !id) {
    if (binding.folderId)
      throw new ContentError(
        409,
        "LOCAL_BINDING_INVALID",
        "The selected folder binding is incomplete.",
      );
    const device = await db.query.localDevices.findFirst({
      where: eq(localDevices.id, binding.deviceId),
    });
    if (!device?.workspaceBase)
      throw new ContentError(
        409,
        "LOCAL_HOST_UPGRADE_REQUIRED",
        "Sign in on that computer to restore its working directory information.",
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
      "The working directory binding is unavailable.",
    );
  const workspaceRoot = root;
  const workspaceId = id;
  let initialized: Promise<Record<string, unknown>> | undefined;
  const ensure = () =>
    (initialized ??= (async () => {
      const value = await dispatch("workspace.ensure", {
        workspaceId,
        ...(binding.folderId ? { folderId: binding.folderId } : {}),
        ...(thread.executionTargetJson.kind === "local" &&
        thread.executionTargetJson.directoryGrantId
          ? { directoryGrantId: thread.executionTargetJson.directoryGrantId }
          : {}),
      });
      if (value.id !== workspaceId || value.path !== workspaceRoot)
        throw new ContentError(
          409,
          "LOCAL_WORKSPACE_MISMATCH",
          "The computer returned a working directory that does not match this conversation.",
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
      return readLocalBinaryFile({
        call,
        workspaceId: id,
        path: relative(input.sandboxPath),
        signal: input.signal,
        onCleanupError: (error) =>
          logger.warn("Local file transfer cleanup failed", {
            error: String(error),
          }),
      });
    },
    ensureDirectory: async (input) =>
      call("file.mkdir", { workspaceId: id, path: relative(input.directory) }),
    nativeFileOperations: true,
    nativeGrep: async (input) => {
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const visitedPaths: string[] = [],
        skipped: string[] = [];
      let truncated = false;
      for (let offset = 0; offset < input.paths.length; offset += 100) {
        const result = await grepLocalFilePaths({
          userId: context.userId,
          deviceId: binding.deviceId,
          threadId: context.threadId,
          workspaceId: id,
          root: workspaceRoot,
          paths: input.paths.slice(offset, offset + 100),
          pattern: input.pattern,
          caller: context.localCaller,
          signal: input.signal,
          literal: input.literal,
          ignoreCase: input.ignoreCase,
          firstPerFile: input.firstPerFile,
        });
        matches.push(...result.matches);
        visitedPaths.push(...result.visitedPaths);
        skipped.push(...result.skipped);
        truncated ||= result.truncated || result.skipped.length > 0;
        if (matches.length >= 100) {
          truncated ||= offset + 100 < input.paths.length;
          break;
        }
      }
      return {
        matches: matches.slice(0, 100),
        visitedPaths,
        skipped,
        truncated,
      };
    },
    listFiles: async (input) => {
      const result = await call("file.list", {
        workspaceId: id,
        path: relative(input.sandboxPath),
        recursive: input.recursive === true,
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
    replaceTextFile: async (input) =>
      call("file.replace", {
        workspaceId: id,
        path: relative(input.sandboxPath),
        content: Buffer.from(input.content).toString("base64"),
        expected: Buffer.from(input.expected).toString("base64"),
      }),
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
