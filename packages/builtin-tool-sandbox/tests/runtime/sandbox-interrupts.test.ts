import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
  EXECUTE_TOOL_NAME,
  PREPARE_SANDBOX_TOOL_NAME,
} from "@sourceweft/contracts/agent-tools";
import { createSandboxInterruptConfigs } from "../../src/runtime/sandbox-interrupts";

test("sandbox tool approval gates execute only", () => {
  const interrupts = createSandboxInterruptConfigs();

  assert.deepEqual(Object.keys(interrupts), [EXECUTE_TOOL_NAME]);
  assert.deepEqual(interrupts[EXECUTE_TOOL_NAME]?.allowedDecisions, [
    "approve",
    "edit",
    "reject",
  ]);
  assert.equal(interrupts[PREPARE_SANDBOX_TOOL_NAME], undefined);
  assert.equal(interrupts[COLLECT_SANDBOX_OUTPUTS_TOOL_NAME], undefined);
});
