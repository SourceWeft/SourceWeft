import { beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  grant: true,
  revokeAfterDispatch: false,
  invocation: null as Record<string, unknown> | null,
  access: vi.fn(),
  bindings: vi.fn(),
  inserts: vi.fn(),
  consume: vi.fn(),
}));
vi.mock("./access", () => ({
  requireDeviceAccess: async (...args: unknown[]) => {
    state.access(...args);
    return { id: "access" };
  },
}));
vi.mock("./binary-transfer", () => ({ consumeLocalFileReply: state.consume }));
vi.mock("@sourceweft/db", () => ({
  localDevices: {},
  localFolderGrants: {},
  localDeviceEnrollments: {},
  localThreadBindings: {},
  localToolInvocations: {},
  threads: {},
  db: {
    query: {
      localFolderGrants: {
        findFirst: async () =>
          state.grant && !(state.revokeAfterDispatch && state.invocation)
            ? { id: "grant" }
            : undefined,
      },
      localThreadBindings: { findFirst: state.bindings },
      localDevices: {
        findFirst: async () => ({
          heartbeatAt: new Date(),
          revokedAt: null,
          connectionId: "connection",
        }),
      },
      localToolInvocations: {
        findFirst: async () =>
          state.invocation
            ? {
                ...state.invocation,
                status: "succeeded",
                result: { files: [], contentTransport: "ephemeral" },
              }
            : null,
      },
    },
    transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              for: async () => [
                {
                  heartbeatAt: new Date(),
                  revokedAt: null,
                  connectionId: "connection",
                },
              ],
            }),
          }),
        }),
        insert: () => ({
          values: (value: Record<string, unknown>) => ({
            onConflictDoNothing: async () => {
              state.inserts(value);
              state.invocation = value;
            },
          }),
        }),
      }),
  },
}));
import { localCall } from "./service";
const input = {
  deviceId: "pc",
  userId: "owner",
  threadId: null,
  action: "folder.list",
  payload: { folderId: "grant", path: "" },
  caller: { sessionId: "session" },
};
beforeEach(() => {
  vi.clearAllMocks();
  state.grant = true;
  state.revokeAfterDispatch = false;
  state.invocation = null;
  state.consume.mockResolvedValue({ content: "aGVsbG8=" });
});
test("draft reads require device access and a live grant, without a thread binding", async () => {
  await expect(localCall(input)).resolves.toMatchObject({ files: [] });
  expect(state.access).toHaveBeenCalledTimes(2);
  expect(state.bindings).not.toHaveBeenCalled();
  expect(state.inserts).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: null, action: "folder.list" }),
  );
});
test("missing/revoked grants and write actions never dispatch", async () => {
  state.grant = false;
  await expect(localCall(input)).rejects.toMatchObject({
    code: "LOCAL_FOLDER_REVOKED",
  });
  state.grant = true;
  for (const action of ["file.write", "workspace.ensure", "command.execute"])
    await expect(localCall({ ...input, action })).rejects.toMatchObject({
      code: "LOCAL_FOLDER_SCOPE_INVALID",
    });
  await expect(
    localCall({ ...input, payload: { folderId: "", path: "" } }),
  ).rejects.toMatchObject({ code: "LOCAL_FOLDER_SCOPE_INVALID" });
  expect(state.inserts).not.toHaveBeenCalled();
});
test("revocation while the computer is reading prevents delivery", async () => {
  state.revokeAfterDispatch = true;
  await expect(
    localCall({ ...input, action: "folder.read" }),
  ).rejects.toMatchObject({ code: "LOCAL_FOLDER_REVOKED" });
  expect(state.consume).not.toHaveBeenCalled();
});
test("draft file bytes use the ephemeral transfer channel", async () => {
  await expect(localCall({ ...input, action: "folder.read" })).resolves.toEqual(
    { content: "aGVsbG8=" },
  );
  expect(state.consume).toHaveBeenCalledTimes(1);
});
