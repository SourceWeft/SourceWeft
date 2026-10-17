import assert from "node:assert/strict";
import { test } from "vitest";
import {
  readMessageAgentRunStop,
  readMessageAgentRunProgress,
} from "./agent-run-continuation";
import type { MessageVersion } from "./types";

const stop = {
  reason: "step_limit",
  steps: 400,
  limit: 400,
  canContinue: true,
  summaryStatus: "completed",
};
const version: MessageVersion = {
  id: "assistant",
  content: "Partial summary",
  metadata: { agentRunStop: stop },
};
const eligible = {
  role: "assistant",
  version,
  isLatestAssistantGroup: true,
  isActiveVersion: true,
};

test("persisted valid stops display only for the latest selected assistant branch", () => {
  assert.deepEqual(readMessageAgentRunStop(eligible), stop);
  for (const change of [
    { role: "user" },
    { isLatestAssistantGroup: false },
    { isActiveVersion: false },
  ]) {
    assert.equal(readMessageAgentRunStop({ ...eligible, ...change }), null);
  }
});

test("malformed/private markers and cancelled versions never offer continuation", () => {
  for (const marker of [
    null,
    {},
    { ...stop, canContinue: false },
    { ...stop, steps: 300 },
    { ...stop, namespace: "private" },
  ]) {
    assert.equal(
      readMessageAgentRunStop({
        ...eligible,
        version: { ...version, metadata: { agentRunStop: marker } },
      }),
      null,
    );
  }
  for (const change of [
    { isCancelled: true },
    { errorCode: "CLIENT_CANCELLED" },
    { threadRun: { status: "cancelled" } },
    { metadata: { agentRunStop: stop, isCancelled: true } },
    { metadata: { agentRunStop: stop, errorCode: "CLIENT_CANCELLED" } },
  ]) {
    assert.equal(
      readMessageAgentRunStop({
        ...eligible,
        version: { ...version, ...change },
      }),
      null,
    );
  }
});

test("failed summaries retain the explicit continuation marker without claiming completed work", () => {
  const failed = { ...stop, summaryStatus: "failed" };
  assert.deepEqual(
    readMessageAgentRunStop({
      ...eligible,
      version: {
        ...version,
        isError: true,
        metadata: { agentRunStop: failed },
      },
    }),
    failed,
  );
});

test("only a currently active root assistant displays closing progress", () => {
  const progress = {
    policyVersion: 2,
    phase: "closing",
    normalSteps: 400,
    normalLimit: 400,
    closingSteps: 1,
    closingLimit: 40,
    steps: 401,
    limit: 440,
  };
  const input = {
    ...eligible,
    isRunActive: true,
    version: { ...version, metadata: { agentRunProgress: progress } },
  };
  assert.deepEqual(readMessageAgentRunProgress(input), progress);
  assert.equal(readMessageAgentRunStop(input), null);
  assert.equal(
    readMessageAgentRunProgress({ ...input, isRunActive: false }),
    null,
  );
  assert.equal(
    readMessageAgentRunProgress({ ...input, isLatestAssistantGroup: false }),
    null,
  );
  assert.equal(
    readMessageAgentRunProgress({
      ...input,
      version: { ...input.version, isCancelled: true },
    }),
    null,
  );
});

test("lagging active-run state cannot display cancelled checkpoint progress", () => {
  const progress = {
    policyVersion: 2,
    phase: "closing",
    normalSteps: 400,
    normalLimit: 400,
    closingSteps: 1,
    closingLimit: 40,
    steps: 401,
    limit: 440,
  };
  assert.equal(
    readMessageAgentRunProgress({
      ...eligible,
      isRunActive: true,
      version: {
        ...version,
        metadata: {
          agentRunProgress: progress,
          threadRun: { status: "cancelled" },
        },
      },
    }),
    null,
  );
});
