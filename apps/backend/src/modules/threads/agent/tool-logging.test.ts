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
      failureHint:
        "Use a non-empty command without NUL bytes or unsafe control characters. Multiline shell commands are allowed.",
      failureMessage:
        "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.",
      repeatCount: 2,
      runId: "run-1",
      status: "error",
      error: "raw sandbox output should not be logged",
    }),
    {
      event: AGENT_TOOL_LOG_EVENTS.failed,
      toolName: "execute",
      commandFingerprint: "sha256:abc",
      failureCode: "SANDBOX_EXECUTE_COMMAND_DENIED",
      failureHint:
        "Use a non-empty command without NUL bytes or unsafe control characters. Multiline shell commands are allowed.",
      failureMessage:
        "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.",
      repeatCount: 2,
      runId: "run-1",
      status: "error",
      error: { message: "Tool execution failed." },
    },
  );
});
