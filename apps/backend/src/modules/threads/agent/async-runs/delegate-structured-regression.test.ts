/**
 * Regression for the DeepSeek structured-output 400: run the REAL explore
 * delegate graph (which sets `responseFormat`) on a REAL DeepSeek model, end to
 * end through createDelegateRunExecutor → createDelegateGraph. Before the
 * capability fix this threw `400 This response_format type is unavailable now`;
 * now the bridge applies functionCalling + thinking-off from capabilities, so it
 * completes.
 *
 * Opt-in: RUN_REAL_MODEL_SMOKE=1 + OPENROUTER_API_KEY (real model calls).
 */
import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { StateBackend } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import {
  ensureModelConfigAvailable,
  syncGlobalModelGatewayConfig,
} from "../../../../shared/model-gateway/index";
import { createRawAgentChatModel } from "../../../../shared/model-gateway/internal/raw";
import { createDelegateRunExecutor } from "./delegate-executor";
import type { RunContextResolver } from "./delegate-executor";
import type { RunRecord } from "./types";

const ENABLED = Boolean(
  process.env.RUN_REAL_MODEL_SMOKE && process.env.OPENROUTER_API_KEY,
);

const resolver: RunContextResolver = async () => ({
  model: await createRawAgentChatModel({ modelAlias: "chat-default" }),
  backend: new StateBackend() as never,
  availableTools: [],
  checkpointer: new MemorySaver(),
  input: {
    messages: [
      {
        role: "user",
        content:
          "In one sentence, summarize what makes a good git commit message.",
      },
    ],
  },
});

const RUN: RunRecord = {
  runId: "run_reg",
  threadId: "thread_reg",
  graphId: "explore",
  status: "running",
  multitaskStrategy: "reject",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeAll(async () => {
  if (!ENABLED) return;
  await syncGlobalModelGatewayConfig({ syncPricing: false });
  await ensureModelConfigAvailable();
});

test.skipIf(!ENABLED)(
  "the real explore delegate (responseFormat) runs on real DeepSeek without the 400",
  async () => {
    const execute = createDelegateRunExecutor(resolver);
    const finalState = (await execute(RUN, new AbortController().signal)) as {
      messages?: unknown[];
    };
    assert.ok(
      finalState && Array.isArray(finalState.messages) && finalState.messages.length > 0,
      `expected a final state with messages; got ${JSON.stringify(finalState)?.slice(0, 200)}`,
    );
  },
  120_000,
);
