import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceWeftSandboxBackend } from "../../src/runtime/sourceweft-sandbox-backend";
import {
  SandboxProviderError,
  SANDBOX_PROVIDER_ERROR_CODES,
  SANDBOX_RESTARTED_NOTICE,
} from "../../src/runtime/errors";
import { SandboxManager } from "../../src/runtime/sandbox-manager";
import {
  maxSandboxCommandTimeoutMs,
  resolveSandboxCommandTimeoutMs,
} from "../../src/runtime/command-budgets";
import type {
  SandboxOperationStore,
  SandboxProvider,
  SandboxProviderPathPolicy,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStore,
} from "../../src/runtime/types";
import type { RuntimeAssetPlan } from "../../src/runtime/runtime-assets";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const TEST_SANDBOX_PATH_POLICY: SandboxProviderPathPolicy = {
  workspaceRoot: "/workspace",
  defaultCwd: "/workspace",
  prepareTargetRoots: ["/workspace/input", "/workspace"],
  collectSourceRoots: ["/workspace/output", "/workspace"],
  readWriteRoots: ["/workspace"],
};

const context: SandboxRuntimeContext = {
  teamId: "team-sandbox-backend-test",
  workspaceId: "workspace-sandbox-backend-test",
  threadId: "thread-sandbox-backend-test",
  userId: "user-sandbox-backend-test",
  messageId: "message-sandbox-backend-test",
  runId: "run-sandbox-backend-test",
  sandboxExecuteToolCallId: "tool-call-execute",
};

const contextWithoutExecuteToolCallId: SandboxRuntimeContext = {
  ...context,
  sandboxExecuteToolCallId: undefined,
};

const limits: SandboxRuntimeLimits = {
  ttlSeconds: 3600,
  commandBudgetsMs: { interactive: 1000, batch: 4000 },
  maxCommandTimeoutMs: 10000,
  maxOutputChars: 10000,
  maxPrepareFileBytes: 10000,
  maxPrepareTotalBytes: 10000,
  maxCollectFileBytes: 10000,
  maxCollectTotalBytes: 10000,
};

function createSandboxStore(): SandboxStore & { releaseReasons: string[] } {
  const releaseReasons: string[] = [];
  return {
    releaseReasons,
    async findLatestActiveThreadSandbox() {
      return {
        id: "sandbox-record-1",
        provider: "fake",
        providerSandboxId: "provider-sandbox-1",
        teamId: context.teamId,
        workspaceId: context.workspaceId,
        threadId: context.threadId,
        userId: context.userId,
        status: "ready",
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
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
    async markSandboxExpired() {
      return true;
    },
    async releaseReadyThreadSandboxLease(input) {
      releaseReasons.push(input.reason);
      return 1;
    },
    async touchSandbox() {
      return true;
    },
  };
}

function createOperationStore(): SandboxOperationStore & {
  completed: Array<{
    operationId: string;
    result?: Record<string, unknown>;
    status: "succeeded" | "failed";
  }>;
  inserted: Array<Record<string, unknown>>;
} {
  const store: SandboxOperationStore & {
    completed: Array<{
      operationId: string;
      result?: Record<string, unknown>;
      status: "succeeded" | "failed";
    }>;
    inserted: Array<Record<string, unknown>>;
  } = {
    completed: [],
    inserted: [],
    async listMessageOperations() {
      return [];
    },
    async findLatestToolOperation() {
      return null;
    },
    async insertRunningToolOperation(input) {
      store.inserted.push(input.request);
      return true;
    },
    async findLatestActiveToolOperation() {
      return null;
    },
    async markStaleRunningToolOperationFailed() {
      return false;
    },
    async completeToolOperation(input) {
      store.completed.push({
        operationId: input.operationId,
        status: input.status,
        result: input.result,
      });
    },
    async recordOperation() {},
    async findSucceededOperationByToolCall() {
      return null;
    },
  };
  return store;
}

function createNullOperationStore(): SandboxOperationStore {
  return {
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
    async recordOperation() {},
    async findSucceededOperationByToolCall() {
      return null;
    },
  };
}

function createReplayOperationStore(): SandboxOperationStore & {
  inserts: Array<{
    operationId: string;
    operationType: string;
    request: Record<string, unknown>;
    toolCallId: string;
  }>;
} {
  const operations = new Map<
    string,
    {
      messageId: string;
      operationId: string;
      request: Record<string, unknown>;
      result: Record<string, unknown>;
      status: "running" | "succeeded" | "failed";
      toolCallId: string;
    }
  >();
  const keyFor = (input: {
    context: SandboxRuntimeContext;
    operationType: string;
    toolCallId: string;
  }) => `${input.context.messageId}:${input.operationType}:${input.toolCallId}`;
  const inserts: Array<{
    operationId: string;
    operationType: string;
    request: Record<string, unknown>;
    toolCallId: string;
  }> = [];

  return {
    inserts,
    async listMessageOperations() {
      return [];
    },
    async findLatestToolOperation(input) {
      const operation = operations.get(keyFor(input));
      return operation
        ? {
            status: operation.status,
            messageId: operation.messageId,
            requestJsonRedacted: operation.request,
            resultJsonRedacted: operation.result,
          }
        : null;
    },
    async insertRunningToolOperation(input) {
      inserts.push({
        operationId: input.operationId,
        operationType: input.operationType,
        request: input.request,
        toolCallId: input.toolCallId,
      });
      operations.set(keyFor(input), {
        operationId: input.operationId,
        messageId: input.context.messageId,
        request: input.request,
        result: {},
        status: "running",
        toolCallId: input.toolCallId,
      });
      return true;
    },
    async findLatestActiveToolOperation(input) {
      const operation = operations.get(keyFor(input));
      return operation
        ? {
            id: operation.operationId,
            status: operation.status,
            messageId: operation.messageId,
            requestJsonRedacted: operation.request,
            resultJsonRedacted: operation.result,
          }
        : null;
    },
    async markStaleRunningToolOperationFailed(input) {
      const operation = operations.get(keyFor(input));
      if (operation?.status !== "running") {
        return false;
      }
      operation.status = "failed";
      operation.result = input.result;
      return true;
    },
    async completeToolOperation(input) {
      const operation = Array.from(operations.values()).find(
        (candidate) => candidate.operationId === input.operationId,
      );
      if (!operation) {
        return;
      }
      operation.status = input.status;
      operation.result = input.result ?? {};
    },
    async recordOperation() {},
    async findSucceededOperationByToolCall(input) {
      const operation = operations.get(keyFor(input));
      return operation?.status === "succeeded"
        ? { result: operation.result }
        : null;
    },
  };
}

function createProvider() {
  const files = new Map<string, Uint8Array>();
  const executeInputs: Array<{
    command: string;
    cwd?: string;
    executionId?: string;
    maxOutputChars: number;
    providerSandboxId: string;
    signal?: AbortSignal;
    timeoutMs: number;
  }> = [];
  const systemExecuteInputs: Array<{
    command: string;
    cwd?: string;
    idempotent?: boolean;
    maxOutputChars: number;
    providerSandboxId: string;
    timeoutMs: number;
  }> = [];
  const provider: SandboxProvider & {
    executed: string[];
    executeInputs: typeof executeInputs;
    systemExecuted: string[];
    systemExecuteInputs: typeof systemExecuteInputs;
    ensuredDirectories: string[];
    uploadedFiles: string[];
  } = {
    id: "fake",
    pathPolicy: TEST_SANDBOX_PATH_POLICY,
    executed: [],
    executeInputs,
    systemExecuted: [],
    systemExecuteInputs,
    ensuredDirectories: [],
    uploadedFiles: [],
    async createSandbox() {
      return { id: "provider-sandbox-1" };
    },
    async getSandbox() {
      return {};
    },
    async deleteSandbox() {},
    async execute(input) {
      provider.executeInputs.push(input);
      provider.executed.push(input.command);
      return { output: "user execute", exitCode: 0, truncated: false };
    },
    async executeSystem(input) {
      provider.systemExecuteInputs.push(input);
      provider.systemExecuted.push(input.command);
      if (input.command.startsWith("awk ")) {
        const match = input.command.match(/'([^']+)'$/u);
        const path = match?.[1] ?? "";
        const content = files.get(path);
        return {
          output: content ? new TextDecoder().decode(content) : "",
          exitCode: content ? 0 : 1,
          truncated: false,
        };
      }
      return { output: "", exitCode: 0, truncated: false };
    },
    async uploadFile(input) {
      // Mirrors the real providers: a bridge file route is workspace-relative
      // by construction (Cloudflare's is literally `/file/workspace/{rel}`), so
      // an upload outside /workspace cannot be addressed at all. Without this,
      // the fake accepted `/skills/...` uploads that every real provider
      // rejects, and skill staging looked healthy in tests while failing in
      // every sandbox.
      if (!input.sandboxPath.startsWith("/workspace/")) {
        throw new Error(
          `SANDBOX_FILE_PATH_DENIED: ${input.sandboxPath} is outside the /workspace root.`,
        );
      }
      provider.uploadedFiles.push(input.sandboxPath);
      files.set(input.sandboxPath, input.content);
    },
    async downloadFile(input) {
      const content = files.get(input.sandboxPath);
      if (!content) {
        throw new SandboxProviderError(
          SANDBOX_PROVIDER_ERROR_CODES.fileMissing,
          "SANDBOX_FILE_NOT_FOUND: requested sandbox file was not found.",
          "download",
        );
      }
      return Buffer.from(content);
    },
    async ensureDirectory(input) {
      provider.ensuredDirectories.push(input.directory);
    },
  };
  return { files, provider };
}

function createBackend() {
  const { files, provider } = createProvider();
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore: createNullOperationStore(),
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled: true,
  });
  return { backend, files, provider };
}

function createBackendWithOperationStore(
  operationStore: SandboxOperationStore,
  input: {
    runtimeContext?: SandboxRuntimeContext;
    toolApprovalEnabled?: boolean;
  } = {},
) {
  const { files, provider } = createProvider();
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore,
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context: input.runtimeContext ?? context,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled: input.toolApprovalEnabled ?? true,
  });
  return { backend, files, provider };
}

function createBackendWithProvider(
  provider: SandboxProvider,
  sandboxStore: SandboxStore = createSandboxStore(),
  operationStore: SandboxOperationStore = createOperationStore(),
  runtimeContext: SandboxRuntimeContext = context,
  toolApprovalEnabled = true,
) {
  const manager = new SandboxManager({
    provider,
    sandboxStore,
    operationStore,
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context: runtimeContext,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled,
  });
  return { backend, sandboxStore };
}

test("SourceWeftSandboxBackend reads and writes sandbox files without user execute bookkeeping", async () => {
  const { backend, provider } = createBackend();

  assert.equal(
    (await backend.write("/workspace/ppt-deck/report.txt", "hello")).path,
    "/workspace/ppt-deck/report.txt",
  );
  assert.equal(
    (await backend.read("/workspace/ppt-deck/report.txt")).content,
    "hello",
  );
  assert.deepEqual(provider.executed, []);
  assert.ok(
    provider.systemExecuted.some((command) => command.startsWith("awk ")),
  );
});

test("SourceWeftSandboxBackend aborts a blocked write, waits for sandbox deletion, and discards the late upload", async () => {
  const { provider } = createProvider();
  const uploadStarted = deferred<void>();
  const lateUpload = deferred<void>();
  const deletionStarted = deferred<void>();
  const deletionConfirmed = deferred<void>();
  let uploadedAfterAbort = false;
  provider.uploadFile = async () => {
    uploadStarted.resolve();
    await lateUpload.promise;
    uploadedAfterAbort = true;
  };
  provider.deleteSandbox = async () => {
    deletionStarted.resolve();
    await deletionConfirmed.promise;
  };
  const { backend } = createBackendWithProvider(provider);
  const controller = new AbortController();
  const invocation = backend.write("/workspace/late.txt", "late", {
    signal: controller.signal,
  });
  void invocation.catch(() => undefined);

  await uploadStarted.promise;
  controller.abort(new DOMException("user stopped", "AbortError"));
  await deletionStarted.promise;
  lateUpload.resolve();
  await Promise.resolve();
  let settled = false;
  void invocation
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  await Promise.resolve();
  assert.equal(settled, false);

  deletionConfirmed.resolve();
  await assert.rejects(invocation, (error: unknown) => {
    assert.equal(
      (error as { code?: unknown }).code,
      "SANDBOX_OPERATION_CANCELLED",
    );
    return true;
  });
  assert.equal(uploadedAfterAbort, true);
});

test("SourceWeftSandboxBackend aborts a blocked read command and never returns late bytes", async () => {
  const { provider } = createProvider();
  const readStarted = deferred<void>();
  const lateRead = deferred<{
    output: string;
    exitCode: number;
    truncated: boolean;
  }>();
  let deleteCalls = 0;
  provider.executeSystem = async (input) => {
    provider.systemExecuteInputs.push(input);
    readStarted.resolve();
    return lateRead.promise;
  };
  provider.deleteSandbox = async () => {
    deleteCalls += 1;
  };
  const { backend } = createBackendWithProvider(provider);
  const controller = new AbortController();
  const invocation = backend.read("/workspace/late.txt", 0, 20, {
    signal: controller.signal,
  });
  void invocation.catch(() => undefined);

  await readStarted.promise;
  controller.abort(
    Object.assign(new Error("tool deadline elapsed"), {
      code: "AGENT_TOOL_EXECUTION_TIMEOUT",
      name: "TimeoutError",
    }),
  );
  await assert.rejects(invocation, (error: unknown) => {
    assert.equal(
      (error as { code?: unknown }).code,
      "SANDBOX_OPERATION_TIMED_OUT",
    );
    return true;
  });
  assert.equal(deleteCalls, 1);

  lateRead.resolve({ output: "late bytes", exitCode: 0, truncated: false });
  await Promise.resolve();
});

test("SourceWeftSandboxBackend physically cancels blocked uploadFiles and downloadFiles", async () => {
  for (const operation of ["upload", "download"] as const) {
    const { provider } = createProvider();
    const started = deferred<void>();
    const late = deferred<void>();
    let deleteCalls = 0;
    provider.deleteSandbox = async () => {
      deleteCalls += 1;
    };
    if (operation === "upload") {
      provider.uploadFile = async () => {
        started.resolve();
        await late.promise;
      };
    } else {
      provider.downloadFile = async () => {
        started.resolve();
        await late.promise;
        return Buffer.from("late");
      };
    }
    const { backend } = createBackendWithProvider(provider);
    const controller = new AbortController();
    const invocation =
      operation === "upload"
        ? backend.uploadFiles(
            [["/workspace/late.txt", new TextEncoder().encode("late")]],
            { signal: controller.signal },
          )
        : backend.downloadFiles(["/workspace/late.txt"], {
            signal: controller.signal,
          });
    void invocation.catch(() => undefined);

    await started.promise;
    controller.abort(new DOMException("user stopped", "AbortError"));
    await assert.rejects(invocation, (error: unknown) => {
      assert.equal(
        (error as { code?: unknown }).code,
        "SANDBOX_OPERATION_CANCELLED",
      );
      return true;
    });
    assert.equal(deleteCalls, 1, operation);
    late.resolve();
    await Promise.resolve();
  }
});

test("SourceWeftSandboxBackend rejects a file result from a replaced sandbox generation", async () => {
  const { provider } = createProvider();
  let activeProviderSandboxId = "provider-sandbox-1";
  const sandboxStore = {
    ...createSandboxStore(),
    async findLatestActiveThreadSandbox() {
      return {
        id:
          activeProviderSandboxId === "provider-sandbox-1"
            ? "sandbox-record-1"
            : "sandbox-record-2",
        provider: "fake",
        providerSandboxId: activeProviderSandboxId,
        teamId: context.teamId,
        workspaceId: context.workspaceId,
        threadId: context.threadId,
        userId: context.userId,
        status: "ready" as const,
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      };
    },
  } satisfies SandboxStore;
  const readStarted = deferred<void>();
  const lateRead = deferred<{
    output: string;
    exitCode: number;
    truncated: boolean;
  }>();
  provider.executeSystem = async () => {
    readStarted.resolve();
    return lateRead.promise;
  };
  const { backend } = createBackendWithProvider(provider, sandboxStore);
  const invocation = backend.read("/workspace/replaced.txt");
  void invocation.catch(() => undefined);

  await readStarted.promise;
  activeProviderSandboxId = "provider-sandbox-2";
  lateRead.resolve({ output: "stale", exitCode: 0, truncated: false });

  await assert.rejects(invocation, (error: unknown) => {
    assert.equal(
      (error as { code?: unknown }).code,
      "SANDBOX_INSTANCE_CHANGED",
    );
    return true;
  });
});

test("SourceWeftSandboxBackend rejects read_file on binary image files", async () => {
  const { backend, files, provider } = createBackend();
  files.set(
    "/workspace/ppt-deck/qa/slide-01.jpg",
    new Uint8Array([0xff, 0xd8, 0xff]),
  );

  const result = await backend.read("/workspace/ppt-deck/qa/slide-01.jpg");

  assert.match(result.error ?? "", /^READ_FILE_BINARY_UNSUPPORTED:/u);
  assert.match(result.error ?? "", /image\/jpeg/u);
  assert.equal(result.content, undefined);
  assert.equal(result.mimeType, "image/jpeg");
  assert.deepEqual(provider.systemExecuted, []);
});

test("SourceWeftSandboxBackend returns recoverable errors for sandbox file paths outside workspace", async () => {
  const { backend, provider } = createBackend();

  const read = await backend.read("/tmp/qa_hires/slide-01.jpg");
  const raw = await backend.readRaw("/tmp/qa_hires/slide-01.jpg");
  const ls = await backend.ls("/tmp/qa_hires");
  const grep = await backend.grep("slide", "/tmp/qa_hires");
  const glob = await backend.glob("*.jpg", "/tmp/qa_hires");

  for (const result of [read, raw, ls, grep, glob]) {
    assert.match(result.error ?? "", /SANDBOX_READ_PATH_DENIED/u);
    assert.match(result.error ?? "", /\/workspace/u);
  }
  assert.deepEqual(provider.systemExecuted, []);
});

test("SourceWeftSandboxBackend enforces grep maxCount at the protocol boundary", async () => {
  const { provider } = createProvider();
  provider.executeSystem = async () => ({
    output: ["/workspace/a.md:1:match a", "/workspace/b.md:2:match b"].join(
      "\n",
    ),
    exitCode: 0,
    truncated: false,
  });
  const { backend } = createBackendWithProvider(provider);
  const allMatches = [
    { path: "/workspace/a.md", line: 1, text: "match a" },
    { path: "/workspace/b.md", line: 2, text: "match b" },
  ];

  assert.deepEqual(await backend.grep("match", "/workspace", null, null), {
    matches: allMatches,
  });
  assert.deepEqual(await backend.grep("match", "/workspace", null, 2), {
    matches: allMatches,
  });
  assert.deepEqual(await backend.grep("match", "/workspace", null, 1), {
    error: undefined,
    matches: allMatches.slice(0, 1),
    truncated: true,
  });
});

test("SourceWeftSandboxBackend treats /skills as a SourceWeft DB-backed VFS path outside sandbox file tools", async () => {
  const { backend, provider } = createBackend();

  assert.match(
    (await backend.write("/skills/ppt-deck/SKILL.md", "x")).error ?? "",
    /SANDBOX_READ_PATH_DENIED/u,
  );
  assert.equal(
    (
      await backend.uploadFiles([
        ["/skills/ppt-deck/SKILL.md", new TextEncoder().encode("x")],
      ])
    )[0]?.error,
    "permission_denied",
  );
  const executeResult = await backend.execute(
    "node /skills/ppt-deck/scripts/run.js",
  );
  assert.equal(executeResult.exitCode, 1);
  assert.equal(executeResult.truncated, false);
  assert.match(executeResult.output, /SANDBOX_EXECUTE_VFS_PATH_DENIED/u);
  assert.match(executeResult.output, /\/skills/u);
  assert.deepEqual(provider.executed, []);
});

test("SourceWeftSandboxBackend does not stage skills before execute", async () => {
  const { backend, provider } = createBackend();

  assert.deepEqual(await backend.execute("node /workspace/ppt-deck/a.js"), {
    output: "user execute",
    exitCode: 0,
    truncated: false,
  });
  assert.deepEqual(provider.ensuredDirectories, []);
  assert.deepEqual(provider.uploadedFiles, []);
});

test("SourceWeftSandboxBackend passes raw execute commands with backend-controlled limits", async () => {
  const { backend, provider } = createBackend();
  const command =
    "GITHUB_TOKEN=caller-provided node /workspace/a.js && cat /workspace/source.md";

  assert.deepEqual(await backend.execute(command), {
    output: "user execute",
    exitCode: 0,
    truncated: false,
  });

  assert.equal(provider.executeInputs.length, 1);
  assert.deepEqual(
    {
      ...provider.executeInputs[0],
      executionId: typeof provider.executeInputs[0]?.executionId,
    },
    {
      providerSandboxId: "provider-sandbox-1",
      executionId: "string",
      command,
      cwd: "/workspace",
      timeoutMs: limits.commandBudgetsMs.interactive,
      maxOutputChars: limits.maxOutputChars,
    },
  );
});

test("SourceWeftSandboxBackend passes multiline execute commands through unchanged", async () => {
  const { backend, provider } = createBackend();
  const command = "set -e\npwd\necho ok";

  assert.deepEqual(await backend.execute(command), {
    output: "user execute",
    exitCode: 0,
    truncated: false,
  });

  assert.equal(provider.executeInputs.length, 1);
  assert.deepEqual(
    {
      ...provider.executeInputs[0],
      executionId: typeof provider.executeInputs[0]?.executionId,
    },
    {
      providerSandboxId: "provider-sandbox-1",
      executionId: "string",
      command,
      cwd: "/workspace",
      timeoutMs: limits.commandBudgetsMs.interactive,
      maxOutputChars: limits.maxOutputChars,
    },
  );
});

test("SourceWeftSandboxBackend returns recoverable failure for execute commands with control characters", async () => {
  const operationStore = createOperationStore();
  const { provider } = createProvider();
  const sandboxStore = createSandboxStore();
  const { backend } = createBackendWithProvider(
    provider,
    sandboxStore,
    operationStore,
  );

  const result = await backend.execute("node good\u0000bad");

  assert.equal(result.exitCode, 1);
  assert.equal(result.truncated, false);
  assert.match(result.output, /SANDBOX_EXECUTE_COMMAND_DENIED/u);
  assert.match(result.output, /unsafe control characters/u);
  assert.match(
    result.output,
    /Diagnostics: toolName=execute commandFingerprint=sha256:/u,
  );
  assert.deepEqual(provider.executed, []);
  assert.deepEqual(sandboxStore.releaseReasons, []);
  assert.deepEqual(
    operationStore.completed.map((entry) => entry.status),
    ["succeeded"],
  );
  assert.equal(operationStore.inserted[0]?.command, "node good\\u0000bad");
  assert.equal(
    operationStore.inserted[0]?.commandContainsControlCharacters,
    true,
  );
  assert.doesNotMatch(String(operationStore.inserted[0]?.command), /\u0000/u);
  assert.equal(
    operationStore.completed[0]?.result?.failureCode,
    "SANDBOX_EXECUTE_COMMAND_DENIED",
  );
  assert.equal(operationStore.completed[0]?.result?.toolName, "execute");
  assert.equal(operationStore.completed[0]?.result?.runId, context.runId);
  assert.match(
    String(operationStore.completed[0]?.result?.commandFingerprint),
    /^sha256:/u,
  );
});

test("SourceWeftSandboxBackend returns recoverable failure for empty execute commands", async () => {
  const operationStore = createOperationStore();
  const { provider } = createProvider();
  const sandboxStore = createSandboxStore();
  const { backend } = createBackendWithProvider(
    provider,
    sandboxStore,
    operationStore,
  );

  const result = await backend.execute("   ");

  assert.equal(result.exitCode, 1);
  assert.equal(result.truncated, false);
  assert.match(result.output, /SANDBOX_EXECUTE_COMMAND_DENIED/u);
  assert.match(result.output, /command is empty/u);
  assert.deepEqual(provider.executed, []);
  assert.deepEqual(sandboxStore.releaseReasons, []);
  assert.equal(
    operationStore.completed[0]?.result?.failureCode,
    "SANDBOX_EXECUTE_COMMAND_DENIED",
  );
});

test("SourceWeftSandboxBackend returns recoverable failure for VFS paths in execute commands", async () => {
  const operationStore = createOperationStore();
  const { provider } = createProvider();
  const sandboxStore = createSandboxStore();
  const { backend } = createBackendWithProvider(
    provider,
    sandboxStore,
    operationStore,
  );

  const result = await backend.execute("mkdir -p /files/ppt-deck");

  assert.equal(result.exitCode, 1);
  assert.equal(result.truncated, false);
  assert.match(result.output, /SANDBOX_EXECUTE_VFS_PATH_DENIED/u);
  assert.match(result.output, /prepare_sandbox_workspace/u);
  assert.match(result.output, /\/workspace/u);
  assert.deepEqual(provider.executed, []);
  assert.deepEqual(sandboxStore.releaseReasons, []);
  assert.equal(
    operationStore.completed[0]?.result?.failureCode,
    "SANDBOX_EXECUTE_VFS_PATH_DENIED",
  );
});

test("SourceWeftSandboxBackend replays recoverable execute failures by tool call id", async () => {
  const operationStore = createReplayOperationStore();
  const { backend, provider } = createBackendWithOperationStore(operationStore);

  const first = await backend.execute("node good\u0000bad");
  const replay = await backend.execute("node good\u0000bad");

  assert.deepEqual(provider.executed, []);
  assert.equal(operationStore.inserts.length, 1);
  assert.deepEqual(replay, first);
  assert.equal(first.exitCode, 1);
  assert.match(first.output, /SANDBOX_EXECUTE_COMMAND_DENIED/u);
});

test("SourceWeftSandboxBackend escalates repeated recoverable execute failures in turn memory", async () => {
  const operationStore = createOperationStore();
  const { provider } = createProvider();
  const { backend } = createBackendWithProvider(
    provider,
    createSandboxStore(),
    operationStore,
    contextWithoutExecuteToolCallId,
    false,
  );

  const first = await backend.execute("node good\u0000bad", {
    toolCallId: "call-bad-1",
  });
  const second = await backend.execute("node good\u0000bad", {
    toolCallId: "call-bad-2",
  });

  assert.match(first.output, /SANDBOX_EXECUTE_COMMAND_DENIED/u);
  assert.doesNotMatch(first.output, /Repeated execute input failure/u);
  assert.match(second.output, /Repeated execute input failure detected/u);
  assert.match(second.output, /repeatCount=2/u);
  assert.deepEqual(provider.executed, []);
  assert.deepEqual(
    operationStore.completed.map((entry) => entry.result?.repeatCount),
    [1, 2],
  );
});

test("SourceWeftSandboxBackend escalates repeated VFS path execute failures in turn memory", async () => {
  const operationStore = createOperationStore();
  const { provider } = createProvider();
  const { backend } = createBackendWithProvider(
    provider,
    createSandboxStore(),
    operationStore,
    contextWithoutExecuteToolCallId,
    false,
  );

  const first = await backend.execute("ls /files", {
    toolCallId: "call-vfs-1",
  });
  const second = await backend.execute("ls /files", {
    toolCallId: "call-vfs-2",
  });

  assert.match(first.output, /SANDBOX_EXECUTE_VFS_PATH_DENIED/u);
  assert.doesNotMatch(first.output, /Repeated execute input failure/u);
  assert.match(second.output, /Repeated execute input failure detected/u);
  assert.match(second.output, /repeatCount=2/u);
  assert.deepEqual(provider.executed, []);
  assert.deepEqual(
    operationStore.completed.map((entry) => entry.result?.repeatCount),
    [1, 2],
  );
});

test("SourceWeftSandboxBackend returns recoverable failure for invalid execute cwd policy", async () => {
  const operationStore = createOperationStore();
  const { provider } = createProvider();
  provider.pathPolicy = {
    ...TEST_SANDBOX_PATH_POLICY,
    defaultCwd: "/etc",
  };
  const sandboxStore = createSandboxStore();
  const { backend } = createBackendWithProvider(
    provider,
    sandboxStore,
    operationStore,
  );

  const result = await backend.execute("node /workspace/ppt-deck/a.js");

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /SANDBOX_EXECUTE_CWD_DENIED/u);
  assert.deepEqual(provider.executed, []);
  assert.deepEqual(sandboxStore.releaseReasons, []);
  assert.equal(
    operationStore.completed[0]?.result?.failureCode,
    "SANDBOX_EXECUTE_CWD_DENIED",
  );
});

test("SourceWeftSandboxBackend rejects execute without approved stable tool call id when sandbox approval is enabled", async () => {
  const operationStore = createOperationStore();
  const { provider } = createProvider();
  const { backend } = createBackendWithProvider(
    provider,
    createSandboxStore(),
    operationStore,
    contextWithoutExecuteToolCallId,
    true,
  );

  await assert.rejects(
    () => backend.execute("node /workspace/ppt-deck/a.js"),
    /SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED/u,
  );
  assert.deepEqual(provider.executed, []);
  assert.deepEqual(operationStore.inserted, []);
  assert.deepEqual(operationStore.completed, []);
});

test("SourceWeftSandboxBackend executes with current tool call id when sandbox approval is disabled", async () => {
  const operationStore = createReplayOperationStore();
  const { backend, provider } = createBackendWithOperationStore(
    operationStore,
    {
      runtimeContext: contextWithoutExecuteToolCallId,
      toolApprovalEnabled: false,
    },
  );

  assert.deepEqual(
    await backend.execute("node /workspace/ppt-deck/a.js", {
      toolCallId: "call-runtime-execute",
    }),
    {
      output: "user execute",
      exitCode: 0,
      truncated: false,
    },
  );

  assert.deepEqual(provider.executed, ["node /workspace/ppt-deck/a.js"]);
  assert.equal(operationStore.inserts[0]?.toolCallId, "call-runtime-execute");
});

test("SourceWeftSandboxBackend rejects execute without current tool call id when sandbox approval is disabled", async () => {
  const operationStore = createOperationStore();
  const { provider } = createProvider();
  const { backend } = createBackendWithProvider(
    provider,
    createSandboxStore(),
    operationStore,
    contextWithoutExecuteToolCallId,
    false,
  );

  await assert.rejects(
    () => backend.execute("node /workspace/ppt-deck/a.js"),
    /SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED/u,
  );
  assert.deepEqual(provider.executed, []);
  assert.deepEqual(operationStore.inserted, []);
  assert.deepEqual(operationStore.completed, []);
});

test("SourceWeftSandboxBackend replays duplicate execute operations by canonical tool call id", async () => {
  const operationStore = createReplayOperationStore();
  const { backend, provider } = createBackendWithOperationStore(operationStore);

  assert.deepEqual(await backend.execute("node /workspace/ppt-deck/a.js"), {
    output: "user execute",
    exitCode: 0,
    truncated: false,
  });
  assert.deepEqual(await backend.execute("node /workspace/ppt-deck/a.js"), {
    output: "user execute",
    exitCode: 0,
    truncated: false,
  });

  assert.deepEqual(provider.executed, ["node /workspace/ppt-deck/a.js"]);
  assert.deepEqual(
    operationStore.inserts.map((operation) => ({
      operationType: operation.operationType,
      command: operation.request.command,
      hasFingerprint:
        typeof operation.request._sourceweftRequestFingerprint === "string",
      toolCallId: operation.toolCallId,
    })),
    [
      {
        operationType: "execute",
        command: "node /workspace/ppt-deck/a.js",
        hasFingerprint: true,
        toolCallId: "tool-call-execute",
      },
    ],
  );
});

test("SourceWeftSandboxBackend throws and records failed operation when execute provider throws", async () => {
  const { provider } = createProvider();
  provider.execute = async () => {
    throw new Error("provider bridge failed");
  };
  const sandboxStore = createSandboxStore();
  const operationStore = createOperationStore();
  const { backend } = createBackendWithProvider(
    provider,
    sandboxStore,
    operationStore,
  );

  await assert.rejects(
    () => backend.execute("node /workspace/ppt-deck/a.js"),
    /provider bridge failed/u,
  );

  assert.equal(operationStore.completed.at(-1)?.status, "failed");
  assert.match(
    String(operationStore.completed.at(-1)?.result?.error),
    /provider bridge failed/u,
  );
  // An unclassified provider failure proves nothing about the instance, so
  // the lease keeps its full TTL instead of being cut to the release grace.
  assert.deepEqual(sandboxStore.releaseReasons, []);
});

test("SourceWeftSandboxBackend releases the lease only after a confirmed-termination execute error", async () => {
  const { provider } = createProvider();
  let activeProviderSandboxId = "provider-sandbox-1";
  const sandboxStore = {
    ...createSandboxStore(),
    async findLatestActiveThreadSandbox() {
      return {
        id:
          activeProviderSandboxId === "provider-sandbox-1"
            ? "sandbox-record-1"
            : "sandbox-record-2",
        provider: "fake",
        providerSandboxId: activeProviderSandboxId,
        teamId: context.teamId,
        workspaceId: context.workspaceId,
        threadId: context.threadId,
        userId: context.userId,
        status: "ready" as const,
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      };
    },
  } satisfies SandboxStore;
  provider.execute = async () => {
    // Another worker replaced the generation while the command ran.
    activeProviderSandboxId = "provider-sandbox-2";
    return { output: "stale", exitCode: 0, truncated: false };
  };
  const { backend } = createBackendWithProvider(provider, sandboxStore);

  await assert.rejects(
    backend.execute("node /workspace/a.js"),
    (error: unknown) =>
      (error as { code?: unknown }).code === "SANDBOX_INSTANCE_CHANGED",
  );
  assert.deepEqual(sandboxStore.releaseReasons, [
    "sandbox_execute_runtime_error",
  ]);
});

test("SourceWeftSandboxBackend turns a provider outage into a recoverable execute result that keeps the lease", async () => {
  const { provider } = createProvider();
  provider.execute = async () => {
    throw new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.unavailable,
      "sandbox provider container is temporarily unavailable.",
      "execute",
    );
  };
  const sandboxStore = createSandboxStore();
  const operationStore = createOperationStore();
  const { backend } = createBackendWithProvider(
    provider,
    sandboxStore,
    operationStore,
  );

  const result = await backend.execute("node /workspace/a.js");
  assert.equal(result.exitCode, 1);
  const lines = result.output.split("\n");
  assert.match(
    lines[0] ?? "",
    /^SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox provider container/u,
  );
  // The command had already spawned: a blind "retry the same command" could
  // double-run it, so the hint asks the model to check its effects first.
  assert.equal(
    lines[1],
    "Hint: The connection to the sandbox was lost while the command was running; it may have run partly or fully. Check its effects (output files, state) before retrying it in a new tool call.",
  );
  assert.match(lines[2] ?? "", /failureCode=SANDBOX_NOT_READY_OR_UNHEALTHY/u);
  assert.equal(lines.length, 3, "no repeat escalation on the first failure");
  assert.ok(result.output.length < 600);
  assert.deepEqual(sandboxStore.releaseReasons, []);
  assert.equal(operationStore.completed.at(-1)?.status, "succeeded");
  assert.equal(
    operationStore.completed.at(-1)?.result?.errorCode,
    "SANDBOX_NOT_READY_OR_UNHEALTHY",
  );

  // Three attempts are tolerated; the fourth replaces the hint with the
  // escalation instead of contradicting it.
  await backend.execute("node /workspace/a.js");
  const third = await backend.execute("node /workspace/a.js");
  assert.equal(third.output.split("\n").length, 3);
  const fourth = await backend.execute("node /workspace/a.js");
  assert.match(
    fourth.output,
    /^SANDBOX_NOT_READY_OR_UNHEALTHY: .*\nHint: The sandbox provider stayed unavailable across 4 attempts\. Stop retrying;.*\nDiagnostics: /u,
  );
  assert.doesNotMatch(fourth.output, /retry the same|Check its effects/u);
  assert.equal(fourth.output.split("\n").length, 3);
  assert.deepEqual(sandboxStore.releaseReasons, []);
});

test("SourceWeftSandboxBackend reports an acquisition-time provider outage the same recoverable way", async () => {
  const { provider } = createProvider();
  provider.createSandbox = async () => {
    throw new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.unavailable,
      "SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox did not become ready within 90s after create.",
      "create",
    );
  };
  const sandboxStore = {
    ...createSandboxStore(),
    async findLatestActiveThreadSandbox() {
      return null;
    },
  } satisfies SandboxStore;
  const { backend } = createBackendWithProvider(provider, sandboxStore);

  const result = await backend.execute("node /workspace/a.js");
  assert.equal(result.exitCode, 1);
  const lines = result.output.split("\n");
  assert.match(
    lines[0] ?? "",
    /^SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox did not become ready/u,
  );
  // Nothing spawned, so the same command is safe to retry.
  assert.equal(
    lines[1],
    "Hint: The sandbox provider is temporarily unavailable. Wait 10-20 seconds, then retry the same command in a new tool call (at most 2 retries). Do not change the report content because of this error.",
  );
  assert.equal(lines.length, 3);
  assert.equal(provider.executeInputs.length, 0);
  assert.deepEqual(sandboxStore.releaseReasons, []);
});

test("SourceWeftSandboxBackend caps the provider timer at the remaining tool budget under a host deadline", async () => {
  const { provider } = createProvider();
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore: createNullOperationStore(),
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: 10_000,
    toolApprovalEnabled: true,
    // Pretend the host granted 12 s: 12 s − 5 s margin leaves 7 s.
    toolExecutionTimeoutMs: 12_000,
  });

  await backend.execute("node /workspace/a.js", {
    signal: new AbortController().signal,
  });
  const timeoutMs = provider.executeInputs[0]?.timeoutMs ?? 0;
  assert.ok(
    timeoutMs <= 7_000,
    `provider timer ${timeoutMs} must beat the host deadline`,
  );
  assert.ok(timeoutMs >= 6_000, "the command keeps what the budget leaves");

  // Without a host invocation signal there is no host deadline to beat.
  await backend.execute("node /workspace/b.js");
  assert.equal(provider.executeInputs[1]?.timeoutMs, 10_000);
});

test("SourceWeftSandboxBackend hands the next execute a fresh instance after a stateless generation timed out", async () => {
  const { provider } = createProvider();
  const rows: Array<{ id: string; providerSandboxId: string; status: string }> =
    [];
  let created = 0;
  provider.createSandbox = async () => {
    created += 1;
    return { id: `provider-sandbox-${created}` };
  };
  let timeoutProviderCall = true;
  const executionStarted = deferred<void>();
  provider.execute = async (input) => {
    provider.executeInputs.push(input);
    if (timeoutProviderCall) {
      executionStarted.resolve();
      return new Promise(() => undefined);
    }
    return { output: "fresh", exitCode: 0, truncated: false };
  };
  const sandboxStore = {
    ...createSandboxStore(),
    async findLatestActiveThreadSandbox() {
      const row = [...rows]
        .reverse()
        .find((r) => r.status === "ready" || r.status === "creating");
      return row
        ? {
            id: row.id,
            provider: "fake",
            providerSandboxId: row.providerSandboxId,
            teamId: context.teamId,
            workspaceId: context.workspaceId,
            threadId: context.threadId,
            userId: context.userId,
            status: row.status as "ready" | "creating",
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 3600_000),
          }
        : null;
    },
    async insertCreatingSandbox(input) {
      rows.push({
        id: input.sandboxId,
        providerSandboxId: input.providerSandboxId,
        status: "creating",
      });
      return true;
    },
    async markSandboxReady(input) {
      const row = rows.find((r) => r.id === input.sandboxId)!;
      row.status = "ready";
      row.providerSandboxId = input.providerSandboxId;
      return true;
    },
    async markSandboxExpired(input) {
      const row = rows.find((r) => r.id === input.sandboxId);
      if (!row) return false;
      row.status = "expired";
      return true;
    },
    async touchSandbox(input) {
      return rows.find((r) => r.id === input.sandboxId)?.status === "ready";
    },
  } satisfies SandboxStore;
  const operationStore = createOperationStore();
  const { backend } = createBackendWithProvider(
    provider,
    sandboxStore,
    operationStore,
  );

  const deadline = new AbortController();
  const first = backend.execute("node /workspace/slow.js", {
    signal: deadline.signal,
  });
  void first.catch(() => undefined);
  await executionStarted.promise;
  deadline.abort(
    Object.assign(new Error("tool deadline elapsed"), { name: "TimeoutError" }),
  );
  await assert.rejects(
    first,
    (error: unknown) =>
      (error as { code?: unknown }).code === "SANDBOX_OPERATION_TIMED_OUT",
  );

  timeoutProviderCall = false;
  const second = await backend.execute("ls /workspace", {
    signal: new AbortController().signal,
    toolCallId: "tool-call-2",
  });
  assert.equal(created, 2);
  assert.equal(
    provider.executeInputs[1]?.providerSandboxId,
    "provider-sandbox-2",
  );
  assert.equal(second.exitCode, 0);
  assert.equal(
    second.output,
    "fresh\nDiagnostics: sandbox replaced. The previous sandbox was terminated after a timeout before it accepted any operation. A fresh sandbox is ready but its /workspace is empty: run prepare_sandbox_workspace again before continuing.",
  );
  // The notice is one-shot.
  const third = await backend.execute("ls /workspace", {
    signal: new AbortController().signal,
    toolCallId: "tool-call-3",
  });
  assert.equal(third.output, "fresh");
  assert.equal(created, 2);
  assert.deepEqual(sandboxStore.releaseReasons, []);
});

test("SourceWeftSandboxBackend Stop waits for physical cancellation and discards a late execute success", async () => {
  const { provider } = createProvider();
  const executionStarted = deferred<void>();
  const lateExecution = deferred<{
    output: string;
    exitCode: number;
    truncated: boolean;
  }>();
  const deletionStarted = deferred<void>();
  const deletionConfirmed = deferred<void>();
  provider.execute = async (input) => {
    provider.executeInputs.push(input);
    executionStarted.resolve();
    return lateExecution.promise;
  };
  provider.deleteSandbox = async () => {
    deletionStarted.resolve();
    await deletionConfirmed.promise;
  };
  const operationStore = createOperationStore();
  const { backend } = createBackendWithProvider(
    provider,
    createSandboxStore(),
    operationStore,
  );
  const stop = new AbortController();
  const invocation = backend.execute("node /workspace/ppt-deck/a.js", {
    signal: stop.signal,
  });
  void invocation.catch(() => undefined);

  await executionStarted.promise;
  stop.abort(new DOMException("user stopped", "AbortError"));
  await deletionStarted.promise;

  let settled = false;
  void invocation
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(provider.executeInputs[0]?.signal, stop.signal);
  assert.equal(typeof provider.executeInputs[0]?.executionId, "string");

  deletionConfirmed.resolve();
  await assert.rejects(invocation, (error: unknown) => {
    assert.equal((error as { name?: unknown }).name, "AbortError");
    assert.equal(
      (error as { code?: unknown }).code,
      "SANDBOX_OPERATION_CANCELLED",
    );
    assert.equal(
      (error as { physicalCancellationConfirmed?: unknown })
        .physicalCancellationConfirmed,
      true,
    );
    return true;
  });

  lateExecution.resolve({
    output: "must-not-succeed",
    exitCode: 0,
    truncated: false,
  });
  await Promise.resolve();
  assert.equal(operationStore.completed.at(-1)?.status, "failed");
  assert.equal(
    operationStore.completed.at(-1)?.result?.errorCode,
    "SANDBOX_OPERATION_CANCELLED",
  );
  assert.equal(
    operationStore.completed.some(
      (operation) => operation.result?.output === "must-not-succeed",
    ),
    false,
  );
});

test("SourceWeftSandboxBackend host timeout waits for physical cancellation and never returns provider success", async () => {
  const { provider } = createProvider();
  const executionStarted = deferred<void>();
  const lateExecution = deferred<{
    output: string;
    exitCode: number;
    truncated: boolean;
  }>();
  let deleteCalls = 0;
  provider.execute = async (input) => {
    provider.executeInputs.push(input);
    executionStarted.resolve();
    return lateExecution.promise;
  };
  provider.deleteSandbox = async () => {
    deleteCalls += 1;
  };
  const operationStore = createOperationStore();
  const { backend } = createBackendWithProvider(
    provider,
    createSandboxStore(),
    operationStore,
  );
  const deadline = new AbortController();
  const invocation = backend.execute("node /workspace/ppt-deck/a.js", {
    signal: deadline.signal,
  });
  void invocation.catch(() => undefined);

  await executionStarted.promise;
  deadline.abort(
    Object.assign(new Error("tool deadline elapsed"), {
      code: "AGENT_TOOL_EXECUTION_TIMEOUT",
      name: "TimeoutError",
    }),
  );

  await assert.rejects(invocation, (error: unknown) => {
    assert.equal((error as { name?: unknown }).name, "TimeoutError");
    assert.equal(
      (error as { code?: unknown }).code,
      "SANDBOX_OPERATION_TIMED_OUT",
    );
    return true;
  });
  assert.equal(deleteCalls, 1);

  lateExecution.resolve({
    output: "late-timeout-success",
    exitCode: 0,
    truncated: false,
  });
  await Promise.resolve();
  assert.equal(operationStore.completed.at(-1)?.status, "failed");
  assert.equal(
    operationStore.completed.some(
      (operation) => operation.result?.output === "late-timeout-success",
    ),
    false,
  );
});

test("SourceWeftSandboxBackend redacts execute metadata without rewriting provider command", async () => {
  const operationStore = createOperationStore();
  const { provider } = createProvider();
  const rawCommand =
    "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 npm test";
  provider.execute = async (input) => {
    provider.executeInputs.push(input);
    provider.executed.push(input.command);
    return {
      output:
        "uploaded https://s3.example.com/file.pdf?X-Amz-Signature=secret&safe=1 sk-testsecret1234567890",
      exitCode: 0,
      truncated: false,
    };
  };
  const { backend } = createBackendWithProvider(
    provider,
    createSandboxStore(),
    operationStore,
  );

  const result = await backend.execute(rawCommand);

  assert.deepEqual(provider.executed, [rawCommand]);
  assert.match(String(operationStore.inserted[0]?.command), /\[redacted\]/u);
  assert.doesNotMatch(String(operationStore.inserted[0]?.command), /ghp_/u);
  assert.match(
    String(operationStore.inserted[0]?._sourceweftRequestFingerprint),
    /^sha256:/u,
  );
  assert.match(result.output, /X-Amz-Signature=%5Bredacted%5D/u);
  assert.doesNotMatch(result.output, /sk-testsecret/u);
  assert.doesNotMatch(
    String(operationStore.completed[0]?.result?.output),
    /secret/u,
  );
});

test("SourceWeftSandboxBackend does not release sandbox lease for non-zero execute exit code", async () => {
  const { provider } = createProvider();
  provider.execute = async () => ({
    output: "tests failed",
    exitCode: 1,
    truncated: false,
  });
  const sandboxStore = createSandboxStore();
  const { backend } = createBackendWithProvider(provider, sandboxStore);

  assert.deepEqual(await backend.execute("node /workspace/ppt-deck/a.js"), {
    output: "tests failed",
    exitCode: 1,
    truncated: false,
  });
  assert.deepEqual(sandboxStore.releaseReasons, []);
});

test("SourceWeftSandboxBackend rejects SourceWeft DB-backed VFS paths for sandbox file operations", async () => {
  const { backend, provider } = createBackend();

  assert.match(
    (await backend.write("/files/output.md", "x")).error ?? "",
    /SANDBOX_FILE_PATH_DENIED|SANDBOX_READ_PATH_DENIED/u,
  );
  const executeResult = await backend.execute("node /files/output.js");
  assert.equal(executeResult.exitCode, 1);
  assert.equal(executeResult.truncated, false);
  assert.match(executeResult.output, /SANDBOX_EXECUTE_VFS_PATH_DENIED/u);
  assert.match(executeResult.output, /\/files/u);
  assert.deepEqual(provider.executed, []);
  assert.deepEqual(provider.ensuredDirectories, []);
  assert.deepEqual(provider.uploadedFiles, []);
});

test("SourceWeftSandboxBackend returns per-file permission errors for invalid downloads", async () => {
  const { backend } = createBackend();

  const downloads = await backend.downloadFiles([
    "/files/output.md",
    "/workspace/ppt-deck/missing.md",
  ]);

  assert.deepEqual(
    downloads.map((download) => download.error),
    ["permission_denied", "file_not_found"],
  );
});

test("SourceWeftSandboxBackend returns recoverable error for absolute glob patterns outside sandbox roots", async () => {
  const { backend } = createBackend();

  const result = await backend.glob("/files/**/*.md", "/workspace/ppt-deck");

  assert.match(result.error ?? "", /SANDBOX_READ_PATH_DENIED/u);
});

// ── Skill-bundle staging (docs/architecture/sandbox-skill-staging.md) ────

function createSkillStagingBackend(input: {
  loadContent?: () => Promise<Uint8Array | null>;
  plans?: () => Promise<RuntimeAssetPlan[]>;
}) {
  const { files, provider } = createProvider();
  const plansCalls = { count: 0 };
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore: createNullOperationStore(),
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
    skillStaging: {
      plans:
        input.plans ??
        (async () => {
          plansCalls.count += 1;
          return [
            {
              name: "ppt-deck",
              version: "sv-1",
              platform: "any",
              sha256: "a".repeat(64),
              archive: "zip" as const,
              entrypoint: "SKILL.md",
              installDir: "/skills/ppt-deck",
              loadContent:
                input.loadContent ?? (async () => new Uint8Array([1, 2, 3])),
            },
          ];
        }),
      commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
      maxOutputChars: limits.maxOutputChars,
    },
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled: true,
  });
  return { backend, files, manager, plansCalls, provider };
}

test("skill staging stages bundles into /skills and admits /skills execute commands", async () => {
  const { backend, files, manager, provider } = createSkillStagingBackend({});

  const result = await backend.execute(
    'python3 "/skills/ppt-deck/scripts/validate_pptx.py" /workspace/deck.pptx',
    { toolCallId: "tool-call-skill-1" },
  );

  // The model command reached the provider unchanged.
  assert.equal(result.output, "user execute");
  assert.equal(
    provider.executed.at(-1),
    'python3 "/skills/ppt-deck/scripts/validate_pptx.py" /workspace/deck.pptx',
  );
  assert.equal(manager.skillScriptsStaged(), true);
  // The archive is uploaded into the workspace — the only place a provider
  // file route can address — and moved into the /skills contract path from
  // inside the sandbox, where the shell has no such restriction.
  assert.ok(
    provider.uploadedFiles.some(
      (path) => path.startsWith("/workspace/") && path.endsWith(".zip"),
    ),
    "archive must be uploaded under /workspace",
  );
  assert.ok(
    provider.systemExecuted.some(
      (command) =>
        command.includes("mv ") &&
        command.includes("/skills/ppt-deck.staging/asset.zip"),
    ),
    "archive must be moved into the /skills staging dir",
  );
  // The stamp goes through the shell for the same reason as the archive.
  assert.ok(
    provider.systemExecuted.some((command) =>
      command.includes("/skills/ppt-deck/.sourceweft-asset.json"),
    ),
    "stamp must be written into the /skills asset dir",
  );
  // Staging commands are host-issued (executeSystem), not model commands.
  assert.ok(
    provider.systemExecuted.some((command) =>
      command.includes("/skills/ppt-deck.staging"),
    ),
  );
});

test("skill staging runs once per sandbox across repeated acquisitions", async () => {
  const { backend, plansCalls } = createSkillStagingBackend({});

  await backend.execute("echo one", { toolCallId: "tool-call-skill-2" });
  await backend.execute("echo two", { toolCallId: "tool-call-skill-3" });

  assert.equal(plansCalls.count, 1);
});

test("failed skill staging degrades /skills execute commands to a recoverable failure", async () => {
  const { backend, manager, provider } = createSkillStagingBackend({
    // No content and no fetch URL → every staging rung is unavailable.
    loadContent: async () => null,
  });

  const result = await backend.execute(
    "python3 /skills/ppt-deck/scripts/validate_pptx.py",
    { toolCallId: "tool-call-skill-4" },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /SANDBOX_SKILL_STAGING_UNAVAILABLE/u);
  assert.match(result.output, /file tools/u);
  assert.equal(manager.skillScriptsStaged(), false);
  // The model command never reached the provider.
  assert.ok(!provider.executed.some((command) => command.includes("/skills")));
});

test("skill staging leaves non-/skills commands and unconfigured runtimes untouched", async () => {
  // Unconfigured runtime (no skillStaging): /skills stays denied fast.
  const { backend: plainBackend, provider: plainProvider } = createBackend();
  const denied = await plainBackend.execute(
    "python3 /skills/ppt-deck/scripts/validate_pptx.py",
    { toolCallId: "tool-call-skill-5" },
  );
  assert.equal(denied.exitCode, 1);
  assert.match(denied.output, /SANDBOX_EXECUTE_VFS_PATH_DENIED/u);
  assert.deepEqual(plainProvider.executed, []);

  // Configured runtime, command without /skills: no deferral in play, and
  // /files stays denied fast even with staging configured.
  const { backend } = createSkillStagingBackend({});
  const workfiles = await backend.execute("cat /files/notes.md", {
    toolCallId: "tool-call-skill-6",
  });
  assert.equal(workfiles.exitCode, 1);
  assert.match(workfiles.output, /SANDBOX_EXECUTE_VFS_PATH_DENIED/u);
});

// ── Plans added after the turn started (install_skill mid-turn) ──────────

function skillPlan(
  name: string,
  loadContent: () => Promise<Uint8Array | null> = async () =>
    new Uint8Array([1, 2, 3]),
): RuntimeAssetPlan {
  return {
    name,
    version: "sv-1",
    platform: "any",
    sha256: "a".repeat(64),
    archive: "zip",
    entrypoint: "SKILL.md",
    installDir: `/skills/${name}`,
    loadContent,
  };
}

/** A runtime whose plan set is a live registry, as turn assembly wires it. */
function createGrowingSkillStagingBackend(initial: RuntimeAssetPlan[]) {
  const { files, provider } = createProvider();
  const plans = [...initial];
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore: createNullOperationStore(),
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
    skillStaging: {
      plans: async () => [...plans],
      hasPlans: () => plans.length > 0,
      commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
      maxOutputChars: limits.maxOutputChars,
    },
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled: true,
  });
  const uploadsFor = (name: string) =>
    provider.uploadedFiles.filter((path) => path.includes(`${name}-`)).length;
  return { backend, files, manager, plans, provider, uploadsFor };
}

test("a plan added after the first staging is staged on the next /skills execute, and staged bundles are not re-uploaded", async () => {
  const { backend, plans, provider, uploadsFor } =
    createGrowingSkillStagingBackend([skillPlan("ppt-deck")]);

  await backend.execute("python3 /skills/ppt-deck/scripts/a.py", {
    toolCallId: "tool-call-grow-1",
  });
  assert.equal(uploadsFor("ppt-deck"), 1);
  assert.equal(uploadsFor("notes"), 0);

  plans.push(skillPlan("notes"));
  // Registering a plan stages nothing by itself, and a command that does not
  // touch /skills does not pay for it either.
  await backend.execute("echo unrelated", { toolCallId: "tool-call-grow-2" });
  assert.equal(uploadsFor("notes"), 0);

  const result = await backend.execute("python3 /skills/notes/scripts/b.py", {
    toolCallId: "tool-call-grow-3",
  });
  assert.equal(result.output, "user execute");
  assert.equal(uploadsFor("notes"), 1);
  assert.equal(uploadsFor("ppt-deck"), 1);
  assert.ok(
    provider.systemExecuted.some((command) =>
      command.includes("/skills/notes/.sourceweft-asset.json"),
    ),
  );

  // Nothing new → a further /skills command moves no bytes at all.
  const uploadsBefore = provider.uploadedFiles.length;
  const systemBefore = provider.systemExecuted.length;
  await backend.execute("python3 /skills/notes/scripts/b.py --again", {
    toolCallId: "tool-call-grow-4",
  });
  assert.equal(provider.uploadedFiles.length, uploadsBefore);
  assert.equal(provider.systemExecuted.length, systemBefore);
});

test("a bundle already stamped in the sandbox by an earlier turn is not uploaded again", async () => {
  const { backend, files, plans, manager, uploadsFor } =
    createGrowingSkillStagingBackend([]);
  files.set(
    "/skills/notes/.sourceweft-asset.json",
    new TextEncoder().encode(
      JSON.stringify({ version: "sv-1", sha256: "a".repeat(64) }),
    ),
  );
  plans.push(skillPlan("notes"));

  const result = await backend.execute("python3 /skills/notes/scripts/b.py", {
    toolCallId: "tool-call-grow-stamp",
  });

  assert.equal(result.output, "user execute");
  assert.equal(uploadsFor("notes"), 0);
  assert.deepEqual(
    manager.skillAssetResolutions()?.map((resolution) => resolution.rung),
    ["stamp"],
  );
});

test("a turn that started with no stageable skill stages a mid-turn install; without the staging contract it stays denied", async () => {
  const { backend, plans, provider, uploadsFor } =
    createGrowingSkillStagingBackend([]);

  // Empty registry: exactly the fast denial of a runtime without staging.
  const before = await backend.execute("python3 /skills/notes/scripts/b.py", {
    toolCallId: "tool-call-grow-5",
  });
  assert.equal(before.exitCode, 1);
  assert.match(before.output, /SANDBOX_EXECUTE_VFS_PATH_DENIED/u);
  assert.deepEqual(provider.executed, []);

  // The sandbox is acquired (and its empty staging run memoized) before the
  // install, which is the ordering a one-shot memo could not recover from.
  await backend.execute("echo warm", { toolCallId: "tool-call-grow-6" });
  plans.push(skillPlan("notes"));

  const after = await backend.execute("python3 /skills/notes/scripts/b.py", {
    toolCallId: "tool-call-grow-7",
  });
  assert.equal(after.output, "user execute");
  assert.equal(uploadsFor("notes"), 1);

  // No skillStaging at all (the contract is off): nothing to register with,
  // so /skills is denied before and after — today's behavior.
  const { backend: plainBackend, provider: plainProvider } = createBackend();
  const denied = await plainBackend.execute(
    "python3 /skills/notes/scripts/b.py",
    { toolCallId: "tool-call-grow-8" },
  );
  assert.match(denied.output, /SANDBOX_EXECUTE_VFS_PATH_DENIED/u);
  assert.deepEqual(plainProvider.executed, []);
});

test("a mid-turn bundle that fails to stage degrades alone with the recoverable error", async () => {
  const { backend, manager, plans, provider } =
    createGrowingSkillStagingBackend([skillPlan("ppt-deck")]);
  await backend.execute("python3 /skills/ppt-deck/scripts/a.py", {
    toolCallId: "tool-call-grow-9",
  });

  // No content and no fetch URL → every staging rung is unavailable.
  plans.push(skillPlan("notes", async () => null));
  const failed = await backend.execute("python3 /skills/notes/scripts/b.py", {
    toolCallId: "tool-call-grow-10",
  });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /SANDBOX_SKILL_STAGING_UNAVAILABLE/u);
  assert.ok(
    !provider.executed.some((command) => command.includes("/skills/notes")),
  );

  // The bundle that did stage keeps working, and the failure is not retried
  // on every later command.
  const systemBefore = provider.systemExecuted.length;
  const ok = await backend.execute("python3 /skills/ppt-deck/scripts/a.py -v", {
    toolCallId: "tool-call-grow-11",
  });
  assert.equal(ok.output, "user execute");
  assert.equal(provider.systemExecuted.length, systemBefore);
  assert.equal(manager.skillScriptsStaged(), true);
  assert.equal(
    manager.skillScriptsStagedForCommand("ls /skills/notes-extra"),
    true,
  );
});

test("a skill the host could not plan fails alone, without any sandbox traffic for it", async () => {
  const { provider } = createProvider();
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore: createNullOperationStore(),
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
    skillStaging: {
      plans: async () => [skillPlan("ppt-deck")],
      hasPlans: () => true,
      unstageable: () => [
        {
          name: "huge",
          version: "1.0.0",
          error: "not stageable: bundle_too_large",
        },
      ],
      commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
      maxOutputChars: limits.maxOutputChars,
    },
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled: true,
  });

  const failed = await backend.execute("python3 /skills/huge/scripts/run.py", {
    toolCallId: "tool-call-unstageable-1",
  });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /SANDBOX_SKILL_STAGING_UNAVAILABLE/u);
  assert.ok(
    ![...provider.executed, ...provider.systemExecuted].some((command) =>
      command.includes("/skills/huge"),
    ),
  );

  const ok = await backend.execute("python3 /skills/ppt-deck/scripts/a.py", {
    toolCallId: "tool-call-unstageable-2",
  });
  assert.equal(ok.output, "user execute");
  assert.deepEqual(
    manager
      .skillAssetResolutions()
      ?.map((resolution) => [resolution.name, resolution.ok]),
    [
      ["ppt-deck", true],
      ["huge", false],
    ],
  );
});

// ── Skill staging overlaps the turn (Issue #323 B2) ──────────────────────

/** Resolve after `ms` of wall time — long enough for any unblocked chain. */
function settle(ms = 20) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test("prefetch starts skill staging; a non-/skills command does not wait for it and a /skills command waits only for the in-flight run", async () => {
  const loadEntered = deferred<void>();
  const gate = deferred<Uint8Array | null>();
  let loads = 0;
  const { backend, manager, provider, uploadsFor } =
    createGrowingSkillStagingBackend([
      skillPlan("ppt-deck", async () => {
        loads += 1;
        loadEntered.resolve();
        return gate.promise;
      }),
    ]);

  // The turn-start prefetch: the same acquisition trustedHost
  // .ensureCurrentSession() runs, fire-and-forget.
  let prefetched = false;
  const prefetch = manager.getOrCreateThreadSandbox(context).then((ref) => {
    prefetched = true;
    return ref;
  });
  await loadEntered.promise;
  await settle();
  assert.equal(
    prefetched,
    true,
    "acquisition must hand the sandbox out without awaiting skill staging",
  );
  // Conservative until staging resolved: /skills stays denied.
  assert.equal(manager.skillScriptsStaged(), false);

  let plainDone = false;
  const plain = backend
    .execute("echo unrelated", { toolCallId: "tool-call-overlap-1" })
    .then((result) => {
      plainDone = true;
      return result;
    });
  let skillsDone = false;
  const skills = backend
    .execute("python3 /skills/ppt-deck/scripts/a.py", {
      toolCallId: "tool-call-overlap-2",
    })
    .then((result) => {
      skillsDone = true;
      return result;
    });
  await settle();
  assert.equal(
    plainDone,
    true,
    "a command that does not reference /skills must not wait for skill staging",
  );
  assert.equal((await plain).output, "user execute");
  assert.equal(skillsDone, false, "a /skills command waits for staging");
  assert.ok(!provider.executed.some((command) => command.includes("/skills")));

  gate.resolve(new Uint8Array([1, 2, 3]));
  const skillsResult = await skills;
  assert.equal(skillsResult.output, "user execute");
  assert.equal(
    provider.executed.at(-1),
    "python3 /skills/ppt-deck/scripts/a.py",
  );
  // The /skills command joined the prefetch's run instead of restarting it.
  assert.equal(loads, 1);
  assert.equal(uploadsFor("ppt-deck"), 1);
  assert.equal(manager.skillScriptsStaged(), true);
  await prefetch;
});

test("a /skills caller's abort stops only its own wait; the acquisition's staging run completes and is reused", async () => {
  const loadEntered = deferred<void>();
  const gate = deferred<Uint8Array | null>();
  let loads = 0;
  const { backend, manager, provider, uploadsFor } =
    createGrowingSkillStagingBackend([
      skillPlan("ppt-deck", async () => {
        loads += 1;
        loadEntered.resolve();
        return gate.promise;
      }),
    ]);
  await manager.getOrCreateThreadSandbox(context);
  await loadEntered.promise;

  const controller = new AbortController();
  const aborted = backend.execute("python3 /skills/ppt-deck/scripts/a.py", {
    toolCallId: "tool-call-overlap-abort-1",
    signal: controller.signal,
  });
  await settle();
  controller.abort(new DOMException("user stopped", "AbortError"));
  await assert.rejects(aborted, /user stopped/u);
  assert.ok(!provider.executed.some((command) => command.includes("/skills")));

  // The detached run was not cancelled by that caller's signal.
  gate.resolve(new Uint8Array([1, 2, 3]));
  const result = await backend.execute(
    "python3 /skills/ppt-deck/scripts/a.py",
    { toolCallId: "tool-call-overlap-abort-2" },
  );
  assert.equal(result.output, "user execute");
  assert.equal(loads, 1);
  assert.equal(uploadsFor("ppt-deck"), 1);
  assert.deepEqual(
    manager.skillAssetResolutions()?.map((resolution) => resolution.ok),
    [true],
  );
});

test("skill staging forwards the engine's idempotent verdict to executeSystem: every staging command but the unpack", async () => {
  const { backend, provider } = createGrowingSkillStagingBackend([
    skillPlan("ppt-deck"),
  ]);

  await backend.execute("python3 /skills/ppt-deck/scripts/a.py", {
    toolCallId: "tool-call-idempotent-1",
  });

  const staging = provider.systemExecuteInputs.filter((input) =>
    input.command.includes("/skills/ppt-deck"),
  );
  const flagged = (match: (command: string) => boolean) =>
    staging
      .filter((input) => match(input.command))
      .map((input) => input.idempotent);
  // upload-prepare: rm -rf + mkdir -p.
  assert.deepEqual(
    flagged((command) =>
      command.includes("mkdir -p '/skills/ppt-deck.staging'"),
    ),
    [true],
  );
  // upload-relocate: guarded move, convergent on re-run.
  assert.deepEqual(
    flagged((command) => command.includes("/.inbox/ppt-deck-sv-1.zip")),
    [true],
  );
  // upload-unpack consumes asset.zip and moves the staging dir away: unsafe.
  assert.deepEqual(
    flagged((command) => command.includes("unzip -q asset.zip")),
    [undefined],
  );
  // stamp write: identical bytes on every attempt.
  assert.deepEqual(
    flagged((command) => command.includes(".sourceweft-asset.json")),
    [true],
  );
  assert.equal(staging.length, 4);
});

/**
 * Models the Cloudflare provider's S4 contract: an `idempotent` executeSystem
 * that hits SANDBOX_NOT_READY_OR_UNHEALTHY is retried inside the provider;
 * anything else surfaces the first failure. `transientOn` picks the command.
 */
function withProviderSideUnavailableRetry(
  provider: ReturnType<typeof createProvider>["provider"],
  transientOn: (command: string) => boolean,
) {
  const attempts: Array<{ command: string; idempotent: boolean }> = [];
  let injected = false;
  const inner = provider.executeSystem!.bind(provider);
  provider.executeSystem = async (input) => {
    const attempt = async () => {
      attempts.push({
        command: input.command,
        idempotent: input.idempotent === true,
      });
      if (!injected && transientOn(input.command)) {
        injected = true;
        throw new SandboxProviderError(
          SANDBOX_PROVIDER_ERROR_CODES.unavailable,
          "SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox provider container is temporarily unavailable. Retry when the provider is available.",
          "execute",
        );
      }
      return inner(input);
    };
    try {
      return await attempt();
    } catch (error) {
      const retryable =
        input.idempotent === true &&
        error instanceof SandboxProviderError &&
        error.code === SANDBOX_PROVIDER_ERROR_CODES.unavailable;
      if (!retryable) throw error;
      return attempt();
    }
  };
  return attempts;
}

test("a transient NOT_READY on an idempotent staging command is ridden out by the provider; the manager adds no retry of its own", async () => {
  const { backend, manager, provider } = createGrowingSkillStagingBackend([
    skillPlan("ppt-deck"),
  ]);
  const attempts = withProviderSideUnavailableRetry(provider, (command) =>
    command.includes("mkdir -p '/skills/ppt-deck.staging'"),
  );

  const result = await backend.execute(
    "python3 /skills/ppt-deck/scripts/a.py",
    { toolCallId: "tool-call-not-ready-1" },
  );

  assert.equal(result.output, "user execute");
  assert.deepEqual(
    manager
      .skillAssetResolutions()
      ?.map((resolution) => [resolution.ok, resolution.rung]),
    [[true, "upload"]],
  );
  assert.equal(
    attempts.filter((attempt) =>
      attempt.command.includes("mkdir -p '/skills/ppt-deck.staging'"),
    ).length,
    2,
    "one failed attempt plus the provider's own retry",
  );
});

test("a transient NOT_READY on the non-idempotent unpack fails the rung once, with no manager-level retry", async () => {
  const { backend, manager, provider } = createGrowingSkillStagingBackend([
    skillPlan("ppt-deck"),
  ]);
  const attempts = withProviderSideUnavailableRetry(provider, (command) =>
    command.includes("unzip -q asset.zip"),
  );

  const result = await backend.execute(
    "python3 /skills/ppt-deck/scripts/a.py",
    { toolCallId: "tool-call-not-ready-2" },
  );

  assert.match(result.output, /SANDBOX_SKILL_STAGING_UNAVAILABLE/u);
  assert.equal(
    attempts.filter((attempt) => attempt.command.includes("unzip -q")).length,
    1,
  );
  assert.match(
    manager.skillAssetResolutions()?.[0]?.error ?? "",
    /SANDBOX_NOT_READY_OR_UNHEALTHY/u,
  );
});

test("neither the model's execute nor the pinned read-only file fallbacks carry idempotent", async () => {
  const { backend, files, provider } = createSkillStagingBackend({});
  files.set("/workspace/notes.md", new TextEncoder().encode("hello\n"));

  await backend.execute("echo model", { toolCallId: "tool-call-flag-1" });
  await backend.execute("python3 /skills/ppt-deck/scripts/a.py", {
    toolCallId: "tool-call-flag-2",
  });
  assert.deepEqual(provider.executed, [
    "echo model",
    "python3 /skills/ppt-deck/scripts/a.py",
  ]);
  for (const input of provider.executeInputs) {
    assert.equal(
      "idempotent" in input,
      false,
      `model execute must not carry idempotent: ${input.command}`,
    );
  }
  // Model command text never goes through executeSystem.
  assert.ok(
    !provider.systemExecuteInputs.some(
      (input) =>
        input.command === "echo model" ||
        input.command === "python3 /skills/ppt-deck/scripts/a.py",
    ),
  );

  // ls/read/grep/glob fallbacks run inside a pinned window whose expiry
  // deletes the sandbox, so a provider retry must not spend that window.
  const before = provider.systemExecuteInputs.length;
  assert.equal((await backend.read("/workspace/notes.md")).content, "hello\n");
  await backend.ls("/workspace");
  await backend.grep("hello", "/workspace");
  await backend.glob("*.md", "/workspace");
  const fileTools = provider.systemExecuteInputs.slice(before);
  assert.equal(fileTools.length, 4);
  assert.ok(fileTools.every((input) => !("idempotent" in input)));
});

test("cancelling a generation stops its in-flight skill staging: no further staging traffic, and a waiting /skills command reports the fence", async () => {
  const loadEntered = deferred<void>();
  const gate = deferred<Uint8Array | null>();
  const { backend, manager, provider } = createGrowingSkillStagingBackend([
    skillPlan("ppt-deck", async () => {
      loadEntered.resolve();
      return gate.promise;
    }),
  ]);
  const deleted: string[] = [];
  provider.deleteSandbox = async (providerSandboxId) => {
    deleted.push(providerSandboxId);
  };
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  await loadEntered.promise;

  const waiting = backend.execute("python3 /skills/ppt-deck/scripts/a.py", {
    toolCallId: "tool-call-fenced-staging-1",
  });
  await settle();
  // A sibling's timeout: no command-scoped kill, so the sandbox is deleted.
  const cancellation = await manager.cancelExecution({
    sandbox,
    executionId: "sibling-execution",
    reason: "timed_out",
  });
  assert.deepEqual(cancellation, { confirmed: true, mode: "sandbox" });
  assert.deepEqual(deleted, ["provider-sandbox-1"]);

  const systemAfterCancel = provider.systemExecuteInputs.length;
  const uploadsAfterCancel = provider.uploadedFiles.length;
  // The blocked bundle load resolves only after the delete.
  gate.resolve(new Uint8Array([1, 2, 3]));
  await assert.rejects(
    waiting,
    /SANDBOX_EXECUTION_RESULT_DISCARDED|discarded/u,
  );
  await settle();

  assert.equal(
    provider.systemExecuteInputs.length,
    systemAfterCancel,
    "staging must not send commands to a deleted sandbox",
  );
  assert.equal(provider.uploadedFiles.length, uploadsAfterCancel);
  assert.ok(!provider.executed.some((command) => command.includes("/skills")));
  // Nothing was judged, so nothing was memoized as a failed bundle.
  assert.equal(manager.skillAssetResolutions(), null);
});

test("a missing required runtime asset fails acquisition instead of degrading", async () => {
  const { provider } = createProvider();
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore: createNullOperationStore(),
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
    requiredAssetStaging: {
      plans: async () => [
        {
          name: "chrome-headless-shell",
          version: "149.0.7790.0",
          platform: "linux-x64",
          sha256: "a".repeat(64),
          archive: "zip",
          entrypoint: "chrome-headless-shell",
          loadContent: async () => null,
        },
      ],
      commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
      maxOutputChars: limits.maxOutputChars,
    },
  });

  await assert.rejects(
    () => manager.getOrCreateThreadSandbox(context),
    /SANDBOX_REQUIRED_RUNTIME_ASSET_UNAVAILABLE: chrome-headless-shell@149\.0\.7790\.0/u,
  );
});

test("required runtime asset staging exposes its resolved executable path", async () => {
  const { provider } = createProvider();
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore: createNullOperationStore(),
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
    requiredAssetStaging: {
      plans: async () => [
        {
          name: "chrome-headless-shell",
          version: "149.0.7790.0",
          platform: "linux-x64",
          sha256: "a".repeat(64),
          archive: "zip",
          entrypoint: "chrome-headless-shell",
          loadContent: async () => new Uint8Array([1, 2, 3]),
        },
      ],
      commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
      maxOutputChars: limits.maxOutputChars,
    },
  });

  await manager.getOrCreateThreadSandbox(context);
  assert.equal(
    manager.requiredAssetResolutions()?.[0]?.entrypointPath,
    "/workspace/.sourceweft-assets/chrome-headless-shell/149.0.7790.0/chrome-headless-shell",
  );
});

test("native file tools share disk state without invoking Linux shell helpers", async () => {
  const { files, provider } = createProvider();
  const nativeSearches: Array<{ paths: string[]; pattern: string }> = [];
  provider.nativeFileOperations = true;
  provider.listFiles = async (input) =>
    [...files.entries()]
      .filter(
        ([path]) =>
          path.startsWith(`${input.sandboxPath}/`) ||
          path === input.sandboxPath,
      )
      .map(([path, bytes]) => ({ path, size: bytes.length, is_dir: false }));
  provider.nativeGrep = async ({ paths, pattern }) => {
    nativeSearches.push({ paths, pattern });
    return {
      matches: paths.flatMap((path) =>
        new TextDecoder()
          .decode(files.get(path))
          .split("\n")
          .flatMap((text, index) =>
            text.includes(pattern) ? [{ path, line: index + 1, text }] : [],
          ),
      ),
      visitedPaths: paths,
      skipped: [],
      truncated: false,
    };
  };
  provider.readTextFile = async (input) =>
    new TextDecoder("utf-8", { fatal: true }).decode(
      files.get(input.sandboxPath),
    );
  provider.replaceTextFile = async (input) => {
    assert.equal(
      new TextDecoder().decode(files.get(input.sandboxPath)),
      input.expected,
    );
    files.set(input.sandboxPath, new TextEncoder().encode(input.content));
  };
  const { backend } = createBackendWithProvider(provider);
  await backend.write("/workspace/note.txt", "before\nline2");
  assert.equal(
    (await backend.ls("/workspace")).files?.[0]?.path,
    "/workspace/note.txt",
  );
  assert.equal((await backend.glob("*.txt", "/workspace")).files?.length, 1);
  assert.equal(
    (await backend.read("/workspace/note.txt", 1, 1)).content,
    "line2",
  );
  assert.equal(
    (await backend.grep("before", "/workspace")).matches?.[0]?.line,
    1,
  );
  assert.deepEqual(nativeSearches, [
    { paths: ["/workspace/note.txt"], pattern: "before" },
  ]);
  assert.equal(
    (await backend.edit("/workspace/note.txt", "before", "after")).occurrences,
    1,
  );
  files.set("/workspace/note.txt", new TextEncoder().encode("external change"));
  assert.equal(
    (await backend.read("/workspace/note.txt")).content,
    "external change",
  );
  assert.ok((await backend.write("/files/wrong.txt", "wrong")).error);
  assert.deepEqual(provider.systemExecuted, []);
  assert.deepEqual(provider.executed, []);
});

test("native grep fails explicitly when the provider has no native search capability", async () => {
  const { provider } = createProvider();
  provider.nativeFileOperations = true;
  provider.listFiles = async () => [
    { path: "/workspace/note.txt", size: 6, is_dir: false },
  ];
  const { backend } = createBackendWithProvider(provider);
  await assert.rejects(
    backend.grep("before", "/workspace"),
    /NATIVE_SEARCH_UNAVAILABLE/,
  );
  assert.deepEqual(provider.systemExecuted, []);
  assert.deepEqual(provider.executed, []);
});

test("PC runtime removes prepare/collect while cloud runtime retains the bridge", async () => {
  const { AgentSandboxService } = await import("../../src/sandbox-service");
  const { provider } = createProvider();
  const service = new AgentSandboxService({
    getConfig: () => ({
      enabled: true,
      provider: "fake",
      toolApprovalEnabled: true,
      limits,
    }),
    getProviderFactory: () => ({
      id: "fake",
      createProvider: () => provider,
      getConfigurationStatus: () => ({ configured: true, missing: [] }),
    }),
    logWarn: () => {},
  });
  const input = {
    context,
    filesystem: {} as import("deepagents").BackendProtocolV2,
  };
  const pc = service.createRuntimeForTurn(
    { ...input, executionTarget: { kind: "local", deviceId: "pc" } },
    createSandboxStore(),
    createOperationStore(),
  )!;
  assert.ok(
    !pc.tools.some((tool) =>
      ["prepare_sandbox_workspace", "collect_sandbox_outputs"].includes(
        tool.name,
      ),
    ),
  );
  assert.match(pc.buildRuntimePrompt(), /only|same physical files/);
  const cloud = service.createRuntimeForTurn(
    input,
    createSandboxStore(),
    createOperationStore(),
  )!;
  assert.ok(
    cloud.tools.some((tool) => tool.name === "prepare_sandbox_workspace"),
  );
  assert.ok(
    cloud.tools.some((tool) => tool.name === "collect_sandbox_outputs"),
  );
});

test("the runtime prompt of a turn without stageable skills is byte-identical, before and after a mid-turn install", async () => {
  const { AgentSandboxService } = await import("../../src/sandbox-service");
  const { provider } = createProvider();
  const service = new AgentSandboxService({
    getConfig: () => ({
      enabled: true,
      provider: "fake",
      toolApprovalEnabled: true,
      limits,
    }),
    getProviderFactory: () => ({
      id: "fake",
      createProvider: () => provider,
      getConfigurationStatus: () => ({ configured: true, missing: [] }),
    }),
    logWarn: () => {},
  });
  const input = {
    context,
    filesystem: {} as import("deepagents").BackendProtocolV2,
  };
  const withoutStaging = service
    .createRuntimeForTurn(input, createSandboxStore(), createOperationStore())!
    .buildRuntimePrompt();

  const plans: RuntimeAssetPlan[] = [];
  const skillAssets = {
    plans: async () => [...plans],
    hasPlans: () => plans.length > 0,
  };
  const emptyAtStart = service.createRuntimeForTurn(
    { ...input, skillAssets },
    createSandboxStore(),
    createOperationStore(),
  )!;
  assert.equal(emptyAtStart.buildRuntimePrompt(), withoutStaging);
  // The install tool's result announces the scripts; the prompt must not move
  // under the model (and its cache) when the registry grows.
  plans.push(skillPlan("notes"));
  assert.equal(emptyAtStart.buildRuntimePrompt(), withoutStaging);

  // A turn that starts WITH a stageable skill still gets the staged prompt.
  const stagedAtStart = service.createRuntimeForTurn(
    { ...input, skillAssets },
    createSandboxStore(),
    createOperationStore(),
  )!;
  assert.notEqual(stagedAtStart.buildRuntimePrompt(), withoutStaging);
  assert.match(stagedAtStart.buildRuntimePrompt(), /materialized read-only/u);
});

test("SourceWeftSandboxBackend only creates after typed missing and preserves existing empty/nonempty bytes", async () => {
  const { backend, files, provider } = createBackend();
  const path = "/workspace/create-and-read.txt";
  assert.equal((await backend.write(path, "written exactly")).path, path);
  assert.equal((await backend.readRaw(path)).data?.content, "written exactly");
  for (const content of ["", "original bytes"]) {
    files.set(path, new TextEncoder().encode(content));
    const uploads = provider.uploadedFiles.length;
    assert.match(
      (await backend.write(path, "must not overwrite")).error ?? "",
      /already exists/,
    );
    assert.equal(provider.uploadedFiles.length, uploads);
    assert.equal(new TextDecoder().decode(files.get(path)), content);
  }
});

test("SourceWeftSandboxBackend preserves provider read failures and never uploads after an inconclusive existence check", async () => {
  const failures = [
    new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.authentication,
      "provider authentication failed",
      "download",
    ),
    new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.unavailable,
      "provider network unavailable",
      "download",
    ),
    // A SANDBOX_NOT_FOUND_OR_EXPIRED read is no longer passed through: the
    // manager turns a lost instance into SANDBOX_REPLACED (see "a file tool
    // on a replaced container ..." below, which also checks that nothing is
    // uploaded).
    new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.unknown,
      "provider unknown error",
      "download",
    ),
    new Error("file not found"),
    new Error("network failed"),
  ];
  for (const failure of failures) {
    const { provider } = createProvider();
    provider.downloadFile = async () => {
      throw failure;
    };
    const { backend } = createBackendWithProvider(provider);
    await assert.rejects(
      backend.write("/workspace/never-written.txt", "data"),
      (error) => error === failure,
    );
    await assert.rejects(
      backend.readRaw("/workspace/unavailable.txt"),
      (error) => error === failure,
    );
    await assert.rejects(
      backend.downloadFiles(["/workspace/unavailable.txt"]),
      (error) => error === failure,
    );
    assert.deepEqual(provider.uploadedFiles, []);
    assert.deepEqual(provider.ensuredDirectories, []);
  }
});

test("SourceWeftSandboxBackend upload provider failures retain their cause instead of permission_denied", async () => {
  const { provider } = createProvider();
  const failure = new SandboxProviderError(
    SANDBOX_PROVIDER_ERROR_CODES.unavailable,
    "upload transport unavailable",
    "upload",
  );
  provider.uploadFile = async () => {
    throw failure;
  };
  const { backend } = createBackendWithProvider(provider);
  await assert.rejects(
    backend.write("/workspace/upload-failed.txt", "data"),
    (error) => error === failure,
  );
  await assert.rejects(
    backend.uploadFiles([["/workspace/upload-failed.txt", new Uint8Array()]]),
    (error) => error === failure,
  );
});

test("SourceWeftSandboxBackend readRaw missing is explicit and nonzero read command is not invented ENOENT", async () => {
  const { backend, provider } = createBackend();
  assert.match(
    (await backend.readRaw("/workspace/missing.txt")).error ?? "",
    /^ENOENT:/,
  );
  provider.executeSystem = async () => ({
    exitCode: 2,
    output: "Permission denied",
    truncated: false,
  });
  const result = await backend.read("/workspace/unreadable.txt");
  assert.match(
    result.error ?? "",
    /SANDBOX_FILE_READ_FAILED.*Permission denied/,
  );
  assert.doesNotMatch(result.error ?? "", /ENOENT/);
});

test("SourceWeftSandboxBackend reports an exhausted tool budget instead of spawning a doomed command", async () => {
  const { provider } = createProvider();
  let deleteCalls = 0;
  provider.deleteSandbox = async () => {
    deleteCalls += 1;
  };
  const sandboxStore = createSandboxStore();
  const operationStore = createOperationStore();
  const manager = new SandboxManager({
    provider,
    sandboxStore,
    operationStore,
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: 10_000,
    toolApprovalEnabled: true,
    // A joiner that waited out a sibling's cold start: under 10 s left.
    toolExecutionTimeoutMs: 7_000,
  });

  const result = await backend.execute("node /workspace/a.js", {
    signal: new AbortController().signal,
  });
  assert.equal(result.exitCode, 1);
  const lines = result.output.split("\n");
  assert.match(lines[0] ?? "", /^SANDBOX_TOOL_BUDGET_EXHAUSTED: /u);
  assert.equal(
    lines[1],
    "Hint: The tool budget was spent acquiring the sandbox, which is now ready. Retry the same command in a new tool call.",
  );
  assert.match(lines[2] ?? "", /failureCode=SANDBOX_TOOL_BUDGET_EXHAUSTED/u);
  assert.equal(lines.length, 3);
  // Nothing spawned, nothing terminated, lease untouched.
  assert.equal(provider.executeInputs.length, 0);
  assert.equal(deleteCalls, 0);
  assert.deepEqual(sandboxStore.releaseReasons, []);
  assert.equal(operationStore.completed.at(-1)?.status, "succeeded");
  assert.equal(
    operationStore.completed.at(-1)?.result?.errorCode,
    "SANDBOX_TOOL_BUDGET_EXHAUSTED",
  );
  // A repeat is not an "input failure": no stop-retrying escalation.
  const again = await backend.execute("node /workspace/a.js", {
    signal: new AbortController().signal,
  });
  assert.equal(again.output.split("\n").length, 3);
  // Without a host deadline the command simply runs.
  await backend.execute("node /workspace/a.js");
  assert.equal(provider.executeInputs.length, 1);
});

// ── Provider-side container replacement mid-run (Issue #323 follow-up) ────

test("a container replaced between two successful commands is caught by the next execute: the run moves to a fresh sandbox, /skills is re-staged and the model is told", async () => {
  const { provider } = createProvider();
  let created = 0;
  provider.createSandbox = async () => {
    created += 1;
    return { id: `provider-sandbox-${created}` };
  };
  // Once the SDK restarted the container behind an id, the Cloudflare stamp
  // guard refuses every exec on it before the command runs.
  const replacedIds = new Set<string>();
  provider.execute = async (input) => {
    if (replacedIds.has(input.providerSandboxId)) {
      throw new SandboxProviderError(
        SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
        "SANDBOX_NOT_FOUND_OR_EXPIRED: the sandbox identity stamp was missing or did not match when the command started; the container was replaced and the command did not run.",
        "execute",
      );
    }
    provider.executeInputs.push(input);
    provider.executed.push(input.command);
    return { output: "ran", exitCode: 0, truncated: false };
  };
  const rows: Array<{ id: string; providerSandboxId: string; status: string }> =
    [];
  const sandboxStore = {
    ...createSandboxStore(),
    async findLatestActiveThreadSandbox() {
      const row = [...rows]
        .reverse()
        .find((r) => r.status === "ready" || r.status === "creating");
      return row
        ? {
            id: row.id,
            provider: "fake",
            providerSandboxId: row.providerSandboxId,
            teamId: context.teamId,
            workspaceId: context.workspaceId,
            threadId: context.threadId,
            userId: context.userId,
            status: row.status as "ready" | "creating",
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 3600_000),
          }
        : null;
    },
    async insertCreatingSandbox(input) {
      rows.push({
        id: input.sandboxId,
        providerSandboxId: input.providerSandboxId,
        status: "creating",
      });
      return true;
    },
    async markSandboxReady(input) {
      const row = rows.find((r) => r.id === input.sandboxId)!;
      row.status = "ready";
      row.providerSandboxId = input.providerSandboxId;
      return true;
    },
    async markSandboxExpired(input) {
      const row = rows.find((r) => r.id === input.sandboxId);
      if (!row || (input.expectedStatus && row.status !== input.expectedStatus))
        return false;
      row.status = "expired";
      return true;
    },
    async touchSandbox(input) {
      return rows.find((r) => r.id === input.sandboxId)?.status === "ready";
    },
  } satisfies SandboxStore;
  const operationStore = createOperationStore();
  const plansCalls = { count: 0 };
  const logs: string[] = [];
  const manager = new SandboxManager({
    provider,
    sandboxStore,
    operationStore,
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
    logWarn: (event) => logs.push(event),
    skillStaging: {
      plans: async () => {
        plansCalls.count += 1;
        return [
          {
            name: "report",
            version: "sv-1",
            platform: "any",
            sha256: "a".repeat(64),
            archive: "zip" as const,
            entrypoint: "SKILL.md",
            installDir: "/skills/report",
            loadContent: async () => new Uint8Array([1, 2, 3]),
          },
        ];
      },
      commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
      maxOutputChars: limits.maxOutputChars,
    },
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled: true,
  });
  const command =
    "python3 /skills/report/scripts/build.py /workspace/report-v2";

  const first = await backend.execute(command);
  assert.equal(first.output, "ran");
  assert.equal(
    provider.executeInputs[0]?.providerSandboxId,
    "provider-sandbox-1",
  );
  const uploadsForFirst = provider.uploadedFiles.length;
  assert.ok(
    uploadsForFirst >= 1,
    "the bundle was staged into the first sandbox",
  );

  // 20:20:16Z "Failed to check container status, assuming stopped": the SDK
  // replaced the container; the backend still holds the same row.
  replacedIds.add("provider-sandbox-1");
  const second = await backend.execute(command);
  assert.equal(second.exitCode, 1);
  assert.match(
    second.output,
    /^SANDBOX_REPLACED: The sandbox container was replaced by the provider while this run was in progress/u,
  );
  assert.match(second.output, /this operation did not run/u);
  assert.match(second.output, /Hint: .*prepare_sandbox_workspace/u);
  assert.match(second.output, /Do not copy skill files by hand/u);
  assert.match(second.output, /failureCode=SANDBOX_REPLACED/u);
  assert.doesNotMatch(second.output, /change the approach/u);
  // Nothing ran on the fresh container under the old id, the row is expired
  // (not left ready), and the operation is recorded with the single code.
  assert.equal(provider.executeInputs.length, 1);
  assert.equal(
    rows.find((row) => row.providerSandboxId === "provider-sandbox-1")?.status,
    "expired",
  );
  assert.equal(operationStore.completed.at(-1)?.status, "succeeded");
  assert.equal(
    operationStore.completed.at(-1)?.result?.errorCode,
    "SANDBOX_REPLACED",
  );
  assert.ok(logs.includes("sandbox.generation.lost"));
  // Not the fail-closed B1 code: the run continues.
  assert.doesNotMatch(second.output, /SANDBOX_INSTANCE_CHANGED/u);

  // The next call runs on a replacement that was re-staged (the /skills
  // command waited for that staging), and carries the one-shot notice.
  const third = await backend.execute(command);
  assert.equal(created, 2);
  assert.equal(
    provider.executeInputs.at(-1)?.providerSandboxId,
    "provider-sandbox-2",
  );
  assert.equal(third.exitCode, 0);
  assert.equal(
    third.output,
    `ran\nDiagnostics: sandbox replaced. ${SANDBOX_RESTARTED_NOTICE}`,
  );
  assert.ok(plansCalls.count >= 2, "the replacement's staging read the plans");
  assert.equal(provider.uploadedFiles.length, uploadsForFirst * 2);
  assert.equal(manager.skillScriptsStaged(), true);
  assert.deepEqual(sandboxStore.releaseReasons, []);

  const fourth = await backend.execute("echo again");
  assert.equal(fourth.output, "ran");
  assert.equal(created, 2);
});

test("a file tool on a replaced container reports SANDBOX_REPLACED instead of a bare missing file", async () => {
  const { provider } = createProvider();
  let created = 0;
  provider.createSandbox = async () => {
    created += 1;
    return { id: `provider-sandbox-${created}` };
  };
  const replacedIds = new Set<string>(["provider-sandbox-1"]);
  provider.downloadFile = async (input) => {
    if (replacedIds.has(input.providerSandboxId)) {
      throw new SandboxProviderError(
        SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
        "SANDBOX_NOT_FOUND_OR_EXPIRED: sandbox identity stamp was not found.",
        "download",
      );
    }
    return Buffer.from("hello");
  };
  const rows: Array<{ id: string; providerSandboxId: string; status: string }> =
    [];
  const sandboxStore = {
    ...createSandboxStore(),
    async findLatestActiveThreadSandbox() {
      const row = [...rows]
        .reverse()
        .find((r) => r.status === "ready" || r.status === "creating");
      return row
        ? {
            id: row.id,
            provider: "fake",
            providerSandboxId: row.providerSandboxId,
            teamId: context.teamId,
            workspaceId: context.workspaceId,
            threadId: context.threadId,
            userId: context.userId,
            status: row.status as "ready" | "creating",
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 3600_000),
          }
        : null;
    },
    async insertCreatingSandbox(input) {
      rows.push({
        id: input.sandboxId,
        providerSandboxId: input.providerSandboxId,
        status: "creating",
      });
      return true;
    },
    async markSandboxReady(input) {
      const row = rows.find((r) => r.id === input.sandboxId)!;
      row.status = "ready";
      row.providerSandboxId = input.providerSandboxId;
      return true;
    },
    async markSandboxExpired(input) {
      const row = rows.find((r) => r.id === input.sandboxId);
      if (!row) return false;
      row.status = "expired";
      return true;
    },
    async touchSandbox(input) {
      return rows.find((r) => r.id === input.sandboxId)?.status === "ready";
    },
  } satisfies SandboxStore;
  const { backend } = createBackendWithProvider(provider, sandboxStore);

  // write's existence check is the operation that finds the instance gone:
  // the verdict replaces the provider error, and nothing is uploaded.
  await assert.rejects(
    backend.write("/workspace/never-written.txt", "data"),
    (error: unknown) =>
      (error as { code?: string }).code === "SANDBOX_REPLACED" &&
      /replaced by the provider/u.test((error as Error).message),
  );
  assert.deepEqual(provider.uploadedFiles, []);
  assert.deepEqual(provider.ensuredDirectories, []);
  assert.equal(rows[0]?.status, "expired");
  // The replacement serves the next call.
  const read = await backend.readRaw("/workspace/output/report.md");
  assert.equal(read.data?.content, "hello");
  assert.equal(created, 2);
});
