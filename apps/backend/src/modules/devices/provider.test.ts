import { beforeEach, expect, test, vi } from "vitest";
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
  update: vi.fn(),
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
          returning: async () => {
            state.update(value);
            return [{ ...state.binding, ...value }];
          },
        }),
      }),
    }),
  },
}));
vi.mock("./service", () => ({ localCall: state.call }));
import { localProviderForTurn } from "./provider";
const context = {
  teamId: "team",
  workspaceId: "w",
  threadId: "t",
  userId: "owner",
};
beforeEach(() => {
  vi.clearAllMocks();
  state.thread.createdBy = "owner";
  state.call.mockImplementation(async (input) => {
    if (input.action === "workspace.ensure")
      return { id: "native", path: "/Users/test/task" };
    if (input.action === "file.read")
      return { content: Buffer.from("disk").toString("base64") };
    return {};
  });
});
test("all PC file operations use the bound directory and native grant", async () => {
  const provider = (await localProviderForTurn(context))!.createProvider();
  expect(state.call.mock.calls[0]![0].payload).toEqual({
    directoryGrantId: "grant",
  });
  expect(provider.pathPolicy.defaultCwd).toBe("/Users/test/task");
  await provider.replaceTextFile!({
    providerSandboxId: "native",
    sandboxPath: "/Users/test/task/a.txt",
    content: "new",
    expected: "disk",
  });
  expect(state.call.mock.calls.at(-1)![0]).toMatchObject({
    action: "file.replace",
    payload: {
      workspaceId: "native",
      path: "a.txt",
      expected: Buffer.from("disk").toString("base64"),
    },
  });
  for (const path of [
    "/files/a.txt",
    "/Users/test/task-other/a",
    "/Users/test/task/../a",
  ]) {
    await expect(
      provider.downloadFile({ providerSandboxId: "native", sandboxPath: path }),
    ).rejects.toThrow("LOCAL_PATH_DENIED");
  }
});
test("offline failure propagates without selecting another file store", async () => {
  state.call.mockRejectedValue(new Error("DEVICE_OFFLINE"));
  await expect(localProviderForTurn(context)).rejects.toThrow("DEVICE_OFFLINE");
  expect(state.update).not.toHaveBeenCalled();
});
test("a different account cannot resolve the directory", async () => {
  await expect(
    localProviderForTurn({ ...context, userId: "other" }),
  ).rejects.toThrow("private");
  expect(state.call).not.toHaveBeenCalled();
});

test("PC download maps only structured FILE_NOT_FOUND into provider missing", async () => {
  const { ContentError } = await import("../content/errors");
  const { SandboxProviderError, SANDBOX_PROVIDER_ERROR_CODES } =
    await import("@sourceweft/builtin-tool-sandbox");
  const provider = (await localProviderForTurn(context))!.createProvider();
  // Resolve the workspace before injecting a file-operation failure; workspace
  // initialization is deliberately memoized by the real provider.
  await provider.getSandbox("native");
  const missing = new ContentError(404, "FILE_NOT_FOUND", "本地文件不存在");
  state.call.mockRejectedValue(missing);
  await expect(
    provider.downloadFile({
      providerSandboxId: "native",
      sandboxPath: "/Users/test/task/missing.bin",
    }),
  ).rejects.toMatchObject({
    code: SANDBOX_PROVIDER_ERROR_CODES.fileMissing,
    cause: missing,
  });
  for (const failure of [
    new ContentError(
      409,
      "LOCAL_EXECUTION_FAILED",
      "FILE_NOT_FOUND: no such file",
    ),
    new ContentError(403, "FILE_ACCESS_DENIED", "denied"),
    new ContentError(409, "DEVICE_OFFLINE", "offline"),
  ]) {
    state.call.mockRejectedValue(failure);
    await expect(
      provider.downloadFile({
        providerSandboxId: "native",
        sandboxPath: "/Users/test/task/unknown.bin",
      }),
    ).rejects.toBe(failure);
    expect(failure).not.toBeInstanceOf(SandboxProviderError);
  }
});

test("Windows forward-slash drive paths are bound, mapped and fenced like POSIX ones", async () => {
  const root = "C:/Users/Test/AppData/Roaming/app/task-workspaces/id/files";
  state.call.mockImplementation(async (input) => {
    if (input.action === "workspace.ensure")
      return { id: "native", path: root };
    if (input.action === "file.list")
      return { files: [{ path: "src/a.ts", is_dir: false, size: 3 }] };
    return {};
  });
  const provider = (await localProviderForTurn(context))!.createProvider();
  expect(provider.pathPolicy.defaultCwd).toBe(root);
  expect(provider.pathPolicy.skillsRoot).toBe(`${root}/.sourceweft-skills`);
  await provider.ensureDirectory!({
    providerSandboxId: "native",
    directory: `${root}/src`,
  });
  expect(state.call.mock.calls.at(-1)![0]).toMatchObject({
    action: "file.mkdir",
    payload: { workspaceId: "native", path: "src" },
  });
  // NTFS is case-insensitive: the drive letter and directories may differ in case.
  await provider.ensureDirectory!({
    providerSandboxId: "native",
    directory: `${root.toLowerCase()}/Src`,
  });
  expect(state.call.mock.calls.at(-1)![0]).toMatchObject({
    payload: { path: "Src" },
  });
  await expect(
    provider.listFiles!({ providerSandboxId: "native", sandboxPath: root }),
  ).resolves.toEqual([{ path: `${root}/src/a.ts`, is_dir: false, size: 3 }]);
  for (const path of [
    "C:/Users/Test/other/a.txt",
    "D:/Users/Test/AppData/Roaming/app/task-workspaces/id/files/a",
    `${root}x/a`,
    `${root}/../a`,
  ]) {
    await expect(
      provider.downloadFile({ providerSandboxId: "native", sandboxPath: path }),
    ).rejects.toThrow("LOCAL_PATH_DENIED");
  }
});

test.each([
  "relative/path",
  "C:\\Users\\Test\\files",
  "\\\\server\\share\\files",
  "//server/share/files",
  "C:/Users/Test/../Other",
])(
  "an invalid working directory from the host is refused: %s",
  async (path) => {
    state.call.mockImplementation(async (input) =>
      input.action === "workspace.ensure" ? { id: "native", path } : {},
    );
    await expect(localProviderForTurn(context)).rejects.toMatchObject({
      code: "LOCAL_WORKSPACE_MISMATCH",
    });
  },
);
