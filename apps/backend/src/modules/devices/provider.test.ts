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

test("Windows directories retain their drive and scope across file and command dispatch", async () => {
  state.call.mockImplementation(async (input) => {
    if (input.action === "workspace.ensure")
      return { id: "native", path: "C:/Users/test/任务 folder" };
    return { output: "ok", exitCode: 0, files: [{ path: "sub/report.txt" }] };
  });
  const provider = (await localProviderForTurn(context))!.createProvider();
  expect(provider.pathPolicy.workspaceRoot).toBe("C:/Users/test/任务 folder");
  await provider.execute({
    providerSandboxId: "native",
    command: "echo ok",
    cwd: "C:/Users/test/任务 folder/sub",
    timeoutMs: 1000,
    maxOutputChars: 100,
  });
  expect(state.call.mock.calls.at(-1)![0].payload.cwd).toBe("sub");
  expect(
    await provider.listFiles!({
      providerSandboxId: "native",
      sandboxPath: "C:/Users/test/任务 folder",
    }),
  ).toEqual([{ path: "C:/Users/test/任务 folder/sub/report.txt" }]);
  for (const path of [
    "D:/outside.txt",
    "C:/Users/test/任务 folder-other/a",
    "C:/Users/test/任务 folder/../a",
  ])
    await expect(
      provider.downloadFile({ providerSandboxId: "native", sandboxPath: path }),
    ).rejects.toThrow("LOCAL_PATH_DENIED");
});
