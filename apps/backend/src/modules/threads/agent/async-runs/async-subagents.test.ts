/**
 * Passing the async delegates in `createDeepAgent`'s `subagents` array exposes
 * deepagents' async task tools to the model (proving the wiring, without a
 * running endpoint). Uses a capturing scripted model — no API key, no network.
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
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import { buildAsyncDelegates } from "./async-subagents";

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
    return { generations: [{ text: "done", message: new AIMessage("done") }] };
  }
}

test("buildAsyncDelegates produces explore-async / plan-async with graphId + url", () => {
  const delegates = buildAsyncDelegates("http://localhost:3001/internal/async-runs");
  assert.deepEqual(
    delegates.map((d) => d.name),
    ["explore-async", "plan-async"],
  );
  assert.deepEqual(
    delegates.map((d) => d.graphId),
    ["explore", "plan"],
  );
  for (const d of delegates) {
    assert.equal(d.url, "http://localhost:3001/internal/async-runs");
  }
});

test("async delegates in `subagents` expose the async task tools to the model", async () => {
  const model = new CaptureModel();
  const agent = createDeepAgent({
    model: model as never,
    tools: [],
    checkpointer: new MemorySaver(),
    subagents: buildAsyncDelegates("http://localhost:3001/internal/async-runs"),
  } as never);

  await (
    agent as never as {
      invoke: (i: unknown, c: unknown) => Promise<unknown>;
    }
  ).invoke(
    { messages: [new HumanMessage("hi")] },
    { configurable: { thread_id: "async_probe" }, recursionLimit: 4 },
  );

  const names = new Set(model.boundToolNames);
  assert.ok(
    names.has("check_async_task"),
    `expected check_async_task; got: ${[...names].join(", ")}`,
  );
  assert.ok(names.has("list_async_tasks"), "expected list_async_tasks");
});
