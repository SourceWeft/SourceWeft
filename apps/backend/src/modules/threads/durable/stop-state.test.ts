import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ChatThreadRunRecord, ChatThreadRunStopState } from "./types";
import { toRunStopError, toTerminalRunError } from "./run-state";

const mocks = vi.hoisted(() => ({ narrow: vi.fn(), full: vi.fn() }));
vi.mock("./repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository")>()),
  findChatThreadRunStopState: mocks.narrow,
  findChatThreadRunById: mocks.full,
}));
import { durableChatRunService } from "./service";

afterEach(() => vi.clearAllMocks());
const scope: ChatThreadRunRecord = {
  id: "run-1",
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  userId: "user-1",
  userMessageId: null,
  assistantMessageId: null,
  idempotencyKey: "test",
  mode: "send",
  jobId: null,
  streamKey: "test-stream",
  status: "running",
  eventOffset: 0,
  requestJson: {},
  snapshotJson: {},
  errorCode: null,
  errorMessage: null,
  startedAt: null,
  heartbeatAt: null,
  finishedAt: null,
  createdAt: "2026-10-16T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z",
};

const cases: Array<
  [ChatThreadRunStopState["status"], string | null, number | null]
> = [
  ["queued", "CHAT_RUN_OWNERSHIP_LOST", 409],
  ["running", null, null],
  ["cancel_requested", "CLIENT_CANCELLED", 499],
  ["waiting_for_approval", "CHAT_RUN_OWNERSHIP_LOST", 409],
  ["completed", "CHAT_RUN_OWNERSHIP_LOST", 409],
  ["failed", "CHAT_RUN_FAILED", 500],
  ["cancelled", "CLIENT_CANCELLED", 499],
];

test.each(cases)(
  "narrow stop-state preserves %s semantics without loading payloads",
  async (status, code, http) => {
    const state: ChatThreadRunStopState = {
      status,
      errorCode: null,
      errorMessage: null,
    };
    mocks.narrow.mockResolvedValue(state);
    const error = await durableChatRunService.getRunStopError(scope);
    assert.equal(error?.code ?? null, code);
    assert.equal(error?.statusCode ?? null, http);
    assert.deepEqual(mocks.narrow.mock.calls[0]?.[0], {
      runId: scope.id,
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
    });
    assert.equal(mocks.full.mock.calls.length, 0);
  },
);

test("narrow missing/inaccessible stop-state loses ownership without a full-record fallback", async () => {
  mocks.narrow.mockResolvedValue(null);
  const error = await durableChatRunService.getRunStopError(scope);
  assert.equal(error?.code, "CHAT_RUN_OWNERSHIP_LOST");
  assert.equal(error?.statusCode, 409);
  assert.equal(mocks.full.mock.calls.length, 0);
  assert.equal(toRunStopError(null)?.code, "CHAT_RUN_OWNERSHIP_LOST");
});

test.each(["failed", "cancelled"] as const)(
  "narrow %s errors preserve persisted code/message and existing nullish behavior",
  (status) => {
    const state: ChatThreadRunStopState = {
      status,
      errorCode: "CUSTOM_ERROR",
      errorMessage: "Persisted detail",
    };
    const error = toRunStopError(state);
    assert.equal(error?.code, "CUSTOM_ERROR");
    assert.equal(error?.message, "Persisted detail");
    assert.equal(toTerminalRunError(state)?.message, "Persisted detail");
    assert.equal(
      toRunStopError({ ...state, errorCode: "", errorMessage: "" })?.message,
      "",
    );
  },
);

test("every stop check observes the latest state instead of caching a previous running result", async () => {
  mocks.narrow
    .mockResolvedValueOnce({
      status: "running",
      errorCode: null,
      errorMessage: null,
    })
    .mockResolvedValueOnce({
      status: "cancel_requested",
      errorCode: "IGNORED",
      errorMessage: "ignored",
    });
  assert.equal(await durableChatRunService.shouldCancel(scope), false);
  assert.equal(await durableChatRunService.shouldCancel(scope), true);
  assert.equal(mocks.narrow.mock.calls.length, 2);
  assert.equal(mocks.full.mock.calls.length, 0);
});
