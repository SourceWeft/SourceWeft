import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectSandboxOutputsAgentTool,
  executeAgentTool,
  prepareSandboxWorkspaceAgentTool,
  SANDBOX_TOOL_EXECUTION_TIMEOUT_MS,
} from "../src/agent-tool-defs";

test("execute and prepare declare the acquisition-inclusive tool budget", () => {
  // 120 s command budget + 120 s acquisition budget: a cold start must not be
  // charged against the first command's own budget.
  assert.equal(SANDBOX_TOOL_EXECUTION_TIMEOUT_MS, 240_000);
  assert.equal(
    executeAgentTool.executionTimeoutMs,
    SANDBOX_TOOL_EXECUTION_TIMEOUT_MS,
  );
  assert.equal(
    prepareSandboxWorkspaceAgentTool.executionTimeoutMs,
    SANDBOX_TOOL_EXECUTION_TIMEOUT_MS,
  );
});

test("collect_sandbox_outputs keeps the host default budget", () => {
  assert.equal(
    (collectSandboxOutputsAgentTool as { executionTimeoutMs?: number })
      .executionTimeoutMs,
    undefined,
  );
});
