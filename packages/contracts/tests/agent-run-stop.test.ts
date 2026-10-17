import assert from "node:assert/strict";
import test from "node:test";
import {
  agentRunStopSchema,
  readAgentRunStop,
  readAgentRunProgress,
  advanceAgentRunProgress,
} from "../src/agent-run-stop";

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

const closing = {
  policyVersion: 2,
  phase: "closing",
  normalSteps: 400,
  normalLimit: 400,
  closingSteps: 1,
  closingLimit: 40,
  steps: 401,
  limit: 440,
} as const;
test("segmented stops require full coherent exhaustion and preserve legacy shapes", () => {
  const stop = {
    ...closing,
    reason: "step_limit",
    canContinue: true,
    summaryStatus: "completed",
    closingSteps: 40,
    steps: 440,
  };
  const { phase: _phase, ...value } = stop;
  assert.deepEqual(readAgentRunStop(value), value);
  for (const invalid of [
    { ...value, closingSteps: 39, steps: 439 },
    { ...value, steps: 400 },
    { ...value, policyVersion: 3 },
    { ...value, normalLimit: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.equal(readAgentRunStop(invalid), null);
  }
  assert.deepEqual(readAgentRunStop(stopped), stopped);
});
test("progress validates stage boundaries, counters and public fields", () => {
  assert.deepEqual(readAgentRunProgress(closing), closing);
  assert.ok(
    readAgentRunProgress({
      ...closing,
      phase: "working",
      closingSteps: 0,
      steps: 400,
    }),
  );
  assert.ok(
    readAgentRunProgress({
      ...closing,
      phase: "finalizing",
      closingSteps: 40,
      steps: 440,
    }),
  );
  for (const value of [
    { ...closing, phase: "working" },
    { ...closing, normalSteps: 399, steps: 400 },
    { ...closing, phase: "finalizing" },
    { ...closing, steps: 402 },
    { ...closing, closingSteps: -1 },
    { ...closing, namespace: "private" },
    { ...closing, canContinue: true },
  ]) {
    assert.equal(readAgentRunProgress(value), null);
  }
});
test("progress never regresses phase, counters or snapshotted limits", () => {
  assert.deepEqual(advanceAgentRunProgress(null, closing), closing);
  assert.deepEqual(
    advanceAgentRunProgress(closing, {
      ...closing,
      closingSteps: 0,
      steps: 400,
    }),
    closing,
  );
  assert.deepEqual(
    advanceAgentRunProgress(closing, {
      ...closing,
      closingLimit: 50,
      limit: 450,
    }),
    closing,
  );
  const next = { ...closing, closingSteps: 2, steps: 402 };
  assert.deepEqual(advanceAgentRunProgress(closing, next), next);
});
