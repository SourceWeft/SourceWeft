import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SandboxManager,
  SANDBOX_CREATE_WORST_CASE_MS,
  SANDBOX_CREATING_STALE_MS,
  SANDBOX_CREATING_WAIT_TIMEOUT_MS,
  SANDBOX_LOST_GENERATION_REPLACEMENT_LIMIT,
  resolveSandboxToolOperationReplay,
  stableSandboxRequestJson,
} from "../../src/runtime/sandbox-manager";
import { sandboxRequestFingerprint } from "../../src/runtime/redaction";
import {
  SandboxProviderError,
  SANDBOX_PROVIDER_ERROR_CODES,
  SANDBOX_REPLACED_NOTICE,
  SANDBOX_RESTARTED_NOTICE,
} from "../../src/runtime/errors";
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
  readWriteRoots: ["/workspace"],
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
    async markSandboxReady() {
      return true;
    },
    async markSandboxExpired() {
      return true;
    },
    async releaseReadyThreadSandboxLease() {
      return 0;
    },
    async touchSandbox() {
      return true;
    },
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
    async listMessageOperations() {
      return [];
    },
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
      operations.set(
        keyFor({
          context: input.context,
          operationType: input.operationType,
          toolCallId: input.toolCallId,
        }),
        {
          id: input.operationId,
          createdAt: new Date(),
          messageId: input.context.messageId,
          request: input.request ?? {},
          result: input.result ?? {},
          status: input.status as "running" | "succeeded" | "failed",
        },
      );
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
    maxCommandTimeoutMs: 1,
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
        files: [{ sourcePath: "/files/ppt-deck/deck.js" }],
      },
      resultJsonRedacted: { error: "ENOENT" },
    },
    request: {
      files: [{ sourcePath: "/files/ppt-deck/deck.js" }],
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
    async listMessageOperations() {
      return [];
    },
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
    async markSandboxReady() {
      return true;
    },
    async markSandboxExpired() {
      return true;
    },
    async releaseReadyThreadSandboxLease() {
      return 0;
    },
    async touchSandbox() {
      return true;
    },
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
    maxCommandTimeoutMs: 1,
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
    request: { files: [{ sourcePath: "/files/ppt-deck/deck.js" }] },
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
        request: { files: [{ sourcePath: "/files/ppt-deck/deck.js" }] },
      }),
    /SANDBOX_OPERATION_FAILED_RETRY_REQUIRED/u,
  );

  const second = await manager.beginToolOperation({
    context: { ...baseContext, messageId: "message-new", runId: "run-2" },
    operationType: "prepare",
    toolCallId: "call-repeat",
    request: { files: [{ sourcePath: "/files/ppt-deck/deck.js" }] },
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
        return true;
      },
    },
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1,
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

test("a persisted generation fence rejects late results across manager instances", async () => {
  const context: SandboxRuntimeContext = {
    teamId: "team-persistent-fence",
    workspaceId: "workspace-persistent-fence",
    threadId: "thread-persistent-fence",
    userId: "user-persistent-fence",
    messageId: "message-persistent-fence",
    runId: "run-persistent-fence",
  };
  const sandbox = {
    id: "sandbox-generation-persistent",
    provider: "fake",
    providerSandboxId: "provider-sandbox-persistent",
  };
  let active = true;
  const sandboxStore: SandboxStore = {
    ...createTestSandboxStore(),
    async findLatestActiveThreadSandbox() {
      return active
        ? {
            ...sandbox,
            ...context,
            status: "ready" as const,
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          }
        : null;
    },
    async markSandboxExpired() {
      active = false;
      return true;
    },
  };
  const operationStore = createMessageScopedOperationStore();
  let dispositionDuringProviderCancellation: string | null = null;
  let firstManager!: SandboxManager;
  const provider: SandboxProvider = {
    ...createTestProvider(),
    cancellationScope: "sandbox",
    async cancelExecution() {
      dispositionDuringProviderCancellation =
        await firstManager.resolveExecutionResultDisposition(sandbox, context);
      return { confirmed: true, mode: "sandbox" };
    },
  };
  firstManager = new SandboxManager({
    provider,
    sandboxStore,
    operationStore,
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1,
  });
  const secondManager = new SandboxManager({
    provider,
    sandboxStore,
    operationStore,
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1,
  });

  await secondManager.cancelExecution({
    sandbox,
    executionId: "execution-from-second-manager",
    reason: "user_cancelled",
  });

  assert.equal(dispositionDuringProviderCancellation, "instance_changed");
  assert.equal(
    await firstManager.resolveExecutionResultDisposition(sandbox, context),
    "instance_changed",
  );
});

test("a persisted generation replacement rejects a result from the old sandbox", async () => {
  const context: SandboxRuntimeContext = {
    teamId: "team-generation-replaced",
    workspaceId: "workspace-generation-replaced",
    threadId: "thread-generation-replaced",
    userId: "user-generation-replaced",
    messageId: "message-generation-replaced",
    runId: "run-generation-replaced",
  };
  const oldSandbox = {
    id: "sandbox-generation-old",
    provider: "fake",
    providerSandboxId: "provider-sandbox-old",
  };
  const sandboxStore: SandboxStore = {
    ...createTestSandboxStore(),
    async findLatestActiveThreadSandbox() {
      return {
        id: "sandbox-generation-new",
        provider: "fake",
        providerSandboxId: "provider-sandbox-new",
        ...context,
        status: "ready",
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
  };
  const manager = new SandboxManager({
    provider: createTestProvider(),
    sandboxStore,
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1,
  });

  assert.equal(
    await manager.resolveExecutionResultDisposition(oldSandbox, context),
    "instance_changed",
  );
});

test("getOrCreateThreadSandbox recreates only a confirmed missing instance before binding", async () => {
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
          throw new SandboxProviderError(
            SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
            "identity missing",
            "get",
          );
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
        return true;
      },
    },
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1,
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

test("getOrCreateThreadSandbox waits for concurrent sandbox creation and reuses ready sandbox", async () => {
  let lookupCount = 0;
  const touched: string[] = [];
  const readyAfterWait = {
    id: "sandbox-concurrent",
    provider: "fake",
    providerSandboxId: "provider-concurrent",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    status: "ready" as const,
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
  const creating = {
    ...readyAfterWait,
    providerSandboxId: "creating:sandbox-concurrent",
    status: "creating" as const,
  };
  const manager = new SandboxManager({
    provider: createTestProvider(),
    sandboxStore: {
      ...createTestSandboxStore(),
      async findLatestActiveThreadSandbox() {
        lookupCount += 1;
        return lookupCount === 1 ? creating : readyAfterWait;
      },
      async insertCreatingSandbox() {
        throw new Error("should not create a second sandbox");
      },
      async touchSandbox(input) {
        touched.push(input.sandboxId);
        return true;
      },
    },
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1,
  });

  const sandbox = await manager.getOrCreateThreadSandbox(
    {
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      messageId: "message-1",
      runId: "run-1",
    },
    { waitIntervalMs: 1, waitTimeoutMs: 50 },
  );

  assert.equal(sandbox.providerSandboxId, "provider-concurrent");
  assert.equal(lookupCount, 2);
  assert.deepEqual(touched, ["sandbox-concurrent"]);
});

function acquisitionFixture() {
  const context: SandboxRuntimeContext = {
    teamId: "tenant-a",
    workspaceId: "workspace-a",
    threadId: "thread-a",
    userId: "user-a",
    messageId: "message-a",
    runId: "run-a",
  };
  const existing = {
    ...context,
    id: "instance-a",
    provider: "synthetic-provider",
    providerSandboxId: "remote-a",
    status: "ready" as const,
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
  };
  return {
    context,
    existing,
    store: {
      ...createTestSandboxStore(),
      findLatestActiveThreadSandbox: async () => existing,
    } satisfies SandboxStore,
  };
}

test("parallel acquisitions share checking and asset preparation and pin the instance for the run", async () => {
  const { context, store } = acquisitionFixture();
  let checked!: () => void,
    releaseCheck!: () => void,
    staging!: () => void,
    releaseStaging!: () => void;
  const checkEntered = new Promise<void>((r) => {
    checked = r;
  });
  const checkGate = new Promise<void>((r) => {
    releaseCheck = r;
  });
  const stagingEntered = new Promise<void>((r) => {
    staging = r;
  });
  const stagingGate = new Promise<void>((r) => {
    releaseStaging = r;
  });
  let checks = 0,
    prepared = 0,
    settled = 0,
    touches = 0;
  const manager = new SandboxManager({
    provider: {
      ...createTestProvider(),
      id: "synthetic-provider",
      getSandbox: async () => {
        throw new Error("must not repeat the declared health check");
      },
      checkSandboxHealth: async () => {
        checks++;
        checked();
        await checkGate;
      },
    },
    sandboxStore: {
      ...store,
      touchSandbox: async () => {
        touches++;
        return true;
      },
    },
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1000,
    requiredAssetStaging: {
      plans: async () => {
        prepared++;
        staging();
        await stagingGate;
        return [];
      },
      commandTimeoutMs: 1000,
      maxOutputChars: 1000,
    },
  });
  const pending = [1, 2, 3].map(() =>
    manager.getOrCreateThreadSandbox(context).then((x) => {
      settled++;
      return x;
    }),
  );
  await checkEntered;
  assert.equal(checks, 1);
  releaseCheck();
  await stagingEntered;
  assert.equal(
    settled,
    0,
    "no operation may escape while preparation is pending",
  );
  releaseStaging();
  const refs = await Promise.all(pending);
  assert.strictEqual(refs[0], refs[1]);
  assert.strictEqual(refs[1], refs[2]);
  await manager.getOrCreateThreadSandbox(context);
  assert.equal(checks, 1);
  assert.equal(prepared, 1);
  assert.equal(touches, 4);
  await manager.getOrCreateThreadSandbox({ ...context, runId: "another-run" });
  await manager.getOrCreateThreadSandbox({
    ...context,
    workspaceId: "another-workspace",
  });
  assert.equal(checks, 3, "different scopes must not share acquisitions");
});

for (const error of [
  new SandboxProviderError(
    SANDBOX_PROVIDER_ERROR_CODES.unavailable,
    "network unavailable",
    "get",
  ),
  new SandboxProviderError(
    SANDBOX_PROVIDER_ERROR_CODES.authentication,
    "not authorized",
    "get",
  ),
  new SandboxProviderError(
    SANDBOX_PROVIDER_ERROR_CODES.fileMissing,
    "file missing",
    "download",
  ),
  new Error(
    "SANDBOX_NOT_FOUND_OR_EXPIRED: a string is not a provider classification",
  ),
])
  test(`acquisition failure is shared without expiry or recreation: ${error.message}`, async () => {
    const { context, store } = acquisitionFixture();
    let checked = 0,
      expired = 0,
      created = 0;
    const manager = new SandboxManager({
      provider: {
        ...createTestProvider(),
        getSandbox: async () => {
          checked++;
          throw error;
        },
        createSandbox: async () => {
          created++;
          return { id: "unexpected" };
        },
      },
      sandboxStore: {
        ...store,
        markSandboxExpired: async () => {
          expired++;
          return true;
        },
      },
      operationStore: createMessageScopedOperationStore(),
      ttlSeconds: 3600,
      maxCommandTimeoutMs: 1000,
    });
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => manager.getOrCreateThreadSandbox(context)),
    );
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected")
        assert.strictEqual(result.reason, error);
    }
    // Concurrent callers shared one check. A later call is a new attempt
    // (a momentary outage must not poison the whole turn), so it checks
    // again — and still neither expires nor recreates the instance.
    assert.equal(checked, 1);
    await assert.rejects(
      manager.getOrCreateThreadSandbox(context),
      (e) => e === error,
    );
    assert.equal(checked, 2);
    assert.equal(expired, 0);
    assert.equal(created, 0);
  });

test("renewal errors preserve the original cause and safe diagnostics without invalidating the instance", async () => {
  const { context, store } = acquisitionFixture();
  let checks = 0,
    expired = 0;
  const error = new Error("renew failed", {
    cause: new Error("api_key=private-value"),
  });
  const logs: unknown[] = [];
  const manager = new SandboxManager({
    provider: {
      ...createTestProvider(),
      getSandbox: async () => {
        checks++;
      },
    },
    sandboxStore: {
      ...store,
      touchSandbox: async () => {
        throw error;
      },
      markSandboxExpired: async () => {
        expired++;
        return true;
      },
    },
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1000,
    logWarn: (_message, data) => logs.push(data),
  });
  await assert.rejects(
    manager.getOrCreateThreadSandbox(context),
    (e) => e === error,
  );
  await assert.rejects(
    manager.getOrCreateThreadSandbox(context),
    (e) => e === error,
  );
  assert.equal(checks, 1);
  assert.equal(expired, 0);
  assert.match(JSON.stringify(logs), /renew/);
  assert.ok(!JSON.stringify(logs).includes("private-value"));
});

/**
 * A store that tracks one thread's generations like the real table does:
 * creating → ready → expired. Lets a test drive the full fence/replace cycle
 * (terminate → look up → recreate) instead of scripting each lookup.
 */
function createStatefulSandboxStore() {
  type Row = {
    id: string;
    providerSandboxId: string;
    status: "creating" | "ready" | "expired" | "error";
    updatedAt: Date;
  };
  const rows: Row[] = [];
  const calls = { expired: 0, ready: 0, creatingError: 0, released: 0 };
  const store: SandboxStore & { rows: Row[]; calls: typeof calls } = {
    rows,
    calls,
    async findLatestActiveThreadSandbox({ context }) {
      const row = [...rows]
        .reverse()
        .find((r) => r.status === "creating" || r.status === "ready");
      return row
        ? {
            ...context,
            id: row.id,
            provider: "fake",
            providerSandboxId: row.providerSandboxId,
            status: row.status,
            updatedAt: row.updatedAt,
            expiresAt: new Date(Date.now() + 3600_000),
          }
        : null;
    },
    async insertCreatingSandbox(input) {
      rows.push({
        id: input.sandboxId,
        providerSandboxId: input.providerSandboxId,
        status: "creating",
        updatedAt: new Date(),
      });
      return true;
    },
    async markSandboxReady(input) {
      const row = rows.find((r) => r.id === input.sandboxId);
      if (!row || row.status !== "creating") return false;
      row.status = "ready";
      row.providerSandboxId = input.providerSandboxId;
      calls.ready += 1;
      return true;
    },
    async markCreatingSandboxError(input) {
      const row = rows.find((r) => r.id === input.sandboxId);
      if (!row || row.status !== "creating") return false;
      row.status = "error";
      calls.creatingError += 1;
      return true;
    },
    async markSandboxExpired(input) {
      const row = rows.find((r) => r.id === input.sandboxId);
      if (!row || row.status === "expired") return false;
      row.status = "expired";
      calls.expired += 1;
      return true;
    },
    async releaseReadyThreadSandboxLease() {
      calls.released += 1;
      return 0;
    },
    async touchSandbox(input) {
      const row = rows.find((r) => r.id === input.sandboxId);
      return row?.status === "ready";
    },
  };
  return store;
}

function replacementFixture() {
  const { context } = acquisitionFixture();
  const store = createStatefulSandboxStore();
  let created = 0;
  const logs: Array<{ event: string; meta: Record<string, unknown> }> = [];
  const manager = new SandboxManager({
    provider: {
      ...createTestProvider(),
      createSandbox: async () => {
        created += 1;
        return { id: `remote-${created}` };
      },
    },
    sandboxStore: store,
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1000,
    logWarn: (event, meta) =>
      logs.push({ event, meta: meta as Record<string, unknown> }),
  });
  return { context, store, manager, logs, created: () => created };
}

test("a generation terminated after a timeout before accepting any operation is replaced on the next acquisition", async () => {
  const { context, store, manager, logs, created } = replacementFixture();
  const first = await manager.getOrCreateThreadSandbox(context);
  assert.equal(first.providerSandboxId, "remote-1");

  // Provider without command-scoped cancellation: the host timeout deletes
  // the sandbox and fences the generation.
  const cancellation = await manager.cancelExecution({
    sandbox: first,
    executionId: "execution-1",
    reason: "timed_out",
  });
  assert.deepEqual(cancellation, { confirmed: true, mode: "sandbox" });

  const second = await manager.getOrCreateThreadSandbox(context);
  assert.equal(second.providerSandboxId, "remote-2");
  assert.notEqual(second.id, first.id);
  assert.equal(created(), 2);
  assert.equal(
    logs.some((log) => log.event === "sandbox.generation.replaced"),
    true,
  );
  // The notice reaches the model exactly once.
  assert.equal(manager.consumeReplacementNotice(), SANDBOX_REPLACED_NOTICE);
  assert.equal(manager.consumeReplacementNotice(), false);

  // Late results for the old generation are still rejected, and the
  // replacement is the only generation whose results are accepted.
  assert.equal(
    await manager.resolveExecutionResultDisposition(first, context),
    "sandbox_terminated",
  );
  assert.equal(
    await manager.resolveExecutionResultDisposition(second, context),
    "accepted",
  );
  // A third acquisition reuses the replacement without creating again.
  const third = await manager.getOrCreateThreadSandbox(context);
  assert.strictEqual(third, second);
  assert.equal(created(), 2);
});

test("a generation that accepted an operation is never replaced within that run", async () => {
  const { context, manager, created } = replacementFixture();
  const first = await manager.getOrCreateThreadSandbox(context);
  // A succeeded upload/prepare receipt on this generation.
  await manager.completeToolOperation({
    operationId: "prepare-1",
    sandboxId: first.id,
    status: "succeeded",
    result: { ok: true },
  });
  await manager.cancelExecution({
    sandbox: first,
    executionId: "execution-1",
    reason: "timed_out",
  });
  await assert.rejects(
    manager.getOrCreateThreadSandbox(context),
    (e: unknown) =>
      (e as { code?: string }).code === "SANDBOX_INSTANCE_CHANGED",
  );
  await assert.rejects(
    manager.getOrCreateThreadSandbox(context),
    (e: unknown) =>
      (e as { code?: string }).code === "SANDBOX_INSTANCE_CHANGED",
  );
  assert.equal(created(), 1);
  assert.equal(manager.consumeReplacementNotice(), false);
});

test("an accepted execute result also pins the generation against replacement", async () => {
  const { context, manager, created } = replacementFixture();
  const first = await manager.getOrCreateThreadSandbox(context);
  assert.equal(
    await manager.resolveExecutionResultDisposition(first, context),
    "accepted",
  );
  await manager.cancelExecution({
    sandbox: first,
    executionId: "execution-1",
    reason: "timed_out",
  });
  await assert.rejects(
    manager.getOrCreateThreadSandbox(context),
    (e: unknown) =>
      (e as { code?: string }).code === "SANDBOX_INSTANCE_CHANGED",
  );
  assert.equal(created(), 1);
});

test("a bound instance that loses its ready state is replaced only when it accepted nothing", async () => {
  // Stateless: the swept row is forgotten and a fresh generation is created.
  {
    const { context, store, manager, created } = replacementFixture();
    const first = await manager.getOrCreateThreadSandbox(context);
    store.rows.find((row) => row.id === first.id)!.status = "expired";
    const second = await manager.getOrCreateThreadSandbox(context);
    assert.equal(second.providerSandboxId, "remote-2");
    assert.equal(created(), 2);
    assert.equal(
      await manager.resolveExecutionResultDisposition(first, context),
      "instance_changed",
    );
  }
  // Stateful: the run stays pinned to the lost generation and fails closed.
  {
    const { context, store, manager, created } = replacementFixture();
    const first = await manager.getOrCreateThreadSandbox(context);
    await manager.completeToolOperation({
      operationId: "prepare-1",
      sandboxId: first.id,
      status: "succeeded",
      result: { ok: true },
    });
    store.rows.find((row) => row.id === first.id)!.status = "expired";
    await assert.rejects(
      manager.getOrCreateThreadSandbox(context),
      (e: unknown) =>
        (e as { code?: string }).code === "SANDBOX_INSTANCE_CHANGED",
    );
    assert.equal(created(), 1);
  }
});

test("a replacement that is fenced again in the same call fails closed instead of looping", async () => {
  const { context, store, manager, created } = replacementFixture();
  const first = await manager.getOrCreateThreadSandbox(context);
  await manager.cancelExecution({
    sandbox: first,
    executionId: "execution-1",
    reason: "timed_out",
  });
  // The fence write did not land: the store still reports the old row ready
  // and refuses to expire it.
  store.rows.find((row) => row.id === first.id)!.status = "ready";
  store.markSandboxExpired = async () => false;
  await assert.rejects(
    manager.getOrCreateThreadSandbox(context),
    (e: unknown) =>
      (e as { code?: string }).code === "SANDBOX_INSTANCE_CHANGED",
  );
  assert.equal(created(), 1);
});

test("aborting an acquisition while the provider create is blocked marks the row errored without fencing or expiring", async () => {
  const { context, store, manager } = replacementFixture();
  let createGate!: () => void;
  const createEntered = new Promise<void>((resolve) => {
    createGate = resolve;
  });
  const provider = manager.providerForSandbox();
  provider.createSandbox = async (input) => {
    createGate();
    await new Promise<never>((_resolve, reject) => {
      input.signal?.addEventListener("abort", () =>
        reject(input.signal?.reason),
      );
    });
    throw new Error("unreachable");
  };
  const controller = new AbortController();
  const reason = Object.assign(new Error("tool deadline elapsed"), {
    name: "TimeoutError",
  });
  const acquisition = manager.getOrCreateThreadSandbox(context, {
    signal: controller.signal,
  });
  void acquisition.catch(() => undefined);
  await createEntered;
  controller.abort(reason);
  await assert.rejects(acquisition, (e) => e === reason);
  assert.equal(store.calls.ready, 0);
  assert.equal(store.calls.expired, 0);
  assert.equal(store.calls.creatingError, 1);

  // The aborted acquisition is this caller's outcome, not the run's: the
  // next call starts over and succeeds.
  provider.createSandbox = async () => ({ id: "remote-after-abort" });
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  assert.equal(sandbox.providerSandboxId, "remote-after-abort");
  assert.equal(
    await manager.resolveExecutionResultDisposition(sandbox, context),
    "accepted",
  );
});

test("aborting while waiting for a sibling's creation stops the wait at once", async () => {
  const { context, store, existing } = acquisitionFixture();
  const manager = new SandboxManager({
    provider: createTestProvider(),
    sandboxStore: {
      ...store,
      findLatestActiveThreadSandbox: async () => ({
        ...existing,
        providerSandboxId: "creating:other",
        status: "creating" as const,
        updatedAt: new Date(),
      }),
    },
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1000,
  });
  const controller = new AbortController();
  const reason = new DOMException("user stopped", "AbortError");
  const acquisition = manager.getOrCreateThreadSandbox(context, {
    signal: controller.signal,
    waitIntervalMs: 10_000,
    waitTimeoutMs: 60_000,
  });
  void acquisition.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const startedAt = Date.now();
  controller.abort(reason);
  await assert.rejects(acquisition, (e) => e === reason);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("a joiner's abort stops only its own wait; the owner's acquisition completes", async () => {
  const { context, manager, created } = replacementFixture();
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  manager.providerForSandbox().createSandbox = async () => {
    await createGate;
    return { id: "remote-shared" };
  };
  const owner = manager.getOrCreateThreadSandbox(context);
  const joinerController = new AbortController();
  const joiner = manager.getOrCreateThreadSandbox(context, {
    signal: joinerController.signal,
  });
  void joiner.catch(() => undefined);
  const reason = new DOMException("joiner stopped", "AbortError");
  joinerController.abort(reason);
  await assert.rejects(joiner, (e) => e === reason);
  releaseCreate();
  const sandbox = await owner;
  assert.equal(sandbox.providerSandboxId, "remote-shared");
  assert.equal(created(), 0);
});

test("creation timing constants cover one worst-case create and leave the stale sweep a margin", () => {
  assert.ok(SANDBOX_CREATING_WAIT_TIMEOUT_MS > SANDBOX_CREATE_WORST_CASE_MS);
  assert.ok(
    SANDBOX_CREATING_STALE_MS >= SANDBOX_CREATING_WAIT_TIMEOUT_MS + 60_000,
  );
});

test("late operation completion cannot persist success after its instance expires", async () => {
  let completions = 0;
  const manager = new SandboxManager({
    provider: createTestProvider(),
    sandboxStore: {
      ...createTestSandboxStore(),
      touchSandbox: async () => false,
    },
    operationStore: {
      ...createMessageScopedOperationStore(),
      completeToolOperation: async () => {
        completions++;
      },
    },
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1000,
  });
  await assert.rejects(
    manager.completeToolOperation({
      operationId: "late-result",
      sandboxId: "expired-instance",
      status: "succeeded",
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "SANDBOX_INSTANCE_CHANGED",
  );
  assert.equal(completions, 0);
});

test("creation failure remains shared when persisting that failure also fails", async () => {
  const { context } = acquisitionFixture();
  const original = new Error("provider acquisition failed");
  let creates = 0;
  const logs: unknown[] = [];
  const manager = new SandboxManager({
    provider: {
      ...createTestProvider(),
      createSandbox: async () => {
        creates++;
        throw original;
      },
    },
    sandboxStore: {
      ...createTestSandboxStore(),
      markCreatingSandboxError: async () => {
        throw new Error("database unavailable");
      },
    },
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1000,
    logWarn: (_message, meta) => {
      logs.push(meta);
    },
  });
  const results = await Promise.allSettled([
    manager.getOrCreateThreadSandbox(context),
    manager.getOrCreateThreadSandbox(context),
  ]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, original);
  }
  assert.equal(creates, 1);
  assert.match(JSON.stringify(logs), /record_create_failure/);
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

test("cancelExecution is idempotent for one provider execution", async () => {
  let cancellationCalls = 0;
  const provider: SandboxProvider = {
    ...createTestProvider(),
    cancellationScope: "command",
    async cancelExecution() {
      cancellationCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { confirmed: true, mode: "command" };
    },
  };
  const manager = new SandboxManager({
    provider,
    sandboxStore: createTestSandboxStore(),
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1,
  });
  const sandbox = {
    id: "sandbox-row-1",
    provider: "fake",
    providerSandboxId: "sandbox-provider-1",
  };

  const [first, second] = await Promise.all([
    manager.cancelExecution({
      sandbox,
      executionId: "execution-1",
      reason: "user_cancelled",
    }),
    manager.cancelExecution({
      sandbox,
      executionId: "execution-1",
      reason: "user_cancelled",
    }),
  ]);

  assert.deepEqual(first, { confirmed: true, mode: "command" });
  assert.deepEqual(second, first);
  assert.equal(cancellationCalls, 1);
});

// A momentary provider outage (connection reset, 5xx) must not fail the
// acquisition — it used to surface to the user as "command failed".
function retryFixture(
  createSandbox: (attempt: number) => Promise<{ id: string }>,
) {
  let attempts = 0;
  const warnings: Array<{ event: string; meta: Record<string, unknown> }> = [];
  const manager = new SandboxManager({
    provider: {
      ...createTestProvider(),
      async createSandbox() {
        attempts += 1;
        return createSandbox(attempts);
      },
    },
    sandboxStore: createTestSandboxStore(),
    operationStore: createMessageScopedOperationStore(),
    ttlSeconds: 3600,
    maxCommandTimeoutMs: 1,
    logWarn: (event, meta) =>
      warnings.push({ event, meta: meta as Record<string, unknown> }),
  });
  const acquire = (runId: string) =>
    manager.getOrCreateThreadSandbox({
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: `thread-${runId}`,
      userId: "user-1",
      messageId: "message-1",
      runId,
    });
  return { acquire, warnings, attempts: () => attempts };
}
const unavailable = () =>
  new SandboxProviderError(
    SANDBOX_PROVIDER_ERROR_CODES.unavailable,
    "SANDBOX_NOT_READY_OR_UNHEALTHY: provider unavailable",
    "create",
    new TypeError("fetch failed"),
  );

test("sandbox creation rides out a momentary provider outage", async () => {
  const fixture = retryFixture(async (attempt) => {
    if (attempt === 1) throw unavailable();
    return { id: "sandbox-after-retry" };
  });
  const sandbox = await fixture.acquire("retry-once");
  assert.equal(sandbox.providerSandboxId, "sandbox-after-retry");
  assert.equal(fixture.attempts(), 2);
  const retries = fixture.warnings.filter(
    (warning) => warning.event === "sandbox.create.retry",
  );
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.meta.attempt, 1);
});

test("sandbox creation gives up after its retries and reports the provider error", async () => {
  const fixture = retryFixture(async () => {
    throw unavailable();
  });
  await assert.rejects(fixture.acquire("retry-exhausted"), {
    code: SANDBOX_PROVIDER_ERROR_CODES.unavailable,
  });
  // The first try plus two retries — bounded, so a real outage fails fast.
  assert.equal(fixture.attempts(), 3);
});

for (const code of [
  SANDBOX_PROVIDER_ERROR_CODES.authentication,
  SANDBOX_PROVIDER_ERROR_CODES.unknown,
  SANDBOX_PROVIDER_ERROR_CODES.timeout,
] as const) {
  test(`sandbox creation does not retry what a retry cannot fix: ${code}`, async () => {
    const fixture = retryFixture(async () => {
      throw new SandboxProviderError(code, `${code}: nope`, "create");
    });
    await assert.rejects(fixture.acquire(`no-retry-${code}`), { code });
    assert.equal(fixture.attempts(), 1);
    assert.equal(
      fixture.warnings.some((w) => w.event === "sandbox.create.retry"),
      false,
    );
  });
}

test("sandbox creation does not retry a readiness-probe failure: the provider already spent its probe budget", async () => {
  const fixture = retryFixture(async () => {
    throw new SandboxProviderError(
      SANDBOX_PROVIDER_ERROR_CODES.unavailable,
      "SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox did not become ready within 90s after create. Retry the operation to create a fresh sandbox.",
      "create",
    );
  });
  await assert.rejects(fixture.acquire("probe-exhausted"), {
    code: SANDBOX_PROVIDER_ERROR_CODES.unavailable,
  });
  assert.equal(fixture.attempts(), 1);
  assert.equal(
    fixture.warnings.some((w) => w.event === "sandbox.create.retry"),
    false,
  );
});

test("a ready generation reused from an earlier turn is never replaced: its /workspace may already hold state", async () => {
  const { context, store, manager, created } = replacementFixture();
  // Left ready by a previous turn (or another worker); this manager did not
  // create it and cannot know what the model already put there.
  store.rows.push({
    id: "instance-earlier",
    providerSandboxId: "remote-earlier",
    status: "ready",
    updatedAt: new Date(),
  });
  const reused = await manager.getOrCreateThreadSandbox(context);
  assert.equal(reused.providerSandboxId, "remote-earlier");
  assert.equal(created(), 0);
  await manager.cancelExecution({
    sandbox: reused,
    executionId: "execution-1",
    reason: "timed_out",
  });
  await assert.rejects(
    manager.getOrCreateThreadSandbox(context),
    (e: unknown) =>
      (e as { code?: string }).code === "SANDBOX_INSTANCE_CHANGED",
  );
  assert.equal(created(), 0);
  assert.equal(manager.consumeReplacementNotice(), false);
});

test("a failed acquisition is forgotten after it settles so the next call re-acquires", async () => {
  const fixture = retryFixture(async (attempt) => {
    if (attempt === 1) {
      // A probe-budget failure is not retried inside the create; it must
      // still not poison the rest of the turn.
      throw new SandboxProviderError(
        SANDBOX_PROVIDER_ERROR_CODES.unavailable,
        "SANDBOX_NOT_READY_OR_UNHEALTHY: sandbox did not become ready within 90s after create.",
        "create",
      );
    }
    return { id: "sandbox-after-outage" };
  });
  await assert.rejects(fixture.acquire("same-run"), {
    code: SANDBOX_PROVIDER_ERROR_CODES.unavailable,
  });
  assert.equal(fixture.attempts(), 1);
  const sandbox = await fixture.acquire("same-run");
  assert.equal(sandbox.providerSandboxId, "sandbox-after-outage");
  assert.equal(fixture.attempts(), 2);
});

test("an abort that lands after the provider create resolved deletes the live container", async () => {
  const { context, store, manager } = replacementFixture();
  const controller = new AbortController();
  const reason = new DOMException("user stopped", "AbortError");
  const deleted: string[] = [];
  const provider = manager.providerForSandbox();
  provider.createSandbox = async () => {
    // The provider ignores the signal and returns a running container just
    // as the host gives up on this call.
    controller.abort(reason);
    return { id: "remote-live-but-unready" };
  };
  provider.deleteSandbox = async (id) => {
    deleted.push(id);
  };
  await assert.rejects(
    manager.getOrCreateThreadSandbox(context, { signal: controller.signal }),
    (e) => e === reason,
  );
  assert.deepEqual(deleted, ["remote-live-but-unready"]);
  assert.equal(store.calls.ready, 0);
  assert.equal(store.calls.expired, 0);
  assert.equal(store.calls.creatingError, 1);
});

// ── Background skill staging (Issue #323 B2) ─────────────────────────────

for (const fence of ["cancelExecution", "renew failure"] as const)
  test(`a fenced generation's skill staging stops (${fence}): no further provider calls to it, and it never speaks for the replacement`, async () => {
    const { context } = acquisitionFixture();
    const loads: Array<(content: Uint8Array | null) => void> = [];
    const loadEntered: Array<() => void> = [];
    const entered = [0, 1].map(
      (index) =>
        new Promise<void>((resolve) => {
          loadEntered[index] = resolve;
        }),
    );
    let created = 0;
    const calls: Array<{ kind: string; providerSandboxId: string }> = [];
    const executeInputs: Array<Record<string, unknown>> = [];
    const store = createStatefulSandboxStore();
    const manager = new SandboxManager({
      provider: {
        // No executeSystem: staging falls back to plain execute, which must
        // never receive the idempotent flag.
        ...createTestProvider(),
        createSandbox: async () => {
          created += 1;
          return { id: `remote-${created}` };
        },
        execute: async (input) => {
          executeInputs.push(input);
          calls.push({
            kind: "execute",
            providerSandboxId: input.providerSandboxId,
          });
          return { output: "", exitCode: 0, truncated: false };
        },
        uploadFile: async (input) => {
          calls.push({
            kind: "upload",
            providerSandboxId: input.providerSandboxId,
          });
        },
        downloadFile: async (input) => {
          calls.push({
            kind: "download",
            providerSandboxId: input.providerSandboxId,
          });
          return Buffer.from("");
        },
      },
      sandboxStore: store,
      operationStore: createMessageScopedOperationStore(),
      ttlSeconds: 3600,
      maxCommandTimeoutMs: 1000,
      skillStaging: {
        plans: async () => [
          {
            name: "notes",
            version: "sv-1",
            platform: "any",
            sha256: "a".repeat(64),
            archive: "zip",
            entrypoint: "SKILL.md",
            installDir: "/skills/notes",
            loadContent: () =>
              new Promise<Uint8Array | null>((resolve) => {
                const index = loads.length;
                loads.push(resolve);
                loadEntered[index]?.();
              }),
          },
        ],
        commandTimeoutMs: 1000,
        maxOutputChars: 1000,
      },
    });

    const first = await manager.getOrCreateThreadSandbox(context);
    await entered[0];
    if (fence === "cancelExecution") {
      // Host timeout without a command-scoped kill → sandbox delete.
      await manager.cancelExecution({
        sandbox: first,
        executionId: "execution-1",
        reason: "timed_out",
      });
    } else {
      // Swept / fenced by another worker: the next renewal fails and the
      // stateless generation is forgotten.
      await store.markSandboxExpired({ sandboxId: first.id });
    }
    const callsToFirst = () =>
      calls.filter((call) => call.providerSandboxId === "remote-1").length;
    const firstCallsAtFence = callsToFirst();
    const second = await manager.getOrCreateThreadSandbox(context);
    assert.equal(second.providerSandboxId, "remote-2");
    await entered[1];

    // The old generation's blocked load resolves after the fence.
    loads[0]!(new Uint8Array([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      callsToFirst(),
      firstCallsAtFence,
      "staging must not address a fenced generation",
    );
    assert.equal(manager.skillScriptsStaged(), false);
    assert.equal(manager.skillAssetResolutions(), null);

    loads[1]!(new Uint8Array([1, 2, 3]));
    await manager.ensureSkillAssetsStaged(second);
    assert.equal(manager.skillScriptsStaged(), true);
    assert.equal(loads.length, 2, "each generation started staging once");
    assert.equal(callsToFirst(), firstCallsAtFence);
    assert.ok(executeInputs.length > 0);
    assert.ok(executeInputs.every((input) => !("idempotent" in input)));
  });

// ── Provider-side container replacement mid-run (Issue #323 follow-up) ────

function lostInstanceError() {
  return new SandboxProviderError(
    SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
    "SANDBOX_NOT_FOUND_OR_EXPIRED: the sandbox identity stamp was missing or did not match when the command started; the container was replaced and the command did not run.",
    "execute",
  );
}

test("a generation the provider replaced mid-run is fenced, expired and replaced once reported, although it accepted operations", async () => {
  const { context, store, manager, logs, created } = replacementFixture();
  const first = await manager.getOrCreateThreadSandbox(context);
  // The model already relied on this generation: a succeeded execute.
  await manager.completeToolOperation({
    operationId: "execute-1",
    sandboxId: first.id,
    status: "succeeded",
    result: { exitCode: 0 },
  });

  const verdict = await manager.reportLostGeneration(
    first,
    context,
    lostInstanceError(),
  );
  assert.equal(verdict?.code, "SANDBOX_REPLACED");
  assert.match(verdict?.message ?? "", /replaced by the provider/u);
  assert.match(verdict?.message ?? "", /this operation did not run/u);
  // The row is expired in this one place, with the generation pinned.
  assert.equal(store.calls.expired, 1);
  // Late results from siblings still running on the old container are
  // rejected, and their staging stops.
  assert.equal(
    await manager.resolveExecutionResultDisposition(first, context),
    "instance_changed",
  );
  // A sibling reporting the same loss gets the same verdict, no second expiry.
  assert.strictEqual(
    await manager.reportLostGeneration(first, context, lostInstanceError()),
    verdict,
  );
  assert.equal(store.calls.expired, 1);

  // The old initializationRuns entry no longer pins the run: the next
  // acquisition is the replacement the report already prefetched.
  const second = await manager.getOrCreateThreadSandbox(context);
  assert.equal(second.providerSandboxId, "remote-2");
  assert.notEqual(second.id, first.id);
  assert.equal(created(), 2);
  assert.equal(
    await manager.resolveExecutionResultDisposition(second, context),
    "accepted",
  );
  // The first result on the replacement says why, once.
  assert.equal(manager.consumeReplacementNotice(), SANDBOX_RESTARTED_NOTICE);
  assert.equal(manager.consumeReplacementNotice(), false);
  assert.ok(logs.some((log) => log.event === "sandbox.generation.lost"));
  assert.ok(
    logs.some(
      (log) =>
        log.event === "sandbox.generation.replaced" &&
        log.meta.phase === "lost",
    ),
  );
});

test("a provider-side replacement beyond the per-turn limit fails closed with SANDBOX_INSTANCE_CHANGED and creates nothing more", async () => {
  const { context, store, manager, created } = replacementFixture();
  let current = await manager.getOrCreateThreadSandbox(context);
  for (
    let loss = 1;
    loss <= SANDBOX_LOST_GENERATION_REPLACEMENT_LIMIT;
    loss += 1
  ) {
    const verdict = await manager.reportLostGeneration(
      current,
      context,
      lostInstanceError(),
    );
    assert.equal(verdict?.code, "SANDBOX_REPLACED");
    current = await manager.getOrCreateThreadSandbox(context);
    assert.equal(current.providerSandboxId, `remote-${loss + 1}`);
    assert.equal(manager.consumeReplacementNotice(), SANDBOX_RESTARTED_NOTICE);
  }

  const verdict = await manager.reportLostGeneration(
    current,
    context,
    lostInstanceError(),
  );
  assert.equal(verdict?.code, "SANDBOX_INSTANCE_CHANGED");
  assert.match(verdict?.message ?? "", /replaced by the provider again/u);
  assert.match(
    verdict?.message ?? "",
    /unavailable for the rest of this turn/u,
  );
  assert.equal(
    store.calls.expired,
    SANDBOX_LOST_GENERATION_REPLACEMENT_LIMIT + 1,
  );
  await assert.rejects(
    manager.getOrCreateThreadSandbox(context),
    (error: unknown) =>
      (error as { code?: string }).code === "SANDBOX_INSTANCE_CHANGED",
  );
  assert.equal(created(), SANDBOX_LOST_GENERATION_REPLACEMENT_LIMIT + 1);
  assert.equal(manager.consumeReplacementNotice(), false);
});

test("a loss reported on a generation a cancellation already fenced leaves that fence in charge", async () => {
  const { context, store, manager, created } = replacementFixture();
  const first = await manager.getOrCreateThreadSandbox(context);
  await manager.cancelExecution({
    sandbox: first,
    executionId: "execution-1",
    reason: "user_cancelled",
  });
  const expired = store.calls.expired;

  assert.equal(
    await manager.reportLostGeneration(first, context, lostInstanceError()),
    null,
  );
  assert.equal(store.calls.expired, expired);
  assert.equal(
    await manager.resolveExecutionResultDisposition(first, context),
    "sandbox_terminated",
  );
  assert.equal(created(), 1);
});
