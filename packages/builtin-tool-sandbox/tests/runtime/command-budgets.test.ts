import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  maxSandboxCommandTimeoutMs,
  resolveSandboxCommandTimeoutMs,
} from "../../src/runtime/command-budgets";
import { createSandboxRuntimeForTurn } from "../../src/runtime/runtime";
import {
  collectSandboxOutputsSchema,
  prepareSandboxWorkspaceSchema,
} from "../../src/sandbox-tools";
import type {
  SandboxCommandBudget,
  SandboxOperationStore,
  SandboxProvider,
  SandboxProviderPathPolicy,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStore,
} from "../../src";

const PATH_POLICY: SandboxProviderPathPolicy = {
  workspaceRoot: "/workspace",
  defaultCwd: "/workspace",
  prepareTargetRoots: ["/workspace"],
  collectSourceRoots: ["/workspace"],
  readWriteRoots: ["/workspace"],
};

const context: SandboxRuntimeContext = {
  teamId: "team-budget-test",
  workspaceId: "workspace-budget-test",
  threadId: "thread-budget-test",
  userId: "user-budget-test",
  messageId: "message-budget-test",
  runId: "run-budget-test",
  sandboxExecuteToolCallId: "tool-call-execute",
};

const INTERACTIVE_MS = 120_000;
const BATCH_MS = 480_000;
const CEILING_MS = 600_000;

function createLimits(
  overrides: Partial<SandboxRuntimeLimits> = {},
): SandboxRuntimeLimits {
  return {
    ttlSeconds: 3600,
    commandBudgetsMs: { interactive: INTERACTIVE_MS, batch: BATCH_MS },
    maxCommandTimeoutMs: CEILING_MS,
    maxOutputChars: 10_000,
    maxPrepareFileBytes: 10_000,
    maxPrepareTotalBytes: 10_000,
    maxCollectFileBytes: 10_000,
    maxCollectTotalBytes: 10_000,
    ...overrides,
  };
}

function createProvider() {
  const executeInputs: Array<{ command: string; timeoutMs: number }> = [];
  const provider: SandboxProvider & {
    executeInputs: typeof executeInputs;
  } = {
    id: "fake",
    pathPolicy: PATH_POLICY,
    executeInputs,
    async createSandbox() {
      return { id: "provider-sandbox-1" };
    },
    async getSandbox() {
      return {};
    },
    async deleteSandbox() {
      return {};
    },
    async execute(input) {
      executeInputs.push({
        command: input.command,
        timeoutMs: input.timeoutMs,
      });
      return { output: "ok", exitCode: 0, truncated: false };
    },
    async uploadFile() {
      return {};
    },
    async downloadFile() {
      return Buffer.from("");
    },
    async ensureDirectory() {
      return {};
    },
  };
  return provider;
}

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
        expiresAt: new Date(Date.now() + 3_600_000),
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
    async releaseReadyThreadSandboxLease() {
      return 1;
    },
    async touchSandbox() {},
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

function createRuntime(input: {
  limits?: SandboxRuntimeLimits;
  commandBudget?: SandboxCommandBudget;
  operationStore?: SandboxOperationStore;
} = {}) {
  const provider = createProvider();
  const runtime = createSandboxRuntimeForTurn({
    filesystem: {} as never,
    context,
    limits: input.limits ?? createLimits(),
    provider,
    sandboxStore: createSandboxStore(),
    operationStore: input.operationStore ?? createOperationStore(),
    toolApprovalEnabled: false,
    commandBudget: input.commandBudget,
  });
  return { provider, runtime };
}

test("sandbox runtime exposes the current message's persisted operation timeline", async () => {
  const expected = [
    {
      operationType: "execute" as const,
      status: "succeeded" as const,
      durationMs: 42,
      createdAt: "2026-08-16T08:00:00.000Z",
      result: { exitCode: 0, outputChars: 2 },
    },
  ];
  const operationStore = createOperationStore();
  operationStore.listMessageOperations = async (input) => {
    assert.deepEqual(input, { context, limit: 50 });
    return expected;
  };
  const { runtime } = createRuntime({ operationStore });

  assert.deepEqual(await runtime.getOperationTimeline(), expected);
});

test("sandbox commands use the interactive budget when no budget is named", async () => {
  // The agent turn builds its runtime exactly like this — no commandBudget —
  // so this asserts what the model actually runs under.
  const { provider, runtime } = createRuntime();

  await runtime.backend.execute("echo hi", { toolCallId: "tool-call-execute" });

  assert.deepEqual(
    provider.executeInputs.map((input) => input.timeoutMs),
    [INTERACTIVE_MS],
  );
});

test("host-initiated runtimes can name the batch budget", async () => {
  const { provider, runtime } = createRuntime({ commandBudget: "batch" });

  await runtime.backend.execute("npm ci", { toolCallId: "tool-call-execute" });

  assert.deepEqual(
    provider.executeInputs.map((input) => input.timeoutMs),
    [BATCH_MS],
  );
});

test("a budget configured above the ceiling is clamped, not rejected", async () => {
  const limits = createLimits({
    commandBudgetsMs: { interactive: INTERACTIVE_MS, batch: 60 * 60_000 },
  });
  const { provider, runtime } = createRuntime({
    limits,
    commandBudget: "batch",
  });

  // Clamping rather than throwing: a too-large budget is a misconfiguration,
  // and refusing to build the runtime would take sandbox execution down
  // entirely instead of degrading it to the ceiling.
  await runtime.backend.execute("npm ci", { toolCallId: "tool-call-execute" });

  assert.deepEqual(
    provider.executeInputs.map((input) => input.timeoutMs),
    [CEILING_MS],
  );
  assert.equal(
    resolveSandboxCommandTimeoutMs({ limits, budget: "batch" }),
    CEILING_MS,
  );
});

test("staleness sweeps read the longest budget, never the interactive one", () => {
  // A live batch command must not be swept as stale mid-flight.
  assert.equal(maxSandboxCommandTimeoutMs(createLimits()), BATCH_MS);
  assert.equal(
    maxSandboxCommandTimeoutMs(
      createLimits({
        commandBudgetsMs: { interactive: INTERACTIVE_MS, batch: 60 * 60_000 },
      }),
    ),
    CEILING_MS,
  );
});

test("tool input cannot raise the sandbox command timeout", async () => {
  const { provider, runtime } = createRuntime();

  // Model-authored tool arguments reach `execute` as the command string, and
  // reach the other sandbox tools through these schemas. Neither exposes a
  // timeout or budget field, so there is nothing for the model to set. If a
  // field matching this ever appears in a tool schema, the sandbox holding-time
  // limit has become self-serve and this test must not be relaxed to allow it.
  for (const schema of [
    prepareSandboxWorkspaceSchema,
    collectSandboxOutputsSchema,
  ]) {
    const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
    assert.doesNotMatch(jsonSchema, /timeout|budget/iu);
    // Belt and braces: the schemas are closed, so an unknown key would be
    // rejected rather than quietly carried through to the runtime.
    assert.match(jsonSchema, /"additionalProperties":false/u);
  }

  // And even a forged options object cannot do it: the timeout is bound when
  // the runtime is constructed, so `execute` has no per-call knob to override.
  await runtime.backend.execute("sleep 3600", {
    toolCallId: "tool-call-execute",
    commandBudget: "batch",
    timeoutMs: 60 * 60_000,
  } as never);

  assert.deepEqual(
    provider.executeInputs.map((input) => input.timeoutMs),
    [INTERACTIVE_MS],
  );
});
