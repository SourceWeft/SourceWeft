import assert from "node:assert/strict";
import { test } from "vitest";
import { agentRunStopMetadata } from "./agent-run-stop-metadata";

const stop = {
  reason: "step_limit",
  steps: 2,
  limit: 2,
  canContinue: true,
  summaryStatus: "failed",
};
test("error marker survives an omitted finish but explicit null clears it", () => {
  const error = {
    ...agentRunStopMetadata(stop),
    errorCode: "AGENT_STEP_SUMMARY_FAILED",
  };
  assert.deepEqual(
    { ...error, ...agentRunStopMetadata(undefined) }.agentRunStop,
    stop,
  );
  assert.equal({ ...error, ...agentRunStopMetadata(null) }.agentRunStop, null);
  assert.equal(
    {
      ...error,
      ...agentRunStopMetadata({ ...stop, privateNamespace: "secret" }),
    }.agentRunStop,
    null,
  );
});
test("cancellation always clears an earlier valid step-limit marker", () => {
  assert.equal(agentRunStopMetadata(stop, true).agentRunStop, null);
  assert.equal(agentRunStopMetadata(undefined, true).agentRunStop, null);
});
