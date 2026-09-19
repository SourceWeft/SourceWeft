import { beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  thread: {
    id: "t",
    workspaceId: "w",
    createdBy: "owner",
    visibility: "private",
    executionTargetJson: { kind: "local", deviceId: "pc" },
  },
  binding: {
    userId: "owner",
    deviceId: "pc",
    localWorkspaceId: "directory",
    folderId: "grant",
  },
  call: vi.fn(),
}));
vi.mock("@sourceweft/db", () => ({
  threads: {},
  localThreadBindings: {},
  db: {
    query: {
      threads: { findFirst: async () => state.thread },
      localThreadBindings: { findFirst: async () => state.binding },
    },
  },
}));
vi.mock("./service", () => ({ localCall: state.call }));
import { requireLocalConversationReady } from "./availability";
const input = {
  userId: "owner",
  workspaceId: "w",
  threadId: "t",
  localCaller: { sessionId: "session" },
};
beforeEach(() => {
  state.thread.executionTargetJson.kind = "local";
  state.call.mockReset().mockResolvedValue({ ready: true });
});
test("readiness uses the bound directory and caller in a read-only probe", async () => {
  await requireLocalConversationReady(input);
  expect(state.call).toHaveBeenCalledWith(
    expect.objectContaining({
      caller: input.localCaller,
      deviceId: "pc",
      action: "workspace.check",
      payload: { workspaceId: "directory", directoryGrantId: "grant" },
    }),
  );
});
test("a probe must positively acknowledge readiness", async () => {
  state.call.mockResolvedValue({ ready: false });
  await expect(requireLocalConversationReady(input)).rejects.toMatchObject({
    code: "LOCAL_HOST_UPGRADE_REQUIRED",
  });
});
test.each([
  "DEVICE_OFFLINE",
  "REMOTE_ACCESS_DISABLED",
  "LOCAL_CONNECTION_REQUIRED",
  "LOCAL_FOLDER_REVOKED",
])("%s blocks without another execution target", async (code) => {
  state.call.mockRejectedValue(Object.assign(new Error(code), { code }));
  await expect(requireLocalConversationReady(input)).rejects.toMatchObject({
    code,
  });
  expect(state.call).toHaveBeenCalledOnce();
});
test("cloud skips PC probes; another account cannot probe a private PC", async () => {
  await expect(
    requireLocalConversationReady({ ...input, userId: "other" }),
  ).rejects.toMatchObject({ code: "LOCAL_THREAD_FORBIDDEN" });
  state.thread.executionTargetJson.kind = "cloud";
  await requireLocalConversationReady(input);
  expect(state.call).not.toHaveBeenCalled();
});
