import assert from "node:assert/strict";
import { test } from "node:test";
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

function createProvider(responses: Array<{ output: string; exitCode: number }>) {
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
  };
  return { provider, executed };
}

function createHooks() {
  const calls: string[] = [];
  let attachments = 0;
  class Replaced extends Error {}
  const hooks: SandboxVolumeHooks = {
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
      return { output: input.output.replace(/ \+marker$/, ""), exitCode: input.exitCode, sync: { persisted: true } };
    },
    async checkpoint(input) {
      calls.push(`checkpoint:${input.attachmentId}`);
    },
    async checkpointScope() {
      calls.push("checkpointScope");
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
  return { hooks, calls };
}

function createBackend(responses: Array<{ output: string; exitCode: number }>, volume: SandboxVolumeHooks | null) {
  const { provider, executed } = createProvider(responses);
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore: createOperationStore(),
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
  return { backend, manager, executed };
}

test("without a volume the backend behaves exactly as before", async () => {
  const { backend, executed } = createBackend([{ output: "hello", exitCode: 0 }], null);
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

test("a replaced container is re-attached and the command runs once more", async () => {
  const { hooks, calls } = createHooks();
  const { backend, executed } = createBackend(
    [
      { output: "__REPLACED__", exitCode: 75 },
      { output: "after reattach +marker", exitCode: 0 },
    ],
    hooks,
  );
  const result = await backend.execute("echo again");
  assert.equal(result.output, "after reattach");
  assert.deepEqual(executed, ["WRAP(echo again)", "WRAP(echo again)"]);
  assert.deepEqual(calls, ["attach", "parse:att-1", "reattach", "parse:att-2"]);
});

test("a container replaced twice in one command surfaces as an instance change", async () => {
  const { hooks } = createHooks();
  const { backend } = createBackend(
    [
      { output: "__REPLACED__", exitCode: 75 },
      { output: "__REPLACED__", exitCode: 75 },
    ],
    hooks,
  );
  await assert.rejects(backend.execute("echo never"), (error: unknown) => /instance|replaced/i.test(String((error as Error)?.message ?? error)));
});

test("the checkpoint goes to the attachment the manager made", async () => {
  const { hooks, calls } = createHooks();
  const { backend, manager } = createBackend([{ output: "x +marker", exitCode: 0 }], hooks);
  await backend.execute("true");
  const sandbox = await manager.getOrCreateThreadSandbox(context);
  await manager.volumeCheckpoint(sandbox);
  assert.deepEqual(calls, ["attach", "parse:att-1", "checkpoint:att-1"]);
});
