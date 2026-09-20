import assert from "node:assert/strict";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import { tool } from "langchain";
import { afterEach, beforeEach, test } from "vitest";
import { z } from "zod";
import { adoptV3RunStream } from "./v3-protocol";

// A tool that throws — a sandbox that could not be reached — must not be able
// to end the PROCESS. It did: found when one connection reset to the sandbox
// provider during an e2e run took the whole API down. This runs the installed
// langchain/deepagents with a scripted model; no network.

class OneFailingToolCallModel extends BaseChatModel {
  step = 0;
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType() {
    return "one-failing-tool-call";
  }
  bindTools() {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.step += 1;
    const message =
      this.step === 1
        ? new AIMessage({
            content: "",
            tool_calls: [{ id: "call-boom", name: "boom", args: {} }],
          })
        : new AIMessage("done");
    return { generations: [{ text: String(message.content), message }] };
  }
}

const boom = tool(
  async () => {
    throw new Error("SANDBOX_NOT_READY_OR_UNHEALTHY: provider unavailable");
  },
  { name: "boom", description: "always fails", schema: z.object({}) },
);

let unhandled: unknown[] = [];
const record = (reason: unknown) => unhandled.push(reason);
// vitest installs its own listener that fails the run; take it off for the
// duration so the test can OBSERVE the rejection instead of dying from it.
let parked: NodeJS.UnhandledRejectionListener[] = [];

beforeEach(() => {
  unhandled = [];
  parked = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", record);
});
afterEach(() => {
  process.removeAllListeners("unhandledRejection");
  for (const listener of parked) process.on("unhandledRejection", listener);
});

async function runFailingTurn(adopt: (raw: unknown) => unknown) {
  const agent = createDeepAgent({
    model: new OneFailingToolCallModel() as never,
    tools: [boom],
    checkpointer: new MemorySaver(),
  });
  const stream = adopt(
    await agent.streamEvents(
      { messages: [{ role: "user", content: "go" }] },
      {
        configurable: { thread_id: `boom-${Math.random()}` },
        version: "v3",
      } as never,
    ),
  ) as AsyncIterable<{ method?: string }>;
  const methods: string[] = [];
  try {
    for await (const event of stream) {
      if (typeof event?.method === "string") methods.push(event.method);
    }
  } catch {
    // The run itself may surface the tool error; that is handled by callers.
  }
  // `unhandledRejection` is raised after the microtask queue drains.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return methods;
}

test("reading only the event stream leaves the tool's rejected output promise unhandled", async () => {
  await runFailingTurn((raw) => raw);
  assert.ok(
    unhandled.length > 0,
    "expected the raw v3 stream to leak an unhandled rejection — if langchain fixed this upstream, adoptV3RunStream's guard can go",
  );
  assert.match(String(unhandled[0]), /SANDBOX_NOT_READY_OR_UNHEALTHY/);
});

test("adoptV3RunStream observes it, so a failing tool cannot take the process down", async () => {
  await runFailingTurn(adoptV3RunStream);
  assert.deepEqual(unhandled, []);
});
