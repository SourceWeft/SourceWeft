import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: true,
  actors: [] as Array<{ id: string }>,
  applyWal: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@sourceweft/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => state.actors }) }),
      }),
    }),
  },
}));
vi.mock("../../modules/threads/agent/sandbox-service/volume", () => ({
  sandboxVolumeService: () =>
    state.enabled ? { applyWal: state.applyWal } : null,
}));
vi.mock("../../shared/logger", () => ({
  logger: { error: state.log, info: state.log },
}));
import { scheduleSandboxVolumeWal } from "./sandbox-volumes";

beforeEach(() => {
  state.enabled = true;
  state.actors = [];
  state.applyWal.mockReset();
  state.log.mockReset();
});
test("disabled volume maintenance performs no store IO", async () => {
  state.enabled = false;
  expect(await scheduleSandboxVolumeWal()).toEqual({
    checked: 0,
    applied: 0,
    failed: 0,
  });
  expect(state.applyWal).not.toHaveBeenCalled();
});
test("background WAL applies without waiting for command completion", async () => {
  state.actors = [{ id: "a" }, { id: "b" }];
  state.applyWal.mockResolvedValue({ applied: 3, rejected: null });
  expect(await scheduleSandboxVolumeWal()).toEqual({
    checked: 2,
    applied: 6,
    failed: 0,
  });
});
test("one failed actor does not block others and signed URLs are not logged", async () => {
  state.actors = [{ id: "a" }, { id: "b" }];
  state.applyWal
    .mockRejectedValueOnce(
      new Error("https://bucket.invalid/private?X-Amz-Signature=secret"),
    )
    .mockResolvedValueOnce({ applied: 1, rejected: null });
  await expect(scheduleSandboxVolumeWal()).rejects.toThrow("1 of 2");
  expect(state.applyWal).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(state.log.mock.calls)).not.toContain("Signature");
});
test("protocol rejection is observable and never invokes rebase automatically", async () => {
  state.actors = [{ id: "a" }];
  state.applyWal.mockResolvedValue({
    applied: 0,
    rejected: "invalid manifest",
  });
  await expect(scheduleSandboxVolumeWal()).rejects.toThrow("1 of 1");
  expect(state.log).toHaveBeenCalledWith(
    "sandbox.volume.background_wal_rejected",
    { attachmentId: "a" },
  );
});
