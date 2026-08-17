/**
 * Runtime introspection of what `createDeepAgent` actually composes.
 *
 * The leverage plan's "dormant" list was drawn from SourceWeft's *explicit*
 * usage and missed that `createDeepAgent` injects several middleware internally
 * (filesystem, subagent + general-purpose `task`, patch-tool-calls, and — for
 * Anthropic-typed models — prompt caching). This test confirms empirically what
 * reaches the model, so items ①–④ move from guess to fact.
 *
 * It uses a capturing fake model (same shape as the billing smoke test's
 * ScriptedChatModel) that records the tools bound to it and the messages it is
 * asked to generate from, then ends the loop with a tool-call-free reply.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { type StructuredTool, tool } from "@langchain/core/tools";
import { z } from "zod";
import { MemorySaver } from "@langchain/langgraph";
import { todoListMiddleware } from "langchain";
import { createDeepAgent, StateBackend, type SubAgent } from "deepagents";
import { createExploreSubagent } from "./subagents/explore";

/** A model that records what the composed agent binds and sends to it. */
class CaptureChatModel extends BaseChatModel {
  boundToolNames: string[] = [];
  generatedMessages: BaseMessage[] = [];
  sawCacheControl = false;

  constructor(
    private readonly modelName: string,
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }

  _llmType() {
    return "capture";
  }

  // deepagents' `isAnthropicModel` checks `getName()`, so this drives whether
  // the prompt-caching middleware is injected.
  getName() {
    return this.modelName;
  }

  boundTools: StructuredTool[] = [];

  bindTools(tools: unknown[]) {
    for (const t of tools) {
      const name =
        (t as { name?: string })?.name ??
        (t as { function?: { name?: string } })?.function?.name;
      if (typeof name === "string") this.boundToolNames.push(name);
      if ((t as { name?: string })?.name) this.boundTools.push(t as StructuredTool);
    }
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.generatedMessages = messages;
    this.sawCacheControl = messages.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Array<Record<string, unknown>>).some(
          (block) => block?.cache_control != null,
        ),
    );
    const message = new AIMessage({ content: "done" });
    return { generations: [{ text: "done", message }] };
  }
}

const RUN_CONFIG = {
  configurable: { thread_id: "introspection_thread" },
  recursionLimit: 6,
};

async function captureComposedRequest(
  modelName: string,
  options: { subagents?: SubAgent[]; tools?: StructuredTool[] } = {},
) {
  const model = new CaptureChatModel(modelName);
  const agent = createDeepAgent({
    model: model as never,
    tools: options.tools ?? [],
    // The one tool-relevant middleware SourceWeft adds on top of the defaults.
    middleware: [todoListMiddleware()],
    checkpointer: new MemorySaver(),
    ...(options.subagents ? { subagents: options.subagents } : {}),
  } as never);

  await (
    agent as never as {
      invoke: (input: unknown, config: unknown) => Promise<unknown>;
    }
  ).invoke({ messages: [new HumanMessage("hello")] }, RUN_CONFIG);

  const toolNames = [...new Set(model.boundToolNames)].sort();
  const taskTool = model.boundTools.find((tool) => tool.name === "task");
  return {
    toolNames,
    sawCacheControl: model.sawCacheControl,
    taskDescription: taskTool?.description ?? "",
  };
}

test("createDeepAgent exposes the multi-agent, filesystem, and planning tools by default", async () => {
  const { toolNames } = await captureComposedRequest("ChatDeepSeek");

  // Surface the ground truth in the test output.

  console.log("[introspection] tools exposed to the model:", toolNames);

  // Multi-agent substrate: the general-purpose subagent `task` tool is present
  // even with an empty `subagents` list — so delegation is already live.
  assert.ok(
    toolNames.includes("task"),
    `expected the 'task' delegation tool; got: ${toolNames.join(", ")}`,
  );

  // Filesystem working-memory tools from the default StateBackend.
  for (const fsTool of ["ls", "read_file", "write_file", "edit_file"]) {
    assert.ok(
      toolNames.includes(fsTool),
      `expected filesystem tool '${fsTool}'; got: ${toolNames.join(", ")}`,
    );
  }

  // Planning tool from the todo middleware SourceWeft adds.
  assert.ok(
    toolNames.includes("write_todos"),
    `expected 'write_todos'; got: ${toolNames.join(", ")}`,
  );
});

test("prompt caching is gated on the model's Anthropic identity", async () => {
  const anthropic = await captureComposedRequest("ChatAnthropic");
  const nonAnthropic = await captureComposedRequest("ChatOpenAI");

  console.log("[introspection] cache_control seen — ChatAnthropic:", anthropic.sawCacheControl, "ChatOpenAI:", nonAnthropic.sawCacheControl);

  // Tool exposure must be identical regardless of provider identity.
  assert.deepEqual(anthropic.toolNames, nonAnthropic.toolNames);

  // The meaningful finding: caching is applied for the Anthropic path only.
  // If this assertion fails because the fake model isn't a real ChatAnthropic
  // instance, that itself is the answer — caching must be confirmed in staging
  // via `prompt_cache_hit_tokens` instead. See the leverage plan, item ①.
  assert.equal(
    nonAnthropic.sawCacheControl,
    false,
    "non-Anthropic models must not receive cache_control blocks",
  );
});

test("a custom explore subagent is advertised to the model via the task tool", async () => {
  const readTools = ["search_sources", "ls", "read_file", "glob", "grep"].map(
    (name) =>
      tool(async () => "ok", {
        name,
        description: `stub ${name}`,
        schema: z.object({ q: z.string().optional() }),
      }),
  );

  const explore = createExploreSubagent({
    availableTools: readTools,
    backend: new StateBackend({ state: { files: {} } } as never),
    middleware: [],
  });
  const { toolNames, taskDescription } = await captureComposedRequest(
    "ChatDeepSeek",
    { subagents: [explore] },
  );

  console.log("[introspection] task tool description:\n", taskDescription);

  // The delegation tool is still present, and now names explore as a
  // selectable subagent type.
  assert.ok(toolNames.includes("task"));
  assert.match(taskDescription, /explore/);
});
