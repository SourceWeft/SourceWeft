/**
 * The delegate graph compiles as a standalone root agent and binds the
 * delegate's read-only tools. Uses a capturing scripted model (no API key) —
 * the same pattern as the sub-agent introspection test.
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
import { StateBackend as DeepAgentsStateBackend } from "deepagents";
import {
  createDelegateGraph,
  DELEGATE_GRAPH_IDS,
  isDelegateGraphId,
} from "./delegate-graph";
import { createSourceWeftSubagentMiddlewareStack } from "../middleware";

class CaptureModel extends BaseChatModel {
  boundToolNames: string[] = [];
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType() {
    return "capture";
  }
  getName() {
    return "CaptureModel";
  }
  bindTools(tools: unknown[]) {
    for (const t of tools) {
      const name = (t as { name?: string })?.name;
      if (typeof name === "string") this.boundToolNames.push(name);
    }
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = new AIMessage({ content: "done" });
    return { generations: [{ text: "done", message }] };
  }
}

const readTools = ["search_sources", "ls", "read_file", "glob", "grep"].map(
  (name) =>
    tool(async () => "ok", {
      name,
      description: `stub ${name}`,
      schema: z.object({ q: z.string().optional() }),
    }),
) as unknown as StructuredTool[];

test("isDelegateGraphId matches the roster", () => {
  assert.equal(isDelegateGraphId("explore"), true);
  assert.equal(isDelegateGraphId("plan"), true);
  assert.equal(isDelegateGraphId("general-purpose"), false);
  assert.deepEqual([...DELEGATE_GRAPH_IDS], ["explore", "plan"]);
});

for (const graphId of DELEGATE_GRAPH_IDS) {
  test(`the ${graphId} delegate compiles as a root graph and binds read-only tools`, async () => {
    const model = new CaptureModel();
    const agent = createDelegateGraph({
      graphId,
      model: model as never,
      backend: new DeepAgentsStateBackend({ state: { files: {} } } as never),
      checkpointer: new MemorySaver(),
      availableTools: readTools,
    });

    try {
      await (
        agent as never as {
          invoke: (i: unknown, c: unknown) => Promise<unknown>;
        }
      ).invoke(
        { messages: [new HumanMessage("go")] },
        {
          configurable: { thread_id: `delegate_${graphId}` },
          recursionLimit: 4,
        },
      );
    } catch {
      // A responseFormat delegate may reject the capture model's plain reply;
      // tools are bound before that, which is what we assert.
    }

    // The delegate's read-only business tool reached the model.
    assert.ok(
      model.boundToolNames.includes("search_sources"),
      `expected search_sources; got: ${model.boundToolNames.join(", ")}`,
    );
    // Filesystem read tools from the delegate's read-only middleware.
    for (const fsTool of ["read_file", "ls"]) {
      assert.ok(
        model.boundToolNames.includes(fsTool),
        `expected ${fsTool}; got: ${model.boundToolNames.join(", ")}`,
      );
    }
  });
}

test("standalone async delegates receive the same SourceWeft governance as inline subagents", () => {
  const model = new CaptureModel();
  const backend = new DeepAgentsStateBackend({ state: { files: {} } } as never);
  const expectedNames = createSourceWeftSubagentMiddlewareStack({
    backend,
    model: model as never,
  }).map((middleware) => middleware.name);
  const agent = createDelegateGraph({
    graphId: "explore",
    model: model as never,
    backend,
    availableTools: readTools,
  });
  const actualNames =
    (
      agent as never as {
        options?: { middleware?: readonly { name?: string }[] };
      }
    ).options?.middleware?.map((middleware) => middleware.name) ?? [];

  for (const name of expectedNames) {
    assert.ok(
      actualNames.includes(name),
      `expected standalone delegate middleware '${name}'; got: ${actualNames.join(", ")}`,
    );
  }
  assert.ok(expectedNames.includes("SourceWeftToolExecutionTimeout"));
});
