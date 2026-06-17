import assert from "node:assert/strict";
import type { BackendProtocolV2 } from "deepagents";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { config } from "../../../../shared/config";
import { logger } from "../../../../shared/logger";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { agentSandboxService } from "./service";

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

describe("AgentSandboxService", () => {
  beforeEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
    config.sandbox.enabled = true;
    config.sandbox.toolApprovalEnabled = false;
    config.sandbox.provider = "daytona";
    config.sandbox.daytona.apiUrl = "http://daytona-runtime-test";
    config.sandbox.daytona.apiKey = "runtime-test-key";
    config.sandbox.daytona.snapshot = "sourceweft-runtime-test";
    config.sandbox.daytona.image = "";
  });

  afterEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
    vi.restoreAllMocks();
  });

  test("returns null when sandbox is disabled", () => {
    config.sandbox.enabled = false;

    assert.equal(
      agentSandboxService.createRuntimeForTurn({ filesystem, context }),
      null,
    );
  });

  test("throws when selected provider is not registered", () => {
    config.sandbox.provider = "unknown-provider";

    assert.throws(
      () => agentSandboxService.createRuntimeForTurn({ filesystem, context }),
      /registered provider/u,
    );
  });

  test("throws when selected provider config is missing", () => {
    config.sandbox.daytona.apiKey = "";

    assert.throws(
      () => agentSandboxService.createRuntimeForTurn({ filesystem, context }),
      /complete 'daytona' provider configuration/u,
    );
  });

  test("wraps the backend and binds sandbox transfer tools without HITL interrupts by default", () => {
    const runtime = agentSandboxService.createRuntimeForTurn({
      filesystem,
      context,
    });

    assert.ok(runtime);
    assert.notEqual(runtime.backend, filesystem);
    assert.deepEqual(
      runtime.tools.map((tool) => tool.name).sort(),
      [
        AGENT_TOOL_NAMES.collectSandboxOutputs,
        AGENT_TOOL_NAMES.prepareSandboxWorkspace,
      ].sort(),
    );
    assert.deepEqual(runtime.interruptOn, {});
  });

  test("binds sandbox HITL interrupts when tool approval is enabled", () => {
    config.sandbox.toolApprovalEnabled = true;

    const runtime = agentSandboxService.createRuntimeForTurn({
      filesystem,
      context,
    });

    assert.ok(runtime);
    assert.deepEqual(
      Object.keys(runtime.interruptOn).sort(),
      [
        AGENT_TOOL_NAMES.collectSandboxOutputs,
        AGENT_TOOL_NAMES.execute,
        AGENT_TOOL_NAMES.prepareSandboxWorkspace,
      ].sort(),
    );
  });

  test("runtime prompt includes default sandbox environment summary", () => {
    const runtime = agentSandboxService.createRuntimeForTurn({
      filesystem,
      context,
    });

    const prompt = runtime?.buildRuntimePrompt() ?? "";
    assert.match(prompt, /<sandbox_environment>/u);
    assert.match(prompt, /Node\.js 22/u);
    assert.match(prompt, /pptxgenjs/u);
    assert.match(prompt, /markitdown\[pptx\]/u);
    assert.match(prompt, /Do not run installs such as npm install pptxgenjs/u);
  });

  test("logStartupWarning reports provider-generic configuration state", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    agentSandboxService.logStartupWarning("api");

    assert.equal(warn.mock.calls.length, 1);
    const metadata = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    assert.equal(metadata.provider, "daytona");
    assert.equal(metadata.providerConfigured, true);
    assert.deepEqual(metadata.providerMissingConfig, []);
    assert.equal(metadata.toolApprovalEnabled, false);
    assert.match(JSON.stringify(metadata), /snapshotConfigured/u);
    assert.match(JSON.stringify(metadata), /targetKind/u);
  });

  test("logStartupWarning warns when provider configuration is incomplete", () => {
    config.sandbox.daytona.snapshot = "";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    agentSandboxService.logStartupWarning("worker");

    assert.equal(warn.mock.calls.length, 2);
    const startupMetadata = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    const incompleteMetadata = warn.mock.calls[1]?.[1] as Record<string, unknown>;
    assert.equal(startupMetadata.providerConfigured, false);
    assert.equal(startupMetadata.toolApprovalEnabled, false);
    assert.deepEqual(startupMetadata.providerMissingConfig, [
      "DAYTONA_SANDBOX_SNAPSHOT or DAYTONA_SANDBOX_IMAGE",
    ]);
    assert.equal(
      warn.mock.calls[1]?.[0],
      "Sandbox runtime is enabled but provider configuration is incomplete",
    );
    assert.deepEqual(incompleteMetadata.missing, [
      "DAYTONA_SANDBOX_SNAPSHOT or DAYTONA_SANDBOX_IMAGE",
    ]);
  });

  test("warnIfHitlBypassed warns when execute interrupt is missing", () => {
    config.sandbox.toolApprovalEnabled = true;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    agentSandboxService.warnIfHitlBypassed({
      interruptOn: {},
      boundSandboxToolNames: [AGENT_TOOL_NAMES.prepareSandboxWorkspace],
    });

    assert.equal(warn.mock.calls.length, 1);
    assert.deepEqual(warn.mock.calls[0]?.[1], {
      missingInterrupts: [
        AGENT_TOOL_NAMES.execute,
        AGENT_TOOL_NAMES.prepareSandboxWorkspace,
      ],
      boundSandboxToolNames: [AGENT_TOOL_NAMES.prepareSandboxWorkspace],
    });
  });

  test("warnIfHitlBypassed stays quiet when sandbox tool approval is disabled", () => {
    config.sandbox.toolApprovalEnabled = false;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    agentSandboxService.warnIfHitlBypassed({
      interruptOn: {},
      boundSandboxToolNames: [AGENT_TOOL_NAMES.prepareSandboxWorkspace],
    });

    assert.equal(warn.mock.calls.length, 0);
  });

  test("warnIfHitlBypassed stays quiet when sandbox interrupts are present", () => {
    config.sandbox.toolApprovalEnabled = true;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    agentSandboxService.warnIfHitlBypassed({
      interruptOn: {
        [AGENT_TOOL_NAMES.execute]: {},
        [AGENT_TOOL_NAMES.prepareSandboxWorkspace]: {},
        [AGENT_TOOL_NAMES.collectSandboxOutputs]: {},
      },
      boundSandboxToolNames: [
        AGENT_TOOL_NAMES.prepareSandboxWorkspace,
        AGENT_TOOL_NAMES.collectSandboxOutputs,
      ],
    });

    assert.equal(warn.mock.calls.length, 0);
  });
});
