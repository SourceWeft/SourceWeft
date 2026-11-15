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
      directoryGrantId: "grant" as string | undefined,
    },
  },
  binding: { threadId: "t", userId: "owner", deviceId: "pc" },
  device: {
    id: "pc",
    workspaceBase: null as string | null,
    capabilities: null as string[] | null,
  },
  call: vi.fn(),
  update: vi.fn(),
  policy: vi.fn(),
}));
vi.mock("@sourceweft/db", () => ({
  threads: {},
  localDevices: {},
  localThreadBindings: {},
  db: {
    query: {
      threads: { findFirst: async () => state.thread },
      localThreadBindings: { findFirst: async () => state.binding },
      localDevices: { findFirst: async () => state.device },
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
vi.mock("./network-approvals", () => ({
  resolveCommandNetworkPolicy: state.policy,
}));
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
  state.thread.executionTargetJson.directoryGrantId = "grant";
  state.device.workspaceBase = null;
  state.device.capabilities = null;
  state.policy.mockResolvedValue({ mode: "ask", allow: [], suggested: {} });
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

test("each command carries a freshly resolved network policy for this user and the turn's skills", async () => {
  const networkSkills = [
    { name: "pdf", sourceType: "builtin", skillMd: "---\nname: pdf\n---" },
  ];
  const policy = {
    mode: "ask",
    allow: ["api.example.com"],
    suggested: { "x.example.com": "mine" },
  };
  state.policy.mockResolvedValue(policy);
  const provider = (await localProviderForTurn(context, {
    networkSkills,
  }))!.createProvider();
  await provider.getSandbox("native");
  await provider.execute({
    providerSandboxId: "native",
    command: "curl https://api.example.com",
    timeoutMs: 10_000,
    maxOutputChars: 1000,
  } as never);
  expect(state.policy).toHaveBeenCalledWith({
    deviceId: "pc",
    tenant: { teamId: "team", workspaceId: "w", userId: "owner" },
    skills: networkSkills,
  });
  const execute = state.call.mock.calls.find(
    ([input]) => input.action === "command.execute",
  )![0];
  expect(execute.payload).toMatchObject({
    command: "curl https://api.example.com",
    network: policy,
  });
  // The second command resolves again instead of reusing the first answer.
  state.policy.mockResolvedValue({ mode: "strict", allow: [], suggested: {} });
  await provider.execute({
    providerSandboxId: "native",
    command: "true",
    timeoutMs: 10_000,
    maxOutputChars: 1000,
  } as never);
  expect(state.policy).toHaveBeenCalledTimes(2);
  expect(state.call.mock.calls.at(-1)![0].payload.network.mode).toBe("strict");
});

test("a failed policy lookup stops the command instead of running it unrestricted", async () => {
  const provider = (await localProviderForTurn(context))!.createProvider();
  await provider.getSandbox("native");
  state.policy.mockRejectedValue(new Error("LOCAL_DEVICE_NOT_FOUND"));
  await expect(
    provider.execute({
      providerSandboxId: "native",
      command: "true",
      timeoutMs: 10_000,
      maxOutputChars: 1000,
    } as never),
  ).rejects.toThrow("LOCAL_DEVICE_NOT_FOUND");
  expect(
    state.call.mock.calls.some(([input]) => input.action === "command.execute"),
  ).toBe(false);
});

test("a computer that announces workspace.reserve decides where the automatic task folder goes", async () => {
  state.thread.executionTargetJson.directoryGrantId = undefined;
  state.device.workspaceBase = "/Users/test/Library/app/task-workspaces";
  state.device.capabilities = ["workspace.ensure", "workspace.reserve"];
  const root = "/Users/test/SourceWeft/2026-11-15/0a1b2c3d";
  state.call.mockImplementation(async (input) =>
    input.action === "workspace.reserve" || input.action === "workspace.ensure"
      ? { id: "native", path: root }
      : {},
  );
  const provider = (await localProviderForTurn(context))!.createProvider();
  // Reserving records the location on the computer; nothing is created until
  // a tool acquires the directory.
  expect(state.call).toHaveBeenCalledTimes(1);
  expect(state.call.mock.calls[0]![0]).toMatchObject({
    action: "workspace.reserve",
    payload: {},
    threadId: "t",
  });
  expect(state.update).toHaveBeenCalledWith({
    localWorkspaceId: "native",
    workspacePath: root,
  });
  expect(provider.pathPolicy.defaultCwd).toBe(root);
  await provider.ensureDirectory!({
    providerSandboxId: "native",
    directory: `${root}/src`,
  });
  expect(state.call.mock.calls[1]![0]).toMatchObject({
    action: "workspace.ensure",
    payload: { workspaceId: "native" },
  });
});

test("a computer without the reserve action keeps the path derived from its application storage", async () => {
  state.thread.executionTargetJson.directoryGrantId = undefined;
  state.device.workspaceBase = "/Users/test/Library/app/task-workspaces";
  state.device.capabilities = ["workspace.ensure", "workspace.check"];
  const provider = (await localProviderForTurn(context))!.createProvider();
  expect(state.call).not.toHaveBeenCalled();
  const saved = state.update.mock.calls[0]![0] as {
    localWorkspaceId: string;
    workspacePath: string;
  };
  expect(saved.workspacePath).toBe(
    `/Users/test/Library/app/task-workspaces/${saved.localWorkspaceId}/files`,
  );
  expect(provider.pathPolicy.defaultCwd).toBe(saved.workspacePath);
});

test("a computer with neither the reserve action nor a reported storage path needs an upgrade", async () => {
  state.thread.executionTargetJson.directoryGrantId = undefined;
  await expect(localProviderForTurn(context)).rejects.toMatchObject({
    code: "LOCAL_HOST_UPGRADE_REQUIRED",
  });
  expect(state.call).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
});

test.each(["relative/path", "C:\\Users\\Test\\SourceWeft", undefined])(
  "an invalid reserved task folder is refused: %s",
  async (path) => {
    state.thread.executionTargetJson.directoryGrantId = undefined;
    state.device.capabilities = ["workspace.reserve"];
    state.call.mockImplementation(async () => ({ id: "native", path }));
    await expect(localProviderForTurn(context)).rejects.toMatchObject({
      code: "LOCAL_WORKSPACE_MISMATCH",
    });
    expect(state.update).not.toHaveBeenCalled();
  },
);

test("an offline computer fails the reservation instead of deriving a path", async () => {
  state.thread.executionTargetJson.directoryGrantId = undefined;
  state.device.workspaceBase = "/Users/test/Library/app/task-workspaces";
  state.device.capabilities = ["workspace.reserve"];
  state.call.mockRejectedValue(new Error("DEVICE_OFFLINE"));
  await expect(localProviderForTurn(context)).rejects.toThrow("DEVICE_OFFLINE");
  expect(state.update).not.toHaveBeenCalled();
});
