import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { createSandboxRuntimeForTurn } from "../../src/runtime/runtime";
import type {
  SandboxCancellationResult,
  SandboxOperationStore,
  SandboxProvider,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStore,
} from "../../src/runtime/types";

const context: SandboxRuntimeContext = {
  teamId: "team-trusted-host",
  workspaceId: "workspace-trusted-host",
  threadId: "thread-trusted-host",
  userId: "user-trusted-host",
  messageId: "message-trusted-host",
  runId: "run-trusted-host",
};

const limits: SandboxRuntimeLimits = {
  ttlSeconds: 3600,
  commandBudgetsMs: { interactive: 1_000, batch: 5_000 },
  maxCommandTimeoutMs: 6_000,
  maxOutputChars: 4_000,
  maxPrepareFileBytes: 8,
  maxPrepareTotalBytes: 12,
  maxCollectFileBytes: 8,
  maxCollectTotalBytes: 12,
};

type ManifestReply = {
  exitCode?: number;
  output: string;
  truncated?: boolean;
};

function createHarness(
  options: {
    workspaceRoot?: string;
    executeSystem?: NonNullable<SandboxProvider["executeSystem"]>;
  } = {},
) {
  const workspaceRoot = options.workspaceRoot ?? "/workspace";
  const files = new Map<string, Buffer>([
    ["/workspace/project/a.txt", Buffer.from("abc")],
    ["/workspace/project/b.bin", Buffer.from([4, 5])],
  ]);
  const canonicalOverrides = new Map<string, string>();
  const manifestReplies: ManifestReply[] = [];
  const executeInputs: Array<{
    command: string;
    timeoutMs: number;
    maxOutputChars: number;
    signal?: AbortSignal;
  }> = [];
  const uploads: Array<{ path: string; content: Uint8Array }> = [];
  const deletedSandboxIds: string[] = [];
  const downloadInputs: Array<{
    executionId?: string;
    sandboxPath: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }> = [];
  const expiredSandboxIds: string[] = [];
  const cancellationInputs: Array<{
    providerSandboxId: string;
    executionId: string;
    reason: "user_cancelled" | "timed_out";
  }> = [];
  const recordedOperations: Array<Record<string, unknown>> = [];
  const modelExecuteTimeouts: number[] = [];
  let commandHandler: (input: (typeof executeInputs)[number]) => Promise<{
    output: string;
    exitCode: number | null;
    truncated: boolean;
  }> = async () => ({ output: "ok", exitCode: 0, truncated: false });
  let deleteHandler: (
    providerSandboxId: string,
  ) => Promise<void> = async () => {};
  let downloadHandler: (
    input: (typeof downloadInputs)[number],
  ) => Promise<Buffer> = async (input) => {
    const content = files.get(input.sandboxPath);
    if (!content) throw new Error("not found");
    return Buffer.from(content);
  };
  let uploadHandler: (input: {
    providerSandboxId: string;
    sandboxPath: string;
    content: Uint8Array;
  }) => Promise<void> = async (input) => {
    files.set(input.sandboxPath, Buffer.from(input.content));
    uploads.push({ path: input.sandboxPath, content: input.content });
  };

  const canonicalTarget = (command: string) =>
    command.match(/target='([^']*)'/u)?.[1] ?? "";
  const defaultManifest = [
    "SOURCEWEFT_MANIFEST_BEGIN",
    "3\t100\t1\t/workspace/project/a.txt",
    "2\t100\t2\t/workspace/project/b.bin",
    "SOURCEWEFT_MANIFEST_END",
  ].join("\n");

  const provider: SandboxProvider = {
    id: "fake",
    pathPolicy: {
      workspaceRoot,
      defaultCwd: workspaceRoot,
      prepareTargetRoots: [workspaceRoot],
      collectSourceRoots: [workspaceRoot],
      readWriteRoots: [workspaceRoot],
    },
    async createSandbox() {
      return { id: "provider-sandbox-new" };
    },
    async getSandbox() {
      return {};
    },
    async deleteSandbox(providerSandboxId) {
      deletedSandboxIds.push(providerSandboxId);
      await deleteHandler(providerSandboxId);
    },
    async execute(input) {
      modelExecuteTimeouts.push(input.timeoutMs);
      return { output: "model-ok", exitCode: 0, truncated: false };
    },
    async executeSystem(input) {
      if (options.executeSystem) return options.executeSystem(input);
      if (input.command.includes("SOURCEWEFT_CANONICAL_PATH=")) {
        const target = canonicalTarget(input.command);
        return {
          output: `SOURCEWEFT_CANONICAL_PATH=${canonicalOverrides.get(target) ?? target}`,
          exitCode: 0,
          truncated: false,
        };
      }
      if (input.command.includes("SOURCEWEFT_MANIFEST_BEGIN")) {
        const reply = manifestReplies.shift() ?? { output: defaultManifest };
        return {
          output: reply.output,
          exitCode: reply.exitCode ?? 0,
          truncated: reply.truncated ?? false,
        };
      }
      if (input.command.includes("SOURCEWEFT_FILE=")) {
        const target = canonicalTarget(input.command);
        const content = files.get(target);
        return content
          ? {
              output: `SOURCEWEFT_FILE=${content.byteLength}\t100\t1\t${target}`,
              exitCode: 0,
              truncated: false,
            }
          : { output: "", exitCode: 1, truncated: false };
      }
      const captured = {
        command: input.command,
        timeoutMs: input.timeoutMs,
        maxOutputChars: input.maxOutputChars,
        ...(input.signal ? { signal: input.signal } : {}),
      };
      executeInputs.push(captured);
      return commandHandler(captured);
    },
    async uploadFile(input) {
      await uploadHandler(input);
    },
    async downloadFile(input) {
      downloadInputs.push(input);
      return downloadHandler(input);
    },
    async ensureDirectory() {},
  };

  const sandboxStore: SandboxStore = {
    async findLatestActiveThreadSandbox() {
      return {
        id: "sandbox-generation-1",
        provider: provider.id,
        providerSandboxId: "provider-sandbox-1",
        teamId: context.teamId,
        workspaceId: context.workspaceId,
        threadId: context.threadId,
        userId: context.userId,
        status: "ready",
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
    async markCreatingSandboxError() {
      return true;
    },
    async insertCreatingSandbox() {
      return true;
    },
    async markSandboxReady() {
      return true;
    },
    async markSandboxExpired(input) {
      expiredSandboxIds.push(input.sandboxId);
      return true;
    },
    async releaseReadyThreadSandboxLease() {
      return 1;
    },
    async touchSandbox() {
      return true;
    },
  };

  const operationStore: SandboxOperationStore = {
    async listMessageOperations() {
      return [];
    },
    async findLatestToolOperation() {
      return null;
    },
    async insertRunningToolOperation() {
      return true;
    },
    async findLatestActiveToolOperation() {
      return null;
    },
    async markStaleRunningToolOperationFailed() {
      return false;
    },
    async completeToolOperation() {},
    async recordOperation(input) {
      recordedOperations.push(input);
    },
    async findSucceededOperationByToolCall() {
      return null;
    },
  };

  const runtime = createSandboxRuntimeForTurn({
    filesystem: {} as never,
    context,
    limits,
    provider,
    sandboxStore,
    operationStore,
    toolApprovalEnabled: false,
  });

  return {
    cancellationInputs,
    canonicalOverrides,
    deletedSandboxIds,
    downloadInputs,
    executeInputs,
    expiredSandboxIds,
    files,
    manifestReplies,
    modelExecuteTimeouts,
    recordedOperations,
    runtime,
    setCommandHandler(handler: typeof commandHandler) {
      commandHandler = handler;
    },
    setCancellationHandler(
      handler: (
        input: (typeof cancellationInputs)[number],
      ) => Promise<SandboxCancellationResult>,
      scope: "command" | "sandbox" = "sandbox",
    ) {
      provider.cancellationScope = scope;
      provider.cancelExecution = async (input) => {
        cancellationInputs.push(input);
        return handler(input);
      };
    },
    setDeleteHandler(handler: typeof deleteHandler) {
      deleteHandler = handler;
    },
    setDownloadHandler(handler: typeof downloadHandler) {
      downloadHandler = handler;
    },
    setUploadHandler(handler: typeof uploadHandler) {
      uploadHandler = handler;
    },
    uploads,
  };
}

describe("trusted sandbox host adapter", () => {
  test("exposes the current session generation and allowed roots", async () => {
    const { runtime } = createHarness();

    assert.deepEqual(runtime.trustedHost.allowedReadRoots, ["/workspace"]);
    assert.deepEqual(await runtime.trustedHost.ensureCurrentSession(), {
      sessionGeneration: "sandbox-generation-1",
      hostLimits: {
        commandTimeoutMs: 5_000,
        maxOutputChars: 4_000,
        maxUploadFileBytes: 8,
        maxUploadTotalBytes: 12,
        maxDownloadFileBytes: 8,
        maxDownloadTotalBytes: 12,
        maxCaptureFiles: 200,
      },
    });
  });

  test("uploads bounded binary files after canonical path checks", async () => {
    const { runtime, uploads } = createHarness();

    await runtime.trustedHost.uploadCurrentFiles([
      { path: "/workspace/project/c.bin", bytes: new Uint8Array([1, 2]) },
      { path: "/workspace/project/d.bin", bytes: new Uint8Array([3]) },
    ]);

    assert.deepEqual(
      uploads.map((item) => item.path),
      ["/workspace/project/c.bin", "/workspace/project/d.bin"],
    );
    await assert.rejects(
      runtime.trustedHost.uploadCurrentFiles([
        { path: "/workspace/project/too-large.bin", bytes: new Uint8Array(9) },
      ]),
      /SANDBOX_HOST_UPLOAD_FILE_TOO_LARGE/u,
    );
    await assert.rejects(
      runtime.trustedHost.uploadCurrentFiles([
        { path: "/workspace/project/e.bin", bytes: new Uint8Array(7) },
        { path: "/workspace/project/f.bin", bytes: new Uint8Array(6) },
      ]),
      /SANDBOX_HOST_UPLOAD_TOTAL_LIMIT/u,
    );
  });

  test("rejects a canonical path that escapes through a symlink", async () => {
    const { canonicalOverrides, runtime, uploads } = createHarness();
    canonicalOverrides.set("/workspace/link/secret", "/etc/secret");

    await assert.rejects(
      runtime.trustedHost.uploadCurrentFiles([
        { path: "/workspace/link/secret", bytes: new Uint8Array([1]) },
      ]),
      /SANDBOX_HOST_SYMLINK_ESCAPE/u,
    );
    assert.equal(uploads.length, 0);
  });

  test("lists and captures a bounded symlink-free tree", async () => {
    const { runtime } = createHarness();

    assert.deepEqual(
      await runtime.trustedHost.listCurrentFiles({
        root: "/workspace/project",
      }),
      ["/workspace/project/a.txt", "/workspace/project/b.bin"],
    );
    assert.deepEqual(
      await runtime.trustedHost.captureCurrentTree({
        root: "/workspace/project",
        maxFiles: 2,
        maxTotalBytes: 5,
      }),
      [
        { relativePath: "a.txt", bytes: new Uint8Array(Buffer.from("abc")) },
        { relativePath: "b.bin", bytes: new Uint8Array([4, 5]) },
      ],
    );
  });

  test("rejects symlinks, changing trees, and caller limits above host ceilings", async () => {
    const symlinkHarness = createHarness();
    symlinkHarness.manifestReplies.push({
      exitCode: 73,
      output: "SOURCEWEFT_SYMLINK=/workspace/project/link",
    });
    await assert.rejects(
      symlinkHarness.runtime.trustedHost.listCurrentFiles({
        root: "/workspace/project",
      }),
      /SANDBOX_HOST_SYMLINK_DENIED/u,
    );

    const changingHarness = createHarness();
    changingHarness.manifestReplies.push(
      {
        output: [
          "SOURCEWEFT_MANIFEST_BEGIN",
          "3\t100\t1\t/workspace/project/a.txt",
          "SOURCEWEFT_MANIFEST_END",
        ].join("\n"),
      },
      {
        output: [
          "SOURCEWEFT_MANIFEST_BEGIN",
          "3\t101\t1\t/workspace/project/a.txt",
          "SOURCEWEFT_MANIFEST_END",
        ].join("\n"),
      },
    );
    await assert.rejects(
      changingHarness.runtime.trustedHost.captureCurrentTree({
        root: "/workspace/project",
        maxFiles: 1,
        maxTotalBytes: 3,
      }),
      /SANDBOX_HOST_TREE_CHANGED/u,
    );
    await assert.rejects(
      changingHarness.runtime.trustedHost.captureCurrentTree({
        root: "/workspace/project",
        maxFiles: 201,
        maxTotalBytes: 3,
      }),
      /SANDBOX_HOST_CAPTURE_LIMIT_INVALID/u,
    );
  });

  test("downloads binary bytes only after bounded stat and post-read verification", async () => {
    const { files, runtime } = createHarness();

    assert.deepEqual(
      await runtime.trustedHost.downloadCurrentFile({
        sandboxPath: "/workspace/project/a.txt",
      }),
      new Uint8Array(Buffer.from("abc")),
    );
    files.set("/workspace/project/large.bin", Buffer.alloc(9));
    await assert.rejects(
      runtime.trustedHost.downloadCurrentFile({
        sandboxPath: "/workspace/project/large.bin",
      }),
      /SANDBOX_HOST_DOWNLOAD_TOO_LARGE/u,
    );
  });

  test(
    "downloads a real Linux file through the emitted stat command",
    {
      skip: process.platform !== "linux",
    },
    async (t) => {
      const workspaceRoot = await mkdtemp(
        join(tmpdir(), "sourceweft-file-stat-"),
      );
      t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
      const file = join(workspaceRoot, "deck with spaces.bin");
      const bytes = Buffer.from([0x50, 0x4b, 0x00, 0xff]);
      await writeFile(file, bytes);
      const execute = promisify(execFile);
      const harness = createHarness({
        workspaceRoot,
        executeSystem: async (input) => {
          const result = await execute("sh", ["-c", input.command], {
            timeout: input.timeoutMs,
            signal: input.signal,
            maxBuffer: input.maxOutputChars,
          });
          return {
            output: result.stdout + result.stderr,
            exitCode: 0,
            truncated: false,
          };
        },
      });
      harness.setDownloadHandler((input) => readFile(input.sandboxPath));
      assert.deepEqual(
        await harness.runtime.trustedHost.downloadCurrentFile({
          sandboxPath: file,
        }),
        new Uint8Array(bytes),
      );
    },
  );

  test("download cancellation waits for physical sandbox termination", async () => {
    const harness = createHarness();
    harness.setDownloadHandler(() => new Promise<never>(() => undefined));
    let cleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    harness.setDeleteHandler(async () => {
      cleanupStarted();
      await release;
    });
    const controller = new AbortController();
    const download = harness.runtime.trustedHost.downloadCurrentFile({
      sandboxPath: "/workspace/project/a.txt",
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    while (harness.downloadInputs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();
    await started;
    let settled = false;
    void download.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    assert.equal(settled, false);
    releaseCleanup();
    await assert.rejects(download, (error: unknown) => {
      assert.equal(
        (error as { physicalCancellationConfirmed?: unknown })
          .physicalCancellationConfirmed,
        true,
      );
      return true;
    });
    assert.equal(harness.downloadInputs[0]?.signal?.aborted, true);
    assert.equal(harness.downloadInputs[0]?.timeoutMs, 5_000);
    assert.deepEqual(harness.deletedSandboxIds, ["provider-sandbox-1"]);
    assert.deepEqual(harness.expiredSandboxIds, ["sandbox-generation-1"]);
  });

  test("upload cancellation deletes the pinned sandbox and waits for confirmation", async () => {
    const harness = createHarness();
    let uploadStarted!: () => void;
    let releaseUpload!: () => void;
    let deletionStarted!: () => void;
    let releaseDeletion!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const uploadRelease = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const deleting = new Promise<void>((resolve) => {
      deletionStarted = resolve;
    });
    const deletionRelease = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    harness.setUploadHandler(async () => {
      uploadStarted();
      await uploadRelease;
    });
    harness.setDeleteHandler(async () => {
      deletionStarted();
      await deletionRelease;
    });
    const controller = new AbortController();
    const upload = harness.runtime.trustedHost.uploadCurrentFiles(
      [{ path: "/workspace/project/new.bin", bytes: new Uint8Array([1]) }],
      { signal: controller.signal, timeoutMs: 5_000 },
    );
    await started;
    controller.abort();
    await deleting;

    let settled = false;
    void upload.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    assert.equal(settled, false);

    releaseDeletion();
    await assert.rejects(
      upload,
      (error: unknown) =>
        (error as { code?: unknown }).code ===
        "SANDBOX_HOST_OPERATION_CANCELLED",
    );
    assert.deepEqual(harness.deletedSandboxIds, ["provider-sandbox-1"]);
    assert.deepEqual(harness.expiredSandboxIds, ["sandbox-generation-1"]);
    releaseUpload();
  });

  test("capture cancellation deletes the pinned sandbox and discards late bytes", async () => {
    const harness = createHarness();
    let downloadStarted!: () => void;
    let releaseDownload!: () => void;
    let deletionStarted!: () => void;
    let releaseDeletion!: () => void;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const downloadRelease = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const deleting = new Promise<void>((resolve) => {
      deletionStarted = resolve;
    });
    const deletionRelease = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    harness.setDownloadHandler(async () => {
      downloadStarted();
      await downloadRelease;
      return Buffer.from("abc");
    });
    harness.setDeleteHandler(async () => {
      deletionStarted();
      await deletionRelease;
    });
    const controller = new AbortController();
    const capture = harness.runtime.trustedHost.captureCurrentTree({
      root: "/workspace/project",
      maxFiles: 2,
      maxTotalBytes: 12,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    await started;
    controller.abort();
    await deleting;
    assert.equal(harness.downloadInputs[0]?.signal?.aborted, true);

    releaseDeletion();
    await assert.rejects(
      capture,
      (error: unknown) =>
        (error as { code?: unknown }).code ===
        "SANDBOX_HOST_OPERATION_CANCELLED",
    );
    assert.deepEqual(harness.deletedSandboxIds, ["provider-sandbox-1"]);
    assert.deepEqual(harness.expiredSandboxIds, ["sandbox-generation-1"]);
    releaseDownload();
  });

  test("uses batch only for trusted commands and keeps model execution interactive", async () => {
    const { executeInputs, modelExecuteTimeouts, recordedOperations, runtime } =
      createHarness();

    const result = await runtime.trustedHost.executeCurrent({
      command: "API_TOKEN=super-secret npm test",
      timeoutMs: 60_000,
    });

    assert.deepEqual(result, { output: "ok", exitCode: 0, truncated: false });
    assert.equal(executeInputs[0]?.timeoutMs, 5_000);
    assert.equal(executeInputs[0]?.maxOutputChars, 4_000);
    assert.equal(recordedOperations.length, 1);
    assert.equal(recordedOperations[0]?.status, "succeeded");
    assert.doesNotMatch(JSON.stringify(recordedOperations[0]), /super-secret/u);
    const modelResult = await runtime.backend.execute("npm test", {
      toolCallId: "model-execute-call",
    });
    assert.equal(modelResult.output, "model-ok");
    assert.deepEqual(modelExecuteTimeouts, [1_000]);
    await assert.rejects(
      runtime.trustedHost.executeCurrent({
        command: "npm test",
        timeoutMs: 600_001,
      }),
      /SANDBOX_HOST_EXECUTE_TIMEOUT_INVALID/u,
    );
  });

  test("deletes a sandbox to confirm cancellation and discards its late result", async () => {
    const {
      deletedSandboxIds,
      executeInputs,
      expiredSandboxIds,
      recordedOperations,
      runtime,
      setCommandHandler,
    } = createHarness();
    let release!: () => void;
    const providerFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    setCommandHandler(async () => {
      await providerFinished;
      return { output: "late", exitCode: 0, truncated: false };
    });
    const controller = new AbortController();
    const execution = runtime.trustedHost.executeCurrent({
      command: "npm test",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    while (executeInputs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();
    assert.equal(executeInputs[0]?.signal, controller.signal);
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, true);

    await assert.rejects(execution, (error: unknown) => {
      assert.equal((error as { name?: unknown }).name, "AbortError");
      assert.equal(
        (error as { physicalCancellationConfirmed?: unknown })
          .physicalCancellationConfirmed,
        true,
      );
      assert.equal(
        (error as { cancellationMode?: unknown }).cancellationMode,
        "sandbox",
      );
      return true;
    });
    assert.deepEqual(deletedSandboxIds, ["provider-sandbox-1"]);
    assert.deepEqual(expiredSandboxIds, ["sandbox-generation-1"]);
    assert.equal(recordedOperations[0]?.status, "canceled");
    assert.equal(
      (recordedOperations[0]?.result as Record<string, unknown>)
        .resultDiscarded,
      true,
    );
    assert.equal(
      (recordedOperations[0]?.result as Record<string, unknown>)
        .physicalCancellationConfirmed,
      true,
    );
    release();
    await providerFinished;
  });

  test("keeps the sandbox reusable after confirmed command cancellation", async () => {
    const harness = createHarness();
    let release!: () => void;
    harness.setCommandHandler(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ output: "late", exitCode: 0, truncated: false });
        }),
    );
    harness.setCancellationHandler(
      async () => ({
        confirmed: true,
        mode: "command",
      }),
      "command",
    );
    const controller = new AbortController();
    const execution = harness.runtime.trustedHost.executeCurrent({
      command: "npm test",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    while (harness.executeInputs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();

    await assert.rejects(execution, (error: unknown) => {
      assert.equal(
        (error as { physicalCancellationConfirmed?: unknown })
          .physicalCancellationConfirmed,
        true,
      );
      assert.equal(
        (error as { cancellationMode?: unknown }).cancellationMode,
        "command",
      );
      return true;
    });
    assert.equal(harness.cancellationInputs.length, 1);
    assert.match(
      harness.cancellationInputs[0]?.executionId ?? "",
      /^[0-9a-f-]{36}$/u,
    );
    assert.equal(harness.deletedSandboxIds.length, 0);
    assert.equal(harness.expiredSandboxIds.length, 0);
    release();
  });

  test("discards a sibling result after sandbox-scoped cancellation", async () => {
    const harness = createHarness();
    let releaseSibling!: () => void;
    const siblingRelease = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    harness.setCommandHandler(async (input) => {
      if (input.command === "cancel-me") {
        await new Promise<never>(() => undefined);
      }
      await siblingRelease;
      return { output: "late sibling", exitCode: 0, truncated: false };
    });
    const controller = new AbortController();
    const cancelled = harness.runtime.trustedHost.executeCurrent({
      command: "cancel-me",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    const sibling = harness.runtime.trustedHost.executeCurrent({
      command: "sibling",
      timeoutMs: 5_000,
    });
    while (harness.executeInputs.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();
    releaseSibling();
    await assert.rejects(cancelled);
    await assert.rejects(
      sibling,
      (error: unknown) =>
        (error as { code?: unknown }).code ===
        "SANDBOX_EXECUTION_RESULT_DISCARDED",
    );
  });

  test("propagates unknown termination to a sibling result", async () => {
    const harness = createHarness();
    let releaseSibling!: () => void;
    const siblingRelease = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    harness.setCommandHandler(async (input) => {
      if (input.command === "cancel-me") {
        await new Promise<never>(() => undefined);
      }
      await siblingRelease;
      return { output: "late sibling", exitCode: 0, truncated: false };
    });
    harness.setCancellationHandler(async () => ({
      confirmed: false,
      mode: "unknown",
    }));
    const controller = new AbortController();
    const cancelled = harness.runtime.trustedHost.executeCurrent({
      command: "cancel-me",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    const sibling = harness.runtime.trustedHost.executeCurrent({
      command: "sibling",
      timeoutMs: 5_000,
    });
    while (harness.executeInputs.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();
    releaseSibling();
    await assert.rejects(cancelled);
    await assert.rejects(
      sibling,
      (error: unknown) =>
        (error as { code?: unknown }).code === "SANDBOX_TERMINATION_UNKNOWN",
    );
  });

  test("reports termination unknown and quarantines the sandbox when delete fails", async () => {
    const harness = createHarness();
    harness.setCommandHandler(() => new Promise(() => {}));
    harness.setDeleteHandler(async () => {
      throw new Error("provider delete failed");
    });
    const controller = new AbortController();
    const execution = harness.runtime.trustedHost.executeCurrent({
      command: "npm test",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    while (harness.executeInputs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();

    await assert.rejects(execution, (error: unknown) => {
      assert.equal(
        (error as { code?: unknown }).code,
        "SANDBOX_TERMINATION_UNKNOWN",
      );
      assert.equal(
        (error as { physicalCancellationConfirmed?: unknown })
          .physicalCancellationConfirmed,
        false,
      );
      assert.equal(
        (error as { cancellationMode?: unknown }).cancellationMode,
        "unknown",
      );
      return true;
    });
    assert.deepEqual(harness.expiredSandboxIds, ["sandbox-generation-1"]);
  });

  test("preserves timeout semantics while confirming physical termination", async () => {
    const harness = createHarness();
    harness.setCommandHandler(() => new Promise(() => {}));
    harness.setCancellationHandler(
      async () => ({
        confirmed: true,
        mode: "command",
      }),
      "command",
    );
    const controller = new AbortController();
    const execution = harness.runtime.trustedHost.executeCurrent({
      command: "npm test",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    while (harness.executeInputs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort(new DOMException("tool timeout", "TimeoutError"));

    await assert.rejects(execution, (error: unknown) => {
      assert.equal((error as { name?: unknown }).name, "TimeoutError");
      assert.equal(
        (error as { code?: unknown }).code,
        "SANDBOX_HOST_OPERATION_TIMED_OUT",
      );
      return true;
    });
    assert.equal(harness.cancellationInputs[0]?.reason, "timed_out");
  });

  test("physically terminates the sandbox after a provider command timeout", async () => {
    const harness = createHarness();
    harness.setCommandHandler(async () => {
      throw new Error(
        "SANDBOX_COMMAND_TIMEOUT: sandbox command exceeded the configured timeout.",
      );
    });

    await assert.rejects(
      harness.runtime.trustedHost.executeCurrent({
        command: "npm test",
        timeoutMs: 5_000,
      }),
      (error: unknown) => {
        assert.equal((error as { name?: unknown }).name, "TimeoutError");
        assert.equal(
          (error as { code?: unknown }).code,
          "SANDBOX_HOST_OPERATION_TIMED_OUT",
        );
        assert.equal(
          (error as { physicalCancellationConfirmed?: unknown })
            .physicalCancellationConfirmed,
          true,
        );
        return true;
      },
    );
    assert.deepEqual(harness.deletedSandboxIds, ["provider-sandbox-1"]);
    assert.deepEqual(harness.expiredSandboxIds, ["sandbox-generation-1"]);
  });
});
