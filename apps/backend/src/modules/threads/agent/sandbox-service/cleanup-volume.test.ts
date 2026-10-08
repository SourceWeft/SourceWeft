import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { config } from "../../../../shared/config";

const mocks = vi.hoisted(() => ({
  volumeEnabled: true,
  checkpoint: vi.fn(),
  deleted: vi.fn(),
  updates: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  rows: [] as Array<Record<string, unknown>>,
  operationTable: null as unknown,
}));
vi.mock("./volume", () => ({
  sandboxVolumeHooks: () =>
    mocks.volumeEnabled ? { checkpointScope: mocks.checkpoint } : null,
}));
vi.mock("./provider-registry", () => ({
  initializeSandboxProviderRegistry: vi.fn(),
  getSandboxProviderFactory: () => ({
    id: "fake",
    getConfigurationStatus: () => ({ configured: true }),
    createProvider: () => ({ deleteSandbox: mocks.deleted, execute: vi.fn() }),
  }),
}));
vi.mock("@sourceweft/db", async () => {
  const actual = await import("@sourceweft/db/schema");
  mocks.operationTable = actual.agentSandboxOperations;
  return {
    ...actual,
    db: {
      query: { agentSandboxes: { findMany: async () => mocks.rows } },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ id: "op" }],
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          mocks.updates.push({ table, values });
          return { where: async () => undefined };
        },
      }),
    },
  };
});
import { agentSandboxService } from "./service";
const originalEnabled = config.sandbox.enabled;
beforeEach(() => {
  config.sandbox.enabled = true;
  mocks.volumeEnabled = true;
  mocks.rows = [
    {
      id: "sandbox",
      providerSandboxId: "provider-sandbox",
      teamId: "team",
      workspaceId: "workspace",
      threadId: "thread",
      userId: "user",
      status: "ready",
    },
  ];
  mocks.updates.length = 0;
  mocks.deleted.mockReset();
  mocks.checkpoint.mockReset();
});
afterEach(() => {
  config.sandbox.enabled = originalEnabled;
  vi.restoreAllMocks();
});

for (const failure of ["throw", "unconfirmed", "missing-instance"]) {
  test(`cleanup preserves sandbox and marks operation failed when checkpoint ${failure}`, async () => {
    if (failure === "throw")
      mocks.checkpoint.mockRejectedValue(new Error("persistence unavailable"));
    else if (failure === "missing-instance")
      mocks.checkpoint.mockRejectedValue(
        Object.assign(new Error("checkpoint cannot read missing sandbox"), {
          code: "SANDBOX_NOT_FOUND_OR_EXPIRED",
        }),
      );
    else mocks.checkpoint.mockResolvedValue({ sync: { persisted: false } });
    expect(await agentSandboxService.cleanupExpiredSandboxes()).toEqual({
      cleaned: 0,
    });
    expect(mocks.deleted).not.toHaveBeenCalled();
    expect(mocks.updates.some((x) => x.values.status === "expired")).toBe(
      false,
    );
    expect(
      mocks.updates.some(
        (x) => x.table === mocks.operationTable && x.values.status === "failed",
      ),
    ).toBe(true);
  });
}
test("confirmed checkpoint retains disk while background writers are not drained", async () => {
  mocks.checkpoint.mockResolvedValue({ sync: { persisted: true } });
  expect(await agentSandboxService.cleanupExpiredSandboxes()).toEqual({
    cleaned: 0,
  });
  expect(mocks.deleted).not.toHaveBeenCalled();
  expect(mocks.updates.some((x) => x.values.status === "expired")).toBe(false);
  const failure = mocks.updates.find(
    (x) => x.table === mocks.operationTable && x.values.status === "failed",
  );
  expect(
    (failure?.values.resultJsonRedacted as { error?: string })?.error,
  ).toContain("SANDBOX_VOLUME_CLEANUP_REQUIRES_DRAIN");
});
test("volume disabled preserves the previous cleanup behavior", async () => {
  mocks.volumeEnabled = false;
  expect(await agentSandboxService.cleanupExpiredSandboxes()).toEqual({
    cleaned: 1,
  });
  expect(mocks.deleted).toHaveBeenCalledOnce();
});
test("no existing thread volume still allows cleanup", async () => {
  mocks.checkpoint.mockResolvedValue(null);
  expect(await agentSandboxService.cleanupExpiredSandboxes()).toEqual({
    cleaned: 1,
  });
  expect(mocks.deleted).toHaveBeenCalledOnce();
});
test("disabled sandbox does not checkpoint or delete", async () => {
  config.sandbox.enabled = false;
  expect(await agentSandboxService.cleanupExpiredSandboxes()).toEqual({
    cleaned: 0,
  });
  expect(mocks.deleted).not.toHaveBeenCalled();
  expect(mocks.checkpoint).not.toHaveBeenCalled();
});

test("already deleted provider is accepted when the thread has no persistent volume", async () => {
  mocks.checkpoint.mockResolvedValue(null);
  mocks.deleted.mockRejectedValue(
    Object.assign(new Error("already deleted"), {
      code: "SANDBOX_NOT_FOUND_OR_EXPIRED",
    }),
  );
  expect(await agentSandboxService.cleanupExpiredSandboxes()).toEqual({
    cleaned: 1,
  });
  expect(mocks.updates.some((x) => x.values.status === "expired")).toBe(true);
});

test("cleanup checkpoint is bound to the selected provider instance", async () => {
  mocks.checkpoint.mockResolvedValue({ sync: { persisted: true } });
  await agentSandboxService.cleanupExpiredSandboxes();
  expect(mocks.checkpoint).toHaveBeenCalledWith(
    expect.objectContaining({ sandboxId: "provider-sandbox" }),
  );
});
