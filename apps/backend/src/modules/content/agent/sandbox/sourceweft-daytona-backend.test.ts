import assert from "node:assert/strict";
import type { BackendProtocolV2 } from "deepagents";
import { describe, test } from "vitest";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type { DaytonaSandboxManager } from "./daytona-manager";
import { SourceWeftDaytonaBackend } from "./sourceweft-daytona-backend";

const context = {
  teamId: "team_backend_test",
  workspaceId: "workspace_backend_test",
  threadId: "thread_backend_test",
  userId: "user_backend_test",
  messageId: "message_backend_test",
  runId: "run_backend_test",
  sandboxExecuteToolCallId: "call-sandbox-execute",
};

function enabledSkill(): EnabledSkillDescriptor {
  return {
    workspaceSkillId: "workspace_skill_backend_test",
    sourceType: "builtin",
    name: "tool-a",
    version: "1.0.0",
    description: "Tool A",
    files: [
      {
        path: "scripts/run.js",
        contentText: "console.log('ok')",
        mimeType: "text/javascript",
        sizeBytes: 17,
        contentHash: "hash_script",
      },
    ],
  };
}

function createMockManager(options: {
  replayOperations?: Map<string, Record<string, unknown>>;
  createError?: Error;
  uploadError?: Error;
  executeError?: Error;
} = {}) {
  const calls: {
    ensureDirectories: string[];
    uploads: Array<{ sandboxPath: string; content: Uint8Array }>;
    executes: string[];
    operations: Array<Record<string, unknown>>;
  } = {
    ensureDirectories: [],
    uploads: [],
    executes: [],
    operations: [],
  };
  const adapter = {
    async ensureDirectory(input: { directory: string }) {
      calls.ensureDirectories.push(input.directory);
    },
    async uploadFile(input: { sandboxPath: string; content: Uint8Array }) {
      if (options.uploadError) {
        throw options.uploadError;
      }
      calls.uploads.push({
        sandboxPath: input.sandboxPath,
        content: input.content,
      });
    },
    async execute(input: { command: string }) {
      if (options.executeError) {
        throw options.executeError;
      }
      calls.executes.push(input.command);
      return { output: "ok", exitCode: 0, truncated: false };
    },
  };
  const manager = {
    async beginToolOperation(operation: { operationType: string; toolCallId: string }) {
      const replay = options.replayOperations?.get(
        `${operation.operationType}:${operation.toolCallId}`,
      );
      if (replay) {
        return { kind: "replay", result: replay };
      }
      return { kind: "claimed", operationId: `${operation.operationType}:${operation.toolCallId}` };
    },
    async completeToolOperation(input: Record<string, unknown>) {
      calls.operations.push(input);
    },
    async getOrCreateThreadSandbox() {
      if (options.createError) {
        throw options.createError;
      }
      return {
        id: "sandbox_db_id",
        provider: "daytona" as const,
        providerSandboxId: "provider_sandbox_id",
      };
    },
    adapterForSandbox() {
      return adapter;
    },
    async recordOperation(input: Record<string, unknown>) {
      calls.operations.push(input);
    },
  } as unknown as DaytonaSandboxManager;
  return { manager, calls };
}

function assertFailedExecuteAudit(
  operation: Record<string, unknown> | undefined,
  expectedError: RegExp,
) {
  assert.equal(operation?.operationId, "execute:call-sandbox-execute");
  assert.equal(operation?.status, "failed");
  assert.match((operation?.result as { error?: string } | undefined)?.error ?? "", expectedError);
  assert.equal(typeof operation?.durationMs, "number");
  assert.ok((operation?.durationMs as number) >= 0);
}

describe("SourceWeftDaytonaBackend skill staging", () => {
  test("delegates read-only filesystem operations to SourceWeft", async () => {
    const { manager } = createMockManager();
    const reads: string[] = [];
    const filesystem = {
      read(filePath: string) {
        reads.push(filePath);
        return { content: "hello" };
      },
    } as unknown as BackendProtocolV2;
    const backend = new SourceWeftDaytonaBackend({
      filesystem,
      manager,
      context,
      enabledSkills: [],
    });

    const result = await backend.read("/work/a.txt");

    assert.deepEqual(reads, ["/work/a.txt"]);
    assert.deepEqual(result, { content: "hello" });
  });

  test("does not write or edit the SourceWeft filesystem directly", async () => {
    const { manager } = createMockManager();
    const mutatingCalls: string[] = [];
    const filesystem = {
      write(filePath: string) {
        mutatingCalls.push(`write:${filePath}`);
        return { path: filePath, filesUpdate: null };
      },
      edit(filePath: string) {
        mutatingCalls.push(`edit:${filePath}`);
        return { path: filePath, filesUpdate: null, occurrences: 1 };
      },
    } as unknown as BackendProtocolV2;
    const backend = new SourceWeftDaytonaBackend({
      filesystem,
      manager,
      context,
      enabledSkills: [],
    });

    const write = await backend.write("/work/a.txt", "hello");
    const edit = await backend.edit("/work/a.txt", "hello", "hi");

    assert.deepEqual(mutatingCalls, []);
    assert.match(write.error ?? "", /SANDBOX_MUTATION_REQUIRES_ISOLATION/);
    assert.match(edit.error ?? "", /SANDBOX_MUTATION_REQUIRES_ISOLATION/);
  });

  test("uploads enabled sandbox skills before first execute only", async () => {
    const { manager, calls } = createMockManager();
    const backend = new SourceWeftDaytonaBackend({
      filesystem: {} as BackendProtocolV2,
      manager,
      context,
      enabledSkills: [enabledSkill()],
    });

    const first = await backend.execute("node /skills/tool-a/scripts/run.js");
    const second = await backend.execute("node /skills/tool-a/scripts/run.js");

    assert.equal(first.output, "ok");
    assert.equal(second.output, "ok");
    assert.deepEqual(calls.ensureDirectories, ["/skills/tool-a/scripts"]);
    assert.equal(calls.uploads.length, 1);
    assert.equal(calls.uploads[0]?.sandboxPath, "/skills/tool-a/scripts/run.js");
    assert.equal(new TextDecoder().decode(calls.uploads[0]!.content), "console.log('ok')");
    assert.deepEqual(calls.executes, [
      "node /skills/tool-a/scripts/run.js",
      "node /skills/tool-a/scripts/run.js",
    ]);
    assert.equal(
      calls.operations.filter((operation) =>
        operation.operationType === "prepare" &&
        (operation.request as { kind?: string } | undefined)?.kind === "skill_staging"
      ).length,
      1,
    );
  });

  test("does not stage when no skills are enabled", async () => {
    const { manager, calls } = createMockManager();
    const backend = new SourceWeftDaytonaBackend({
      filesystem: {} as BackendProtocolV2,
      manager,
      context,
      enabledSkills: [],
    });

    await backend.execute("pwd");

    assert.deepEqual(calls.ensureDirectories, []);
    assert.deepEqual(calls.uploads, []);
    assert.deepEqual(calls.executes, ["pwd"]);
  });

  test("replays execute results without rerunning the command", async () => {
    const { manager, calls } = createMockManager({
      replayOperations: new Map([[
        "execute:call-sandbox-execute",
        { output: "cached", exitCode: 0, truncated: false },
      ]]),
    });
    const backend = new SourceWeftDaytonaBackend({
      filesystem: {} as BackendProtocolV2,
      manager,
      context,
      enabledSkills: [],
    });

    const result = await backend.execute("pwd");

    assert.deepEqual(result, { output: "cached", exitCode: 0, truncated: false });
    assert.deepEqual(calls.executes, []);
  });

  test("records failed execute audit when sandbox creation fails", async () => {
    const { manager, calls } = createMockManager({
      createError: new Error("create failed"),
    });
    const backend = new SourceWeftDaytonaBackend({
      filesystem: {} as BackendProtocolV2,
      manager,
      context,
      enabledSkills: [],
    });

    await assert.rejects(() => backend.execute("pwd"), /create failed/);

    assertFailedExecuteAudit(calls.operations.at(-1), /create failed/);
    assert.equal(calls.operations.at(-1)?.sandboxId, null);
    assert.deepEqual(calls.executes, []);
  });

  test("records failed execute audit when skill staging fails", async () => {
    const { manager, calls } = createMockManager({
      uploadError: new Error("stage upload failed"),
    });
    const backend = new SourceWeftDaytonaBackend({
      filesystem: {} as BackendProtocolV2,
      manager,
      context,
      enabledSkills: [enabledSkill()],
    });

    await assert.rejects(() => backend.execute("node /skills/tool-a/scripts/run.js"), /stage upload failed/);

    const failedPrepare = calls.operations.find((operation) =>
      operation.operationType === "prepare" && operation.status === "failed"
    );
    assert.match((failedPrepare?.result as { error?: string } | undefined)?.error ?? "", /stage upload failed/);
    assert.equal(typeof failedPrepare?.durationMs, "number");
    assertFailedExecuteAudit(calls.operations.at(-1), /stage upload failed/);
    assert.equal(calls.operations.at(-1)?.sandboxId, "sandbox_db_id");
    assert.deepEqual(calls.executes, []);
  });

  test("records failed execute audit when adapter execute fails", async () => {
    const { manager, calls } = createMockManager({
      executeError: new Error("adapter execute failed"),
    });
    const backend = new SourceWeftDaytonaBackend({
      filesystem: {} as BackendProtocolV2,
      manager,
      context,
      enabledSkills: [],
    });

    await assert.rejects(() => backend.execute("pwd"), /adapter execute failed/);

    assertFailedExecuteAudit(calls.operations.at(-1), /adapter execute failed/);
    assert.equal(calls.operations.at(-1)?.sandboxId, "sandbox_db_id");
    assert.deepEqual(calls.executes, []);
  });
});
