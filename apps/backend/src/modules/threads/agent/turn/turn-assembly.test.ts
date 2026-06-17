import assert from "node:assert/strict";
import type { BackendProtocolV2, SandboxBackendProtocolV2 } from "deepagents";
import { afterEach, beforeEach, describe, test } from "vitest";
import { config } from "../../../../shared/config";
import type { PreparedThreadTurn } from "../..";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { SelectedSkillsBackend } from "../../../skills/backend";
import type { FilesystemBackend, ToolCollection } from "./turn-assembly";
import {
  buildAgentBackend,
  buildAgentBackendFactory,
  buildRuntimePromptContext,
  buildSandboxRuntimeForPreparedTurn,
} from "./turn-assembly";

const originalSandboxConfig = structuredClone(config.sandbox);

const filesystemBackend = {
  backend: {} as BackendProtocolV2,
  knowledgeBackend: stubBackend("kb") as never,
  workingFilesBackend: stubBackend("work") as never,
  filesystemMounts: [],
  skillsBackend: null,
} as unknown as FilesystemBackend;

const emptyToolCollection = {
  webTools: [],
  artifactTools: [],
  presentationTools: [],
  videoPresentationTools: [],
  mcpTools: [],
} as unknown as ToolCollection;

function stubBackend(label: string): BackendProtocolV2 {
  return {
    ls: async (path) => ({ files: [{ path, is_dir: true }] }),
    read: async (path) => ({ content: `${label}:read:${path}` }),
    readRaw: async (path) => ({
      data: {
        content: `${label}:raw:${path}`,
        mimeType: "text/plain",
        created_at: "",
        modified_at: "",
      },
    }),
    grep: async (_pattern, path) => ({
      matches: [{ path: `${path ?? "/"}/match.txt`, line: 1, text: label }],
    }),
    glob: async (_pattern, path) => ({
      files: [{ path: `${path ?? "/"}/glob.txt`, is_dir: false }],
    }),
    write: async (path) => ({ path, filesUpdate: null }),
    edit: async (path) => ({ path, filesUpdate: null, occurrences: 1 }),
    downloadFiles: async (paths) =>
      paths.map((path) => ({
        path,
        content: new TextEncoder().encode(`${label}:download:${path}`),
        error: null,
      })),
    uploadFiles: async (files) =>
      files.map(([path]) => ({ path, error: null })),
  };
}

function stubSandboxBackend(input: {
  executeCalls?: Array<{ command: string; toolCallId?: string | null }>;
} = {}): SandboxBackendProtocolV2 {
  return {
    ...stubBackend("sandbox"),
    id: "sandbox-test",
    execute: async (
      command: string,
      options?: { toolCallId?: string | null },
    ) => {
      input.executeCalls?.push({
        command,
        toolCallId: options?.toolCallId,
      });
      return {
        output: `executed:${command}`,
        exitCode: 0,
        truncated: false,
      };
    },
  };
}

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
    effectiveTools: {},
    runtimeTools: {},
    generateImageTool: undefined,
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
    mcpInstallIds: [],
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

test("agent backend routes VFS paths while execute stays on sandbox default", async () => {
  const backend = buildAgentBackend({
    filesystemBackend: {
      backend: stubBackend("mounted") as never,
      knowledgeBackend: stubBackend("kb") as never,
      workingFilesBackend: stubBackend("work") as never,
      filesystemMounts: [],
      skillsBackend: stubBackend("skills") as never,
    },
    sandboxRuntime: {
      backend: stubSandboxBackend() as never,
      tools: [],
      interruptOn: {},
      downloadFile: async () => Buffer.from(""),
      buildRuntimePrompt: () => "",
    },
  });

  assert.deepEqual(
    await (backend as SandboxBackendProtocolV2).execute(
      "node /workspace/ppt-deck/a.js",
    ),
    {
      output: "executed:node /workspace/ppt-deck/a.js",
      exitCode: 0,
      truncated: false,
    },
  );

  assert.equal(
    (await backend.read("/workspace/ppt-deck/a.txt")).content,
    "sandbox:read:/workspace/ppt-deck/a.txt",
  );
  assert.equal(
    (await backend.read("/workfiles/notes.md")).content,
    "work:read:/workfiles/notes.md",
  );
  assert.equal(
    (await backend.read("/kb/source.md")).content,
    "kb:read:/kb/source.md",
  );
  assert.equal(
    (await backend.read("/skills/ppt-deck/SKILL.md")).content,
    "skills:read:/ppt-deck/SKILL.md",
  );
});

test("agent backend factory passes runtime tool call id to sandbox execute", async () => {
  const executeCalls: Array<{ command: string; toolCallId?: string | null }> = [];
  const factory = buildAgentBackendFactory({
    filesystemBackend: {
      backend: stubBackend("mounted") as never,
      knowledgeBackend: stubBackend("kb") as never,
      workingFilesBackend: stubBackend("work") as never,
      filesystemMounts: [],
      skillsBackend: null,
    },
    sandboxRuntime: {
      backend: stubSandboxBackend({ executeCalls }) as never,
      tools: [],
      interruptOn: {},
      downloadFile: async () => Buffer.from(""),
      buildRuntimePrompt: () => "",
    },
  });
  const backend = await factory({
    state: {},
    toolCallId: "call-runtime-execute",
  } as never);

  assert.deepEqual(
    await (backend as SandboxBackendProtocolV2).execute(
      "node /workspace/ppt-deck/a.js",
    ),
    {
      output: "executed:node /workspace/ppt-deck/a.js",
      exitCode: 0,
      truncated: false,
    },
  );
  assert.deepEqual(executeCalls, [
    {
      command: "node /workspace/ppt-deck/a.js",
      toolCallId: "call-runtime-execute",
    },
  ]);
});

test("agent backend exposes selected skills through the DeepAgents skills mount", async () => {
  const skillMarkdown = `---
name: ppt-deck
description: Create a PowerPoint deck in the sandbox.
---

# PPT Deck

Read this before creating slides.`;
  const backend = buildAgentBackend({
    filesystemBackend: {
      backend: stubBackend("mounted") as never,
      knowledgeBackend: stubBackend("kb") as never,
      workingFilesBackend: stubBackend("work") as never,
      filesystemMounts: [],
      skillsBackend: new SelectedSkillsBackend([
        {
          workspaceSkillId: "skill-ppt-deck",
          sourceType: "builtin",
          name: "ppt-deck",
          version: "1.0.0",
          description: "Create a PowerPoint deck in the sandbox.",
          files: [
            {
              path: "SKILL.md",
              contentText: skillMarkdown,
              mimeType: "text/markdown",
              sizeBytes: Buffer.byteLength(skillMarkdown, "utf8"),
              contentHash: "hash-ppt-deck-skill",
            },
          ],
        },
      ]),
    },
    sandboxRuntime: {
      backend: stubSandboxBackend() as never,
      tools: [],
      interruptOn: {},
      downloadFile: async () => Buffer.from(""),
      buildRuntimePrompt: () => "",
    },
  });

  assert.deepEqual((await backend.ls("/skills")).files, [
    { path: "/skills/ppt-deck/", is_dir: true },
  ]);
  assert.equal(
    (await backend.read("/skills/ppt-deck/SKILL.md")).content,
    skillMarkdown,
  );
});

describe("sandbox runtime assembly tool permissions", () => {
  beforeEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
    config.sandbox.enabled = true;
    config.sandbox.provider = "daytona";
    config.sandbox.daytona.apiUrl = "http://daytona-turn-assembly-test";
    config.sandbox.daytona.apiKey = "turn-assembly-test-key";
    config.sandbox.daytona.snapshot = "sourceweft-runtime-test";
    config.sandbox.daytona.image = "";
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
      prompt.includes("commands use provider sandbox filesystem paths"),
      true,
    );
    assert.equal(
      prompt.includes(
        "/workfiles, /kb, and /skills inside execute are provider sandbox filesystem paths only",
      ),
      true,
    );
    assert.equal(prompt.includes("Provider sandbox prepare targets:"), true);
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
      prompt.includes("persists explicitly selected sandbox text outputs"),
      false,
    );
  });
});
