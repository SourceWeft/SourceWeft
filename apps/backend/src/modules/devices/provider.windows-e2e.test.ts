import { beforeEach, expect, test, vi } from "vitest";
import {
  SandboxManager,
  SourceWeftSandboxBackend,
  maxSandboxCommandTimeoutMs,
  resolveSandboxCommandTimeoutMs,
} from "@sourceweft/builtin-tool-sandbox";
import type {
  SandboxOperationStore,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStore,
} from "@sourceweft/builtin-tool-sandbox";

/**
 * End to end for a Windows device: the agent-facing backend adapter
 * (read/write/edit/ls/glob/execute with its default cwd) drives the real
 * device provider, which talks to a strict in-memory Windows host. The host
 * only ever sees workspace-relative paths, so a `/C:/...` path produced by a
 * POSIX-only normaliser, or an absolute path leaking through, fails here.
 */
const ROOT = "C:/Users/Test/AppData/Roaming/app/task-workspaces/id/files";

const state = vi.hoisted(() => ({
  thread: {
    id: "t",
    workspaceId: "w",
    teamId: "team",
    createdBy: "owner",
    visibility: "private",
    executionTargetJson: {
      kind: "local",
      deviceId: "pc",
      directoryGrantId: "grant",
    },
  },
  binding: { threadId: "t", userId: "owner", deviceId: "pc" },
  call: vi.fn(),
}));
vi.mock("@sourceweft/db", () => ({
  threads: {},
  localDevices: {},
  localThreadBindings: {},
  db: {
    query: {
      threads: { findFirst: async () => state.thread },
      localThreadBindings: { findFirst: async () => state.binding },
    },
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => [{ ...state.binding, ...value }],
        }),
      }),
    }),
  },
}));
vi.mock("./service", () => ({ localCall: state.call }));
import { localProviderForTurn } from "./provider";
import { ContentError } from "../content/errors";

const context: SandboxRuntimeContext = {
  teamId: "team",
  workspaceId: "w",
  threadId: "t",
  userId: "owner",
  messageId: "message",
  runId: "run",
  sandboxExecuteToolCallId: "tool-call-execute",
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

const sandboxStore: SandboxStore = {
  async findLatestActiveThreadSandbox() {
    return {
      id: "record",
      provider: "local",
      providerSandboxId: "native",
      teamId: "team",
      workspaceId: "w",
      threadId: "t",
      userId: "owner",
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

const operationStore: SandboxOperationStore = {
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

const files = new Map<string, string>();
const hostCalls: Array<{ action: string; payload: Record<string, unknown> }> =
  [];

/** Workspace-relative path as the Windows host requires it. */
function assertRelative(path: unknown): string {
  if (
    typeof path !== "string" ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    path.split("/").includes("..")
  )
    throw new Error(`HOST_REJECTED_PATH: ${String(path)}`);
  return path;
}

beforeEach(() => {
  files.clear();
  hostCalls.length = 0;
  state.call.mockReset();
  state.call.mockImplementation(
    async (input: { action: string; payload: Record<string, unknown> }) => {
      hostCalls.push({ action: input.action, payload: input.payload });
      const { payload } = input;
      switch (input.action) {
        case "workspace.ensure":
          return { id: "native", path: ROOT };
        case "file.mkdir":
          assertRelative(payload.path);
          return {};
        case "file.write": {
          files.set(
            assertRelative(payload.path),
            Buffer.from(String(payload.content), "base64").toString("utf8"),
          );
          return {};
        }
        case "file.replace": {
          files.set(
            assertRelative(payload.path),
            Buffer.from(String(payload.content), "base64").toString("utf8"),
          );
          return {};
        }
        case "file.binary.begin": {
          const content = files.get(assertRelative(payload.path));
          if (content === undefined)
            throw new ContentError(404, "FILE_NOT_FOUND", "missing");
          return {
            transferId: "transfer",
            sizeBytes: Buffer.byteLength(content),
            chunkBytes: 1024,
          };
        }
        case "file.binary.chunk": {
          const bytes = Buffer.from(files.get(assertRelative(payload.path))!);
          return {
            transferId: "transfer",
            offset: payload.offset,
            content: bytes.toString("base64"),
            done: true,
          };
        }
        case "file.binary.close":
          return {};
        case "file.read": {
          const content = files.get(assertRelative(payload.path));
          if (content === undefined) throw new Error("FILE_NOT_FOUND");
          return { content: Buffer.from(content).toString("base64") };
        }
        case "file.list": {
          const rel = assertRelative(payload.path);
          return {
            files: [...files.entries()]
              .filter(([path]) => rel === "." || path.startsWith(`${rel}/`))
              .map(([path, content]) => ({
                path,
                is_dir: false,
                size: content.length,
              })),
          };
        }
        case "command.execute":
          assertRelative(payload.cwd);
          return { output: "ok", exitCode: 0, truncated: false };
        default:
          return {};
      }
    },
  );
});

async function createBackend() {
  const provider = (await localProviderForTurn({
    teamId: "team",
    workspaceId: "w",
    threadId: "t",
    userId: "owner",
  }))!.createProvider();
  const manager = new SandboxManager({
    provider,
    sandboxStore,
    operationStore,
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
  });
  return new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled: true,
  });
}

test("execute with the default cwd reaches the Windows host as the workspace root", async () => {
  const backend = await createBackend();
  const result = await backend.execute("node -v");
  expect(result).toMatchObject({ output: "ok", exitCode: 0 });
  const executed = hostCalls.find((call) => call.action === "command.execute");
  expect(executed?.payload).toMatchObject({
    workspaceId: "native",
    command: "node -v",
    cwd: ".",
  });
});

test("write, read, edit, ls and glob on drive paths reach the host workspace-relative", async () => {
  const backend = await createBackend();

  expect(await backend.write(`${ROOT}/src/a.ts`, "one\ntwo\n")).toMatchObject({
    path: `${ROOT}/src/a.ts`,
  });
  expect(files.get("src/a.ts")).toBe("one\ntwo\n");
  expect(
    hostCalls.find((call) => call.action === "file.mkdir")?.payload,
  ).toMatchObject({
    path: "src",
  });

  const read = await backend.read(`${ROOT}/src/a.ts`);
  expect(read.error).toBeUndefined();
  expect(read.content).toContain("one");

  const edited = await backend.edit(`${ROOT}/src/a.ts`, "two", "2");
  expect(edited.error).toBeUndefined();
  expect(files.get("src/a.ts")).toBe("one\n2\n");

  const ls = await backend.ls(`${ROOT}/src`);
  expect(ls.files?.map((file) => file.path)).toEqual([`${ROOT}/src/a.ts`]);

  // The listing root and a bare "/" resolve to the bound workspace.
  expect((await backend.ls("/")).files).toEqual([
    { path: `${ROOT}/`, is_dir: true },
  ]);
  const globbed = await backend.glob("**/*.ts", "/");
  expect(globbed.files?.map((file) => file.path)).toEqual([`${ROOT}/src/a.ts`]);
  const absolute = await backend.glob(`${ROOT}/**/*.ts`, ROOT);
  expect(absolute.files?.map((file) => file.path)).toEqual([
    `${ROOT}/src/a.ts`,
  ]);
});

test("paths outside the Windows workspace are refused before the host is contacted", async () => {
  const backend = await createBackend();
  const before = hostCalls.length;
  for (const bad of [
    "C:/Users/Test/.ssh/id_rsa",
    "D:/data/a.txt",
    `${ROOT}-other/a`,
    "\\\\server\\share\\a",
  ]) {
    expect((await backend.read(bad)).error).toMatch(
      /SANDBOX_READ_PATH_DENIED/u,
    );
    expect((await backend.write(bad, "x")).error).toMatch(
      /SANDBOX_READ_PATH_DENIED/u,
    );
  }
  expect(
    hostCalls.slice(before).filter((call) => call.action.startsWith("file.")),
  ).toEqual([]);
});
