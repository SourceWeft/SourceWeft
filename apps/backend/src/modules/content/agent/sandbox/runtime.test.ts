import assert from "node:assert/strict";
import type { BackendProtocolV2 } from "deepagents";
import { afterEach, beforeEach, describe, test } from "vitest";
import { config } from "../../../../shared/config";
import { AGENT_TOOL_NAMES } from "../tool-names";
import { createSandboxRuntimeForTurn } from "./runtime";

const originalSandboxConfig = structuredClone(config.sandbox);

const filesystem = {} as BackendProtocolV2;
const context = {
  teamId: "team_runtime_test",
  workspaceId: "workspace_runtime_test",
  threadId: "thread_runtime_test",
  userId: "user_runtime_test",
  messageId: "message_runtime_test",
  runId: "run_runtime_test",
};

describe("createSandboxRuntimeForTurn", () => {
  beforeEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
    config.sandbox.enabled = true;
    config.sandbox.provider = "daytona";
    config.sandbox.daytona.apiUrl = "http://daytona-runtime-test";
    config.sandbox.daytona.apiKey = "runtime-test-key";
    config.sandbox.daytona.defaultSnapshot = "sourceweft-runtime-test";
  });

  afterEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
  });

  test("throws when sandbox is disabled", () => {
    config.sandbox.enabled = false;

    assert.throws(
      () => createSandboxRuntimeForTurn({ filesystem, context }),
      /requires Daytona sandbox runtime configuration/,
    );
  });

  test("throws when required Daytona provider config is missing", () => {
    config.sandbox.daytona.apiKey = "";

    assert.throws(
      () => createSandboxRuntimeForTurn({ filesystem, context }),
      /requires Daytona apiUrl, apiKey, and defaultSnapshot/,
    );
  });

  test("throws when Daytona default snapshot is missing", () => {
    config.sandbox.daytona.defaultSnapshot = "";

    assert.throws(
      () => createSandboxRuntimeForTurn({ filesystem, context }),
      /requires Daytona apiUrl, apiKey, and defaultSnapshot/,
    );
  });

  test("wraps the backend and binds sandbox prepare/collect tools with HITL interrupts", () => {
    const runtime = createSandboxRuntimeForTurn({ filesystem, context });

    assert.ok(runtime);
    assert.notEqual(runtime.backend, filesystem);
    assert.deepEqual(
      runtime.tools.map((tool) => tool.name).sort(),
      [
        AGENT_TOOL_NAMES.collectSandboxOutputs,
        AGENT_TOOL_NAMES.prepareSandboxWorkspace,
      ].sort(),
    );
    assert.deepEqual(
      Object.keys(runtime.interruptOn).sort(),
      [
        AGENT_TOOL_NAMES.collectSandboxOutputs,
        AGENT_TOOL_NAMES.execute,
        AGENT_TOOL_NAMES.prepareSandboxWorkspace,
      ].sort(),
    );
  });
});
