import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceWeftSandboxBackend } from "../../src/runtime/sourceweft-sandbox-backend";
import {
  SandboxProviderError,
  SANDBOX_PROVIDER_ERROR_CODES,
} from "../../src/runtime/errors";
import { SandboxManager } from "../../src/runtime/sandbox-manager";
import {
  maxSandboxCommandTimeoutMs,
  resolveSandboxCommandTimeoutMs,
} from "../../src/runtime/command-budgets";
import type {
  SandboxOperationStore,
  SandboxProvider,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStore,
} from "../../src/runtime/types";

const ROOT = "C:/Users/Test/AppData/Roaming/app/task-workspaces/id/files";

const context: SandboxRuntimeContext = {
  teamId: "team",
  workspaceId: "workspace",
  threadId: "thread",
  userId: "user",
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

function sandboxStore(): SandboxStore {
  return {
    async findLatestActiveThreadSandbox() {
      return {
        id: "record",
        provider: "local",
        providerSandboxId: "native",
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

function operationStore(): SandboxOperationStore {
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

/**
 * A native-file-operations provider that is as strict about paths as the real
 * device provider: it accepts only forward-slash drive paths under the bound
 * root (case-insensitive) and maps them to workspace-relative paths, exactly
 * like `relative()` in apps/backend/src/modules/devices/provider.ts. A path in
 * the `/C:/...` form the old POSIX-only normaliser produced is refused.
 */
function createDriveProvider() {
  const files = new Map<string, string>();
  const calls: Array<{ op: string; relative: string; cwd?: string }> = [];
  const relative = (path: string) => {
    const lowerRoot = ROOT.toLowerCase();
    const lower = path.toLowerCase();
    if (lower === lowerRoot) return ".";
    if (!lower.startsWith(`${lowerRoot}/`) || path.split("/").includes(".."))
      throw new Error(
        "LOCAL_PATH_DENIED: Path is outside the bound workspace.",
      );
    return path.slice(ROOT.length + 1);
  };
  const provider: SandboxProvider = {
    id: "local",
    pathPolicy: {
      skillsRoot: `${ROOT}/.sourceweft-skills`,
      workspaceRoot: ROOT,
      defaultCwd: ROOT,
      prepareTargetRoots: [ROOT],
      collectSourceRoots: [ROOT],
      readWriteRoots: [ROOT],
    },
    nativeFileOperations: true,
    async createSandbox() {
      return { id: "native" };
    },
    async getSandbox() {
      return {};
    },
    async deleteSandbox() {},
    async execute(input) {
      calls.push({
        op: "execute",
        relative: input.cwd ? relative(input.cwd) : ".",
        cwd: input.cwd,
      });
      return { output: "ran", exitCode: 0, truncated: false };
    },
    async ensureDirectory(input) {
      calls.push({ op: "mkdir", relative: relative(input.directory) });
    },
    async uploadFile(input) {
      const rel = relative(input.sandboxPath);
      calls.push({ op: "write", relative: rel });
      files.set(rel, Buffer.from(input.content).toString("utf8"));
    },
    async downloadFile(input) {
      const rel = relative(input.sandboxPath);
      calls.push({ op: "download", relative: rel });
      const content = files.get(rel);
      if (content === undefined)
        throw new SandboxProviderError(
          SANDBOX_PROVIDER_ERROR_CODES.fileMissing,
          "SANDBOX_FILE_NOT_FOUND: requested local file was not found.",
          "download",
        );
      return Buffer.from(content);
    },
    async readTextFile(input) {
      const rel = relative(input.sandboxPath);
      calls.push({ op: "read", relative: rel });
      const content = files.get(rel);
      if (content === undefined) throw new Error("FILE_NOT_FOUND");
      return content;
    },
    async replaceTextFile(input) {
      const rel = relative(input.sandboxPath);
      calls.push({ op: "replace", relative: rel });
      files.set(rel, input.content);
    },
    async listFiles(input) {
      const rel = relative(input.sandboxPath);
      calls.push({ op: "list", relative: rel });
      return [...files.entries()]
        .filter(([path]) => rel === "." || path.startsWith(`${rel}/`))
        .map(([path, content]) => ({
          path: `${ROOT}/${path}`,
          is_dir: false,
          size: content.length,
        }));
    },
  };
  return { provider, files, calls };
}

function createBackend() {
  const { provider, files, calls } = createDriveProvider();
  const manager = new SandboxManager({
    provider,
    sandboxStore: sandboxStore(),
    operationStore: operationStore(),
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled: true,
  });
  return { backend, files, calls };
}

test("a drive-rooted device runs execute in its default cwd", async () => {
  const { backend, calls } = createBackend();
  const result = await backend.execute("node -v");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    calls.filter((call) => call.op === "execute"),
    [{ op: "execute", relative: ".", cwd: ROOT }],
  );
});

test("a drive-rooted device writes, reads, edits and lists through the adapter", async () => {
  const { backend, files, calls } = createBackend();

  const written = await backend.write(`${ROOT}/src/a.ts`, "one\ntwo\n");
  assert.equal(written.error, undefined);
  assert.equal(written.path, `${ROOT}/src/a.ts`);
  assert.equal(files.get("src/a.ts"), "one\ntwo\n");
  assert.ok(calls.some((c) => c.op === "mkdir" && c.relative === "src"));

  // Backslashes and a lower-case drive letter are normalised, not refused.
  const read = await backend.read(
    `${ROOT.replace(/\//g, "\\").replace("C:", "c:")}\\src\\a.ts`,
  );
  assert.equal(read.error, undefined);
  assert.match(String(read.content ?? ""), /^one\ntwo/u);

  const edited = await backend.edit(`${ROOT}/src/a.ts`, "two", "2");
  assert.equal(edited.error, undefined);
  assert.equal(files.get("src/a.ts"), "one\n2\n");

  const ls = await backend.ls(`${ROOT}/src`);
  assert.equal(ls.error, undefined);
  assert.deepEqual(
    ls.files?.map((file) => file.path),
    [`${ROOT}/src/a.ts`],
  );

  const roots = await backend.ls("/");
  assert.deepEqual(roots.files, [{ path: `${ROOT}/`, is_dir: true }]);
});

test("a drive-rooted device globs and uploads/downloads in bulk", async () => {
  const { backend, files, calls } = createBackend();
  await backend.write(`${ROOT}/src/a.ts`, "x");
  await backend.write(`${ROOT}/src/b.md`, "y");

  const relative = await backend.glob("*.ts", `${ROOT}/src`);
  assert.equal(relative.error, undefined);
  assert.deepEqual(
    relative.files?.map((file) => file.path),
    [`${ROOT}/src/a.ts`],
  );

  // The absolute-pattern check must recognise a drive-absolute pattern, and
  // NTFS matches its prefix case-insensitively.
  const absolute = await backend.glob(`${ROOT.toLowerCase()}/**/*.md`, ROOT);
  assert.equal(absolute.error, undefined);
  assert.deepEqual(
    absolute.files?.map((file) => file.path),
    [`${ROOT}/src/b.md`],
  );

  const defaulted = await backend.glob("**/*.ts", "/");
  assert.deepEqual(
    defaulted.files?.map((file) => file.path),
    [`${ROOT}/src/a.ts`],
  );

  const uploaded = await backend.uploadFiles([
    [`${ROOT}/out/c.bin`, new Uint8Array([1, 2, 3])],
  ]);
  assert.deepEqual(uploaded, [{ path: `${ROOT}/out/c.bin`, error: null }]);
  assert.ok(calls.some((c) => c.op === "mkdir" && c.relative === "out"));
  assert.ok(files.has("out/c.bin"));
  const downloaded = await backend.downloadFiles([
    `${ROOT}/out/c.bin`,
    `${ROOT}/missing.bin`,
    "C:/Users/Test/.ssh/id_rsa",
  ]);
  assert.deepEqual(
    downloaded.map((file) => file.error),
    [null, "file_not_found", "permission_denied"],
  );
});

test("a drive-rooted device refuses paths outside its root with a recoverable error", async () => {
  const { backend, calls } = createBackend();
  for (const bad of [
    "C:/Users/Test/.ssh/id_rsa",
    "D:/anything",
    `${ROOT}-other/a`,
    "/etc/passwd",
    "\\\\server\\share\\a",
  ]) {
    const read = await backend.read(bad);
    assert.match(read.error ?? "", /SANDBOX_READ_PATH_DENIED/u, bad);
    const write = await backend.write(bad, "x");
    assert.match(write.error ?? "", /SANDBOX_READ_PATH_DENIED/u, bad);
  }
  assert.equal(calls.length, 0);
});
