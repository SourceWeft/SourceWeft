/**
 * Everything the Router's model reads, held to a size budget (as DeepSeek's
 * Super-agent prototype does per role): the system prompt and the tool
 * definitions of one real Router turn. The turn is assembled by the threads
 * module and run through the real agent against a model that only records
 * its request, so a prompt or tool added anywhere in that path shows up here.
 */
import assert from "node:assert/strict";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { StateBackend, type BackendProtocolV2 } from "deepagents";
import { afterAll, test, vi } from "vitest";
import { ScriptedChatModel } from "../../../test/chat-model";
import { createPreparedThreadTurn } from "../../../test/prepared-turn";
import { SelectedSkillsBackend } from "../../skills/backend";
import { TurnSkillSandboxAssets } from "../../skills/sandbox-assets";
import type { CreateThreadAgentParams } from "../../threads/agent";
import type {
  FilesystemBackend,
  ToolCollection,
} from "../../threads/agent/turn/turn-assembly";
import { applyUnattendedToolPolicy } from "../../threads/agent/unattended-policy";

/** Characters, not tokens: stable across tokenizers. Measured 2026-11-23:
 * system prompt 2,849, tool definitions 2,852. */
const ROUTER_SYSTEM_PROMPT_BUDGET = 4_000;
const ROUTER_TOOL_DEFINITIONS_BUDGET = 4_000;

vi.mock("../../../shared/chat-checkpointer", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  return { getChatCheckpointer: async () => saver };
});

// Assembly hands its parameters here; the test builds the real agent from them.
const created: CreateThreadAgentParams[] = [];
vi.mock("../../threads/agent/index", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createThreadAgent: vi.fn(async (params: CreateThreadAgentParams) => {
    created.push(params);
    return {};
  }),
}));

const {
  buildRuntimePromptContext,
  buildThreadAgentAssembly,
  restrictToolCollectionForUnattendedRun,
} = await import("../../threads/agent/turn/turn-assembly");
const { registerOriginTurnProvider, unregisterOriginTurnProvider } =
  await import("../../threads/agent/origin-providers");
const { createRouterTools } = await import("./tools");
const { ROUTER_PROMPT } = await import("./prompt");

afterAll(() => unregisterOriginTurnProvider("assistant_router"));

/** Records the model request instead of calling a provider. */
class RecordingModel extends ScriptedChatModel {
  boundTools: unknown[] = [];
  requests: BaseMessage[][] = [];
  constructor() {
    super((messages) => {
      this.requests.push(messages);
      return new AIMessage("done");
    });
  }
  override bindTools(tools?: unknown[]) {
    this.boundTools = tools ?? [];
    return this;
  }
}

function messageText(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => ("text" in block ? String(block.text) : ""))
    .join("\n");
}

async function routerModelSurface() {
  registerOriginTurnProvider("assistant_router", {
    replaceTools: true,
    // Built for a stub batch: the definitions do not depend on its contents.
    tools: async (ctx) =>
      createRouterTools({
        ...ctx,
        assistantId: "assistant_test",
        batchKey: "batch_test",
        batchTriggerIds: [],
      }),
    prompt: async () => ROUTER_PROMPT,
  });
  const prepared = createPreparedThreadTurn({
    thread: { id: "thread_test", origin: "assistant_router" },
    threadRunId: "thread_run_test",
    toolPermissions: applyUnattendedToolPolicy({}),
    unattended: true,
    hostContext: { batchKey: "batch_test" },
  });
  const toolCollection = restrictToolCollectionForUnattendedRun({
    capabilityTools: [],
    skillTools: [],
    webTools: [],
    artifactTools: [],
    promptProviders: [],
    connectorActionTools: [],
    connectorInterruptOn: {},
    mcpTools: [],
    connectorToolContext: {},
    mcpToolRuntime: null,
  } as unknown as ToolCollection);
  const filesystemBackend = {
    backend: new StateBackend() as unknown as BackendProtocolV2,
    knowledgeBackend: {} as never,
    workingFilesBackend: {} as never,
    filesystemMounts: [],
    skillsBackend: new SelectedSkillsBackend([]),
    skillSandboxAssets: new TurnSkillSandboxAssets(),
    citationRegistry: undefined,
  } as unknown as FilesystemBackend;
  const model = new RecordingModel();
  const { runtimePrompt } = await buildRuntimePromptContext({
    prepared,
    toolCollection,
    sandboxRuntime: null,
  });
  await buildThreadAgentAssembly({
    prepared,
    toolCollection,
    filesystemBackend,
    sandboxRuntime: null,
    runtimePrompt,
    model: model as never,
  });
  const params = created.at(-1);
  assert.ok(params, "turn assembly built an agent");

  const actual = await vi.importActual<
    typeof import("../../threads/agent/index")
  >("../../threads/agent/index");
  const agent = await actual.createThreadAgent({
    ...params,
    model,
    backend: new StateBackend(),
  });
  await agent.invoke(
    { messages: [new HumanMessage("<assistant-batch />")] },
    { configurable: { thread_id: "model_surface_test" } },
  );
  const [request] = model.requests;
  assert.ok(request, "the model was called");
  return {
    systemPrompt: request
      .filter((message) => message._getType() === "system")
      .map(messageText)
      .join("\n"),
    tools: model.boundTools.map((tool) => convertToOpenAITool(tool as never)),
  };
}

test("the Router reads only its own prompt and tools, within budget", async () => {
  const { systemPrompt, tools } = await routerModelSurface();

  assert.deepEqual(tools.map((tool) => tool.function.name).sort(), [
    "create_ticket",
    "ignore",
    "recall",
    "route_to_ticket",
    "say",
  ]);
  assert.ok(systemPrompt.includes(ROUTER_PROMPT));
  // None of the chat base prompt: the Router cites nothing and reads no file.
  for (const section of [
    "<system_instruction>",
    "<evidence_workflow>",
    "<filesystem_rules>",
    "<citation_instructions>",
    "<todo_visibility>",
    "<output_rules>",
  ]) {
    assert.equal(systemPrompt.includes(section), false, section);
  }

  const toolDefinitions = tools.reduce(
    (sum, tool) => sum + JSON.stringify(tool).length,
    0,
  );
  assert.ok(
    systemPrompt.length <= ROUTER_SYSTEM_PROMPT_BUDGET,
    `Router system prompt is ${systemPrompt.length} characters; budget ${ROUTER_SYSTEM_PROMPT_BUDGET}`,
  );
  assert.ok(
    toolDefinitions <= ROUTER_TOOL_DEFINITIONS_BUDGET,
    `Router tool definitions are ${toolDefinitions} characters; budget ${ROUTER_TOOL_DEFINITIONS_BUDGET}`,
  );
});
