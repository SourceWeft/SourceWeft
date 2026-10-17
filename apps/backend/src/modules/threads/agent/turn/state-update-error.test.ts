import assert from "node:assert/strict";
import { test } from "vitest";
import { InvalidUpdateError } from "@langchain/langgraph";
import { ContentError } from "../../../content/errors";
import { agentStateUpdateError } from "./state-update-error";

test("native graph conflicts are private internal failures, not generated tool argument errors", () => {
  const raw = new InvalidUpdateError(
    "LastValue kwargs private-history repeated update",
  );
  const failure = agentStateUpdateError(new Error("wrapped", { cause: raw }));
  assert.equal(failure?.code, "AGENT_STATE_UPDATE_CONFLICT");
  assert.equal(failure?.statusCode, 500);
  assert.doesNotMatch(
    failure!.message,
    /kwargs|private-history|Provider|tool arguments/i,
  );
  assert.doesNotMatch(JSON.stringify(failure), /kwargs|private-history/);
});

test("existing cancellation, payment and summary errors keep priority", () => {
  const raw = new InvalidUpdateError("kwargs");
  for (const code of [
    "CLIENT_CANCELLED",
    "CREDITS_REQUIRED",
    "AGENT_STEP_SUMMARY_FAILED",
  ]) {
    const protectedFailure = new ContentError(500, code, "protected");
    Object.defineProperty(protectedFailure, "cause", { value: raw });
    assert.equal(agentStateUpdateError(protectedFailure), null);
  }
});

test("ordinary tool/provider errors and cyclic wrappers are not reclassified by message text", () => {
  assert.equal(
    agentStateUpdateError(
      new Error("Invalid input: expected kwargs object received undefined"),
    ),
    null,
  );
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(agentStateUpdateError(cycle), null);
});
