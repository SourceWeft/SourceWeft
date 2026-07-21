import assert from "node:assert/strict";
import type { BackendProtocolV2 } from "deepagents";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import type { DiscoveredCapabilityRecord } from "@sourceweft/capability-runtime";
import type { SandboxProviderConfigurationStatus } from "@sourceweft/builtin-tool-sandbox";
import { config } from "../../../../shared/config";
import { logger } from "../../../../shared/logger";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import {
  createSyntheticSandboxProviderFactory,
  createSyntheticSandboxProviderRecord,
  SYNTHETIC_SANDBOX_MISSING_CONFIG,
  SYNTHETIC_SANDBOX_PROVIDER_ID,
} from "../../../../test/synthetic-capability";
import { agentSandboxService } from "./service";
import { initializeSandboxProviderRegistry } from "./provider-registry";

/**
 * The sandbox service driven by a synthetic provider.
 *
 * This used to configure `config.sandbox.daytona.*` and assert on
 * `DAYTONA_SANDBOX_SNAPSHOT` in the startup warning — a host test that only
 * passed because one particular capability was installed, and that broke
 * whenever that capability's configuration changed. What is host behaviour is
 * everything below: selection by id, the errors raised when the selected id is
 * unregistered or unconfigured, tool binding, HITL interrupts, and the shape of
 * the startup warning. Which env vars Daytona needs is Daytona's test to write,
 * and it already does in `packages/sandbox-provider-daytona/tests`.
 */

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

const configuredStatus = createSyntheticSandboxProviderFactory()
  .getConfigurationStatus() as SandboxProviderConfigurationStatus;
const unconfiguredStatus = createSyntheticSandboxProviderFactory({
  configured: false,
}).getConfigurationStatus() as SandboxProviderConfigurationStatus;

/**
 * The provider's readiness is swapped per test rather than the provider
 * itself: discovery is memoised for the life of the process, which is the
 * behaviour the host relies on, so re-discovering per test would be testing a
 * registry no deployment ever has.
 */
let providerStatus: SandboxProviderConfigurationStatus = configuredStatus;

const syntheticFactory = {
  ...createSyntheticSandboxProviderFactory(),
  getConfigurationStatus: () => providerStatus,
};

beforeAll(async () => {
  await initializeSandboxProviderRegistry({
    recordsProvider: async () => [
      createSyntheticSandboxProviderRecord() as unknown as DiscoveredCapabilityRecord,
    ],
    loadModule: async () => ({
      createSandboxProviderFactories: () => [syntheticFactory],
    }),
  });
});

describe("AgentSandboxService", () => {
  beforeEach(() => {
    providerStatus = configuredStatus;
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
    config.sandbox.enabled = true;
    config.sandbox.toolApprovalEnabled = false;
    config.sandbox.provider = SYNTHETIC_SANDBOX_PROVIDER_ID;
  });

  afterEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
    vi.restoreAllMocks();
  });

  test("returns null when sandbox is disabled", async () => {
    config.sandbox.enabled = false;

    assert.equal(
      await agentSandboxService.createRuntimeForTurn({ filesystem, context }),
      null,
    );
  });

  test("throws when selected provider is not registered", async () => {
    config.sandbox.provider = "unknown-provider";

    await assert.rejects(
      agentSandboxService.createRuntimeForTurn({ filesystem, context }),
      /registered provider/u,
    );
  });

  test("throws when selected provider config is missing", async () => {
    providerStatus = unconfiguredStatus;

    await assert.rejects(
      agentSandboxService.createRuntimeForTurn({ filesystem, context }),
      new RegExp(
        `complete '${SYNTHETIC_SANDBOX_PROVIDER_ID}' provider configuration`,
        "u",
      ),
    );
  });

  test("wraps the backend and binds sandbox transfer tools without HITL interrupts by default", async () => {
    const runtime = await agentSandboxService.createRuntimeForTurn({
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

  test("binds sandbox HITL interrupts when tool approval is enabled", async () => {
    config.sandbox.toolApprovalEnabled = true;
    const runtime = await agentSandboxService.createRuntimeForTurn({
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

  test("runtime prompt includes default sandbox environment summary", async () => {
    const runtime = await agentSandboxService.createRuntimeForTurn({
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

  test("logStartupWarning reports provider-generic configuration state", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await agentSandboxService.logStartupWarning("api");

    assert.equal(warn.mock.calls.length, 1);
    const metadata = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    assert.equal(metadata.provider, SYNTHETIC_SANDBOX_PROVIDER_ID);
    assert.equal(metadata.providerConfigured, true);
    assert.deepEqual(metadata.providerMissingConfig, []);
    assert.equal(metadata.toolApprovalEnabled, false);
  });

  test("logStartupWarning warns when provider configuration is incomplete", async () => {
    providerStatus = unconfiguredStatus;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await agentSandboxService.logStartupWarning("worker");

    assert.equal(warn.mock.calls.length, 2);
    const startupMetadata = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    const incompleteMetadata = warn.mock.calls[1]?.[1] as Record<string, unknown>;
    assert.equal(startupMetadata.providerConfigured, false);
    assert.equal(startupMetadata.toolApprovalEnabled, false);
    assert.deepEqual(startupMetadata.providerMissingConfig, [
      SYNTHETIC_SANDBOX_MISSING_CONFIG,
    ]);
    assert.equal(
      warn.mock.calls[1]?.[0],
      "Sandbox runtime is enabled but provider configuration is incomplete",
    );
    assert.deepEqual(incompleteMetadata.missing, [
      SYNTHETIC_SANDBOX_MISSING_CONFIG,
    ]);
  });

  test("logStartupWarning reports a selected provider no capability supplies", async () => {
    config.sandbox.provider = "unknown-provider";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await agentSandboxService.logStartupWarning("api");

    const startupMetadata = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    assert.equal(startupMetadata.providerConfigured, false);
    assert.deepEqual(startupMetadata.providerMissingConfig, [
      "provider:unknown-provider",
    ]);
  });

  test("warnIfHitlBypassed warns when execute interrupt is missing", async () => {
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

  test("warnIfHitlBypassed stays quiet when sandbox tool approval is disabled", async () => {
    config.sandbox.toolApprovalEnabled = false;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    agentSandboxService.warnIfHitlBypassed({
      interruptOn: {},
      boundSandboxToolNames: [AGENT_TOOL_NAMES.prepareSandboxWorkspace],
    });

    assert.equal(warn.mock.calls.length, 0);
  });

  test("warnIfHitlBypassed stays quiet when sandbox interrupts are present", async () => {
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
