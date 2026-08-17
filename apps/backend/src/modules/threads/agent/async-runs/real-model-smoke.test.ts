/**
 * Layer 3 — real-model smoke. Exercises a REAL model executing a background
 * delegate through the wired async loop: a scripted parent reliably drives
 * start_async_task → check_async_task against our real HTTP endpoint, and a real
 * BullMQ worker runs the delegate with a REAL model whose answer must surface
 * back through check. The parent is scripted (not a real model) on purpose — its
 * tool-driving is already proven deterministically in agent-e2e.test.ts, and a
 * real parent only adds flakiness; the value here is a real model actually
 * running through the endpoint → worker → result pipeline.
 *
 * Unbilled (raw agent model; E6 covers billing). Uses a plain deep agent for the
 * delegate — NOT the explore/plan graphs, whose `responseFormat` the configured
 * provider (deepseek via OpenRouter) rejects with "400 response_format type is
 * unavailable" (a separate, pre-existing issue affecting the sync delegates too).
 *
 * Opt-in only (real calls + ~tens of seconds): RUN_REAL_MODEL_SMOKE=1 with the
 * gateway key + DATABASE_URL present.
 */
import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Pool } from "pg";
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
import { createDeepAgent, StateBackend } from "deepagents";
import {
  ensureModelConfigAvailable,
  syncGlobalModelGatewayConfig,
} from "../../../../shared/model-gateway/index";
import { createRawAgentChatModel } from "../../../../shared/model-gateway/internal/raw";
import { PostgresRunsStore } from "./postgres-store";
import { createRunQueue, createRunWorker, enqueueRun } from "./run-queue";
import type { RunExecutor } from "./run-processor";
import { buildAsyncDelegates } from "./async-subagents";
import { RUN_INTERNAL_TOKEN_HEADER } from "./run-context-header";
import { registerAsyncRunsRoutes } from "../../../../api/routes/async-runs";
import type { RunContextConfig } from "./types";

const ENABLED = Boolean(
  process.env.RUN_REAL_MODEL_SMOKE &&
    process.env.OPENROUTER_API_KEY &&
    process.env.DATABASE_URL,
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresRunsStore(pool);
const TOKEN = "real-model-smoke-token";
const QUEUE = `async-runs-smoke-${process.pid}`;
const queue = createRunQueue(QUEUE);
const createdThreads: string[] = [];
let server: ReturnType<typeof serve> | undefined;
let worker: ReturnType<typeof createRunWorker> | undefined;

const CONTEXT: RunContextConfig = {
  teamId: "team_smoke",
  workspaceId: "ws_smoke",
  userId: "user_smoke",
  modelAlias: "chat-default",
  providerModel: "chat-default",
  profileAlias: "chat-default",
  gatewayConfigId: "gw_smoke",
  parentThreadId: "thread_smoke_parent",
};

// The delegate: a plain deep agent driven by a REAL model over an empty backend.
const smokeExecutor: RunExecutor = async (run, signal) => {
  const config = await store.getRunConfig(run.runId);
  const model = await createRawAgentChatModel({ modelAlias: "chat-default" });
  const agent = createDeepAgent({
    model: model as never,
    tools: [],
    checkpointer: new MemorySaver(),
    backend: new StateBackend() as never,
  } as never);
  return await (
    agent as never as { invoke: (i: unknown, c: unknown) => Promise<unknown> }
  ).invoke(config?.input ?? { messages: [] }, {
    configurable: { thread_id: run.threadId },
    recursionLimit: 8,
    ...(signal ? { signal } : {}),
  });
};

beforeAll(async () => {
  if (!ENABLED) return;
  await syncGlobalModelGatewayConfig({ syncPricing: false });
  await ensureModelConfigAvailable();
  await store.ensureSchema();
  worker = createRunWorker({ queueName: QUEUE, store, executor: smokeExecutor });
});

afterAll(async () => {
  await worker?.close();
  await queue.close();
  server?.close();
  for (const threadId of createdThreads) {
    await store.deleteThread(threadId);
  }
  await pool.end();
});

function messageType(m: BaseMessage): string {
  const anyM = m as unknown as { getType?: () => string; _getType?: () => string };
  return anyM.getType?.() ?? anyM._getType?.() ?? "";
}

// Scripted parent: start → (wait for the real delegate to finish) → check.
class ScriptedParent extends BaseChatModel {
  private callId = 0;
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType() {
    return "scripted-parent";
  }
  bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const toolMsgs = messages
      .filter((m) => messageType(m) === "tool")
      .map((m) => String((m as { content?: unknown }).content ?? ""));
    const launched = toolMsgs.find((c) => c.includes("Launched async subagent"));
    const checkedSuccess = toolMsgs.some((c) => c.includes('"status":"success"'));

    if (checkedSuccess) {
      return this.answer("Collected the delegate's result.");
    }
    if (launched) {
      const taskId = /taskId:\s*(\S+)/.exec(launched)?.[1];
      assert.ok(taskId, "start_async_task did not return a taskId");
      const deadline = Date.now() + 90_000;
      while ((await store.getThreadState(taskId)) === null) {
        if (Date.now() > deadline) throw new Error("delegate never completed");
        await new Promise((r) => setTimeout(r, 500));
      }
      return this.toolCall("check_async_task", { taskId });
    }
    return this.toolCall("start_async_task", {
      agentName: "explore-async",
      description: "In one sentence, what makes a good commit message?",
    });
  }
  private answer(content: string): ChatResult {
    return { generations: [{ text: content, message: new AIMessage({ content }) }] };
  }
  private toolCall(name: string, args: Record<string, unknown>): ChatResult {
    this.callId += 1;
    return {
      generations: [
        {
          text: "",
          message: new AIMessage({
            content: "",
            tool_calls: [{ id: `call_${this.callId}`, name, args }],
          }),
        },
      ],
    };
  }
}

async function startServer(): Promise<string> {
  const sub = new Hono();
  sub.use("*", async (c, next) => {
    if (c.req.header(RUN_INTERNAL_TOKEN_HEADER) !== TOKEN) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
  registerAsyncRunsRoutes(sub, store, {
    enqueue: (job) => {
      createdThreads.push(job.threadId);
      return enqueueRun(queue, job);
    },
  });
  const app = new Hono();
  app.route("/internal/async-runs", sub);
  const port = await new Promise<number>((resolve) => {
    server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      (info) => resolve(info.port),
    );
  });
  return `http://127.0.0.1:${port}/internal/async-runs`;
}

test.skipIf(!ENABLED)(
  "a real delegate model runs through the async loop and its result surfaces via check",
  async () => {
    const baseUrl = await startServer();
    const agent = createDeepAgent({
      model: new ScriptedParent() as never,
      tools: [],
      checkpointer: new MemorySaver(),
      subagents: buildAsyncDelegates(baseUrl, CONTEXT, TOKEN),
    } as never);

    const result = (await (
      agent as never as {
        invoke: (i: unknown, c: unknown) => Promise<{ messages: BaseMessage[] }>;
      }
    ).invoke(
      { messages: [new HumanMessage("investigate in the background")] },
      { configurable: { thread_id: "smoke_parent" }, recursionLimit: 12 },
    )) as { messages: BaseMessage[] };

    // check_async_task returned success — its JSON carries the real delegate's
    // answer, surfaced back into the parent conversation.
    const checkMsg = result.messages
      .filter((m) => messageType(m) === "tool")
      .map((m) => String((m as { content?: unknown }).content ?? ""))
      .find((c) => c.includes('"status":"success"'));
    assert.ok(checkMsg, "check_async_task did not report success");
    const parsed = JSON.parse(checkMsg) as { result?: string };
    assert.ok(
      typeof parsed.result === "string" && parsed.result.trim().length > 0,
      `the real delegate produced a non-empty result; got: ${checkMsg}`,
    );
  },
  120_000,
);
