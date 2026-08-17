/**
 * The delegate run executor compiles + invokes the delegate graph for a valid
 * graphId (proven by the capture model being driven), and rejects an unknown
 * graphId. Uses a scripted resolver — no billing/agent-assembly.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { MemorySaver } from "@langchain/langgraph";
import { StateBackend } from "deepagents";
import type { RunRecord } from "./types";
import { createDelegateRunExecutor, type RunContext } from "./delegate-executor";

class CaptureModel extends BaseChatModel {
  invoked = false;
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType() {
    return "capture";
  }
  getName() {
    return "CaptureModel";
  }
  bindTools() {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.invoked = true;
    return { generations: [{ text: "done", message: new AIMessage("done") }] };
  }
}

function run(graphId: string): RunRecord {
  return {
    runId: "run_1",
    threadId: "thread_1",
    graphId,
    status: "running",
    multitaskStrategy: "reject",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function contextWith(model: CaptureModel): RunContext {
  return {
    model: model as never,
    backend: new StateBackend({ state: { files: {} } } as never),
    checkpointer: new MemorySaver(),
    availableTools: [
      tool(async () => "ok", {
        name: "search_sources",
        description: "stub",
        schema: z.object({ q: z.string().optional() }),
      }),
    ] as never,
    input: { messages: [{ role: "user", content: "go" }] },
  };
}

test("executor compiles and invokes the delegate graph for a valid graphId", async () => {
  const model = new CaptureModel();
  const executor = createDelegateRunExecutor(async () => contextWith(model));
  try {
    await executor(run("explore"), new AbortController().signal);
  } catch {
    // responseFormat may reject the capture reply; the graph still ran.
  }
  assert.equal(model.invoked, true);
});

test("executor rejects an unknown delegate graphId", async () => {
  const model = new CaptureModel();
  const executor = createDelegateRunExecutor(async () => contextWith(model));
  await assert.rejects(
    () => executor(run("general-purpose"), new AbortController().signal),
    /Unknown delegate graph/,
  );
});
