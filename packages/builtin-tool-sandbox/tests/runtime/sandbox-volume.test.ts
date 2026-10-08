import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandboxRuntimeForTurn } from "../../src/runtime/runtime";
import { SandboxManager } from "../../src/runtime/sandbox-manager";
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
    async assertActive() {},
    async quarantine() {},
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
      return { sync: { persisted: true } };
    },
    async checkpointScope() {
      calls.push("checkpointScope");
      return { sync: { persisted: true } };
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

test("with a volume: attach once, wrap every command, use the parsed output", async () => {
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
  assert.equal(first.output, "one");
  assert.equal(second.output, "two");
  assert.equal(second.exitCode, 3);
  assert.deepEqual(executed, ["WRAP(echo one)", "WRAP(exit 3)"]);
  assert.deepEqual(calls, ["attach", "parse:att-1", "parse:att-1"]);
});

test("trusted preflight restores a replaced container before the user command runs", async () => {
  const { hooks, calls, Replaced } = createHooks();
  let probes = 0;
  hooks.assertActive = async () => {
    if (++probes === 1) throw new Replaced("replaced");
  };
  const { backend, executed } = createBackend(
    [{ output: "after reattach +marker", exitCode: 0 }],
    hooks,
  );
  const result = await backend.execute("echo again");
  assert.equal(result.output, "after reattach");
  assert.deepEqual(executed, ["WRAP(echo again)"]);
  assert.deepEqual(calls, ["attach", "reattach", "parse:att-2"]);
});

test("repeated preflight replacement fails without executing the user command", async () => {
  const { hooks, calls, Replaced } = createHooks();
  hooks.assertActive = async () => {
    throw new Replaced("replaced");
  };
  const { backend, executed } = createBackend([], hooks);
  await assert.rejects(backend.execute("echo never"), /replaced/);
  assert.deepEqual(executed, []);
  assert.deepEqual(calls, ["attach", "reattach"]);
});

test("replacement from command output never authorizes restoration or replay", async () => {
  const { hooks, calls } = createHooks();
  const { backend, executed } = createBackend(
    [{ output: "__REPLACED__", exitCode: 75 }],
    hooks,
  );
  await assert.rejects(
    backend.execute("write-once"),
    /persistence is unconfirmed/i,
  );
  assert.deepEqual(executed, ["WRAP(write-once)"]);
  assert.deepEqual(calls, ["attach", "parse:att-1"]);
});

test("the checkpoint goes to the attachment the manager made", async () => {
  const { hooks, calls } = createHooks();
  const { backend, manager } = createBackend(
    [{ output: "x +marker", exitCode: 0 }],
    hooks,
  );
  await backend.execute("true");
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  await manager.volumeCheckpoint(sandbox);
  assert.deepEqual(calls, ["attach", "parse:att-1", "checkpoint:att-1"]);
});

for (const failure of ["pending", "missing marker", "malformed marker"]) {
  test(`volume ${failure} cannot report success or replay a completed command`, async () => {
    const { hooks, calls } = createHooks();
    hooks.parseResult = async () => {
      if (failure !== "pending") throw new Error(failure);
      return {
        output: "already wrote file",
        exitCode: 0,
        sync: { persisted: false },
      };
    };
    const { backend, executed, operations } = createBackend(
      [{ output: "already wrote file", exitCode: 0 }],
      hooks,
    );
    await assert.rejects(
      backend.execute("echo side-effect >> file"),
      /persist|marker/i,
    );
    assert.deepEqual(executed, ["WRAP(echo side-effect >> file)"]);
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
  await backend.execute("true");
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  await assert.rejects(manager.volumeCheckpoint(sandbox), /persist/i);
});

test("trusted host execution also rejects unconfirmed persistence without replay", async () => {
  const { hooks, calls } = createHooks();
  hooks.parseResult = async () => ({
    output: "written",
    exitCode: 0,
    sync: { persisted: false },
  });
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
  assert.deepEqual(executed, ["WRAP(echo side-effect >> file)"]);
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
  assert.deepEqual(executed, ["WRAP(echo side-effect >> file; exit 75)"]);
  assert.ok(!calls.includes("reattach"));
});

test("confirmed durability survives recording and replay without re-executing", async () => {
  const { hooks } = createHooks();
  hooks.parseResult = async (input) => ({
    output: input.output,
    exitCode: input.exitCode,
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
  hooks.parseResult = async () => {
    throw Object.assign(new Error("flush failed"), {
      commandOutput: "saved file\nAPI_KEY=super-secret",
      commandExitCode: 7,
      durabilityStatus: "failed",
    });
  };
  const { backend, operations, executed } = createBackend(
    [{ output: "raw helper report", exitCode: 7 }],
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

test("replacement errors without proof the command never started do not replay", async () => {
  const { hooks, calls } = createHooks();
  hooks.parseResult = async () => {
    throw new Error("instance replaced after command");
  };
  hooks.isContainerReplacedError = () => true;
  const { backend, executed } = createBackend(
    [{ output: "side effect", exitCode: 75 }],
    hooks,
  );
  await assert.rejects(
    backend.execute("write-once"),
    /persistence is unconfirmed/i,
  );
  assert.equal(executed.length, 1);
  assert.ok(!calls.includes("reattach"));
});

test("shadow acknowledgement remains visible as observation, not confirmed persistence", async () => {
  const { hooks } = createHooks();
  hooks.parseResult = async () => ({
    output: "done",
    exitCode: 0,
    sync: { persisted: true, mode: "shadow" },
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
  assert.deepEqual(executed, ["WRAP(first)"]);
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
  hooks.parseResult = async () => ({
    output: "done",
    exitCode: 0,
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
