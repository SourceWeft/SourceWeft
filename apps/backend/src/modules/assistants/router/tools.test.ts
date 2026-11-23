import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { toObservationError } from "../../threads/stream/observability";
import {
  guarded,
  isRouterToolError,
  resolveRouterToolsContext,
  ROUTER_TOOL_FAILED_MESSAGE,
} from "./tools";
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

test("a Router tool that throws gives the model a fixed message, never the raw error", async () => {
  const result = await guarded("route_to_ticket", async () => {
    throw new Error('duplicate key value violates unique constraint "secret_internal_name"');
  });
  assert.ok(isRouterToolError(result));
  assert.equal(result.code, "ROUTER_TOOL_FAILED");
  assert.equal(result.message, ROUTER_TOOL_FAILED_MESSAGE);
  assert.doesNotMatch(result.message, /secret_internal_name/);
});
