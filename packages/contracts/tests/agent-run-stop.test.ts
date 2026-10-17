import assert from "node:assert/strict";
import test from "node:test";
import { agentRunStopSchema, readAgentRunStop } from "../src/agent-run-stop";

const stopped = {
  reason: "step_limit",
  steps: 400,
  limit: 400,
  canContinue: true,
  summaryStatus: "completed",
} as const;

test("step-limit metadata survives JSON persistence for successful and failed summaries", () => {
  for (const summaryStatus of ["completed", "failed"] as const) {
    const value = { ...stopped, summaryStatus };
    assert.deepEqual(
      agentRunStopSchema.parse(JSON.parse(JSON.stringify(value))),
      value,
    );
  }
});

test("a public continuation marker cannot encode a false budget or private graph state", () => {
  for (const value of [
    null,
    [],
    { ...stopped, steps: 399 },
    { ...stopped, steps: 401 },
    { ...stopped, limit: 0, steps: 0 },
    { ...stopped, steps: 1.5, limit: 1.5 },
    {
      ...stopped,
      limit: Number.MAX_SAFE_INTEGER + 1,
      steps: Number.MAX_SAFE_INTEGER + 1,
    },
    { ...stopped, canContinue: false },
    { ...stopped, reason: "published" },
    { ...stopped, summaryStatus: "running" },
    { ...stopped, namespace: "private-child-scope" },
  ])
    assert.equal(readAgentRunStop(value), null);
  assert.deepEqual(readAgentRunStop(stopped), stopped);
});
