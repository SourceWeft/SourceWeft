import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  markChecked: vi.fn(),
  connector: vi.fn(),
  run: vi.fn(),
  updateRun: vi.fn(),
  lock: vi.fn(),
  workspace: vi.fn(),
  commit: vi.fn(),
  state: vi.fn(),
}));
vi.mock("../preview", () => ({
  previewAccessService: { isEnabled: mocks.enabled },
}));
vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.workspace,
}));
vi.mock("./repository", () => ({
  markConnectorSyncBlockChecked: mocks.markChecked,
  findSourceConnectorRecord: mocks.connector,
  findSyncRunRecord: mocks.run,
  updateSyncRunRecord: mocks.updateRun,
  tryAcquireConnectorSyncLock: mocks.lock,
  commitConnectorSyncPage: mocks.commit,
  getOrResetConnectorSyncState: mocks.state,
  touchConnectorAfterSync: vi.fn(),
  completeScheduleOccurrence: vi.fn(),
  isConnectorScheduleEnabled: vi.fn().mockResolvedValue(true),
}));
import { ConnectorSyncOrchestrator } from "./sync-orchestrator";
const input = {
  runId: "run",
  teamId: "team",
  workspaceId: "workspace",
  connectorId: "connector",
  userId: "actor",
};
const connection = {
  id: "connector",
  connectorType: "gmail",
  status: "active",
  createdBy: "owner",
  configJson: {},
  oauthAccountId: "account",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connector.mockResolvedValue(connection);
  mocks.run.mockResolvedValue({
    id: "run",
    triggerType: "manual",
    status: "queued",
    createdBy: "actor",
  });
  mocks.lock.mockResolvedValue(vi.fn());
  mocks.workspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.state.mockResolvedValue({
    generation: 1,
    committedCursorJson: {},
    pageCursorJson: {},
  });
  mocks.commit.mockResolvedValue({ generation: 2 });
});
function runtime(discoverPages = vi.fn()) {
  const manifest = { type: "gmail", sync: { resources: [] } };
  const registry = {
    getManifest: () => manifest,
    getAdapter: () => ({ getManifest: () => manifest, discoverPages }),
  };
  const oauth = { getRuntimeToken: vi.fn().mockResolvedValue("token") };
  const billing = {
    getExecutionState: vi.fn().mockResolvedValue({ kind: "unmetered" }),
  };
  return {
    oauth,
    orchestrator: new ConnectorSyncOrchestrator(
      billing as never,
      registry as never,
      oauth as never,
      async () => "owner",
    ),
  };
}
it("rejects a queued manual run after its actor loses preview", async () => {
  mocks.enabled.mockResolvedValue(false);
  const { orchestrator, oauth } = runtime();
  await expect(orchestrator.run(input)).rejects.toMatchObject({
    code: "CONNECTOR_PREVIEW_ACCESS_DENIED",
  });
  expect(mocks.enabled).toHaveBeenCalledWith("actor", "gmail");
  expect(oauth.getRuntimeToken).not.toHaveBeenCalled();
  expect(mocks.updateRun).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "failed",
      errorCode: "CONNECTOR_PREVIEW_ACCESS_DENIED",
    }),
  );
});
it("background execution requires owner preview and never trusts a queue user fallback", async () => {
  mocks.run.mockResolvedValue({
    id: "run",
    triggerType: "scheduled",
    status: "queued",
    createdBy: null,
  });
  mocks.connector.mockResolvedValue({ ...connection, createdBy: null });
  const { orchestrator, oauth } = runtime();
  await expect(orchestrator.run(input)).rejects.toMatchObject({
    code: "CONNECTOR_PREVIEW_OWNER_REQUIRED",
  });
  expect(oauth.getRuntimeToken).not.toHaveBeenCalled();
});
it("rechecks before requesting the next provider page", async () => {
  let enabled = true;
  mocks.enabled.mockImplementation(async () => enabled);
  const next = vi
    .fn()
    .mockResolvedValueOnce({
      done: false,
      value: { items: [], complete: false },
    })
    .mockResolvedValueOnce({ done: true });
  const close = vi.fn().mockResolvedValue({ done: true });
  mocks.commit.mockImplementation(async () => {
    enabled = false;
    return { generation: 2 };
  });
  const discover = vi.fn(() => ({
    [Symbol.asyncIterator]: () => ({ next, return: close }),
  }));
  const { orchestrator } = runtime(discover);
  await expect(orchestrator.run(input)).rejects.toMatchObject({
    code: "CONNECTOR_PREVIEW_ACCESS_DENIED",
  });
  expect(next).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledOnce();
});

it.each(["denied", "ownerless"])(
  "quota resume advances the check timestamp for %s Gmail eligibility without queueing",
  async (state) => {
    mocks.enabled.mockResolvedValue(false);
    const { orchestrator, oauth } = runtime();
    const enqueue = vi.fn();
    const result = await orchestrator.enqueueQuotaResumeRun({
      connector: {
        ...connection,
        createdBy: state === "ownerless" ? null : "owner",
        syncBlock: { reason: "PAGES_LIMIT_EXCEEDED" },
      } as never,
      enqueue,
    });
    expect(result).toEqual({ queued: false, reason: "preview_denied" });
    expect(mocks.markChecked).toHaveBeenCalledWith({
      connectorId: "connector",
      checkedAt: expect.any(Date),
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(oauth.getRuntimeToken).not.toHaveBeenCalled();
  },
);
it("quota resume propagates database failures instead of treating them as eligibility denial", async () => {
  mocks.enabled.mockRejectedValueOnce(new Error("database unavailable"));
  const { orchestrator } = runtime();
  const enqueue = vi.fn();
  await expect(
    orchestrator.enqueueQuotaResumeRun({
      connector: {
        ...connection,
        syncBlock: { reason: "PAGES_LIMIT_EXCEEDED" },
      } as never,
      enqueue,
    }),
  ).rejects.toThrow("database unavailable");
  expect(mocks.markChecked).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});
