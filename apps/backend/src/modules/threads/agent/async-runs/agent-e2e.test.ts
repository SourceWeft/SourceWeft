/**
 * Agent E2E (Layer 2 of the async-runs E2E plan): prove deepagents' auto-wired
 * async middleware actually drives OUR endpoint end-to-end. Unlike the endpoint
 * E2E (which calls the routes with raw HTTP), here the real langgraph-sdk
 * `Client` inside deepagents talks to a real HTTP server we serve — exercising
 * the paths, the tenancy + internal-token headers, and check_async_task reading
 * our getThreadState result.
 *
 * A scripted parent model drives start_async_task → check_async_task; a real
 * BullMQ worker with a stub executor returns the delegate's final state. No
 * model API key. Self-skips without DATABASE_URL.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
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
import { createDeepAgent } from "deepagents";
import { PostgresRunsStore } from "./postgres-store";
import { createRunQueue, createRunWorker, enqueueRun } from "./run-queue";
import { buildAsyncDelegates } from "./async-subagents";
import { RUN_INTERNAL_TOKEN_HEADER } from "./run-context-header";
import { registerAsyncRunsRoutes } from "../../../../api/routes/async-runs";
import type { RunContextConfig } from "./types";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresRunsStore(pool);
const TOKEN = "test-agent-e2e-token";
const QUEUE = `async-runs-agent-e2e-${process.pid}`;
const queue = createRunQueue(QUEUE);
const DELEGATE_REPORT = "explore report: the auth flow lives in auth/session.ts";

const CONTEXT: RunContextConfig = {
  teamId: "team_1",
  workspaceId: "ws_1",
  userId: "user_1",
  modelAlias: "chat-default",
  providerModel: "deepseek-chat",
  profileAlias: "default",
  gatewayConfigId: "gw_1",
  parentThreadId: "thread_parent",
};

// Stub delegate executor (Layer 2 focuses on the endpoint↔deepagents seam; the
// real delegate graph is covered by delegate-*.test.ts). Returns a final state
// whose last message is what check_async_task should surface to the parent.
const worker = createRunWorker({
  queueName: QUEUE,
  store,
  executor: async () => ({
    messages: [{ role: "assistant", content: DELEGATE_REPORT }],
  }),
});

let server: ReturnType<typeof serve> | undefined;

afterAll(async () => {
  await worker.close();
  await queue.close();
  server?.close();
  await pool.end();
});

function messageType(m: BaseMessage): string {
  const anyM = m as unknown as { getType?: () => string; _getType?: () => string };
  return anyM.getType?.() ?? anyM._getType?.() ?? "";
}

/**
 * Drives the async loop by inspecting the running message history:
 *  - no task launched yet  → call start_async_task
 *  - launched, not checked → wait for the run to finish, then check_async_task
 *  - check returned success → emit the final answer
 * Waiting on the store before checking makes the single check deterministic
 * (deepagents tells the model never to poll check in a loop).
 */
class AsyncDrivingModel extends BaseChatModel {
  private callId = 0;
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType() {
    return "async-driving";
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
      return this.answer("The delegate finished; result collected.");
    }
    if (launched) {
      const taskId = /taskId:\s*(\S+)/.exec(launched)?.[1];
      assert.ok(taskId, "start_async_task did not return a taskId");
      // Wait until the worker has persisted the result (success), so the single
      // check is deterministic.
      const deadline = Date.now() + 10_000;
      for (;;) {
        if ((await store.getThreadState(taskId)) !== null) break;
        if (Date.now() > deadline) throw new Error("delegate never completed");
        await new Promise((r) => setTimeout(r, 100));
      }
      return this.toolCall("check_async_task", { taskId });
    }
    return this.toolCall("start_async_task", {
      agentName: "explore-async",
      description: "investigate the auth flow",
    });
  }

  private answer(content: string): ChatResult {
    return {
      generations: [{ text: content, message: new AIMessage({ content }) }],
    };
  }
  private toolCall(name: string, args: Record<string, unknown>): ChatResult {
    this.callId += 1;
    const message = new AIMessage({
      content: "",
      tool_calls: [{ id: `call_${this.callId}`, name, args }],
    });
    return { generations: [{ text: "", message }] };
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
  registerAsyncRunsRoutes(sub, store, { enqueue: (job) => enqueueRun(queue, job) });
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

test.skipIf(!process.env.DATABASE_URL)(
  "deepagents async tools drive our endpoint: start → run → check surfaces the result",
  async () => {
    await store.ensureSchema();
    const baseUrl = await startServer();

    const agent = createDeepAgent({
      model: new AsyncDrivingModel() as never,
      tools: [],
      checkpointer: new MemorySaver(),
      subagents: buildAsyncDelegates(baseUrl, CONTEXT, TOKEN),
    } as never);

    const result = (await (
      agent as never as {
        invoke: (i: unknown, c: unknown) => Promise<{ messages: BaseMessage[] }>;
      }
    ).invoke(
      { messages: [new HumanMessage("look into the auth flow in the background")] },
      { configurable: { thread_id: "agent_e2e_parent" }, recursionLimit: 24 },
    )) as { messages: BaseMessage[] };

    // The delegate's report reached the parent THROUGH deepagents' check_async_task
    // reading our getThreadState — the whole seam, headers included.
    const surfaced = result.messages.some((m) =>
      String((m as { content?: unknown }).content ?? "").includes(DELEGATE_REPORT),
    );
    assert.ok(
      surfaced,
      `expected the delegate report to surface via check_async_task; messages: ${result.messages
        .map((m) => `${messageType(m)}:${String((m as { content?: unknown }).content ?? "").slice(0, 60)}`)
        .join(" | ")}`,
    );
  },
);
