import { beforeEach, expect, it, vi } from "vitest";
import { ConnectorError } from "./errors";
const mocks = vi.hoisted(() => ({
  markChecked: vi.fn(),
  connector: vi.fn(),
  run: vi.fn(),
  updateRun: vi.fn(),
  lock: vi.fn(),
  workspace: vi.fn(),
  commit: vi.fn(),
  state: vi.fn(),
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

// A Gmail sync started by a person keeps rechecking that person's workspace
// sync permission while it reads mail on their behalf.
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
const forbidden = () =>
  new ConnectorError(403, "CONNECTOR_FORBIDDEN", "permission revoked");
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
it("rejects a queued manual Gmail run after its actor loses workspace sync permission", async () => {
  mocks.workspace.mockRejectedValue(forbidden());
  const { orchestrator, oauth } = runtime();
  await expect(orchestrator.run(input)).rejects.toMatchObject({
    code: "CONNECTOR_FORBIDDEN",
  });
  expect(mocks.workspace).toHaveBeenCalledWith({
    workspaceId: "workspace",
    userId: "actor",
    permission: "connector.sync",
  });
  expect(oauth.getRuntimeToken).not.toHaveBeenCalled();
  expect(mocks.updateRun).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "failed",
      errorCode: "CONNECTOR_FORBIDDEN",
    }),
  );
});
it("rechecks the actor's permission before requesting the next Gmail page", async () => {
  let allowed = true;
  mocks.workspace.mockImplementation(async () => {
    if (!allowed) throw forbidden();
    return { workspace: { id: "workspace", organizationId: "team" } };
  });
  const next = vi
    .fn()
    .mockResolvedValueOnce({
      done: false,
      value: { items: [], complete: false },
    })
    .mockResolvedValueOnce({ done: true });
  const close = vi.fn().mockResolvedValue({ done: true });
  mocks.commit.mockImplementation(async () => {
    allowed = false;
    return { generation: 2 };
  });
  const discover = vi.fn(() => ({
    [Symbol.asyncIterator]: () => ({ next, return: close }),
  }));
  const { orchestrator } = runtime(discover);
  await expect(orchestrator.run(input)).rejects.toMatchObject({
    code: "CONNECTOR_FORBIDDEN",
  });
  expect(next).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledOnce();
});
it("runs an actorless scheduled Gmail sync like any other connector", async () => {
  mocks.run.mockResolvedValue({
    id: "run",
    triggerType: "scheduled",
    status: "queued",
    createdBy: null,
  });
  const discover = vi.fn(() => ({
    [Symbol.asyncIterator]: () => ({
      next: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: { items: [], complete: true },
        })
        .mockResolvedValue({ done: true }),
      return: vi.fn().mockResolvedValue({ done: true }),
    }),
  }));
  const { orchestrator, oauth } = runtime(discover);
  await orchestrator.run(input);
  expect(mocks.workspace).not.toHaveBeenCalled();
  expect(oauth.getRuntimeToken).toHaveBeenCalledOnce();
  expect(discover).toHaveBeenCalledOnce();
});
