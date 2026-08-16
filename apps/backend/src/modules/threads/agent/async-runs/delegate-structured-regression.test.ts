/**
 * Regression for the DeepSeek structured-output 400: run the REAL explore/plan
 * delegate on a REAL DeepSeek model, end to end through
 * createDelegateRunExecutor → createDelegateGraph. The delegate investigates
 * read-only (no inline `responseFormat`), then the executor makes ONE dedicated
 * `model.withStructuredOutput(...).invoke(...)` call to produce the plan. Before
 * the capability fix a forced tool_choice / json_schema threw `400 This
 * response_format type is unavailable now`; now the bridge binds the schema as an
 * available tool with salvage from capabilities, so it completes and yields a
 * structured result.
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
          "Briefly plan how to add a dark-mode toggle to a small web app.",
      },
    ],
  },
});

function run(graphId: string): RunRecord {
  return {
    runId: `run_reg_${graphId}`,
    threadId: `thread_reg_${graphId}`,
    graphId,
    status: "running",
    multitaskStrategy: "reject",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeAll(async () => {
  if (!ENABLED) return;
  await syncGlobalModelGatewayConfig({ syncPricing: false });
  await ensureModelConfigAvailable();
});

// Both delegates produce a structured result via a dedicated withStructuredOutput
// call; `plan`'s schema is deeply nested (steps[] of objects), which stresses
// DeepSeek's structured output harder.
for (const graphId of ["explore", "plan"] as const) {
  test.skipIf(!ENABLED)(
    `the real ${graphId} delegate runs a dedicated structured call on real DeepSeek without the 400`,
    async () => {
      const execute = createDelegateRunExecutor(resolver);
      const finalState = (await execute(run(graphId), new AbortController().signal)) as {
        messages?: Array<{ content?: unknown }>;
        structuredResponse?: unknown;
      };
      // The delegate must actually PRODUCE its structured output (not merely
      // finish): the executor puts it on `structuredResponse` and stringifies it
      // into the last message. A dropped/failed structured call would finish with
      // no structured response.
      const structured =
        finalState?.structuredResponse ??
        (() => {
          const last = finalState?.messages?.at(-1)?.content;
          try {
            return typeof last === "string" ? JSON.parse(last) : undefined;
          } catch {
            return undefined;
          }
        })();
      assert.ok(
        structured && typeof structured === "object",
        `expected a structured ${graphId} response; got ${JSON.stringify(finalState)?.slice(0, 300)}`,
      );
    },
    120_000,
  );
}
