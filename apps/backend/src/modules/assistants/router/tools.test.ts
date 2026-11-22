import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { toObservationError } from "../../threads/stream/observability";
import { resolveRouterToolsContext } from "./tools";
import { resolveWorkerToolsContext } from "../worker/tools";

const ctx = {
  workspaceId: randomUUID(),
  teamId: randomUUID(),
  threadId: randomUUID(),
  runId: randomUUID(),
  userId: randomUUID(),
  hostContext: {},
};

test("a Router or Worker turn that cannot be set up fails as CHAT_RUN_FAILED, never as an upstream model error", async () => {
  for (const resolve of [resolveRouterToolsContext, resolveWorkerToolsContext]) {
    await assert.rejects(
      () => resolve(ctx),
      (error: unknown) => {
        assert.match(String((error as Error).message), /hostContext is missing/);
        assert.equal(toObservationError(error).code, "CHAT_RUN_FAILED");
        return true;
      },
    );
  }
});
