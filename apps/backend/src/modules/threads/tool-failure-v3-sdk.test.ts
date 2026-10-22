import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  createDeepAgent,
  StateBackend,
  type WriteResult,
  type EditResult,
} from "deepagents";
import { test } from "vitest";
import { ScriptedChatModel } from "../../test/chat-model";
import {
  collectToolStreamEvents,
  createToolLoggingPreparedTurn,
} from "../../test/turn-stream-collectors";
import { parseSseData } from "../../test/thread-stream-fixtures";
import { mapDeepAgentEventToSse } from "./stream/event-mapper";
import { testExports as durable } from "./durable/runner";
import type { ChatRunSnapshot } from "./durable/types";
import { createTurnRuntime } from "./agent/turn/turn-runtime";
import { resolveToolsStreamToolCall } from "./agent/turn/tool-tracker";
import {
  handleToolStartStreamChunk,
  handleToolEndStreamChunk,
  handleToolErrorStreamChunk,
} from "./agent/turn/tool-stream-handler";
import { adaptToolsEvent, adoptV3RunStream } from "./agent/turn/v3-protocol";

class RejectedBackend extends StateBackend {
  override write(_path: string, _content: string): WriteResult {
    return { error: "Backend rejected this write. No file was saved." };
  }
  override edit(
    _path: string,
    _old: string,
    _new: string,
    _all = false,
  ): EditResult {
    return { error: "Backend rejected this edit. No file was changed." };
  }
}
test.each([
  { name: "write_file", args: { file_path: "/report.md", content: "content" } },
  {
    name: "edit_file",
    args: { file_path: "/report.md", old_string: "old", new_string: "new" },
  },
])(
  "actual SDK $name error remains error through v3, runtime, SSE and durable snapshot",
  async ({ name, args }) => {
    let calls = 0;
    const id = `failed-${name}`;
    const agent = createDeepAgent({
      backend: new RejectedBackend(),
      model: new ScriptedChatModel(() =>
        ++calls === 1
          ? new AIMessage({ content: "", tool_calls: [{ id, name, args }] })
          : new AIMessage("The file operation failed."),
      ),
    }) as unknown as {
      streamEvents(input: unknown, options: unknown): Promise<unknown>;
    };
    const stream = adoptV3RunStream(
      await agent.streamEvents(
        { messages: [new HumanMessage("Attempt this file operation.")] },
        { version: "v3" },
      ),
    );
    const prepared = createToolLoggingPreparedTurn();
    const runtime = createTurnRuntime({ prepared });
    const names = new Map<string, string>();
    let snapshot: ChatRunSnapshot = {};
    const statuses: string[] = [];
    let typedReceipt = false;
    for await (const protocol of stream) {
      if (protocol.method !== "tools") continue;
      const data = protocol.params?.data as
        | {
            event?: unknown;
            tool_call_id?: unknown;
            output?: { status?: unknown };
          }
        | undefined;
      if (data?.event === "tool-finished" && data.tool_call_id === id)
        typedReceipt = data.output?.status === "error";
      const payload = adaptToolsEvent(data, names);
      if (!payload) continue;
      const call = resolveToolsStreamToolCall({
        payload,
        toolCallsById: runtime.toolCallsById,
        toolCallOrder: runtime.toolCallOrder,
        resolveToolCallSequence: runtime.resolveToolCallSequence,
      });
      if (
        !call ||
        !["on_tool_start", "on_tool_error", "on_tool_end"].includes(call.event)
      )
        continue;
      const events = await collectToolStreamEvents(
        call.event === "on_tool_start"
          ? handleToolStartStreamChunk({ prepared, runtime, snapshot: call })
          : call.event === "on_tool_error"
            ? handleToolErrorStreamChunk({ prepared, runtime, snapshot: call })
            : handleToolEndStreamChunk({ prepared, runtime, snapshot: call }),
      );
      for (const event of events) {
        if (event.type === "done") continue;
        const sse = parseSseData(mapDeepAgentEventToSse(event, "text"));
        snapshot = durable.updateSnapshotFromPayload(snapshot, sse as never);
        if (event.type === "tool-call-end") statuses.push(event.status);
      }
    }
    await stream.output;
    assert.equal(
      typedReceipt,
      true,
      "fixture must receive an actual SDK error ToolMessage",
    );
    assert.deepEqual(statuses, ["error"]);
    assert.equal(runtime.collectToolCalls()[0]?.status, "error");
    assert.match(
      runtime.collectToolCalls()[0]?.error ?? "",
      /Backend rejected/,
    );
    const durableCall = (
      snapshot.toolCalls as Array<{ status: string; error: string }>
    )[0]!;
    assert.equal(durableCall.status, "error");
    assert.match(durableCall.error, /Backend rejected/);
    assert.equal(
      (snapshot.traceParts as Array<{ kind: string; status?: string }>).find(
        (p) => p.kind === "tool",
      )?.status,
      "error",
    );
  },
);

test.each(["live", "plain", "constructor"])(
  "v3 adapter preserves authoritative %s ToolMessage error without guessing text prefixes",
  (shape) => {
    const message = new ToolMessage({
      name: "write_file",
      tool_call_id: "status-id",
      status: "error",
      content: "Operation denied.",
    });
    const output =
      shape === "live"
        ? message
        : shape === "plain"
          ? JSON.parse(JSON.stringify({ ...message, type: "tool" }))
          : message.toJSON();
    assert.equal(
      adaptToolsEvent(
        { event: "tool-finished", tool_call_id: "status-id", output },
        new Map([["status-id", "write_file"]]),
      )?.event,
      "on_tool_error",
    );
  },
);
test("v3 adapter does not treat an arbitrary domain status field as a ToolMessage", () => {
  const output = { status: "error", content: "domain-specific data" };
  assert.equal(
    adaptToolsEvent(
      { event: "tool-finished", tool_call_id: "domain", output },
      new Map([["domain", "custom_tool"]]),
    )?.event,
    "on_tool_end",
  );
});

test("successful ToolMessage output and metadata are preserved without text-prefix guessing", () => {
  const message = new ToolMessage({
    name: "write_file",
    tool_call_id: "success-id",
    status: "success",
    content: "Error: is example text, not a status.",
    metadata: { receipt: "existing-metadata" },
  });
  const adapted = adaptToolsEvent(
    { event: "tool-finished", tool_call_id: "success-id", output: message },
    new Map([["success-id", "write_file"]]),
  );
  assert.equal(adapted?.event, "on_tool_end");
  assert.strictEqual(adapted?.output, message);
});
