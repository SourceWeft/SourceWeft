import assert from "node:assert/strict";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import type { AgentMiddleware } from "langchain";
import { afterEach, beforeEach, test, vi } from "vitest";
import { z } from "zod";
import { logger } from "../../../../shared/logger";
import { ModelGatewayError } from "../../../../shared/model-gateway/errors";
import { createPreparedThreadTurn } from "../../../../test/prepared-turn";
import { collectMessageStreamEvents } from "../../../../test/turn-stream-collectors";
import {
  createSourceWeftModelRetryMiddleware,
  MODEL_CALL_RETRY_EVENT,
} from "../middleware/model-call-observability";
import type { DeepAgentTurnEvent } from "./events";
import { createTurnRuntime } from "./turn-runtime";
import {
  adaptMessagesEvent,
  adaptToolArgDelta,
  adoptV3RunStream,
} from "./v3-protocol";

/**
 * A chat model that streams the way the gateway's DeepSeek/openai-compatible
 * adapters do: reasoning deltas first, then text deltas, then tool-call arg
 * chunks, each as its own AIMessageChunk. `failBeforeFirstChunk` makes an
 * attempt throw before yielding anything (the first-token timeout case the
 * retry exists for).
 */
type Turn =
  | {
      reasoning: string[];
      text: string[];
      toolCall?: { id: string; name: string; argChunks: string[] };
      /** Throw after this many reasoning chunks have been yielded. */
      failAfterReasoningChunks?: number;
    }
  | { throwError: () => Error };

class StreamingScriptedChatModel extends BaseChatModel {
  readonly turns: Turn[];
  calls = 0;

  constructor(turns: Turn[], params: BaseChatModelParams = {}) {
    super(params);
    this.turns = turns;
  }

  _llmType() {
    return "streaming-scripted";
  }

  bindTools() {
    return this;
  }

  private nextTurn() {
    const turn = this.turns[this.calls] ?? this.turns.at(-1);
    this.calls += 1;
    if (!turn) throw new Error("no scripted turn left");
    if ("throwError" in turn) throw turn.throwError();
    return turn;
  }

  /**
   * Core's `convertChunksToEvents` keys array content blocks by `index` and
   * emits the first chunk of a block as `content-block-start`, later chunks as
   * deltas. Open each block with an empty chunk so every fragment streams as a
   * delta, which is the shape core's openai completions converter produces
   * for `reasoning_content` in production.
   */
  async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    const turn = this.nextTurn();
    let reasoningChunks = 0;
    for (const reasoning of ["", ...turn.reasoning]) {
      if (reasoningChunks === turn.failAfterReasoningChunks) throw timeout();
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: [{ type: "reasoning", reasoning, index: 0 }],
        }),
      });
      if (reasoning.length > 0) reasoningChunks += 1;
    }
    for (const text of ["", ...turn.text]) {
      yield new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({
          content: [{ type: "text", text, index: 1 }],
        }),
      });
    }
    if (turn.toolCall) {
      let index = 0;
      for (const args of turn.toolCall.argChunks) {
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: "",
            tool_call_chunks: [
              {
                type: "tool_call_chunk",
                index: 2,
                ...(index === 0
                  ? { id: turn.toolCall.id, name: turn.toolCall.name }
                  : {}),
                args,
              },
            ],
          }),
        });
        index += 1;
      }
    }
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({
        content: "",
        response_metadata: {
          finish_reason: turn.toolCall ? "tool_calls" : "stop",
        },
      }),
    });
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    let aggregate: AIMessageChunk | undefined;
    for await (const chunk of this._streamResponseChunks()) {
      const message = chunk.message as AIMessageChunk;
      aggregate = aggregate
        ? (aggregate.concat(message) as AIMessageChunk)
        : message;
    }
    const message = new AIMessage({
      content: aggregate?.text ?? "",
      tool_calls: aggregate?.tool_calls ?? [],
      response_metadata: aggregate?.response_metadata ?? {},
    });
    return { generations: [{ text: message.text, message }] };
  }
}

const probe = tool(async () => "verified", {
  name: "probe",
  description: "verify",
  schema: z.object({ query: z.string() }),
});

const SCRIPT: Turn[] = [
  {
    reasoning: ["Let me ", "check the ", "sources."],
    text: ["I will ", "verify first."],
    toolCall: {
      id: "call-probe",
      name: "probe",
      argChunks: ['{"query":', '"alpha"}'],
    },
  },
  {
    reasoning: ["Verified."],
    text: ["Here is ", "the answer."],
  },
];

const timeout = () =>
  new ModelGatewayError({
    code: "TIMEOUT",
    message: "LLM request timed out",
    provider: "deepseek",
  });

type Observed = {
  /** Raw v3 `messages` protocol events, reduced to the fields the runner reads. */
  protocol: unknown[];
  /** DeepAgentTurnEvents the production message handler yields from them. */
  turn: unknown[];
  argDeltas: unknown[];
  calls: number;
  assistantContent: string;
  modelReasoning: string;
};

async function observe(input: {
  turns: Turn[];
  middleware: AgentMiddleware[];
  thread: string;
}): Promise<Observed> {
  const model = new StreamingScriptedChatModel(input.turns);
  const agent = createDeepAgent({
    model,
    tools: [probe],
    middleware: input.middleware,
    checkpointer: new MemorySaver(),
  }) as unknown as {
    streamEvents(input: unknown, options: unknown): Promise<unknown>;
  };
  const runtime = createTurnRuntime({
    prepared: createPreparedThreadTurn({ runTraceId: input.thread }),
  });
  const stream = adoptV3RunStream(
    await agent.streamEvents(
      { messages: [new HumanMessage("Verify and answer.")] },
      { version: "v3", configurable: { thread_id: input.thread } },
    ),
  );
  const protocol: unknown[] = [];
  const turn: DeepAgentTurnEvent[] = [];
  const argDeltas: unknown[] = [];
  for await (const event of stream) {
    if (event.method !== "messages") continue;
    const data = event.params?.data as Record<string, unknown>;
    const delta = data.delta as Record<string, unknown> | undefined;
    protocol.push({
      event: data.event,
      ...(delta
        ? {
            delta:
              delta.type === "block-delta"
                ? { type: delta.type, fields: delta.fields }
                : delta,
          }
        : {}),
    });
    for (const payload of adaptMessagesEvent(data)) {
      turn.push(
        ...(await collectMessageStreamEvents({
          payload,
          commandSuccessCriteria: { kind: "none" },
          runtime,
          suppressModelReasoning: false,
        })),
      );
    }
    const argDelta = adaptToolArgDelta(data);
    if (argDelta) argDeltas.push(argDelta);
  }
  await stream.output;
  return {
    protocol,
    // Segment ids/durations are per-run; compare the user-visible shape.
    turn: turn.map((event) =>
      event.type === "reasoning"
        ? { type: "reasoning", reasoning: event.reasoning }
        : event,
    ),
    argDeltas,
    calls: model.calls,
    assistantContent: runtime.assistantContent,
    modelReasoning: runtime.modelReasoning ?? "",
  };
}

const spyWarn = () =>
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
let warn: ReturnType<typeof spyWarn>;
beforeEach(() => {
  warn = spyWarn();
});
afterEach(() => {
  warn.mockRestore();
});

const fastRetry = () =>
  createSourceWeftModelRetryMiddleware({
    context: { threadId: "thread-seq", runId: "run-seq" },
    retry: { initialDelayMs: 0, jitter: false },
  });

test("the retry middleware bundle leaves the streamed v3 event sequence byte-identical", async () => {
  const baseline = await observe({
    turns: SCRIPT,
    middleware: [],
    thread: "seq-baseline",
  });
  const withRetry = await observe({
    turns: SCRIPT,
    middleware: fastRetry(),
    thread: "seq-with-retry",
  });

  // The baseline itself must exercise every delta kind the runner consumes.
  assert.deepEqual(
    baseline.turn.map((event) => (event as { type: string }).type),
    [
      "reasoning",
      "reasoning",
      "reasoning",
      "text-delta",
      "text-delta",
      "reasoning",
      "text-delta",
      "text-delta",
    ],
  );
  assert.equal(baseline.argDeltas.length, 2);
  assert.equal(
    baseline.assistantContent,
    "I will verify first.Here is the answer.",
  );
  assert.equal(baseline.modelReasoning, "Let me check the sources.Verified.");
  assert.ok(
    baseline.protocol.some(
      (event) =>
        (event as { delta?: { type?: string } }).delta?.type ===
        "reasoning-delta",
    ),
  );

  assert.deepEqual(withRetry, baseline);
  assert.equal(warn.mock.calls.length, 0);
});

test("a first-token timeout retried inside the step produces the same event sequence as a clean run", async () => {
  const baseline = await observe({
    turns: SCRIPT,
    middleware: fastRetry(),
    thread: "seq-clean",
  });
  const retried = await observe({
    turns: [{ throwError: timeout }, ...SCRIPT],
    middleware: fastRetry(),
    thread: "seq-retried",
  });

  assert.equal(retried.calls, baseline.calls + 1);
  assert.deepEqual(
    { ...retried, calls: undefined },
    { ...baseline, calls: undefined },
  );
  const retries = warn.mock.calls.filter(
    (call) => call[0] === MODEL_CALL_RETRY_EVENT,
  );
  assert.equal(retries.length, 1);
  assert.equal(
    (retries[0]?.[1] as { errorCode?: string }).errorCode,
    "MODEL_TIMEOUT",
  );
});

test("characterization: an attempt that dies mid-stream leaks its partial deltas before the retried attempt replays in full", async () => {
  // Documents today's behaviour rather than endorsing it: the gateway's idle
  // watchdog aborts a stream that already surfaced some reasoning, LangChain
  // retries the whole call, and the client sees the fragment twice. Bounding
  // that duplication is B4 (reasoning persistence), out of scope here.
  const clean = await observe({
    turns: SCRIPT,
    middleware: fastRetry(),
    thread: "seq-midstream-clean",
  });
  const retried = await observe({
    turns: [{ ...SCRIPT[0]!, failAfterReasoningChunks: 1 }, ...SCRIPT],
    middleware: fastRetry(),
    thread: "seq-midstream-retried",
  });
  assert.equal(retried.calls, clean.calls + 1);
  assert.deepEqual(
    retried.turn.map((event) => (event as { type: string }).type),
    [
      "reasoning",
      ...clean.turn.map((event) => (event as { type: string }).type),
    ],
  );
  // The leaked fragment reaches the client as its own reasoning event (and
  // render block); the accumulated text only matches because the replayed
  // first fragment is byte-identical and appendReasoningChunk collapses an
  // identical chunk. Any other split would duplicate it.
  assert.equal(retried.modelReasoning, clean.modelReasoning);
  assert.equal(retried.assistantContent, clean.assistantContent);
  assert.equal(
    warn.mock.calls.filter((call) => call[0] === MODEL_CALL_RETRY_EVENT).length,
    1,
  );
});
