import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { isGroundedModelTimeout } from "@sourceweft/contracts/grounded-generation";
import { ModelGatewayError } from "../../shared/model-gateway/index";
import { createGroundedModelPort } from "./model-port";

const call = {
  operation: "table.fill",
  idempotencyKey: "table:art_1:v1:a:g0",
  referenceId: "artifact:art_1",
  system: "s",
  user: "u",
  schema: { name: "n", description: "d", schema: {} },
  maxTokens: 100,
};

function portFailingWith(failure: unknown) {
  return createGroundedModelPort({
    billing: {} as never,
    teamId: "t",
    workspaceId: "w",
    actorUserId: "u",
    scopeId: "j",
    complete: vi.fn().mockRejectedValue(failure),
  });
}

test("a call that timed out on every target becomes a GroundedModelTimeoutError", async () => {
  // As the gateway surfaces it after a single target: the fetch's own abort.
  const raw = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  // As it surfaces after failover, already classified.
  const classified = new ModelGatewayError({ code: "TIMEOUT", message: "timed out" });
  for (const failure of [raw, classified]) {
    await assert.rejects(portFailingWith(failure).completeStructured(call), (error: unknown) => {
      assert.ok(isGroundedModelTimeout(error));
      assert.equal((error as Error).cause, failure);
      assert.match((error as Error).message, /timed out|due to timeout/);
      return true;
    });
  }
});

test("other gateway failures pass through unchanged", async () => {
  const upstream = new ModelGatewayError({ code: "UPSTREAM", message: "502" });
  await assert.rejects(
    portFailingWith(upstream).completeStructured(call),
    (error) => error === upstream,
  );
});
