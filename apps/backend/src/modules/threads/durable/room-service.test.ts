import assert from "node:assert/strict";
import { test } from "vitest";
import { toRunRoomFrame } from "./room-service";

test("artifact output room frames preserve the assistant message identity", () => {
  assert.deepEqual(
    toRunRoomFrame({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      kind: "artifact_output",
      runId: "run-1",
      status: "running",
      assistantMessageId: "assistant-1",
    }),
    {
      type: "run",
      kind: "artifact_output",
      runId: "run-1",
      status: "running",
      assistantMessageId: "assistant-1",
    },
  );
});
