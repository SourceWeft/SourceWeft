import { AgentCitationRegistry } from "../citation-registry";
import assert from "node:assert/strict";
import {
  StateBackend,
  type BackendProtocolV2,
  type SandboxBackendProtocolV2,
} from "deepagents";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { config } from "../../../../shared/config";
import type { PreparedThreadTurn } from "../..";
import type { EnabledSkillDescriptor } from "../../../skills/types";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { SelectedSkillsBackend } from "../../../skills/backend";
import { TurnSkillSandboxAssets } from "../../../skills/sandbox-assets";
import type { FilesystemBackend, ToolCollection } from "./turn-assembly";
import { initializeSandboxProviderRegistry } from "../sandbox-service/provider-registry";
import {
  createSyntheticSandboxProviderFactory,
  createSyntheticSandboxProviderRecord,
  SYNTHETIC_SANDBOX_PROVIDER_ID,
} from "../../../../test/synthetic-capability";
import {
  buildAgentBackend,
  buildRuntimePromptContext,
  buildSandboxRuntimeForPreparedTurn,
  filesystemMountsForPrompt,
  mountInstalledSkillForTurn,
} from "./turn-assembly";
import {
  createSourceWeftToolCallContextMiddleware,
  currentSourceWeftToolCallContext,
  runWithSourceWeftToolInvocationSignal,
} from "../middleware";
import { agentSandboxService } from "../sandbox-service/service";

const SANDBOX_PATH_POLICY_STUB = {
  workspaceRoot: "/workspace",
  defaultCwd: "/workspace",
  prepareTargetRoots: ["/workspace/input", "/workspace"],
  collectSourceRoots: ["/workspace/output", "/workspace"],
  readWriteRoots: ["/workspace"],
} as const;

const originalSandboxConfig = structuredClone(config.sandbox);

test("tool-call context attributes sub-agent artifact publishers", async () => {
  const middleware = createSourceWeftToolCallContextMiddleware({
    subagentType: "general-purpose",
  }) as unknown as {
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };

  const observed = await middleware.wrapToolCall(
    {
      toolCall: {
        id: "publish-call-1",
        name: "publish_artifact",
        args: {},
      },
    },
    async () => currentSourceWeftToolCallContext(),
  );

  assert.deepEqual(observed, {
    producer: { kind: "subagent", subagentType: "general-purpose" },
    toolCallId: "publish-call-1",
    toolName: "publish_artifact",
  });
});

/**
 * The sandbox tests below run against a synthetic provider supplied through the
 * capability path, not against whichever real provider happens to be
 * configured in the developer's `.env`. Turn assembly's behaviour — which tools
 * bind, what the prompt says, which mounts appear — is provider-independent,
 * and asserting it against a real provider made these tests depend on that
 * provider's credentials being present.
 */
beforeAll(async () => {
  await initializeSandboxProviderRegistry({
    recordsProvider: async () => [
      createSyntheticSandboxProviderRecord() as never,
    ],
    loadModule: async () => ({
      createSandboxProviderFactories: () => [
        createSyntheticSandboxProviderFactory(),
      ],
    }),
  });
  config.sandbox.enabled = true;
  config.sandbox.provider = SYNTHETIC_SANDBOX_PROVIDER_ID;
});

const filesystemBackend = {
  backend: {} as BackendProtocolV2,
  knowledgeBackend: stubBackend("kb") as never,
  workingFilesBackend: stubBackend("work") as never,
  filesystemMounts: [],
  skillsBackend: new SelectedSkillsBackend([]),
  skillSandboxAssets: new TurnSkillSandboxAssets(),
} as unknown as FilesystemBackend;

const emptyToolCollection = {
  skillTools: [],
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

function stubSandboxBackend(
  input: {
    executeCalls?: Array<{
      command: string;
      signal?: AbortSignal;
      toolCallId?: string | null;
    }>;
    fileCalls?: Array<{ method: string; signal?: AbortSignal }>;
  } = {},
): SandboxBackendProtocolV2 {
  return {
    ...stubBackend("sandbox"),
    id: "sandbox-test",
    ls: async (path: string, options?: { signal?: AbortSignal }) => {
      input.fileCalls?.push({ method: "ls", signal: options?.signal });
      return { files: [{ path, is_dir: true }] };
    },
    read: async (
      path: string,
      _offset?: number,
      _limit?: number,
      options?: { signal?: AbortSignal },
    ) => {
      input.fileCalls?.push({ method: "read", signal: options?.signal });
      return { content: `sandbox:read:${path}` };
    },
    readRaw: async (path: string, options?: { signal?: AbortSignal }) => {
      input.fileCalls?.push({ method: "readRaw", signal: options?.signal });
      return {
        data: {
          content: `sandbox:raw:${path}`,
          mimeType: "text/plain",
          created_at: "",
          modified_at: "",
        },
      };
    },
    grep: async (
      _pattern: string,
      path?: string | null,
      _glob?: string | null,
      _maxCount?: number | null,
      options?: { signal?: AbortSignal },
    ) => {
      input.fileCalls?.push({ method: "grep", signal: options?.signal });
      return {
        matches: [
          { path: `${path ?? "/"}/match.txt`, line: 1, text: "sandbox" },
        ],
      };
    },
    glob: async (
      _pattern: string,
      path?: string,
      options?: { signal?: AbortSignal },
    ) => {
      input.fileCalls?.push({ method: "glob", signal: options?.signal });
      return { files: [{ path: `${path ?? "/"}/glob.txt`, is_dir: false }] };
    },
    write: async (
      path: string,
      _content: string,
      options?: { signal?: AbortSignal },
    ) => {
      input.fileCalls?.push({ method: "write", signal: options?.signal });
      return { path, filesUpdate: null };
    },
    edit: async (
      path: string,
      _oldString: string,
      _newString: string,
      _replaceAll?: boolean,
      options?: { signal?: AbortSignal },
    ) => {
      input.fileCalls?.push({ method: "edit", signal: options?.signal });
      return { path, filesUpdate: null, occurrences: 1 };
    },
    uploadFiles: async (
      files: Array<[string, Uint8Array]>,
      options?: { signal?: AbortSignal },
    ) => {
      input.fileCalls?.push({ method: "uploadFiles", signal: options?.signal });
      return files.map(([path]) => ({ path, error: null }));
    },
    downloadFiles: async (
      paths: string[],
      options?: { signal?: AbortSignal },
    ) => {
      input.fileCalls?.push({
        method: "downloadFiles",
        signal: options?.signal,
      });
      return paths.map((path) => ({
        path,
        content: new TextEncoder().encode(`sandbox:download:${path}`),
        error: null,
      }));
    },
    execute: async (
      command: string,
      options?: { signal?: AbortSignal; toolCallId?: string | null },
    ) => {
      input.executeCalls?.push({
        command,
        ...(options?.signal ? { signal: options.signal } : {}),
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
    webAccessEnabled: false,
    notionTools: {},
    mcpTools: {},
    command: null,
    invocation: null,
    commandSuccessCriteria: { kind: "none" },
    toolPermissions,
    effectiveTools: {},
    runtimeTools: {},
    turnState: {},
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
    persona: null,
  } as unknown as PreparedThreadTurn;
}

async function promptFor(prepared: PreparedThreadTurn) {
  const sandboxRuntime = await buildSandboxRuntimeForPreparedTurn({
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
  runtime: NonNullable<
    Awaited<ReturnType<typeof buildSandboxRuntimeForPreparedTurn>>
  >,
) {
  return runtime.tools.map((tool) => tool.name).sort();
}

test("agent backend preserves Deep Agents context paths without a sandbox", async () => {
  const workingWrites: string[] = [];
  const workingBackend = {
    ...stubBackend("work"),
    write: async (path: string) => {
      workingWrites.push(path);
      return { path, filesUpdate: null };
    },
  } satisfies BackendProtocolV2;
  const backend = buildAgentBackend({
    filesystemBackend: {
      citationRegistry: new AgentCitationRegistry({ workspaceId: "workspace", threadId: "thread" }),
      backend: stubBackend("mounted") as never,
      knowledgeBackend: stubBackend("kb") as never,
      workingFilesBackend: workingBackend as never,
      localFiles: false,
      filesystemMounts: [],
      skillsBackend: new SelectedSkillsBackend([]),
      skillSandboxAssets: new TurnSkillSandboxAssets(),
    },
    internalContextBackend: new StateBackend({ state: { files: {} } } as never),
    sandboxRuntime: null,
  });

  const history = await backend.write(
    "/conversation_history/messages.md",
    "history",
  );
  const largeResult = await backend.write(
    "/large_tool_results/tool-call.txt",
    "large result",
  );
  await backend.write("/files/notes.md", "notes");

  assert.equal(history.error, undefined);
  assert.equal(largeResult.error, undefined);
  assert.deepEqual(workingWrites, ["/files/notes.md"]);
  assert.equal(
    (await backend.read("/kb/source.md")).content,
    "kb:read:/kb/source.md",
  );
});

test("agent backend routes VFS paths while execute stays on sandbox default", async () => {
  const backend = buildAgentBackend({
    filesystemBackend: {
      citationRegistry: new AgentCitationRegistry({ workspaceId: "workspace", threadId: "thread" }),
      backend: stubBackend("mounted") as never,
      knowledgeBackend: stubBackend("kb") as never,
      workingFilesBackend: stubBackend("work") as never,
      localFiles: false,
      filesystemMounts: [],
      skillsBackend: stubBackend("skills") as never,
      skillSandboxAssets: new TurnSkillSandboxAssets(),
    },
    sandboxRuntime: {
      backend: stubSandboxBackend() as never,
      trustedHost: {} as never,
      tools: [],
      interruptOn: {},
      downloadFile: async () => Buffer.from(""),
      buildRuntimePrompt: () => "",
      getOperationTimeline: async () => [],
      pathPolicy: SANDBOX_PATH_POLICY_STUB,
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
    (await backend.read("/files/notes.md")).content,
    "work:read:/files/notes.md",
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

test("preconstructed agent backend receives concurrent-safe tool call context", async () => {
  const executeCalls: Array<{ command: string; toolCallId?: string | null }> =
    [];
  const backend = buildAgentBackend({
    filesystemBackend: {
      citationRegistry: new AgentCitationRegistry({ workspaceId: "workspace", threadId: "thread" }),
      backend: stubBackend("mounted") as never,
      knowledgeBackend: stubBackend("kb") as never,
      workingFilesBackend: stubBackend("work") as never,
      localFiles: false,
      filesystemMounts: [],
      skillsBackend: new SelectedSkillsBackend([]),
      skillSandboxAssets: new TurnSkillSandboxAssets(),
    },
    sandboxRuntime: {
      backend: stubSandboxBackend({ executeCalls }) as never,
      trustedHost: {} as never,
      tools: [],
      interruptOn: {},
      downloadFile: async () => Buffer.from(""),
      buildRuntimePrompt: () => "",
      getOperationTimeline: async () => [],
      pathPolicy: SANDBOX_PATH_POLICY_STUB,
    },
  });
  const middleware = createSourceWeftToolCallContextMiddleware() as unknown as {
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };

  assert.deepEqual(
    await middleware.wrapToolCall(
      {
        toolCall: {
          id: "call-runtime-execute",
          name: AGENT_TOOL_NAMES.execute,
          args: { command: "node /workspace/ppt-deck/a.js" },
        },
      },
      async () =>
        (backend as SandboxBackendProtocolV2).execute(
          "node /workspace/ppt-deck/a.js",
        ),
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

test("preconstructed agent backend receives the host invocation signal", async () => {
  const executeCalls: Array<{
    command: string;
    signal?: AbortSignal;
    toolCallId?: string | null;
  }> = [];
  const backend = buildAgentBackend({
    filesystemBackend: {
      citationRegistry: new AgentCitationRegistry({ workspaceId: "workspace", threadId: "thread" }),
      backend: stubBackend("mounted") as never,
      knowledgeBackend: stubBackend("kb") as never,
      workingFilesBackend: stubBackend("work") as never,
      localFiles: false,
      filesystemMounts: [],
      skillsBackend: new SelectedSkillsBackend([]),
      skillSandboxAssets: new TurnSkillSandboxAssets(),
    },
    sandboxRuntime: {
      backend: stubSandboxBackend({ executeCalls }) as never,
      trustedHost: {} as never,
      tools: [],
      interruptOn: {},
      downloadFile: async () => Buffer.from(""),
      buildRuntimePrompt: () => "",
      getOperationTimeline: async () => [],
      pathPolicy: SANDBOX_PATH_POLICY_STUB,
    },
  });
  const invocation = new AbortController();

  await runWithSourceWeftToolInvocationSignal(invocation.signal, () =>
    (backend as SandboxBackendProtocolV2).execute(
      "node /workspace/ppt-deck/a.js",
    ),
  );

  assert.equal(executeCalls[0]?.signal, invocation.signal);
});

test("turn-scoped sandbox backend forwards one ALS signal to every sandbox file method without touching DB routes", async () => {
  const fileCalls: Array<{ method: string; signal?: AbortSignal }> = [];
  let workingReads = 0;
  const workingBackend = {
    ...stubBackend("work"),
    read: async (path: string) => {
      workingReads += 1;
      return { content: `work:read:${path}` };
    },
  } satisfies BackendProtocolV2;
  const backend = buildAgentBackend({
    filesystemBackend: {
      citationRegistry: new AgentCitationRegistry({ workspaceId: "workspace", threadId: "thread" }),
      backend: stubBackend("mounted") as never,
      knowledgeBackend: stubBackend("kb") as never,
      workingFilesBackend: workingBackend as never,
      localFiles: false,
      filesystemMounts: [],
      skillsBackend: new SelectedSkillsBackend([]),
      skillSandboxAssets: new TurnSkillSandboxAssets(),
    },
    sandboxRuntime: {
      backend: stubSandboxBackend({ fileCalls }) as never,
      trustedHost: {} as never,
      tools: [],
      interruptOn: {},
      downloadFile: async () => Buffer.from(""),
      buildRuntimePrompt: () => "",
      getOperationTimeline: async () => [],
      pathPolicy: SANDBOX_PATH_POLICY_STUB,
    },
  });
  const invocation = new AbortController();
  const sandboxBackend = backend as SandboxBackendProtocolV2;

  await runWithSourceWeftToolInvocationSignal(invocation.signal, async () => {
    await backend.ls("/workspace");
    await backend.read("/workspace/a.txt");
    await backend.readRaw("/workspace/a.txt");
    await backend.grep("a", "/workspace");
    await backend.glob("*.txt", "/workspace");
    await backend.write("/workspace/a.txt", "a");
    await backend.edit("/workspace/a.txt", "a", "b");
    await sandboxBackend.uploadFiles?.([
      ["/workspace/a.txt", new TextEncoder().encode("a")],
    ]);
    await sandboxBackend.downloadFiles?.(["/workspace/a.txt"]);
    await backend.read("/files/a.txt");
  });

  assert.deepEqual(
    fileCalls.map((call) => call.method),
    [
      "ls",
      "read",
      "readRaw",
      "grep",
      "glob",
      "write",
      "edit",
      "uploadFiles",
      "downloadFiles",
    ],
  );
  assert.ok(fileCalls.every((call) => call.signal === invocation.signal));
  assert.equal(workingReads, 1);
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
      citationRegistry: new AgentCitationRegistry({ workspaceId: "workspace", threadId: "thread" }),
      backend: stubBackend("mounted") as never,
      knowledgeBackend: stubBackend("kb") as never,
      workingFilesBackend: stubBackend("work") as never,
      localFiles: false,
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
      skillSandboxAssets: new TurnSkillSandboxAssets(),
    },
    sandboxRuntime: {
      backend: stubSandboxBackend() as never,
      trustedHost: {} as never,
      tools: [],
      interruptOn: {},
      downloadFile: async () => Buffer.from(""),
      buildRuntimePrompt: () => "",
      getOperationTimeline: async () => [],
      pathPolicy: SANDBOX_PATH_POLICY_STUB,
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

test("filesystem prompt mounts include sandbox workspace only when sandbox runtime is enabled", async () => {
  const withoutSandbox = filesystemMountsForPrompt({
    filesystemBackend,
    sandboxRuntime: null,
  });
  assert.deepEqual(
    withoutSandbox.map((mount) => mount.root),
    filesystemBackend.filesystemMounts.map((mount) => mount.root),
  );

  const sandboxRuntime = await buildSandboxRuntimeForPreparedTurn({
    prepared: createPreparedTurn(),
    filesystemBackend,
  });
  assert.ok(sandboxRuntime);
  const withSandbox = filesystemMountsForPrompt({
    filesystemBackend,
    sandboxRuntime,
  });

  const sandboxMount = withSandbox.find((mount) => mount.root === "/workspace");
  assert.ok(sandboxMount);
  assert.equal(sandboxMount.backendKind, "sandbox");
  assert.equal(sandboxMount.readFile.contentKind, "utf8-text-only");
  assert.match(sandboxMount.readPolicy, /UTF-8 text/u);
});

describe("sandbox runtime assembly tool permissions", () => {
  beforeEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
    config.sandbox.enabled = true;
    config.sandbox.provider = SYNTHETIC_SANDBOX_PROVIDER_ID;
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

  test("root-only trusted sandbox tools keep the runtime when raw execute is denied", async () => {
    const prepared = createPreparedTurn({
      [AGENT_TOOL_NAMES.execute]: "deny",
    });
    prepared.runtimeTools = {
      validate_video_presentation: {
        toolName: "validate_video_presentation",
        enabled: true,
        permission: "allow",
        shouldBind: true,
        selection: {},
        options: {},
      },
    };
    const { sandboxRuntime } = await promptFor(prepared);

    assert.ok(sandboxRuntime);
    assert.ok(sandboxRuntime.trustedHost);
  });

  test("video trusted-host binding never widens raw execute beyond interactive", async () => {
    const prepared = createPreparedTurn();
    prepared.runtimeTools = {
      validate_video_presentation: {
        toolName: "validate_video_presentation",
        enabled: true,
        permission: "allow",
        shouldBind: true,
        selection: {},
        options: {},
      },
    };
    const createRuntime = vi.spyOn(agentSandboxService, "createRuntimeForTurn");
    try {
      const sandboxRuntime = await buildSandboxRuntimeForPreparedTurn({
        prepared,
        filesystemBackend,
      });

      assert.ok(sandboxRuntime);
      assert.equal(typeof sandboxRuntime.backend.execute, "function");
      const runtimeInput = createRuntime.mock.calls.at(-1)?.[0];
      assert.ok(runtimeInput);
      assert.equal(runtimeInput.commandBudget, undefined);
      assert.ok(runtimeInput.runtimeAssets);
      assert.deepEqual(
        (await runtimeInput.runtimeAssets.plans()).map((plan) => plan.name),
        ["chrome-headless-shell"],
      );
      assert.equal(
        typeof sandboxRuntime.trustedHost.executeCurrent,
        "function",
      );
    } finally {
      createRuntime.mockRestore();
    }
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
        "/files, /kb, and /skills inside execute are provider sandbox filesystem paths only",
      ),
      true,
    );
    assert.equal(
      prompt.includes(
        "Never include /files, /kb, or /skills in an execute command",
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

describe("skill installed mid-turn", () => {
  beforeEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
    config.sandbox.enabled = true;
    config.sandbox.provider = SYNTHETIC_SANDBOX_PROVIDER_ID;
  });

  afterEach(() => {
    Object.assign(config.sandbox, structuredClone(originalSandboxConfig));
  });

  function installedSkill(
    overrides: Partial<EnabledSkillDescriptor> = {},
  ): EnabledSkillDescriptor {
    const markdown = "---\nname: notes\ndescription: Notes\n---\n# notes";
    return {
      workspaceSkillId: "workspace-skill-notes",
      sourceType: "registry_github",
      name: "notes",
      version: "1.0.0",
      description: "Notes",
      files: [
        {
          path: "SKILL.md",
          contentText: markdown,
          mimeType: "text/markdown",
          sizeBytes: Buffer.byteLength(markdown, "utf8"),
          contentHash: "hash-notes",
        },
      ],
      ...overrides,
    } as EnabledSkillDescriptor;
  }

  function freshFilesystemBackend(): FilesystemBackend {
    return {
      ...filesystemBackend,
      skillsBackend: new SelectedSkillsBackend([]),
      skillSandboxAssets: new TurnSkillSandboxAssets(),
    };
  }

  test("a turn that started without skills can stage one, and its prompt does not move", async () => {
    const prepared = createPreparedTurn();
    const turnFilesystem = freshFilesystemBackend();
    const createRuntime = vi.spyOn(agentSandboxService, "createRuntimeForTurn");
    try {
      const sandboxRuntime = await buildSandboxRuntimeForPreparedTurn({
        prepared,
        filesystemBackend: turnFilesystem,
      });
      assert.ok(sandboxRuntime);
      const skillAssets = createRuntime.mock.calls.at(-1)?.[0].skillAssets;
      assert.ok(skillAssets);
      // Nothing to stage yet: /skills stays denied and unannounced.
      assert.equal(skillAssets.hasPlans?.(), false);
      const promptAtStart = sandboxRuntime.buildRuntimePrompt();
      assert.match(
        promptAtStart,
        /Never include \/files, \/kb, or \/skills in an execute command/u,
      );

      const mounted = mountInstalledSkillForTurn({
        prepared,
        filesystemBackend: turnFilesystem,
        sandboxRuntime,
        skill: installedSkill(),
      });

      assert.deepEqual(mounted, { scriptsStageable: true });
      // The SAME callbacks the sandbox manager holds now see the new bundle.
      assert.equal(skillAssets.hasPlans?.(), true);
      assert.deepEqual(
        (await skillAssets.plans()).map((plan) => plan.installDir),
        ["/skills/notes"],
      );
      assert.equal(sandboxRuntime.buildRuntimePrompt(), promptAtStart);
    } finally {
      createRuntime.mockRestore();
    }
  });

  test("scripts wait for the next turn without a sandbox, without execute, on a PC, or over the staging caps — the mount stands", async () => {
    const prepared = createPreparedTurn();
    const sandboxRuntime = await buildSandboxRuntimeForPreparedTurn({
      prepared,
      filesystemBackend: freshFilesystemBackend(),
    });
    assert.ok(sandboxRuntime);
    const localPrepared = createPreparedTurn();
    localPrepared.thread = {
      ...localPrepared.thread,
      executionTarget: { kind: "local", deviceId: "pc" },
    } as PreparedThreadTurn["thread"];

    for (const [label, input] of [
      ["no sandbox", { prepared, sandboxRuntime: null }],
      [
        "execute denied",
        {
          prepared: createPreparedTurn({ [AGENT_TOOL_NAMES.execute]: "deny" }),
          sandboxRuntime,
        },
      ],
      ["bound PC", { prepared: localPrepared, sandboxRuntime }],
      [
        "bundle too large",
        {
          prepared,
          sandboxRuntime,
          skill: installedSkill({
            files: [
              ...installedSkill().files,
              {
                path: "blob.bin",
                contentText: "x",
                mimeType: "application/octet-stream",
                sizeBytes: 5 * 1024 * 1024,
                contentHash: "hash-blob",
              },
            ],
          }),
        },
      ],
    ] as const) {
      const turnFilesystem = freshFilesystemBackend();
      const mounted = mountInstalledSkillForTurn({
        filesystemBackend: turnFilesystem,
        skill: installedSkill(),
        ...input,
      });
      assert.deepEqual(mounted, { scriptsStageable: false }, label);
      assert.equal(turnFilesystem.skillSandboxAssets.hasPlans(), false, label);
      const read = await turnFilesystem.skillsBackend.read("/notes/SKILL.md");
      assert.equal(read.error, undefined, label);
    }
  });
});

test("PC assembly omits the DB Files route and exposes a durable physical mount", async () => {
  const dbWrite = vi.fn(async (path: string) => ({ path, filesUpdate: null }));
  const localFilesystem = {
    ...filesystemBackend, localFiles: true,
    workingFilesBackend: { ...stubBackend("work"), write: dbWrite } as never,
  };
  const root = "/Users/example/task";
  const sandboxRuntime = {
    backend: stubSandboxBackend(),
    pathPolicy: { ...SANDBOX_PATH_POLICY_STUB, workspaceRoot: root, defaultCwd: root },
  } as never;
  const mounts = filesystemMountsForPrompt({ filesystemBackend: localFilesystem, sandboxRuntime });
  assert.ok(!mounts.some((mount) => mount.root === "/files"));
  assert.equal(mounts.find((mount) => mount.root === root)?.persisted, true);
  const backend = buildAgentBackend({ filesystemBackend: localFilesystem, sandboxRuntime });
  await backend.write(`${root}/note.txt`, "local");
  await backend.write("/files/note.txt", "old path");
  assert.equal(dbWrite.mock.calls.length, 0);
});
