import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandboxRuntimeForTurn } from "../../src/runtime/runtime";
import { SandboxManager } from "../../src/runtime/sandbox-manager";
import { SandboxVolumePersistenceError } from "../../src/runtime/volume-durability";
import { SourceWeftSandboxBackend } from "../../src/runtime/sourceweft-sandbox-backend";
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
  SandboxVolumeHooks,
} from "../../src/runtime/types";

/**
 * The manager/backend side of the volume integration, with a fake provider and fake hooks:
 * attach once per sandbox, every command wrapped, output replaced by the parsed one, a replaced
 * container re-attached and the command issued exactly once more.
 */
const TEST_SANDBOX_PATH_POLICY: SandboxProviderPathPolicy = {
  workspaceRoot: "/workspace",
  defaultCwd: "/workspace",
  prepareTargetRoots: ["/workspace/input", "/workspace"],
  collectSourceRoots: ["/workspace/output", "/workspace"],
  readWriteRoots: ["/workspace"],
};

const context: SandboxRuntimeContext = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  userId: "user-1",
  messageId: "message-1",
  runId: "run-1",
  sandboxExecuteToolCallId: "tool-call-execute",
};

const limits: SandboxRuntimeLimits = {
  ttlSeconds: 3600,
  commandBudgetsMs: { interactive: 120_000, batch: 480_000 },
  maxCommandTimeoutMs: 600_000,
  maxOutputChars: 80_000,
  maxPrepareFileBytes: 1_000_000,
  maxPrepareTotalBytes: 1_000_000,
  maxCollectFileBytes: 1_000_000,
  maxCollectTotalBytes: 1_000_000,
};

function createSandboxStore(): SandboxStore {
  return {
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
    async releaseReadyThreadSandboxLease() {
      return 1;
    },
    async touchSandbox() {
      return true;
    },
  };
}

function createOperationStore(): SandboxOperationStore {
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

function createProvider(
  responses: Array<{ output: string; exitCode: number }>,
) {
  const executed: string[] = [];
  const provider: SandboxProvider = {
    id: "fake",
    pathPolicy: TEST_SANDBOX_PATH_POLICY,
    volumeControl: {
      async identity() {
        return {
          protocolVersion: 1,
          boundary: "pid-namespace",
          protectedControl: true,
          // Idealized contract fixture only; no real provider supplies this capability.
          stableFreeze: {
            available: true,
            mechanism: "cgroup-v2-freezer",
            kernelEnforced: true,
            kernelIoQuiescence: "qualified",
          },
          bootId: "boot-1",
          supervisorNonce: "supervisor-1",
        };
      },
      async freeze(input) {
        return {
          freezeId: input.freezeId,
          supervisorNonce: input.expectedNonce,
          allWritersStopped: true,
          mechanism: "cgroup-v2-freezer",
          kernelEnforced: true,
          kernelIoQuiescent: true,
        };
      },
      async resume() {},
      async flush() {
        return { output: "trusted receipt", exitCode: 0 };
      },
      async drain(input) {
        return {
          drainId: input.drainId,
          bootId: "boot-1",
          supervisorNonce: input.expectedNonce,
          launchGateClosed: true,
          allNamespacesExited: true,
        };
      },
    },
    async createSandbox() {
      return { id: "provider-sandbox-1" };
    },
    async getSandbox() {
      return {};
    },
    async deleteSandbox() {},
    async execute(input) {
      executed.push(input.command);
      const next = responses.shift() ?? { output: "", exitCode: 0 };
      return { ...next, truncated: false };
    },
    async executeSupervised(input) {
      return provider.execute(input);
    },
    async uploadFile() {},
    async downloadFile() {
      return Buffer.alloc(0);
    },
    async ensureDirectory() {},
  };
  return { provider, executed };
}

function createHooks() {
  const calls: string[] = [];
  let attachments = 0;
  class Replaced extends Error {
    readonly commandStarted = false;
  }
  const hooks: SandboxVolumeHooks = {
    protectedBootstrap: true,
    async assertActive() {},
    async quarantine() {},
    async acquireOperation(input) {
      return { permitId: `permit-${input.operationId}`, reused: false };
    },
    async markOperationStarted() {
      return true;
    },
    async releaseOperation() {},
    async attach() {
      calls.push("attach");
      attachments += 1;
      return { attachmentId: `att-${attachments}` };
    },
    wrapCommand(command) {
      return `WRAP(${command})`;
    },
    async parseResult(input) {
      calls.push(`parse:${input.attachmentId}`);
      if (input.output.includes("__REPLACED__")) throw new Replaced("replaced");
      return {
        output: input.output.replace(/ \+marker$/, ""),
        exitCode: input.exitCode,
        sync: { persisted: true },
      };
    },
    async checkpoint(input) {
      calls.push(`checkpoint:${input.attachmentId}`);
      return { sync: { persisted: true, confirmedSeq: 1 } };
    },
    async checkpointScope() {
      calls.push("checkpointScope");
      return { sync: { persisted: true, confirmedSeq: 1 } };
    },
    async onContainerReplaced() {
      calls.push("reattach");
      attachments += 1;
      return { attachmentId: `att-${attachments}` };
    },
    isContainerReplacedError(error) {
      return error instanceof Replaced;
    },
  };
  return { hooks, calls, Replaced };
}

function createBackend(
  responses: Array<{ output: string; exitCode: number }>,
  volume: SandboxVolumeHooks | null,
) {
  const { provider, executed } = createProvider(responses);
  const operations: Array<{
    status: string;
    result?: Record<string, unknown>;
  }> = [];
  const operationStore = createOperationStore();
  operationStore.completeToolOperation = async (input) => {
    operations.push({ status: input.status, result: input.result });
  };
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore,
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
    volume,
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled: true,
  });
  return { backend, manager, executed, operations, operationStore, provider };
}

test("without a volume the backend behaves exactly as before", async () => {
  const { backend, executed } = createBackend(
    [{ output: "hello", exitCode: 0 }],
    null,
  );
  const result = await backend.execute("echo hello");
  assert.equal(result.output, "hello");
  assert.deepEqual(executed, ["echo hello"]);
});

test("file upload returns only after an independently confirmed persistence barrier", async () => {
  const { hooks } = createHooks();
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let reachedBarrier!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedBarrier = resolve;
  });
  const events: string[] = [];
  hooks.checkpoint = async () => {
    events.push("checkpoint");
    reachedBarrier();
    await barrier;
    return { sync: { persisted: true, confirmedSeq: 5 } };
  };
  const { backend, provider } = createBackend([], hooks);
  provider.uploadFile = async () => {
    events.push("upload");
  };
  let returned = false;
  const pending = backend
    .uploadFiles([["/workspace/saved.txt", Buffer.from("saved")]])
    .then((result) => {
      returned = true;
      return result;
    });
  await reached;
  assert.equal(returned, false);
  assert.deepEqual(events, ["upload", "checkpoint"]);
  releaseBarrier();
  assert.equal((await pending)[0]?.error, null);
});

test("failed file persistence does not report success or replay the upload", async () => {
  const { hooks } = createHooks();
  hooks.checkpoint = async () => ({ sync: { persisted: false } });
  const { backend, provider } = createBackend([], hooks);
  let uploads = 0;
  provider.uploadFile = async () => {
    uploads++;
  };
  await assert.rejects(
    backend.uploadFiles([["/workspace/saved.txt", Buffer.from("saved")]]),
    /persistence|checkpoint/i,
  );
  assert.equal(uploads, 1);
});

test("protected volume commands use raw user output and out-of-band checkpoints", async () => {
  const { hooks, calls } = createHooks();
  const { backend, executed } = createBackend(
    [
      { output: "one +marker", exitCode: 0 },
      { output: "two +marker", exitCode: 3 },
    ],
    hooks,
  );
  const first = await backend.execute("echo one");
  const second = await backend.execute("exit 3");
  assert.equal(first.output, "one +marker");
  assert.equal(second.output, "two +marker");
  assert.equal(second.exitCode, 3);
  assert.deepEqual(executed, ["echo one", "exit 3"]);
  assert.deepEqual(calls, ["attach", "checkpoint:att-1", "checkpoint:att-1"]);
});

test("a changed instance during admitted preflight never dispatches or blindly restores", async () => {
  const { hooks, calls, Replaced } = createHooks();
  hooks.assertActive = async () => {
    throw new Replaced("instance replaced; recovery required");
  };
  const { backend, executed } = createBackend([], hooks);
  await assert.rejects(backend.execute("echo never"), /recovery required/);
  assert.deepEqual(executed, []);
  assert.deepEqual(calls, ["attach"]);
});

test("replacement text in user output never authorizes restoration or replay", async () => {
  const { hooks, calls } = createHooks();
  const { backend, executed } = createBackend(
    [{ output: "__REPLACED__", exitCode: 75 }],
    hooks,
  );
  const result = await backend.execute("write-once");
  assert.equal(result.output, "__REPLACED__");
  assert.equal(result.exitCode, 75);
  assert.deepEqual(executed, ["write-once"]);
  assert.deepEqual(calls, ["attach", "checkpoint:att-1"]);
});

test("the checkpoint goes to the attachment the manager made", async () => {
  const { hooks, calls } = createHooks();
  const { backend, manager } = createBackend(
    [{ output: "x +marker", exitCode: 0 }],
    hooks,
  );
  await backend.execute("true");
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  await manager.withVolumeOperation({
    sandbox,
    context,
    operationId: "second-checkpoint",
    run: async () => undefined,
  });
  assert.deepEqual(calls, ["attach", "checkpoint:att-1", "checkpoint:att-1"]);
});

for (const failure of ["pending", "missing marker", "malformed marker"]) {
  test(`volume ${failure} cannot report success or replay a completed command`, async () => {
    const { hooks, calls } = createHooks();
    hooks.checkpoint = async () => {
      if (failure !== "pending") throw new Error(failure);
      return { sync: { persisted: false } };
    };
    const { backend, executed, operations } = createBackend(
      [{ output: "already wrote file", exitCode: 0 }],
      hooks,
    );
    await assert.rejects(
      backend.execute("echo side-effect >> file"),
      /persist|marker/i,
    );
    assert.deepEqual(executed, ["echo side-effect >> file"]);
    assert.ok(!calls.includes("reattach"));
    assert.equal(operations.at(-1)?.status, "failed");
    assert.ok(!operations.some((x) => x.status === "succeeded"));
  });
}

test("checkpoint cannot discard an unsuccessful persistence acknowledgement", async () => {
  const { hooks } = createHooks();
  hooks.checkpoint = async () => ({ sync: { persisted: false } });
  const { backend, manager } = createBackend(
    [{ output: "written +marker", exitCode: 0 }],
    hooks,
  );
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  await assert.rejects(
    manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "bad-checkpoint",
      run: async () => undefined,
    }),
    /persist/i,
  );
});

test("trusted host execution also rejects unconfirmed persistence without replay", async () => {
  const { hooks, calls } = createHooks();
  hooks.checkpoint = async () => ({ sync: { persisted: false } });
  const { provider, executed } = createProvider([
    { output: "written", exitCode: 0 },
  ]);
  const recorded: Array<{ status: string }> = [];
  const operationStore = createOperationStore();
  operationStore.recordOperation = async (input) => {
    recorded.push({ status: input.status });
  };
  const runtime = createSandboxRuntimeForTurn({
    filesystem: {} as never,
    context,
    limits,
    provider,
    sandboxStore: createSandboxStore(),
    operationStore,
    toolApprovalEnabled: false,
    volume: hooks,
  });
  await assert.rejects(
    runtime.trustedHost.executeCurrent({
      command: "echo side-effect >> file",
      timeoutMs: 480_000,
    }),
    /persist/i,
  );
  assert.deepEqual(executed, ["echo side-effect >> file"]);
  assert.ok(!calls.includes("reattach"));
  assert.equal(recorded.at(-1)?.status, "failed");
});

test("a persisted user command exiting 75 is not treated as pre-execution replacement", async () => {
  const { hooks, calls } = createHooks();
  const { backend, executed } = createBackend(
    [{ output: "user side effect +marker", exitCode: 75 }],
    hooks,
  );
  const result = await backend.execute("echo side-effect >> file; exit 75");
  assert.equal(result.exitCode, 75);
  assert.deepEqual(executed, ["echo side-effect >> file; exit 75"]);
  assert.ok(!calls.includes("reattach"));
});

test("confirmed durability survives recording and replay without re-executing", async () => {
  const { hooks } = createHooks();
  hooks.checkpoint = async () => ({
    sync: { persisted: true, confirmedSeq: 42 },
  });
  const { backend, executed, operations, operationStore } = createBackend(
    [{ output: "done", exitCode: 4 }],
    hooks,
  );
  let recordedRequest: Record<string, unknown> = {};
  operationStore.insertRunningToolOperation = async (input) => {
    recordedRequest = input.request;
    return true;
  };
  const first = await backend.execute("exit 4");
  assert.deepEqual(first.durability, {
    status: "confirmed",
    attachmentId: "att-1",
    confirmedSeq: 42,
  });
  assert.deepEqual(operations[0]?.result?.durability, first.durability);
  operationStore.findLatestToolOperation = async () => ({
    status: "succeeded",
    requestJsonRedacted: recordedRequest,
    resultJsonRedacted: operations[0]!.result!,
  });
  assert.deepEqual(await backend.execute("exit 4"), first);
  assert.equal(executed.length, 1);
});

test("persistence failure preserves the executed command result in its error and operation", async () => {
  const { hooks } = createHooks();
  hooks.checkpoint = async () => {
    throw Object.assign(new Error("flush failed"), {
      commandOutput: "saved file\nAPI_KEY=super-secret",
      commandExitCode: 7,
      durabilityStatus: "failed",
    });
  };
  const { backend, operations, executed } = createBackend(
    [{ output: "saved file\nAPI_KEY=super-secret", exitCode: 7 }],
    hooks,
  );
  await assert.rejects(backend.execute("write-once"), (error: unknown) => {
    const value = error as {
      commandExitCode: number;
      commandOutput: string;
      durability: unknown;
      message: string;
    };
    assert.equal(value.commandExitCode, 7);
    assert.match(value.commandOutput, /saved file/);
    assert.ok(!value.commandOutput.includes("super-secret"));
    assert.deepEqual(value.durability, {
      status: "failed",
      attachmentId: "att-1",
    });
    assert.match(value.message, /Do not execute the command again/);
    return true;
  });
  assert.equal(operations[0]?.status, "failed");
  assert.equal(operations[0]?.result?.commandExitCode, 7);
  assert.equal(operations[0]?.result?.automaticRetryAllowed, false);
  assert.deepEqual(operations[0]?.result?.durability, {
    status: "failed",
    attachmentId: "att-1",
  });
  assert.equal(executed.length, 1);
});

test("unverified preflight replacement errors cannot dispatch a user command", async () => {
  const { hooks, calls } = createHooks();
  hooks.assertActive = async () => {
    throw new Error("instance unverified");
  };
  hooks.isContainerReplacedError = () => true;
  const { backend, executed } = createBackend([], hooks);
  await assert.rejects(backend.execute("write-once"), /unverified/);
  assert.deepEqual(executed, []);
  assert.ok(!calls.includes("reattach"));
});

test("shadow acknowledgement remains visible as observation, not confirmed persistence", async () => {
  const { hooks } = createHooks();
  hooks.checkpoint = async () => ({
    sync: { persisted: true, confirmedSeq: 1, mode: "shadow" },
  });
  const { backend, operations } = createBackend(
    [{ output: "done", exitCode: 0 }],
    hooks,
  );
  const result = await backend.execute("true");
  assert.equal(result.durability?.status, "pending");
  assert.match(result.output, /shadow observation.*not confirmed/);
  assert.equal(
    (operations[0]?.result?.durability as { status: string }).status,
    "pending",
  );
});

test("persistent sandbox-scoped cancellation quarantines and retains its only disk copy", async () => {
  const { hooks } = createHooks();
  const { backend, manager, provider } = createBackend(
    [{ output: "done", exitCode: 0 }],
    hooks,
  );
  let quarantined = false;
  let destructiveCalls = 0;
  hooks.quarantine = async ({ attachmentId }) => {
    assert.equal(attachmentId, "att-1");
    quarantined = true;
  };
  provider.cancelExecution = async () => {
    destructiveCalls++;
    return { confirmed: true, mode: "sandbox" };
  };
  provider.deleteSandbox = async () => {
    destructiveCalls++;
  };
  await backend.execute("true");
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  assert.deepEqual(
    await manager.cancelExecution({
      sandbox,
      executionId: "execution-1",
      reason: "user_cancelled",
    }),
    { confirmed: false, mode: "unknown" },
  );
  assert.equal(quarantined, true);
  assert.equal(destructiveCalls, 0);
  await assert.rejects(manager.getOrCreateThreadSandbox(context), /instance/i);
});

test("database fencing is checked again before each command on a cached attachment", async () => {
  const { hooks } = createHooks();
  let fenced = false;
  hooks.assertActive = async () => {
    if (fenced) throw new Error("attachment quarantined");
  };
  const { backend, executed } = createBackend(
    [{ output: "done", exitCode: 0 }],
    hooks,
  );
  await backend.execute("first");
  fenced = true;
  await assert.rejects(backend.execute("second"), /quarantined/);
  assert.deepEqual(executed, ["first"]);
});

test("volume restoration precedes runtime asset and skill staging", async () => {
  const { hooks } = createHooks();
  const order: string[] = [];
  const originalAttach = hooks.attach;
  hooks.attach = async (input) => {
    order.push("restore");
    return originalAttach(input);
  };
  const { provider } = createProvider([]);
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore: createOperationStore(),
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
    volume: hooks,
    requiredAssetStaging: {
      plans: async () => {
        order.push("assets");
        return [];
      },
      commandTimeoutMs: 1000,
      maxOutputChars: 1000,
    },
    skillStaging: {
      plans: async () => {
        order.push("skills");
        return [];
      },
      commandTimeoutMs: 1000,
      maxOutputChars: 1000,
    },
  });
  await manager.getOrCreateThreadSandbox(context);
  assert.deepEqual(order, ["restore", "assets", "skills"]);
});

test("trusted host returns and records the storage acknowledgement", async () => {
  const { hooks } = createHooks();
  hooks.checkpoint = async () => ({
    sync: { persisted: true, confirmedSeq: 13 },
  });
  const { provider } = createProvider([{ output: "done", exitCode: 0 }]);
  const recorded: Array<Record<string, unknown> | undefined> = [];
  const operationStore = createOperationStore();
  operationStore.recordOperation = async (input) => {
    recorded.push(input.result);
  };
  const runtime = createSandboxRuntimeForTurn({
    filesystem: {} as never,
    context,
    limits,
    provider,
    sandboxStore: createSandboxStore(),
    operationStore,
    toolApprovalEnabled: false,
    volume: hooks,
  });
  const result = await runtime.trustedHost.executeCurrent({
    command: "true",
    timeoutMs: 480_000,
  });
  assert.deepEqual(result.durability, {
    status: "confirmed",
    attachmentId: "att-1",
    confirmedSeq: 13,
  });
  assert.deepEqual(recorded.at(-1)?.durability, result.durability);
});

for (const missing of [true, false]) {
  test(`volume replacement requires provider missing evidence (${missing ? "missing" : "network failure"})`, async () => {
    const { hooks, calls } = createHooks();
    const { provider } = createProvider([]);
    const store = createSandboxStore();
    const originalLookup = store.findLatestActiveThreadSandbox;
    let expired = false;
    store.findLatestActiveThreadSandbox = async (input) =>
      expired ? null : originalLookup(input);
    store.markSandboxExpired = async () => {
      expired = true;
      return true;
    };
    provider.getSandbox = async (id) => {
      if (id === "provider-sandbox-1")
        throw Object.assign(new Error(missing ? "missing" : "unavailable"), {
          code: missing
            ? "SANDBOX_NOT_FOUND_OR_EXPIRED"
            : "SANDBOX_NOT_READY_OR_UNHEALTHY",
          ...(missing
            ? {
                physicalAbsence: {
                  authority: "provider-resource-api",
                  outcome: "not_found",
                  provider: "fake",
                  providerSandboxId: "provider-sandbox-1",
                  requestId: "provider-request-1",
                  observedAtMs: Date.now(),
                },
              }
            : {}),
        });
      return {};
    };
    provider.createSandbox = async () => ({ id: "replacement-sandbox" });
    let replacement:
      { sandboxId: string; previousSandboxId?: string } | undefined;
    hooks.onContainerReplaced = async (input) => {
      replacement = input;
      return { attachmentId: "replacement-att" };
    };
    const manager = new SandboxManager({
      provider,
      sandboxStore: store,
      operationStore: createOperationStore(),
      ttlSeconds: limits.ttlSeconds,
      maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
      volume: hooks,
    });
    if (missing) {
      const sandbox = await manager.getOrCreateThreadSandbox(context);
      assert.equal(sandbox.providerSandboxId, "replacement-sandbox");
      assert.equal(replacement?.previousSandboxId, "provider-sandbox-1");
      assert.equal(replacement?.sandboxId, "replacement-sandbox");
      assert.ok(!calls.includes("attach"));
    } else {
      await assert.rejects(
        manager.getOrCreateThreadSandbox(context),
        /unavailable/,
      );
      assert.equal(expired, false);
      assert.equal(replacement, undefined);
      assert.ok(!calls.includes("attach"));
    }
  });
}

for (const evidence of [
  undefined,
  {
    authority: "provider-resource-api",
    outcome: "not_found",
    provider: "fake",
    providerSandboxId: "different-instance",
    requestId: "r",
    observedAtMs: Date.now(),
  },
]) {
  test(`a missing or altered stamp cannot authorize persistent replacement (${evidence ? "mismatched proof" : "no proof"})`, async () => {
    const { hooks, calls } = createHooks();
    const { provider } = createProvider([]);
    provider.volumeControl = undefined;
    const store = createSandboxStore();
    let expired = false;
    let created = false;
    store.markSandboxExpired = async () => {
      expired = true;
      return true;
    };
    provider.createSandbox = async () => {
      created = true;
      return { id: "new" };
    };
    provider.getSandbox = async () => {
      throw Object.assign(new Error("stamp file was deleted"), {
        code: "SANDBOX_NOT_FOUND_OR_EXPIRED",
        physicalAbsence: evidence,
      });
    };
    const manager = new SandboxManager({
      provider,
      sandboxStore: store,
      operationStore: createOperationStore(),
      ttlSeconds: limits.ttlSeconds,
      maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
      volume: hooks,
    });
    await assert.rejects(
      manager.getOrCreateThreadSandbox(context),
      /missing or altered stamp/,
    );
    assert.equal(expired, false);
    assert.equal(created, false);
    assert.ok(!calls.includes("reattach"));
  });
}

function protectedVolumeOperationFixture() {
  const { hooks } = createHooks();
  const state = createBackend([], hooks);
  const calls: string[] = [];
  state.provider.volumeControl = {
    async identity() {
      return {
        protocolVersion: 1,
        boundary: "pid-namespace",
        protectedControl: true,
        // Idealized contract fixture only; no real provider supplies this capability.
        stableFreeze: {
          available: true,
          mechanism: "cgroup-v2-freezer",
          kernelEnforced: true,
          kernelIoQuiescence: "qualified",
        },
        bootId: "boot-1",
        supervisorNonce: "supervisor-1",
      };
    },
    async freeze(input) {
      calls.push("freeze");
      return {
        freezeId: input.freezeId,
        supervisorNonce: input.expectedNonce,
        allWritersStopped: true,
        mechanism: "cgroup-v2-freezer",
        kernelEnforced: true,
        kernelIoQuiescent: true,
      };
    },
    async resume() {
      calls.push("resume");
    },
    async flush() {
      return { output: "trusted receipt", exitCode: 0 };
    },
    async drain(input) {
      return {
        drainId: input.drainId,
        bootId: "boot-1",
        supervisorNonce: input.expectedNonce,
        launchGateClosed: true,
        allNamespacesExited: true,
      };
    },
  };
  hooks.acquireOperation = async () => ({
    permitId: "permit-1",
    reused: false,
  });
  hooks.markOperationStarted = async () => {
    calls.push("started");
    return true;
  };
  hooks.releaseOperation = async (input) => {
    calls.push(`release:${input.outcome}`);
  };
  return { ...state, hooks, calls };
}

test("volume mutation waits for its database permit and checkpoints while all writers are frozen", async () => {
  const { manager, hooks, calls } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  let acquired = 0;
  hooks.acquireOperation = async () => {
    if (++acquired < 3)
      throw Object.assign(new Error("queued"), {
        code: "VOLUME_EXECUTION_QUEUED",
      });
    return { permitId: "permit-1", reused: false };
  };
  const result = await manager.withVolumeOperation({
    sandbox,
    context,
    operationId: "op",
    run: async (id) => {
      calls.push(`run:${id}`);
      return "written";
    },
    checkpoint: async () => {
      calls.push("checkpoint");
      return 21;
    },
  });
  assert.equal(result, "written");
  assert.equal(acquired, 3);
  assert.deepEqual(calls, [
    "started",
    "run:permit-1",
    "freeze",
    "checkpoint",
    "resume",
    "release:persisted",
  ]);
});

test("failed frozen checkpoint retains the permit and freeze for recovery", async () => {
  const { manager, calls } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  await assert.rejects(
    manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "op",
      run: async () => {
        calls.push("run");
        return null;
      },
      checkpoint: async () => {
        calls.push("checkpoint");
        throw new Error("storage unavailable");
      },
    }),
    /storage unavailable/,
  );
  assert.deepEqual(calls, ["started", "run", "freeze", "checkpoint"]);
});

test("a previously dispatched permit never automatically reruns its mutation", async () => {
  const { manager, hooks, calls } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  hooks.acquireOperation = async () => ({ permitId: "permit-1", reused: true });
  hooks.markOperationStarted = async () => false;
  await assert.rejects(
    manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "op",
      run: async () => {
        calls.push("replayed");
      },
      checkpoint: async () => 22,
    }),
    /already dispatched/,
  );
  assert.deepEqual(calls, []);
});

test("canceling an operation still queued for admission does not cancel somebody else's workload", async () => {
  const { manager, hooks, calls } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  const controller = new AbortController();
  hooks.acquireOperation = async () => {
    controller.abort();
    throw Object.assign(new Error("queued"), {
      code: "VOLUME_EXECUTION_QUEUED",
    });
  };
  await assert.rejects(
    manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "op",
      signal: controller.signal,
      run: async () => {
        calls.push("run");
      },
      checkpoint: async () => 22,
    }),
    /abort/i,
  );
  assert.deepEqual(calls, []);
});

test("legacy bootstrap is rejected before it creates an attachment", async () => {
  const { hooks, calls } = createHooks();
  hooks.protectedBootstrap = undefined;
  const { manager } = createBackend([], hooks);
  await assert.rejects(
    manager.getOrCreateThreadSandbox(context),
    /PROTECTED_BOOTSTRAP_REQUIRED/,
  );
  assert.deepEqual(calls, []);
});

test("a released preflight permit cannot authorize a later command through cached identity", async () => {
  const { manager, hooks, calls, executed } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  hooks.assertActive = async () => {
    throw new Error("preflight failed");
  };
  await assert.rejects(
    manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "op",
      run: async () => undefined,
    }),
    /preflight failed/,
  );
  assert.deepEqual(calls, ["release:not_started"]);
  await assert.rejects(
    manager.executeUserCommand(sandbox, {
      providerSandboxId: sandbox.providerSandboxId,
      executionId: "permit-1",
      command: "must-not-run",
      timeoutMs: 1000,
      maxOutputChars: 1000,
    }),
    /WORKLOAD_RPC_REQUIRED/,
  );
  assert.deepEqual(executed, []);
});

test("an aborted external write retains admission until the underlying writer is known settled", async () => {
  const { manager, calls } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  const controller = new AbortController();
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const run = manager.withVolumeOperation({
    sandbox,
    context,
    operationId: "external",
    writerKind: "external",
    signal: controller.signal,
    run: async () => {
      entered();
      await pending;
      calls.push("writer-settled");
    },
    checkpoint: async () => {
      calls.push("checkpoint");
      return 1;
    },
  });
  await started;
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ["started"]);
  complete();
  await assert.rejects(run, /abort/i);
  assert.deepEqual(calls, ["started", "writer-settled"]);
});

for (const stage of ["resume", "release"] as const) {
  test(`confirmed durability survives a lost ${stage} acknowledgement without enabling command replay`, async () => {
    const { manager, hooks, provider, executed } =
      protectedVolumeOperationFixture();
    const sandbox = await manager.getOrCreateThreadSandbox(context);
    if (stage === "resume")
      provider.volumeControl!.resume = async () => {
        throw new Error("resume response lost");
      };
    else
      hooks.releaseOperation = async () => {
        throw new Error("release response lost");
      };
    await assert.rejects(
      manager.withVolumeOperation({
        sandbox,
        context,
        operationId: "op",
        run: async () => ({
          output: "already wrote file",
          exitCode: 0,
          truncated: false,
        }),
        checkpoint: async () => 41,
      }),
      (error: unknown) => {
        const value = error as {
          durability: { status: string; confirmedSeq: number };
          message: string;
        };
        assert.equal(value.durability.status, "confirmed");
        assert.equal(value.durability.confirmedSeq, 41);
        assert.match(value.message, /Do not execute the command again/);
        return true;
      },
    );
    await assert.rejects(
      manager.executeUserCommand(sandbox, {
        providerSandboxId: sandbox.providerSandboxId,
        executionId: "permit-1",
        command: "must-not-replay",
        timeoutMs: 1000,
        maxOutputChars: 1000,
      }),
      /WORKLOAD_RPC_REQUIRED/,
    );
    assert.deepEqual(executed, []);
  });
}

test("a duplicate local permit cannot replace the grant of a still-running operation", async () => {
  const { manager, hooks, executed } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  let started = 0;
  hooks.markOperationStarted = async () => ++started === 1;
  let enter!: () => void, continueRun!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    continueRun = resolve;
  });
  const first = manager.withVolumeOperation({
    sandbox,
    context,
    operationId: "same",
    run: async (id) => {
      enter();
      await gate;
      return manager.executeUserCommand(sandbox, {
        providerSandboxId: sandbox.providerSandboxId,
        executionId: id,
        command: "only-original",
        timeoutMs: 1000,
        maxOutputChars: 1000,
      });
    },
    checkpoint: async () => 1,
  });
  await entered;
  await assert.rejects(
    manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "same",
      run: async () => {
        throw new Error("duplicate callback ran");
      },
      checkpoint: async () => 1,
    }),
    /already in flight|already dispatched/,
  );
  continueRun();
  await first;
  assert.deepEqual(executed, ["only-original"]);
});

test("a control timeout after confirmed persistence is not treated as a user-command timeout", async () => {
  const { backend, provider, hooks, calls, operations, executed } =
    protectedVolumeOperationFixture();
  let quarantined = false;
  hooks.quarantine = async () => {
    quarantined = true;
  };
  provider.volumeControl!.resume = async () => {
    throw Object.assign(
      new Error("SANDBOX_COMMAND_TIMEOUT: control resume response lost"),
      { code: "SANDBOX_COMMAND_TIMEOUT" },
    );
  };
  await assert.rejects(backend.execute("write-once"), (error: unknown) => {
    assert.equal(
      (error as { code: string }).code,
      "SANDBOX_VOLUME_RECOVERY_PENDING",
    );
    return true;
  });
  assert.equal(quarantined, false);
  assert.deepEqual(executed, ["write-once"]);
  assert.equal(
    (operations.at(-1)?.result?.durability as { status: string }).status,
    "confirmed",
  );
});

test("a shadow checkpoint is not promoted to confirmed by coordination recovery", async () => {
  const { backend, provider, hooks } = protectedVolumeOperationFixture();
  hooks.checkpoint = async () => ({
    sync: { persisted: true, confirmedSeq: 9, mode: "shadow" },
  });
  provider.volumeControl!.resume = async () => {
    throw new Error("resume acknowledgement lost");
  };
  await assert.rejects(backend.execute("observe"), (error: unknown) => {
    assert.equal(
      (error as { durability: { status: string } }).durability.status,
      "pending",
    );
    assert.match(
      (error as Error).message,
      /production persistence is not confirmed/,
    );
    return true;
  });
});

for (const capability of [
  undefined,
  { available: false, mechanism: "signal-pause" },
  {
    available: false,
    mechanism: "cgroup-v2-freezer",
    kernelIoQuiescence: "unqualified",
  },
  { available: true, mechanism: "signal-pause", kernelEnforced: true },
  { available: true, mechanism: "cgroup-v2-freezer", kernelEnforced: false },
  { available: true, mechanism: "cgroup-v2-freezer", kernelEnforced: true },
  {
    available: true,
    mechanism: "cgroup-v2-freezer",
    kernelEnforced: true,
    kernelIoQuiescence: "unqualified",
  },
]) {
  test(`unverified stable freeze capability blocks attachment and dispatch: ${JSON.stringify(capability)}`, async () => {
    const { hooks, calls } = createHooks();
    const { backend, provider, executed } = createBackend([], hooks);
    const identity = await provider.volumeControl!.identity({
      providerSandboxId: "provider-sandbox-1",
    });
    provider.volumeControl!.identity = async () =>
      Object.assign({}, identity, { stableFreeze: capability });
    await assert.rejects(
      backend.execute("echo must-not-write"),
      /STABLE_FREEZE_UNAVAILABLE/,
    );
    assert.deepEqual(executed, []);
    assert.deepEqual(
      calls,
      [],
      "no attach or checkpoint before verified capability",
    );
  });
}

test("cached attachment cannot bypass a downgraded stable freeze capability", async () => {
  const { manager, provider, hooks, calls } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  const identity = await provider.volumeControl!.identity({
    providerSandboxId: sandbox.providerSandboxId,
  });
  provider.volumeControl!.identity = async () => ({
    ...identity,
    stableFreeze: { available: false, mechanism: "signal-pause" },
  });
  hooks.acquireOperation = async () => {
    calls.push("acquire");
    return { permitId: "unexpected", reused: false };
  };
  await assert.rejects(
    manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "blocked",
      run: async () => {
        calls.push("dispatch");
      },
      checkpoint: async () => {
        calls.push("checkpoint");
        return 1;
      },
    }),
    /STABLE_FREEZE_UNAVAILABLE/,
  );
  assert.deepEqual(calls, []);
});

test("a signal pause proof cannot authorize checkpoint or persistence confirmation", async () => {
  const { manager, provider, hooks, calls } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  const freeze = provider.volumeControl!.freeze;
  provider.volumeControl!.freeze = async (input) =>
    Object.assign({}, await freeze(input), {
      mechanism: "signal-pause",
    }) as Awaited<ReturnType<typeof freeze>>;
  hooks.checkpoint = async () => {
    calls.push("confirmation");
    return { sync: { persisted: true, confirmedSeq: 1 } };
  };
  await assert.rejects(
    manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "bad-proof",
      run: async () => {
        calls.push("dispatch");
      },
    }),
    /FREEZE_UNCONFIRMED/,
  );
  assert.deepEqual(calls, ["started", "dispatch", "freeze"]);
  await assert.rejects(
    manager.volumeCheckpoint(sandbox, {
      freezeId: "barrier-permit-1",
      supervisorNonce: "supervisor-1",
    }),
    /no validated kernel freeze proof/,
  );
  assert.ok(!calls.includes("confirmation"));
});

test("a caller-supplied freeze ID cannot fabricate a validated persistence barrier", async () => {
  const { manager, hooks, calls } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  hooks.checkpoint = async () => {
    calls.push("confirmation");
    return { sync: { persisted: true, confirmedSeq: 1 } };
  };
  await assert.rejects(
    manager.volumeCheckpoint(sandbox, {
      freezeId: "fabricated",
      supervisorNonce: "supervisor-1",
    }),
    /no validated kernel freeze proof/,
  );
  assert.deepEqual(calls, []);
});

test("a verified freeze grant expires before resume can reopen writers", async () => {
  const { manager, provider, hooks, calls } = protectedVolumeOperationFixture();
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  hooks.checkpoint = async () => {
    calls.push("confirmation");
    return { sync: { persisted: true, confirmedSeq: 1 } };
  };
  provider.volumeControl!.resume = async (input) => {
    await assert.rejects(
      manager.volumeCheckpoint(sandbox, {
        freezeId: input.freezeId,
        supervisorNonce: input.expectedNonce,
      }),
      /no validated kernel freeze proof/,
    );
    calls.push("resume");
  };
  await manager.withVolumeOperation({
    sandbox,
    context,
    operationId: "grant-lifetime",
    run: async () => undefined,
  });
  assert.deepEqual(calls, [
    "started",
    "freeze",
    "confirmation",
    "resume",
    "release:persisted",
  ]);
});

for (const kernelIoQuiescent of [undefined, false]) {
  test(`kernel-only freeze proof cannot confirm persistence: ${kernelIoQuiescent}`, async () => {
    const { manager, provider, hooks, calls } =
      protectedVolumeOperationFixture();
    const sandbox = await manager.getOrCreateThreadSandbox(context);
    const freeze = provider.volumeControl!.freeze;
    provider.volumeControl!.freeze = async (input) =>
      Object.assign({}, await freeze(input), {
        kernelIoQuiescent,
      }) as Awaited<ReturnType<typeof freeze>>;
    hooks.checkpoint = async () => {
      calls.push("confirmation");
      return { sync: { persisted: true, confirmedSeq: 1 } };
    };
    await assert.rejects(
      manager.withVolumeOperation({
        sandbox,
        context,
        operationId: "unqualified-io-proof",
        run: async () => {
          calls.push("dispatch");
        },
      }),
      /FREEZE_UNCONFIRMED/,
    );
    assert.deepEqual(calls, ["started", "dispatch", "freeze"]);
    await assert.rejects(
      manager.volumeCheckpoint(sandbox, {
        freezeId: "barrier-permit-1",
        supervisorNonce: "supervisor-1",
      }),
      /no validated kernel freeze proof/,
    );
    assert.ok(!calls.includes("confirmation"));
  });
}

// Contract-only negative tests. The ideal I/O capability below is inherited
// from the existing future-provider fixture; no real provider is qualified.
async function declaredLazyFixture() {
  const state = protectedVolumeOperationFixture();
  const identity = await state.provider.volumeControl!.identity({
    providerSandboxId: "provider-sandbox-1",
  });
  let reported: typeof identity = {
    ...identity,
    lazyMount: {
      required: true,
      state: "registered",
      controllerNonce: identity.supervisorNonce,
      registration: {
        volumeId: "vol-1",
        attachmentId: "att-1",
        bootId: identity.bootId,
        fixedBaseSeq: 7,
        planSha256: "a".repeat(64),
        planPath: "/private/state/original-plan.json",
        mountPath: "/private/lower",
        mountId: 41,
        deviceMajor: 0,
        deviceMinor: 57,
        fsName: "swvol",
        fsType: "fuse.swvol",
        dispatcherPid: 101,
        dispatcherStartTime: "1234",
        dispatcherExecutable: "/usr/local/bin/swlazy",
      },
    },
  };
  state.provider.volumeControl!.identity = async () => reported;
  return {
    ...state,
    identity: () => reported,
    report: (value: typeof identity) => {
      reported = value;
    },
  };
}
for (const lazyMount of [
  { required: true, state: "unregistered" },
  { required: true, state: "fenced", reason: "dispatcher_exited" },
] as const) {
  test(`declared ${lazyMount.state} lazy mount never authorizes attachment or dispatch`, async () => {
    const f = await declaredLazyFixture();
    f.report({ ...f.identity(), lazyMount });
    await assert.rejects(
      f.manager.getOrCreateThreadSandbox(context),
      /LAZY_MOUNT_UNVERIFIED/,
    );
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.executed, []);
  });
}
test("cached required mount cannot disappear as an eager fallback", async () => {
  const f = await declaredLazyFixture();
  const sandbox = await f.manager.getOrCreateThreadSandbox(context);
  await f.manager.volumeAssertActive(sandbox, context);
  f.report({ ...f.identity(), lazyMount: undefined });
  await assert.rejects(
    f.manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "missing-mount",
      run: async () => {
        f.calls.push("dispatch");
      },
    }),
    /LAZY_MOUNT_UNVERIFIED/,
  );
  assert.deepEqual(f.calls, []);
});
test("dispatcher death while acquiring a permit rejects before started and releases only not_started", async () => {
  const f = await declaredLazyFixture();
  const sandbox = await f.manager.getOrCreateThreadSandbox(context);
  f.hooks.acquireOperation = async () => {
    f.report({
      ...f.identity(),
      lazyMount: {
        required: true,
        state: "fenced",
        reason: "dispatcher_exited",
      },
    });
    return { permitId: "permit-1", reused: false };
  };
  await assert.rejects(
    f.manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "mount-died-queued",
      run: async () => {
        f.calls.push("dispatch");
      },
    }),
    /LAZY_MOUNT_UNVERIFIED/,
  );
  assert.deepEqual(f.calls, ["release:not_started"]);
});
test("dispatcher death after command completion never reaches freeze, checkpoint or persistence ACK", async () => {
  const f = await declaredLazyFixture();
  const sandbox = await f.manager.getOrCreateThreadSandbox(context);
  await assert.rejects(
    f.manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "mount-died-after-run",
      run: async () => {
        f.calls.push("dispatch");
        f.report({
          ...f.identity(),
          lazyMount: {
            required: true,
            state: "fenced",
            reason: "dispatcher_exited",
          },
        });
        return { output: "original command completed", exitCode: 0 };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof SandboxVolumePersistenceError);
      assert.equal(error.durability.status, "unknown");
      assert.equal(error.commandExitCode, 0);
      assert.equal(error.commandOutput, "original command completed");
      assert.match(error.message, /LAZY_MOUNT_UNVERIFIED/);
      return true;
    },
  );
  assert.deepEqual(f.calls, ["started", "dispatch"]);
  await assert.rejects(
    f.manager.volumeCheckpoint(sandbox, {
      drainId: "explicit-drain",
      supervisorNonce: "supervisor-1",
    }),
    /LAZY_MOUNT_UNVERIFIED/,
  );
  assert.deepEqual(f.calls, ["started", "dispatch"]);
});
test("a new fixed lower generation cannot replace the cached plan under the same dirty workspace", async () => {
  const f = await declaredLazyFixture();
  const sandbox = await f.manager.getOrCreateThreadSandbox(context);
  await f.manager.volumeAssertActive(sandbox, context);
  const identity = f.identity();
  assert.equal(identity.lazyMount?.state, "registered");
  if (identity.lazyMount?.state !== "registered")
    throw new Error("fixture requires an attested registration");
  f.report({
    ...identity,
    lazyMount: {
      ...identity.lazyMount,
      registration: {
        ...identity.lazyMount.registration,
        fixedBaseSeq: 8,
        planSha256: "b".repeat(64),
      },
    },
  });
  await assert.rejects(
    f.manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "forbidden-rebase",
      run: async () => {
        f.calls.push("dispatch");
      },
    }),
    /LAZY_MOUNT_UNVERIFIED/,
  );
  assert.deepEqual(f.calls, []);
});

test("required intent observed before first attach cannot vanish in its completion window", async () => {
  const f = await declaredLazyFixture();
  const attach = f.hooks.attach;
  f.hooks.attach = async (input) => {
    const result = await attach(input);
    f.report({ ...f.identity(), lazyMount: undefined });
    return result;
  };
  const sandbox = await f.manager.getOrCreateThreadSandbox(context);
  await assert.rejects(
    f.manager.withVolumeOperation({
      sandbox,
      context,
      operationId: "attach-window-omission",
      run: async () => {
        f.calls.push("dispatch");
      },
    }),
    /LAZY_MOUNT_UNVERIFIED/,
  );
  assert.deepEqual(f.calls, []);
});
test("failed initial required registration cannot retry as omitted eager metadata", async () => {
  const f = await declaredLazyFixture();
  f.report({
    ...f.identity(),
    lazyMount: { required: true, state: "unregistered" },
  });
  await assert.rejects(
    f.manager.getOrCreateThreadSandbox(context),
    /LAZY_MOUNT_UNVERIFIED/,
  );
  f.report({ ...f.identity(), lazyMount: undefined });
  await assert.rejects(
    f.manager.getOrCreateThreadSandbox(context),
    /LAZY_MOUNT_UNVERIFIED/,
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.executed, []);
});
test("a controller or boot change cannot clear observed required intent before attachment", async () => {
  const f = await declaredLazyFixture();
  f.report({
    ...f.identity(),
    lazyMount: { required: true, state: "unregistered" },
  });
  await assert.rejects(
    f.manager.getOrCreateThreadSandbox(context),
    /LAZY_MOUNT_UNVERIFIED/,
  );
  f.report({
    ...f.identity(),
    bootId: "new-boot",
    supervisorNonce: "new-controller",
    lazyMount: undefined,
  });
  await assert.rejects(
    f.manager.getOrCreateThreadSandbox(context),
    /LAZY_MOUNT_UNVERIFIED/,
  );
  assert.deepEqual(f.calls, []);
});
