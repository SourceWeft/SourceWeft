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
