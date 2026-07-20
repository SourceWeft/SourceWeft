import assert from "node:assert/strict";
import { test } from "vitest";

import { createDeliverableSandboxAdapter } from "./sandbox-session";
import type { DeliverableJobEnvelope } from "@sourceweft/capability-contracts";

const job = {
  jobId: "job-1",
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  userId: "user-1",
  userMessageId: "message-1",
  toolCallId: "tool-call-1",
  traceId: "trace-1",
} as unknown as DeliverableJobEnvelope;

function createSandboxServiceSpy() {
  const requests: Array<Record<string, unknown>> = [];
  const executeCalls: Array<[string, unknown]> = [];
  return {
    requests,
    executeCalls,
    service: {
      createRuntimeForTurn(input: Record<string, unknown>) {
        requests.push(input);
        return {
          pathPolicy: { defaultCwd: "/workspace/" },
          backend: {
            async uploadFiles() {
              return [];
            },
            async execute(command: string, options?: unknown) {
              executeCalls.push([command, options]);
              return { exitCode: 0, output: "", truncated: false };
            },
            async downloadFiles() {
              return [];
            },
          },
        };
      },
    },
  };
}

test("deliverable sandbox sessions run on the batch command budget", async () => {
  const spy = createSandboxServiceSpy();
  const adapter = createDeliverableSandboxAdapter({
    sandboxService: spy.service as never,
  });

  await adapter.createSession({ job });

  assert.equal(spy.requests.length, 1);
  assert.equal(spy.requests[0]?.commandBudget, "batch");
});

test("pipelines cannot pick a command timeout per command", async () => {
  const spy = createSandboxServiceSpy();
  const adapter = createDeliverableSandboxAdapter({
    sandboxService: spy.service as never,
  });

  const session = await adapter.createSession({ job });
  assert.ok(session);
  // A pipeline forging extra execute options changes nothing: the session
  // forwards only the command and its tool call id, and the timeout was already
  // fixed when the runtime was built. The same narrowing is what keeps the
  // budget out of reach of model-authored tool input.
  await session.execute("npm ci", {
    toolCallId: "tool-call-1",
    commandBudget: "interactive",
    timeoutMs: 1,
  } as never);

  assert.deepEqual(spy.executeCalls, [
    ["npm ci", { toolCallId: "tool-call-1" }],
  ]);
});
