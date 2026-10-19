import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ChatThreadRunRecord } from "./types";

const mocks = vi.hoisted(() => ({
  progress: vi.fn(),
  heartbeat: vi.fn(),
  append: vi.fn(),
}));
vi.mock("./repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository")>()),
  updateChatThreadRunProgress: mocks.progress,
  touchChatThreadRunHeartbeat: mocks.heartbeat,
}));
vi.mock("./stream-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stream-manager")>()),
  chatRunStreamManager: { appendEvent: mocks.append },
}));
import { durableChatRunService } from "./service";

afterEach(() => vi.resetAllMocks());
const run = {
  id: "run-1",
  teamId: "team-1",
  workspaceId: "workspace-1",
  streamKey: "events-1",
} as ChatThreadRunRecord;

test("stream append waits for Redis then writes the same snapshot without requesting a returned run", async () => {
  let appended = false;
  mocks.append.mockImplementation(async () => {
    appended = true;
    return 17;
  });
  mocks.progress.mockImplementation(async (input) => {
    assert.equal(appended, true);
    assert.equal(input.returnRecord, false);
  });
  const snapshot = { reasoning: "every delta retained", reasoningRevision: 7 };
  await durableChatRunService.appendRunEvent({
    run,
    payload: "event",
    snapshot,
  });
  assert.deepEqual(mocks.append.mock.calls[0], ["events-1", "event"]);
  assert.deepEqual(mocks.progress.mock.calls[0], [
    {
      runId: "run-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
      eventOffset: 17,
      snapshotJson: snapshot,
      returnRecord: false,
    },
  ]);
});

test("stream append propagates persistence failure instead of detaching a background write", async () => {
  mocks.append.mockResolvedValue(2);
  mocks.progress.mockRejectedValue(new Error("snapshot unavailable"));
  await assert.rejects(
    durableChatRunService.appendRunEvent({
      run,
      payload: "event",
      snapshot: { reasoning: "retained" },
    }),
    /snapshot unavailable/,
  );
});

test("heartbeat preserves the narrow receipt and missing/terminal acknowledgement", async () => {
  const receipt = {
    status: "cancel_requested",
    errorCode: null,
    errorMessage: null,
    heartbeatAt: "2026-10-16T00:00:00Z",
    updatedAt: "2026-10-16T00:00:00Z",
  };
  mocks.heartbeat.mockResolvedValueOnce(receipt).mockResolvedValueOnce(null);
  assert.equal(await durableChatRunService.heartbeat(run), receipt);
  assert.equal(await durableChatRunService.heartbeat(run), null);
  assert.deepEqual(mocks.heartbeat.mock.calls[0], [
    { runId: "run-1", teamId: "team-1", workspaceId: "workspace-1" },
  ]);
});
