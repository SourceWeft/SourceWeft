import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { config } from "../../../../shared/config";
import { AGENT_TOOL_NAMES } from "../tool-names";
import { createSandboxTools } from "./sandbox-tools";
import type { DaytonaSandboxManager } from "./daytona-manager";

const originalLimits = {
  maxPrepareFileBytes: config.sandbox.maxPrepareFileBytes,
  maxPrepareTotalBytes: config.sandbox.maxPrepareTotalBytes,
  maxCollectFileBytes: config.sandbox.maxCollectFileBytes,
  maxCollectTotalBytes: config.sandbox.maxCollectTotalBytes,
};

function makeHarness(input: {
  workFiles?: Record<string, string | Uint8Array>;
  sandboxFiles?: Record<string, Buffer>;
  existingWorkFiles?: Set<string>;
  succeededOperations?: Map<string, Record<string, unknown>>;
} = {}) {
  const workFiles = input.workFiles ?? {};
  const sandboxFiles = input.sandboxFiles ?? {};
  const existingWorkFiles = input.existingWorkFiles ?? new Set<string>();
  const uploadFile = vi.fn();
  const downloadFile = vi.fn(async ({ sandboxPath }: { sandboxPath: string }) => {
    const content = sandboxFiles[sandboxPath];
    if (!content) {
      throw new Error(`missing ${sandboxPath}`);
    }
    return content;
  });
  const ensureDirectory = vi.fn();
  const operationTypes = new Map<string, string>();
  const beginToolOperation = vi.fn(async ({ operationType, toolCallId }: {
    operationType: string;
    toolCallId: string;
    request?: unknown;
  }) => {
    const result = input.succeededOperations?.get(
      `${operationType}:${toolCallId}`,
    );
    if (result) {
      return { kind: "replay", result };
    }
    const operationId = `${operationType}:${toolCallId}`;
    operationTypes.set(operationId, operationType);
    return { kind: "claimed", operationId };
  });
  const completeToolOperation = vi.fn(async (input: Record<string, unknown>) => {
    input.operationType = operationTypes.get(String(input.operationId));
  });
  const writes: Array<{ path: string; content: string }> = [];
  const filesystem = {
    readRaw: vi.fn(async (path: string) => {
      if (existingWorkFiles.has(path)) {
        return { data: { content: "existing" } };
      }
      const content = workFiles[path];
      if (content === undefined) {
        return { error: `missing ${path}` };
      }
      return { data: { content } };
    }),
    write: vi.fn(async (path: string, content: string) => {
      writes.push({ path, content });
      return {};
    }),
  } as unknown as BackendProtocolV2;
  const manager = {
    getOrCreateThreadSandbox: vi.fn(async () => ({
      id: "sandbox_row_1",
      providerSandboxId: "provider_sandbox_1",
    })),
    adapterForSandbox: vi.fn(() => ({ ensureDirectory, uploadFile, downloadFile })),
    beginToolOperation,
    completeToolOperation,
  } as unknown as DaytonaSandboxManager;
  const tools = createSandboxTools({
    filesystem,
    manager,
    context: {
      teamId: "team_1",
      workspaceId: "workspace_1",
      threadId: "thread_1",
      userId: "user_1",
      messageId: "message_1",
      runId: "run_1",
    },
  });
  return {
    prepare: tools.find((tool) => tool.name === AGENT_TOOL_NAMES.prepareSandboxWorkspace)!,
    collect: tools.find((tool) => tool.name === AGENT_TOOL_NAMES.collectSandboxOutputs)!,
    uploadFile,
    downloadFile,
    ensureDirectory,
    beginToolOperation,
    recordOperation: completeToolOperation,
    writes,
  };
}

function toolRuntimeConfig(toolCallId = "sandbox-tool-call-1") {
  return { toolCallId } as never;
}

describe("createSandboxTools byte limits", () => {
  beforeEach(() => {
    config.sandbox.maxPrepareFileBytes = 5;
    config.sandbox.maxPrepareTotalBytes = 8;
    config.sandbox.maxCollectFileBytes = 5;
    config.sandbox.maxCollectTotalBytes = 8;
  });

  afterEach(() => {
    config.sandbox.maxPrepareFileBytes = originalLimits.maxPrepareFileBytes;
    config.sandbox.maxPrepareTotalBytes = originalLimits.maxPrepareTotalBytes;
    config.sandbox.maxCollectFileBytes = originalLimits.maxCollectFileBytes;
    config.sandbox.maxCollectTotalBytes = originalLimits.maxCollectTotalBytes;
    vi.restoreAllMocks();
  });

  test("prepare rejects a single file above the per-file limit", async () => {
    const harness = makeHarness({ workFiles: { "/work/large.txt": "123456" } });

    await assert.rejects(
      () => harness.prepare.invoke({
        files: [{ sourcePath: "/work/large.txt", sandboxPath: "/workspace/input/large.txt" }],
      }, toolRuntimeConfig()),
      /SANDBOX_FILE_TOO_LARGE/,
    );

    assert.equal(harness.uploadFile.mock.calls.length, 0);
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].operationType, "prepare");
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].status, "failed");
  });

  test("prepare approved invocation uploads selected work files once", async () => {
    const harness = makeHarness({
      workFiles: {
        "/work/a.txt": "a",
        "/work/b.txt": "b",
      },
    });

    const result = await harness.prepare.invoke({
      files: [
        { sourcePath: "/work/a.txt", sandboxPath: "/workspace/input/a.txt" },
        { sourcePath: "/work/b.txt", sandboxPath: "/workspace/work/b.txt" },
      ],
    }, toolRuntimeConfig());

    assert.equal(harness.ensureDirectory.mock.calls.length, 2);
    assert.deepEqual(
      harness.uploadFile.mock.calls.map(([input]) => ({
        sandboxPath: input.sandboxPath,
        content: new TextDecoder().decode(input.content),
      })),
      [
        { sandboxPath: "/workspace/input/a.txt", content: "a" },
        { sandboxPath: "/workspace/work/b.txt", content: "b" },
      ],
    );
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].operationType, "prepare");
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].status, "succeeded");
    assert.match(result, /"ok":true/);
  });

  test("prepare replays a succeeded tool call without uploading again", async () => {
    const replayResult = {
      ok: true,
      files: [{
        sourcePath: "/work/a.txt",
        sandboxPath: "/workspace/input/a.txt",
        sizeBytes: 1,
      }],
      totalBytes: 1,
    };
    const harness = makeHarness({
      workFiles: { "/work/a.txt": "a" },
      succeededOperations: new Map([["prepare:prepare-call-1", replayResult]]),
    });

    const result = await harness.prepare.invoke({
      files: [{ sourcePath: "/work/a.txt", sandboxPath: "/workspace/input/a.txt" }],
    }, toolRuntimeConfig("prepare-call-1"));

    assert.equal(result, JSON.stringify(replayResult));
    assert.equal(harness.ensureDirectory.mock.calls.length, 0);
    assert.equal(harness.uploadFile.mock.calls.length, 0);
    assert.equal(harness.recordOperation.mock.calls.length, 0);
  });

  test("prepare requires a standardized tool call id", async () => {
    const harness = makeHarness({ workFiles: { "/work/a.txt": "a" } });

    await assert.rejects(
      () => harness.prepare.invoke({
        files: [{ sourcePath: "/work/a.txt", sandboxPath: "/workspace/input/a.txt" }],
      }),
      /SANDBOX_TOOL_CALL_ID_REQUIRED/,
    );

    assert.equal(harness.uploadFile.mock.calls.length, 0);
    assert.equal(harness.recordOperation.mock.calls.length, 0);
  });

  test("prepare rejects files above the total byte limit", async () => {
    const harness = makeHarness({
      workFiles: { "/work/a.txt": "1234", "/work/b.txt": "12345" },
    });

    await assert.rejects(
      () => harness.prepare.invoke({
        files: [
          { sourcePath: "/work/a.txt", sandboxPath: "/workspace/input/a.txt" },
          { sourcePath: "/work/b.txt", sandboxPath: "/workspace/input/b.txt" },
        ],
      }, toolRuntimeConfig()),
      /SANDBOX_TOTAL_SIZE_EXCEEDED/,
    );

    assert.equal(harness.uploadFile.mock.calls.length, 0);
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].status, "failed");
  });

  test("collect rejects a single output above the per-file limit", async () => {
    const harness = makeHarness({
      sandboxFiles: { "/workspace/output/large.txt": Buffer.from("123456") },
    });

    await assert.rejects(
      () => harness.collect.invoke({
        outputs: [{
          sandboxPath: "/workspace/output/large.txt",
          target: { kind: "workfile", path: "/work/large.txt" },
        }],
      }, toolRuntimeConfig()),
      /SANDBOX_FILE_TOO_LARGE/,
    );

    assert.equal(harness.writes.length, 0);
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].operationType, "collect");
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].status, "failed");
  });

  test("collect approved invocation writes selected outputs once", async () => {
    const harness = makeHarness({
      sandboxFiles: {
        "/workspace/output/a.txt": Buffer.from("a"),
        "/workspace/work/b.txt": Buffer.from("b"),
      },
    });

    const result = await harness.collect.invoke({
      outputs: [
        {
          sandboxPath: "/workspace/output/a.txt",
          target: { kind: "workfile", path: "/work/a.txt" },
        },
        {
          sandboxPath: "/workspace/work/b.txt",
          target: { kind: "workfile", path: "/work/b.txt" },
        },
      ],
    }, toolRuntimeConfig());

    assert.deepEqual(
      harness.downloadFile.mock.calls.map(([input]) => input.sandboxPath),
      ["/workspace/output/a.txt", "/workspace/work/b.txt"],
    );
    assert.deepEqual(harness.writes, [
      { path: "/work/a.txt", content: "a" },
      { path: "/work/b.txt", content: "b" },
    ]);
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].operationType, "collect");
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].status, "succeeded");
    assert.match(result, /"ok":true/);
  });

  test("collect replays a succeeded tool call without downloading or writing again", async () => {
    const replayResult = {
      ok: true,
      outputs: [{
        sandboxPath: "/workspace/output/a.txt",
        targetKind: "workfile",
        targetPath: "/work/a.txt",
        sizeBytes: 1,
      }],
      totalBytes: 1,
    };
    const harness = makeHarness({
      sandboxFiles: { "/workspace/output/a.txt": Buffer.from("a") },
      succeededOperations: new Map([["collect:collect-call-1", replayResult]]),
    });

    const result = await harness.collect.invoke({
      outputs: [{
        sandboxPath: "/workspace/output/a.txt",
        target: { kind: "workfile", path: "/work/a.txt" },
      }],
    }, toolRuntimeConfig("collect-call-1"));

    assert.equal(result, JSON.stringify(replayResult));
    assert.equal(harness.downloadFile.mock.calls.length, 0);
    assert.equal(harness.writes.length, 0);
    assert.equal(harness.recordOperation.mock.calls.length, 0);
  });

  test("collect requires a standardized tool call id", async () => {
    const harness = makeHarness({
      sandboxFiles: { "/workspace/output/a.txt": Buffer.from("a") },
    });

    await assert.rejects(
      () => harness.collect.invoke({
        outputs: [{
          sandboxPath: "/workspace/output/a.txt",
          target: { kind: "workfile", path: "/work/a.txt" },
        }],
      }),
      /SANDBOX_TOOL_CALL_ID_REQUIRED/,
    );

    assert.equal(harness.downloadFile.mock.calls.length, 0);
    assert.equal(harness.writes.length, 0);
    assert.equal(harness.recordOperation.mock.calls.length, 0);
  });

  test("collect rejects outputs above the total byte limit", async () => {
    const harness = makeHarness({
      sandboxFiles: {
        "/workspace/output/a.txt": Buffer.from("1234"),
        "/workspace/output/b.txt": Buffer.from("12345"),
      },
    });

    await assert.rejects(
      () => harness.collect.invoke({
        outputs: [
          { sandboxPath: "/workspace/output/a.txt", target: { kind: "workfile", path: "/work/a.txt" } },
          { sandboxPath: "/workspace/output/b.txt", target: { kind: "workfile", path: "/work/b.txt" } },
        ],
      }, toolRuntimeConfig()),
      /SANDBOX_TOTAL_SIZE_EXCEEDED/,
    );

    assert.deepEqual(harness.writes, []);
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].status, "failed");
  });

  test("collect rejects existing workfile targets unless overwrite is true", async () => {
    const harness = makeHarness({
      sandboxFiles: { "/workspace/output/result.txt": Buffer.from("new") },
      existingWorkFiles: new Set(["/work/result.txt"]),
    });

    await assert.rejects(
      () => harness.collect.invoke({
        outputs: [{
          sandboxPath: "/workspace/output/result.txt",
          target: { kind: "workfile", path: "/work/result.txt" },
        }],
      }, toolRuntimeConfig()),
      /SANDBOX_COLLECT_CONFLICT/,
    );

    assert.equal(harness.writes.length, 0);
    assert.equal(harness.downloadFile.mock.calls.length, 1);
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].operationType, "collect");
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].status, "failed");
  });

  test("collect allows existing workfile targets when overwrite is true", async () => {
    const harness = makeHarness({
      sandboxFiles: { "/workspace/output/result.txt": Buffer.from("repl") },
      existingWorkFiles: new Set(["/work/result.txt"]),
    });

    const result = await harness.collect.invoke({
      outputs: [{
        sandboxPath: "/workspace/output/result.txt",
        target: { kind: "workfile", path: "/work/result.txt", overwrite: true },
      }],
    }, toolRuntimeConfig());

    assert.deepEqual(harness.writes, [{ path: "/work/result.txt", content: "repl" }]);
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].operationType, "collect");
    assert.equal(harness.recordOperation.mock.calls.at(-1)?.[0].status, "succeeded");
    assert.match(result, /"ok":true/);
    assert.deepEqual(harness.beginToolOperation.mock.calls.at(-1)?.[0].request, {
      outputs: [{
        sandboxPath: "/workspace/output/result.txt",
        target: { kind: "workfile", path: "/work/result.txt", overwrite: true },
      }],
    });
  });
});
