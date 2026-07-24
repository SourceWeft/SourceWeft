import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const findThreadRecordMock = vi.fn();

// Only the thread lookup is stubbed; the visibility decision (`canViewThread`)
// stays real so the test exercises the actual authorization rule.
vi.mock("../thread/repository", async (importActual) => {
  const actual = await importActual<typeof import("../thread/repository")>();
  return {
    ...actual,
    findThreadRecord: (input: unknown) => findThreadRecordMock(input),
  };
});

const { isRunThreadViewable } = await import("./run-results");

const context = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  userId: "viewer-1",
};

beforeEach(() => {
  findThreadRecordMock.mockReset();
});

test("run initiator may follow their own run without a thread lookup", async () => {
  const viewable = await isRunThreadViewable(context, { userId: "viewer-1" });

  assert.equal(viewable, true);
  assert.equal(findThreadRecordMock.mock.calls.length, 0);
});

test("another member may follow a run on a workspace-visible thread", async () => {
  findThreadRecordMock.mockResolvedValue({
    visibility: "workspace",
    createdBy: "owner-1",
  });

  const viewable = await isRunThreadViewable(context, { userId: "owner-1" });

  assert.equal(viewable, true);
});

test("another member may not follow a run on someone else's private thread", async () => {
  findThreadRecordMock.mockResolvedValue({
    visibility: "private",
    createdBy: "owner-1",
  });

  const viewable = await isRunThreadViewable(context, { userId: "owner-1" });

  assert.equal(viewable, false);
});

test("a missing thread is never viewable", async () => {
  findThreadRecordMock.mockResolvedValue(null);

  const viewable = await isRunThreadViewable(context, { userId: "owner-1" });

  assert.equal(viewable, false);
});
