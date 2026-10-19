import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  createDeepAgent,
  StateBackend,
  type WriteResult,
  type EditResult,
  type ReadResult,
} from "deepagents";
import { test } from "vitest";
import { ScriptedChatModel } from "../../../../test/chat-model";

class ErrorBackend extends StateBackend {
  readonly operations: string[] = [];
  override read(_path: string): ReadResult {
    this.operations.push("read_file");
    return { error: "backend rejected the read; no content was read." };
  }
  override write(_path: string, _content: string): WriteResult {
    this.operations.push("write_file");
    return { error: "Error: backend rejected the write; no file was saved." };
  }
  override edit(
    _path: string,
    _old: string,
    _new: string,
    _all = false,
  ): EditResult {
    this.operations.push("edit_file");
    return {
      error: "Error: backend rejected the edit; no replacement occurred.",
    };
  }
}
test.each([
  { name: "read_file", args: { file_path: "/report.md" } },
  { name: "write_file", args: { file_path: "/report.md", content: "report" } },
  {
    name: "edit_file",
    args: { file_path: "/report.md", old_string: "old", new_string: "new" },
  },
])(
  "installed SDK $name preserves Backend.error as an error ToolMessage",
  async ({ name, args }) => {
    const backend = new ErrorBackend();
    let models = 0;
    const agent = createDeepAgent({
      backend,
      model: new ScriptedChatModel(() =>
        ++models === 1
          ? new AIMessage({
              content: "",
              tool_calls: [{ id: `failure-${name}`, name, args }],
            })
          : new AIMessage("The backend rejected the operation."),
      ),
    }) as unknown as {
      invoke(
        input: unknown,
      ): Promise<{ messages: unknown[]; files?: Record<string, unknown> }>;
    };
    const result = await agent.invoke({
      messages: [new HumanMessage("Attempt the file operation.")],
    });
    const receipt = result.messages
      .filter(ToolMessage.isInstance)
      .find((message) => message.tool_call_id === `failure-${name}`);
    assert.deepEqual(backend.operations, [name]);
    assert.ok(receipt);
    assert.equal(receipt.name, name);
    assert.equal(
      receipt.status,
      "error",
      "a returned Backend.error must not become a successful tool receipt",
    );
    const text =
      typeof receipt.content === "string"
        ? receipt.content
        : receipt.content
            .map((block) => ("text" in block ? block.text : ""))
            .join("");
    assert.match(text, /backend rejected/);
    assert.equal(result.files?.["/report.md"], undefined);
    assert.equal(models, 2);
  },
);
