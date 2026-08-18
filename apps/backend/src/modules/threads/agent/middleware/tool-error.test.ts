import assert from "node:assert/strict";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { ToolInputParsingException, tool } from "@langchain/core/tools";
import { createDeepAgent, StateBackend } from "deepagents";
import { test } from "vitest";
import { z } from "zod";
import {
  createSourceWeftToolErrorMiddleware,
  formatSourceWeftToolError,
} from "./tool-error";

function request(input?: { aborted?: boolean; toolName?: string }) {
  const controller = new AbortController();
  if (input?.aborted) {
    controller.abort();
  }
  return {
    toolCall: {
      id: "call-1",
      name: input?.toolName ?? "demo_tool",
      args: {},
    },
    runtime: { signal: controller.signal },
  } as never;
}

test("tool input errors omit raw generated arguments", () => {
  const message = formatSourceWeftToolError(
    new ToolInputParsingException(
      "Received tool input did not match expected schema",
      '{"secret":"do-not-expose"}',
    ),
    request({ toolName: "publish_artifact" }),
  );

  assert.equal(
    message,
    "Tool 'publish_artifact' rejected the generated arguments. Review its schema, correct the call, and retry.",
  );
  assert.doesNotMatch(String(message), /do-not-expose|secret/);
});

test("MCP tool errors redact secrets and bound the model-facing message", () => {
  const message = formatSourceWeftToolError(
    new Error(`remote rejected Bearer ${"a".repeat(900)}`),
    request({ toolName: "mcp__demo__search" }),
  );

  assert.match(String(message), /remote rejected \[REDACTED\]/);
  assert.ok(String(message).length <= 600);
  assert.doesNotMatch(String(message), /a{20}/);
});

test("run cancellation propagates instead of becoming a tool result", () => {
  assert.equal(
    formatSourceWeftToolError(
      new Error("aborted"),
      request({ aborted: true }),
    ),
    undefined,
  );
});

class ScriptedToolErrorModel extends BaseChatModel {
  calls: BaseMessage[][] = [];
  private index = 0;

  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }

  _llmType() {
    return "scripted-tool-error";
  }

  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const script = [
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call-bad", name: "validate_demo", args: {} }],
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call-fixed",
            name: "validate_demo",
            args: { value: "fixed" },
          },
        ],
      }),
      new AIMessage({ content: "Recovered successfully." }),
    ];
    const message = script[Math.min(this.index, script.length - 1)]!;
    this.index += 1;
    return { generations: [{ text: String(message.content), message }] };
  }
}

test("a real Deep Agent continues after invalid tool arguments", async () => {
  const model = new ScriptedToolErrorModel();
  let executions = 0;
  const validateDemo = tool(
    async ({ value }) => {
      executions += 1;
      return `ok:${value}`;
    },
    {
      name: "validate_demo",
      description: "Validate a required value.",
      schema: z.object({ value: z.string().min(1) }),
    },
  );
  const agent = createDeepAgent({
    model,
    tools: [validateDemo],
    middleware: [createSourceWeftToolErrorMiddleware()],
    backend: new StateBackend(),
  });

  const result = await agent.invoke(
    { messages: [new HumanMessage("validate it")] },
    {
      configurable: { thread_id: "tool_error_recovery" },
      recursionLimit: 12,
    },
  );
  const messages = (result as { messages?: BaseMessage[] }).messages ?? [];
  const failed = messages.find(
    (message): message is ToolMessage =>
      ToolMessage.isInstance(message) && message.tool_call_id === "call-bad",
  );

  assert.ok(failed, "expected the invalid call to produce a ToolMessage");
  assert.equal(failed.status, "error");
  assert.match(
    String(failed.content),
    /(?:rejected the generated arguments|generated tool arguments were invalid)/i,
  );
  assert.equal(executions, 1, "only the corrected call should reach the body");
  assert.equal(model.calls.length, 3);
  assert.ok(
    model.calls[1]?.some(
      (message) =>
        ToolMessage.isInstance(message) && message.tool_call_id === "call-bad",
    ),
    "the next model request must contain the failed tool result",
  );
  assert.equal(messages.at(-1)?.content, "Recovered successfully.");
});
