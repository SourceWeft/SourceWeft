import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceWeftSandboxBackend } from "../../src/runtime/sourceweft-sandbox-backend";
import { SandboxManager } from "../../src/runtime/sandbox-manager";
import type {
  SandboxOperationStore,
  SandboxProvider,
  SandboxProviderPathPolicy,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStore,
} from "../../src/runtime/types";

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
  commandTimeoutMs: 1000,
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
    async markSandboxReady() {},
    async markSandboxExpired() {},
    async releaseReadyThreadSandboxLease(input) {
      releaseReasons.push(input.reason);
      return 1;
    },
    async touchSandbox() {},
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
  }) =>
    `${input.context.messageId}:${input.operationType}:${input.toolCallId}`;
  const inserts: Array<{
    operationId: string;
    operationType: string;
    request: Record<string, unknown>;
    toolCallId: string;
  }> = [];

  return {
    inserts,
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
    maxOutputChars: number;
    providerSandboxId: string;
    timeoutMs: number;
  }> = [];
  const systemExecuteInputs: Array<{
    command: string;
    cwd?: string;
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
      provider.uploadedFiles.push(input.sandboxPath);
      files.set(input.sandboxPath, input.content);
    },
    async downloadFile(input) {
      const content = files.get(input.sandboxPath);
      if (!content) {
        throw new Error("not found");
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
    commandTimeoutMs: limits.commandTimeoutMs,
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
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
    commandTimeoutMs: limits.commandTimeoutMs,
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context: input.runtimeContext ?? context,
    limits,
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
    commandTimeoutMs: limits.commandTimeoutMs,
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context: runtimeContext,
    limits,
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

test("SourceWeftSandboxBackend skips read_file on binary image files", async () => {
  const { backend, files, provider } = createBackend();
  files.set(
    "/workspace/ppt-deck/qa/slide-01.jpg",
    new Uint8Array([0xff, 0xd8, 0xff]),
  );

  const result = await backend.read("/workspace/ppt-deck/qa/slide-01.jpg");

  assert.equal(result.error, undefined);
  assert.equal(
    result.content,
    "Skipped binary file: /workspace/ppt-deck/qa/slide-01.jpg (image/jpeg). read_file only supports text.",
  );
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

  assert.deepEqual(provider.executeInputs, [
    {
      providerSandboxId: "provider-sandbox-1",
      command,
      cwd: "/workspace",
      timeoutMs: limits.commandTimeoutMs,
      maxOutputChars: limits.maxOutputChars,
    },
  ]);
});

test("SourceWeftSandboxBackend passes multiline execute commands through unchanged", async () => {
  const { backend, provider } = createBackend();
  const command = "set -e\npwd\necho ok";

  assert.deepEqual(await backend.execute(command), {
    output: "user execute",
    exitCode: 0,
    truncated: false,
  });

  assert.deepEqual(provider.executeInputs, [
    {
      providerSandboxId: "provider-sandbox-1",
      command,
      cwd: "/workspace",
      timeoutMs: limits.commandTimeoutMs,
      maxOutputChars: limits.maxOutputChars,
    },
  ]);
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
  assert.deepEqual(operationStore.completed.map((entry) => entry.status), [
    "succeeded",
  ]);
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

  const result = await backend.execute("mkdir -p /workfiles/ppt-deck");

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

  const first = await backend.execute("ls /workfiles", {
    toolCallId: "call-vfs-1",
  });
  const second = await backend.execute("ls /workfiles", {
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
  const { backend, provider } = createBackendWithOperationStore(operationStore, {
    runtimeContext: contextWithoutExecuteToolCallId,
    toolApprovalEnabled: false,
  });

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
  assert.deepEqual(sandboxStore.releaseReasons, [
    "sandbox_execute_runtime_error",
  ]);
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
    (await backend.write("/workfiles/output.md", "x")).error ?? "",
    /SANDBOX_FILE_PATH_DENIED|SANDBOX_READ_PATH_DENIED/u,
  );
  const executeResult = await backend.execute("node /workfiles/output.js");
  assert.equal(executeResult.exitCode, 1);
  assert.equal(executeResult.truncated, false);
  assert.match(executeResult.output, /SANDBOX_EXECUTE_VFS_PATH_DENIED/u);
  assert.match(executeResult.output, /\/workfiles/u);
  assert.deepEqual(provider.executed, []);
  assert.deepEqual(provider.ensuredDirectories, []);
  assert.deepEqual(provider.uploadedFiles, []);
});

test("SourceWeftSandboxBackend returns per-file permission errors for invalid downloads", async () => {
  const { backend } = createBackend();

  const downloads = await backend.downloadFiles([
    "/workfiles/output.md",
    "/workspace/ppt-deck/missing.md",
  ]);

  assert.deepEqual(
    downloads.map((download) => download.error),
    ["permission_denied", "file_not_found"],
  );
});

test("SourceWeftSandboxBackend returns recoverable error for absolute glob patterns outside sandbox roots", async () => {
  const { backend } = createBackend();

  const result = await backend.glob("/workfiles/**/*.md", "/workspace/ppt-deck");

  assert.match(result.error ?? "", /SANDBOX_READ_PATH_DENIED/u);
});
