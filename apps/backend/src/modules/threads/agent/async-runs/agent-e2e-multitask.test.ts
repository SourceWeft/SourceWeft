/**
 * Agent E2E (Layer 2) — the multitask verbs: `update_async_task` (E4) and
 * `cancel_async_task` (E5). Proves deepagents' async tools drive OUR endpoint's
 * double-texting / cancel semantics over real HTTP.
 *
 * No consuming worker here (no-op enqueue): the runs stay in their created state
 * so the interrupt / cancel transitions are asserted deterministically, without
 * worker timing. The happy-path (start → worker → check) is covered by
 * agent-e2e.test.ts; the store's multitask/cancel logic by the store tests. This
 * fills the gap between them: deepagents' verbs → our routes. Self-skips without
 * DATABASE_URL.
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
import { buildAsyncDelegates } from "./async-subagents";
import { RUN_INTERNAL_TOKEN_HEADER } from "./run-context-header";
import { registerAsyncRunsRoutes } from "../../../../api/routes/async-runs";
import type { RunContextConfig } from "./types";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresRunsStore(pool);
const TOKEN = "test-multitask-token";
const createdThreads: string[] = [];
let server: ReturnType<typeof serve> | undefined;

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

afterAll(async () => {
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

/**
 * Drives start_async_task, then one follow-up verb (update or cancel), then a
 * final answer — branching purely on the tool messages it sees.
 */
class MultitaskDrivingModel extends BaseChatModel {
  private callId = 0;
  constructor(
    private readonly secondVerb: "update" | "cancel",
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }
  _llmType() {
    return "multitask-driving";
  }
  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const toolMsgs = messages
      .filter((m) => messageType(m) === "tool")
      .map((m) => String((m as { content?: unknown }).content ?? ""));
    const launched = toolMsgs.find((c) => c.includes("Launched async subagent"));
    const followedUp = toolMsgs.some(
      (c) => c.includes("Updated async subagent") || c.includes("Cancelled async subagent"),
    );

    if (followedUp) {
      return this.answer("Done.");
    }
    if (launched) {
      const taskId = /taskId:\s*(\S+)/.exec(launched)?.[1];
      assert.ok(taskId, "start_async_task did not return a taskId");
      return this.secondVerb === "update"
        ? this.toolCall("update_async_task", {
            taskId,
            message: "also cover the refresh-token path",
          })
        : this.toolCall("cancel_async_task", { taskId });
    }
    return this.toolCall("start_async_task", {
      agentName: "explore-async",
      description: "investigate the auth flow",
    });
  }

  private answer(content: string): ChatResult {
    return { generations: [{ text: content, message: new AIMessage({ content }) }] };
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

let cachedBaseUrl = "";
async function startServer(): Promise<string> {
  if (cachedBaseUrl) return cachedBaseUrl;
  const sub = new Hono();
  sub.use("*", async (c, next) => {
    if (c.req.header(RUN_INTERNAL_TOKEN_HEADER) !== TOKEN) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
  // No consuming worker: runs stay in their created state for deterministic
  // transition assertions.
  registerAsyncRunsRoutes(sub, store, { enqueue: async () => {} });
  const app = new Hono();
  app.route("/internal/async-runs", sub);
  const port = await new Promise<number>((resolve) => {
    server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      (info) => resolve(info.port),
    );
  });
  cachedBaseUrl = `http://127.0.0.1:${port}/internal/async-runs`;
  return cachedBaseUrl;
}

async function runParent(verb: "update" | "cancel", baseUrl: string): Promise<void> {
  const agent = createDeepAgent({
    model: new MultitaskDrivingModel(verb) as never,
    tools: [],
    checkpointer: new MemorySaver(),
    subagents: buildAsyncDelegates(baseUrl, CONTEXT, TOKEN),
  } as never);
  await (
    agent as never as { invoke: (i: unknown, c: unknown) => Promise<unknown> }
  ).invoke(
    { messages: [new HumanMessage("investigate in the background")] },
    { configurable: { thread_id: `multitask_${verb}` }, recursionLimit: 24 },
  );
}

test.skipIf(!process.env.DATABASE_URL)(
  "E4: update_async_task interrupts the active run and starts a new one",
  async () => {
    await store.ensureSchema();
    const baseUrl = await startServer();
    // Capture the thread id the endpoint mints by wrapping createThread.
    const originalCreateThread = store.createThread.bind(store);
    let delegateThreadId = "";
    store.createThread = async () => {
      const t = await originalCreateThread();
      delegateThreadId = t.threadId;
      return t;
    };

    await runParent("update", baseUrl);
    store.createThread = originalCreateThread;
    createdThreads.push(delegateThreadId);

    const runs = await store.listRuns(delegateThreadId);
    assert.equal(runs.length, 2, "start + update create two runs");
    assert.equal(runs[0]?.status, "interrupted", "the first run is superseded");
    assert.equal(runs[1]?.status, "running", "the update's run takes over");
    assert.equal(runs[1]?.multitaskStrategy, "interrupt");
  },
);

test.skipIf(!process.env.DATABASE_URL)(
  "E5: cancel_async_task cancels the running delegate",
  async () => {
    await store.ensureSchema();
    const baseUrl = await startServer();
    const originalCreateThread = store.createThread.bind(store);
    let delegateThreadId = "";
    store.createThread = async () => {
      const t = await originalCreateThread();
      delegateThreadId = t.threadId;
      return t;
    };

    await runParent("cancel", baseUrl);
    store.createThread = originalCreateThread;
    createdThreads.push(delegateThreadId);

    const runs = await store.listRuns(delegateThreadId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "cancelled");
  },
);
