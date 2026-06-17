import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_TOOL_LOG_EVENTS,
  sanitizeAgentToolLogMetadata,
} from "./tool-logging";

test("agent tool log metadata keeps execute failure diagnostics", () => {
  assert.deepEqual(
    sanitizeAgentToolLogMetadata(AGENT_TOOL_LOG_EVENTS.failed, {
      toolName: "execute",
      commandFingerprint: "sha256:abc",
      failureCode: "SANDBOX_EXECUTE_COMMAND_DENIED",
      repeatCount: 2,
      runId: "run-1",
      status: "error",
    }),
    {
      event: AGENT_TOOL_LOG_EVENTS.failed,
      toolName: "execute",
      commandFingerprint: "sha256:abc",
      failureCode: "SANDBOX_EXECUTE_COMMAND_DENIED",
      repeatCount: 2,
      runId: "run-1",
      status: "error",
    },
  );
});
