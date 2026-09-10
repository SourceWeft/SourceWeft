import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  values: new Map<string, string>(),
  set: vi.fn(),
  eval: vi.fn(),
}));
vi.mock("../../shared/queue", () => ({
  jobsRedisClient: async () => ({ set: state.set, eval: state.eval }),
}));
import { storeLocalFileReply, consumeLocalFileReply } from "./binary-transfer";
const scope = { userId: "owner", deviceId: "device", invocationId: "call" };
beforeEach(() => {
  state.values.clear();
  vi.clearAllMocks();
  state.set.mockImplementation(async (key, value) => {
    state.values.set(key, value);
    return "OK";
  });
  state.eval.mockImplementation(async (_script, _count, key) => {
    const value = state.values.get(key) ?? null;
    state.values.delete(key);
    return value;
  });
});
it("persists metadata only and consumes transient bytes once", async () => {
  const reply = await storeLocalFileReply(scope, {
    content: "aW1hZ2U=",
    offset: 0,
    done: true,
  });
  expect(reply).toEqual({
    contentTransport: "ephemeral",
    offset: 0,
    done: true,
  });
  expect(state.set.mock.calls[0]?.slice(2)).toEqual(["EX", 60]);
  await expect(
    consumeLocalFileReply({ ...scope, userId: "other" }, reply),
  ).rejects.toMatchObject({ code: "FILE_TRANSFER_EXPIRED" });
  expect(await consumeLocalFileReply(scope, reply)).toEqual({
    content: "aW1hZ2U=",
    offset: 0,
    done: true,
  });
  await expect(consumeLocalFileReply(scope, reply)).rejects.toMatchObject({
    code: "FILE_TRANSFER_EXPIRED",
  });
});
it("rejects durable byte payloads instead of using a compatibility path", async () => {
  await expect(
    consumeLocalFileReply(scope, { content: "old" }),
  ).rejects.toMatchObject({ code: "INVALID_FILE_REPLY" });
  await expect(
    storeLocalFileReply(scope, { content: "a".repeat(2 * 1024 * 1024 + 1) }),
  ).rejects.toMatchObject({ code: "INVALID_FILE_REPLY" });
  expect(state.set).not.toHaveBeenCalled();
});
