import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SandboxManager,
  resolveSandboxToolOperationReplay,
  stableSandboxRequestJson,
} from "../../src/runtime/sandbox-manager";
import { sandboxRequestFingerprint } from "../../src/runtime/redaction";
import type {
  SandboxOperationStore,
  SandboxProvider,
  SandboxProviderPathPolicy,
  SandboxRuntimeContext,
  SandboxStore,
} from "../../src/runtime/types";

const TEST_SANDBOX_PATH_POLICY: SandboxProviderPathPolicy = {
  workspaceRoot: "/workspace",
  defaultCwd: "/workspace",
  prepareTargetRoots: ["/workspace/input", "/workspace"],
  collectSourceRoots: ["/workspace/output", "/workspace"],
  readWriteRoots: ["/workspace", "/tmp/sourceweft"],
};

function createTestSandboxStore(): SandboxStore {
  return {
    async findLatestActiveThreadSandbox() {
      return null;
    },
    async markCreatingSandboxError() {
      return true;
    },
    async insertCreatingSandbox() {
      return true;
    },
    async markSandboxReady() {},
    async markSandboxExpired() {},
    async releaseReadyThreadSandboxLease() {
      return 0;
    },
    async touchSandbox() {},
  };
}

function createTestProvider(): SandboxProvider {
  return {
    id: "fake",
    pathPolicy: TEST_SANDBOX_PATH_POLICY,
    async createSandbox() {
      return { id: "sandbox-1" };
    },
    async getSandbox() {
      return {};
    },
    async deleteSandbox() {},
    async execute() {
      return { output: "", exitCode: 0, truncated: false };
    },
    async uploadFile() {},
    async downloadFile() {
      return Buffer.from("");
    },
    async ensureDirectory() {},
  };
}

function createMessageScopedOperationStore() {
  type Operation = {
    createdAt: Date;
    id: string;
    messageId: string;
    request: Record<string, unknown>;
    result: Record<string, unknown>;
    status: "running" | "succeeded" | "failed";
  };
  const operations = new Map<string, Operation>();
  const keyFor = (input: {
    context: SandboxRuntimeContext;
    operationType: string;
    toolCallId: string;
  }) => `${input.context.messageId}:${input.operationType}:${input.toolCallId}`;

  const store: SandboxOperationStore & { inserts: string[] } = {
    inserts: [],
    async findLatestToolOperation(input) {
      const operation = operations.get(keyFor(input));
      return operation && input.statuses.includes(operation.status)
        ? {
            id: operation.id,
            createdAt: operation.createdAt,
            messageId: operation.messageId,
            status: operation.status,
            requestJsonRedacted: operation.request,
            resultJsonRedacted: operation.result,
          }
        : null;
    },
    async insertRunningToolOperation(input) {
      const key = keyFor(input);
      if (operations.get(key)?.status === "running") {
        return false;
      }
      store.inserts.push(input.context.messageId);
      operations.set(key, {
        id: input.operationId,
        createdAt: new Date(),
        messageId: input.context.messageId,
        request: input.request,
        result: {},
        status: "running",
      });
      return true;
    },
    async findLatestActiveToolOperation(input) {
      const operation = operations.get(keyFor(input));
      return operation &&
        (operation.status === "running" || operation.status === "succeeded")
        ? {
            id: operation.id,
            createdAt: operation.createdAt,
            messageId: operation.messageId,
            status: operation.status,
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
        (candidate) => candidate.id === input.operationId,
      );
      if (!operation) {
        return;
      }
      operation.status = input.status;
      operation.result = input.result ?? {};
    },
    async recordOperation(input) {
      if (!input.toolCallId) {
        return;
      }
      operations.set(keyFor({
        context: input.context,
        operationType: input.operationType,
        toolCallId: input.toolCallId,
      }), {
        id: input.operationId,
        createdAt: new Date(),
        messageId: input.context.messageId,
        request: input.request ?? {},
        result: input.result ?? {},
        status: input.status as "running" | "succeeded" | "failed",
      });
    },
    async findSucceededOperationByToolCall(input) {
      const operation = operations.get(keyFor(input));
      return operation?.status === "succeeded"
        ? { result: operation.result }
        : null;
    },
  };
  return store;
}

function createSandboxManager(operationStore: SandboxOperationStore) {
  return new SandboxManager({
    provider: createTestProvider(),
    sandboxStore: createTestSandboxStore(),
    operationStore,
    ttlSeconds: 3600,
    commandTimeoutMs: 1,
  });
}

test("stableSandboxRequestJson normalizes object key order", () => {
  assert.equal(
    stableSandboxRequestJson({ b: 2, a: { d: 4, c: 3 } }),
    stableSandboxRequestJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("stableSandboxRequestJson distinguishes different replay requests", () => {
  assert.notEqual(
    stableSandboxRequestJson({ command: "pwd" }),
    stableSandboxRequestJson({ command: "rm -rf /workspace/ppt-deck" }),
  );
});

test("failed sandbox operation requires explicit retry request change", () => {
  const command = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 npm test";
  const existing = {
    status: "failed" as const,
    requestJsonRedacted: {
      command: "GITHUB_TOKEN=[redacted] npm test",
      _sourceweftRequestFingerprint: sandboxRequestFingerprint({ command }),
    },
    resultJsonRedacted: { error: "provider failed" },
  };

  const sameRequest = resolveSandboxToolOperationReplay({
    operationType: "execute",
    existing,
    request: { command },
  });
  const retryRequest = resolveSandboxToolOperationReplay({
    operationType: "execute",
    existing,
    request: { command, retryNonce: "retry-1" },
  });

  assert.equal(sameRequest.kind, "error");
  assert.match(
    sameRequest.kind === "error" ? sameRequest.message : "",
    /SANDBOX_OPERATION_FAILED_RETRY_REQUIRED/,
  );
  assert.equal(retryRequest.kind, "proceed");
});

test("failed sandbox retry diagnostics include operation and message context", () => {
  const result = resolveSandboxToolOperationReplay({
    operationType: "prepare",
    currentMessageId: "message-new",
    existing: {
      id: "operation-old",
      createdAt: new Date("2026-06-14T18:23:18.598Z"),
      messageId: "message-old",
      status: "failed",
      requestJsonRedacted: {
        files: [{ sourcePath: "/workfiles/ppt-deck/deck.js" }],
      },
      resultJsonRedacted: { error: "ENOENT" },
    },
    request: {
      files: [{ sourcePath: "/workfiles/ppt-deck/deck.js" }],
    },
  });

  assert.equal(result.kind, "error");
  assert.match(result.kind === "error" ? result.message : "", /operation-old/u);
  assert.match(result.kind === "error" ? result.message : "", /message-old/u);
  assert.match(result.kind === "error" ? result.message : "", /message-new/u);
  assert.match(result.kind === "error" ? result.message : "", /sha256:/u);
});

test("fingerprinted redacted requests do not conflate different raw commands", () => {
  const existing = {
    status: "succeeded" as const,
    requestJsonRedacted: {
      command: "GITHUB_TOKEN=[redacted] npm test",
      _sourceweftRequestFingerprint: sandboxRequestFingerprint({
        command: "GITHUB_TOKEN=ghp_firstsecret1234567890 npm test",
      }),
    },
    resultJsonRedacted: { output: "first", exitCode: 0 },
  };

  const result = resolveSandboxToolOperationReplay({
    operationType: "execute",
    existing,
    request: { command: "GITHUB_TOKEN=ghp_secondsecret123456789 npm test" },
  });

  assert.equal(result.kind, "error");
  assert.match(
    result.kind === "error" ? result.message : "",
    /SANDBOX_OPERATION_REQUEST_MISMATCH/,
  );
});

test("beginToolOperation releases stale running operation and claims a new one", async () => {
  const context: SandboxRuntimeContext = {
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    messageId: "message-1",
    runId: "run-1",
  };
  let operationStatus: "running" | "failed" = "running";
  let insertAttempts = 0;
  const staleCreatedAt = new Date(Date.now() - 120_000);
  const operationStore: SandboxOperationStore = {
    async findLatestToolOperation() {
      return operationStatus === "running"
        ? {
            id: "operation-old",
            createdAt: staleCreatedAt,
            status: "running",
            requestJsonRedacted: { command: "npm test" },
            resultJsonRedacted: {},
          }
        : null;
    },
    async insertRunningToolOperation(input) {
      insertAttempts += 1;
      assert.match(
        String(input.request._sourceweftRequestFingerprint),
        /^sha256:/,
      );
      return operationStatus === "failed";
    },
    async findLatestActiveToolOperation() {
      return operationStatus === "running"
        ? {
            id: "operation-old",
            createdAt: staleCreatedAt,
            status: "running",
            requestJsonRedacted: { command: "npm test" },
            resultJsonRedacted: {},
          }
        : null;
    },
    async markStaleRunningToolOperationFailed() {
      operationStatus = "failed";
      return true;
    },
    async completeToolOperation() {},
    async recordOperation() {},
    async findSucceededOperationByToolCall() {
      return null;
    },
  };
  const sandboxStore: SandboxStore = {
    async findLatestActiveThreadSandbox() {
      return null;
    },
    async markCreatingSandboxError() {
      return true;
    },
    async insertCreatingSandbox() {
      return true;
    },
    async markSandboxReady() {},
    async markSandboxExpired() {},
    async releaseReadyThreadSandboxLease() {
      return 0;
    },
    async touchSandbox() {},
  };
  const provider: SandboxProvider = {
    id: "fake",
    pathPolicy: TEST_SANDBOX_PATH_POLICY,
    async createSandbox() {
      return { id: "sandbox-1" };
    },
    async getSandbox() {
      return {};
    },
    async deleteSandbox() {},
    async execute() {
      return { output: "", exitCode: 0, truncated: false };
    },
    async uploadFile() {},
    async downloadFile() {
      return Buffer.from("");
    },
    async ensureDirectory() {},
  };
  const manager = new SandboxManager({
    provider,
    sandboxStore,
    operationStore,
    ttlSeconds: 3600,
    commandTimeoutMs: 1,
  });

  const claim = await manager.beginToolOperation({
    context,
    operationType: "execute",
    toolCallId: "call-1",
    request: { command: "npm test" },
  });

  assert.equal(claim.kind, "claimed");
  assert.equal(operationStatus, "failed");
  assert.equal(insertAttempts, 1);
});

test("beginToolOperation scopes replay records by message id", async () => {
  const operationStore = createMessageScopedOperationStore();
  const manager = createSandboxManager(operationStore);
  const baseContext: SandboxRuntimeContext = {
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    messageId: "message-old",
    runId: "run-1",
  };

  const first = await manager.beginToolOperation({
    context: baseContext,
    operationType: "prepare",
    toolCallId: "call-repeat",
    request: { files: [{ sourcePath: "/workfiles/ppt-deck/deck.js" }] },
  });
  assert.equal(first.kind, "claimed");
  await manager.completeToolOperation({
    operationId: first.kind === "claimed" ? first.operationId : "",
    status: "failed",
    result: { error: "ENOENT" },
  });

  await assert.rejects(
    () =>
      manager.beginToolOperation({
        context: baseContext,
        operationType: "prepare",
        toolCallId: "call-repeat",
        request: { files: [{ sourcePath: "/workfiles/ppt-deck/deck.js" }] },
      }),
    /SANDBOX_OPERATION_FAILED_RETRY_REQUIRED/u,
  );

  const second = await manager.beginToolOperation({
    context: { ...baseContext, messageId: "message-new", runId: "run-2" },
    operationType: "prepare",
    toolCallId: "call-repeat",
    request: { files: [{ sourcePath: "/workfiles/ppt-deck/deck.js" }] },
  });

  assert.equal(second.kind, "claimed");
  assert.deepEqual(operationStore.inserts, ["message-old", "message-new"]);
});

test("getOrCreateThreadSandbox checks newly created sandbox health before marking ready", async () => {
  const checked: string[] = [];
  const ready: string[] = [];
  const manager = new SandboxManager({
    provider: {
      ...createTestProvider(),
      async checkSandboxHealth(providerSandboxId) {
        checked.push(providerSandboxId);
      },
    },
    sandboxStore: {
      ...createTestSandboxStore(),
      async markSandboxReady(input) {
        ready.push(input.providerSandboxId);
      },
    },
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    commandTimeoutMs: 1,
  });

  const sandbox = await manager.getOrCreateThreadSandbox({
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    messageId: "message-1",
    runId: "run-1",
  });

  assert.equal(sandbox.providerSandboxId, "sandbox-1");
  assert.deepEqual(checked, ["sandbox-1"]);
  assert.deepEqual(ready, ["sandbox-1"]);
});

test("getOrCreateThreadSandbox expires unhealthy ready sandbox and creates a fresh one", async () => {
  const expired: string[] = [];
  const created: string[] = [];
  const checked: string[] = [];
  const existing = {
    id: "sandbox-existing",
    provider: "fake",
    providerSandboxId: "provider-existing",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    status: "ready" as const,
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
  const manager = new SandboxManager({
    provider: {
      ...createTestProvider(),
      async createSandbox() {
        created.push("provider-new");
        return { id: "provider-new" };
      },
      async checkSandboxHealth(providerSandboxId) {
        checked.push(providerSandboxId);
        if (providerSandboxId === "provider-existing") {
          throw new Error("SANDBOX_NOT_READY_OR_UNHEALTHY");
        }
      },
    },
    sandboxStore: {
      ...createTestSandboxStore(),
      async findLatestActiveThreadSandbox() {
        return expired.length === 0 ? existing : null;
      },
      async markSandboxExpired(input) {
        expired.push(input.sandboxId);
      },
    },
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    commandTimeoutMs: 1,
  });

  const sandbox = await manager.getOrCreateThreadSandbox({
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    messageId: "message-1",
    runId: "run-1",
  });

  assert.equal(sandbox.providerSandboxId, "provider-new");
  assert.deepEqual(checked, ["provider-existing", "provider-new"]);
  assert.deepEqual(expired, ["sandbox-existing"]);
  assert.deepEqual(created, ["provider-new"]);
});

test("beginToolOperation replays succeeded operations only within the same message id", async () => {
  const operationStore = createMessageScopedOperationStore();
  const manager = createSandboxManager(operationStore);
  const context: SandboxRuntimeContext = {
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    messageId: "message-1",
    runId: "run-1",
  };

  const first = await manager.beginToolOperation({
    context,
    operationType: "execute",
    toolCallId: "call-repeat",
    request: { command: "npm test" },
  });
  assert.equal(first.kind, "claimed");
  await manager.completeToolOperation({
    operationId: first.kind === "claimed" ? first.operationId : "",
    status: "succeeded",
    result: { output: "ok", exitCode: 0 },
  });

  const replay = await manager.beginToolOperation({
    context,
    operationType: "execute",
    toolCallId: "call-repeat",
    request: { command: "npm test" },
  });
  assert.deepEqual(replay, {
    kind: "replay",
    result: { output: "ok", exitCode: 0 },
  });

  const nextMessage = await manager.beginToolOperation({
    context: { ...context, messageId: "message-2", runId: "run-2" },
    operationType: "execute",
    toolCallId: "call-repeat",
    request: { command: "npm test" },
  });
  assert.equal(nextMessage.kind, "claimed");
});
