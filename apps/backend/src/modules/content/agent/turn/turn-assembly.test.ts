import assert from "node:assert/strict";
import type { BackendProtocolV2 } from "deepagents";
import { afterEach, beforeEach, describe, test } from "vitest";
import { config } from "../../../../shared/config";
import type { PreparedThreadTurn } from "../../threads";
import { AGENT_TOOL_NAMES } from "../tool-registry";
import type { FilesystemBackend, ToolCollection } from "./turn-assembly";
import {
  buildRuntimePromptContext,
  buildSandboxRuntimeForPreparedTurn,
} from "./turn-assembly";

const originalSandboxConfig = structuredClone(config.sandbox);

const filesystemBackend = {
  backend: {} as BackendProtocolV2,
  filesystemMounts: {},
  skillsBackend: null,
} as FilesystemBackend;

const emptyToolCollection = {
  webTools: [],
  artifactTools: [],
  presentationTools: [],
  videoPresentationTools: [],
  mcpTools: [],
} as unknown as ToolCollection;

function createPreparedTurn(
  toolPermissions: PreparedThreadTurn["toolPermissions"] = {},
): PreparedThreadTurn {
  return {
    userId: "user_turn_assembly_test",
    workspace: {
      id: "workspace_turn_assembly_test",
      organizationId: "team_turn_assembly_test",
    },
    thread: { id: "thread_turn_assembly_test" },
    messageContent: "test",
    messageContentJson: { type: "text", text: "test" },
    imageParts: [],
    preflightBilling: [],
    preflightThinkingSteps: [],
    agentMessageContent: "test",
    mentionedSourceIds: [],
    effectiveMentionedSourceIds: [],
    selectedSourceIds: [],
    sourceIds: [],
    sourceScope: {
      requestedSourceIds: [],
      effectiveSourceIds: [],
      selectedDirectoryIds: [],
      expandedDescendantSourceIds: [],
    },
    skillIds: [],
    invokedSkillIds: [],
    selectedSkillIds: [],
    webSearchEnabled: false,
    notionTools: {},
    mcpTools: {},
    command: null,
    invocation: null,
    commandSuccessCriteria: { kind: "none" },
    toolPermissions,
    generateImageTool: undefined,
    generatePptxTool: undefined,
    generateVideoPresentationTool: undefined,
    artifactIntent: { kind: "none" },
    imageProfile: null,
    timezone: "UTC",
    enabledSkills: [],
    userMessage: { id: "message_turn_assembly_test", metadata: {} },
    runTraceId: "run_turn_assembly_test",
    createdUserMessage: true,
    assistantMessageParentId: null,
    assistantMessageId: null,
    profileAlias: "test-profile",
    modelAlias: "test-model",
    providerModel: "test-provider-model",
    chatProfile: {
      gatewayConfigId: "gateway_turn_assembly_test",
      configJson: {},
    },
    llm: undefined,
    llmIdempotencyKey: "llm_turn_assembly_test",
    agentMode: "continue",
    agentBaseCheckpoint: null,
    agentRunThreadId: "agent_run_turn_assembly_test",
    toolApprovalResume: null,
    traceContinuation: null,
    isFirstAssistantResponse: true,
    isFirstAssistantAttempt: true,
    initialTitle: "Test",
    failurePersistence: "persist-error-turn",
  } as unknown as PreparedThreadTurn;
}

async function promptFor(prepared: PreparedThreadTurn) {
  const sandboxRuntime = buildSandboxRuntimeForPreparedTurn({
    prepared,
    filesystemBackend,
  });
  const promptContext = await buildRuntimePromptContext({
    prepared,
    toolCollection: emptyToolCollection,
    sandboxRuntime,
  });
  return { sandboxRuntime, prompt: promptContext.runtimePrompt };
}

function toolNames(
  runtime: NonNullable<ReturnType<typeof buildSandboxRuntimeForPreparedTurn>>,
) {
  return runtime.tools.map((tool) => tool.name).sort();
}

describe("sandbox runtime assembly tool permissions", () => {
  beforeEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
    config.sandbox.enabled = true;
    config.sandbox.provider = "daytona";
    config.sandbox.daytona.apiUrl = "http://daytona-turn-assembly-test";
    config.sandbox.daytona.apiKey = "turn-assembly-test-key";
    config.sandbox.daytona.defaultSnapshot = "sourceweft-runtime-test";
  });

  afterEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
  });

  test("denied execute disables sandbox backend and prompt rules", async () => {
    const { sandboxRuntime, prompt } = await promptFor(
      createPreparedTurn({ [AGENT_TOOL_NAMES.execute]: "deny" }),
    );

    assert.equal(sandboxRuntime, null);
    assert.equal(prompt.includes("<sandbox_rules>"), false);
    assert.equal(
      prompt.includes(AGENT_TOOL_NAMES.prepareSandboxWorkspace),
      false,
    );
    assert.equal(prompt.includes(AGENT_TOOL_NAMES.execute), false);
    assert.equal(
      prompt.includes(AGENT_TOOL_NAMES.collectSandboxOutputs),
      false,
    );
  });

  test("denied prepare omits prepare tool and prepare prompt instruction", async () => {
    const { sandboxRuntime, prompt } = await promptFor(
      createPreparedTurn({
        [AGENT_TOOL_NAMES.prepareSandboxWorkspace]: "deny",
      }),
    );

    assert.ok(sandboxRuntime);
    assert.deepEqual(toolNames(sandboxRuntime), [
      AGENT_TOOL_NAMES.collectSandboxOutputs,
    ]);
    assert.equal(prompt.includes("<sandbox_rules>"), true);
    assert.equal(prompt.includes(AGENT_TOOL_NAMES.execute), true);
    assert.equal(prompt.includes(AGENT_TOOL_NAMES.collectSandboxOutputs), true);
    assert.equal(
      prompt.includes(AGENT_TOOL_NAMES.prepareSandboxWorkspace),
      false,
    );
    assert.equal(
      prompt.includes(
        "Do not pass /work or /kb paths directly to execute",
      ),
      true,
    );
  });

  test("denied collect omits collect tool and collect prompt instruction", async () => {
    const { sandboxRuntime, prompt } = await promptFor(
      createPreparedTurn({ [AGENT_TOOL_NAMES.collectSandboxOutputs]: "deny" }),
    );

    assert.ok(sandboxRuntime);
    assert.deepEqual(toolNames(sandboxRuntime), [
      AGENT_TOOL_NAMES.prepareSandboxWorkspace,
    ]);
    assert.equal(prompt.includes("<sandbox_rules>"), true);
    assert.equal(prompt.includes(AGENT_TOOL_NAMES.execute), true);
    assert.equal(
      prompt.includes(AGENT_TOOL_NAMES.prepareSandboxWorkspace),
      true,
    );
    assert.equal(
      prompt.includes(AGENT_TOOL_NAMES.collectSandboxOutputs),
      false,
    );
    assert.equal(
      prompt.includes("copies selected sandbox outputs back to /work"),
      false,
    );
  });
});
