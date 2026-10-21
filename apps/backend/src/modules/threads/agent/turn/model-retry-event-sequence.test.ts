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
import { createDeepAgent, type SubAgent } from "deepagents";
import { createMiddleware, type AgentMiddleware } from "langchain";
import { afterEach, beforeEach, test, vi } from "vitest";
import { z } from "zod";
import { logger } from "../../../../shared/logger";
import { ModelGatewayError } from "../../../../shared/model-gateway/errors";
import { createPreparedThreadTurn } from "../../../../test/prepared-turn";
import {
  collectCustomStreamEvents,
  collectMessageStreamEvents,
} from "../../../../test/turn-stream-collectors";
import { mapDeepAgentEventToSse } from "../../stream";
import {
  createSourceWeftModelRetryMiddleware,
  MODEL_CALL_RETRY_EVENT,
} from "../middleware/model-call-observability";
import { ScriptedChatModel } from "../../../../test/chat-model";
import type { DeepAgentTurnEvent } from "./events";
import { isSubagentNamespace } from "./subagent-namespace";
import { createTurnRuntime } from "./turn-runtime";
import { handleToolArgDeltaChunk } from "./tool-arg-stream-handler";
import {
  adaptMessagesEvent,
  adaptToolArgDelta,
  adoptV3RunStream,
  unwrapCustomEvent,
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
      /**
       * Throw (the gateway's idle-watchdog error) after this many content
       * chunks — reasoning, text and tool-arg fragments counted in stream
       * order — have been yielded.
       */
      failAfterChunks?: number;
      /**
       * Finish with the provider's output-limit reason instead of the natural
       * one (`tool_calls` / `stop`): the #338 shape, where a tool call cut by
       * `max_tokens` still aggregates into a valid-looking `tool_calls` entry.
       */
      finishReason?: "length";
    }
  | { throwError: () => Error };

class StreamingScriptedChatModel extends BaseChatModel {
  readonly turns: Turn[];
  calls = 0;
  /** The finish reason the turn being streamed asked for, if overridden. */
  private activeFinishReason: "length" | undefined;

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
    this.activeFinishReason = turn.finishReason;
    return turn;
  }

  /**
   * Core's generic chunk-to-event bridge (`compat.convertChunksToEvents`)
   * hardcodes `message-finish` as `reason: "stop"` and drops the chunks'
   * `response_metadata`. The production path does not: `ChatOpenAI` streams
   * protocol events through core's `convertOpenAICompletionsStream`, whose
   * `message-finish` carries the provider's mapped reason (`"length"`) and
   * `responseMetadata.finish_reason`. Mirror that for a `length` turn so the
   * assembled AIMessage the middleware sees has the production shape.
   */
  async *_streamChatModelEvents(
    ...args: Parameters<BaseChatModel["_streamChatModelEvents"]>
  ): ReturnType<BaseChatModel["_streamChatModelEvents"]> {
    for await (const event of super._streamChatModelEvents(...args)) {
      if (event.event === "message-finish" && this.activeFinishReason) {
        yield {
          ...event,
          reason: this.activeFinishReason,
          responseMetadata: { finish_reason: this.activeFinishReason },
        };
        continue;
      }
      yield event;
    }
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
    let chunks = 0;
    const guard = () => {
      if (chunks === turn.failAfterChunks) throw idleTimeout();
    };
    for (const reasoning of ["", ...turn.reasoning]) {
      guard();
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: [{ type: "reasoning", reasoning, index: 0 }],
        }),
      });
      if (reasoning.length > 0) chunks += 1;
    }
    for (const text of ["", ...turn.text]) {
      guard();
      yield new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({
          content: [{ type: "text", text, index: 1 }],
        }),
      });
      if (text.length > 0) chunks += 1;
    }
    if (turn.toolCall) {
      let index = 0;
      for (const args of turn.toolCall.argChunks) {
        guard();
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
        chunks += 1;
      }
    }
    guard();
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({
        content: "",
        response_metadata: {
          finish_reason:
            turn.finishReason ?? (turn.toolCall ? "tool_calls" : "stop"),
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

/** Every argument set the probe tool was actually invoked with. */
const probeInvocations: unknown[] = [];
const probe = tool(
  async (input: { query: string }) => {
    probeInvocations.push(input);
    return "verified";
  },
  {
    name: "probe",
    description: "verify",
    schema: z.object({ query: z.string() }),
  },
);

const FIRST_DECISION = {
  reasoning: ["Let me ", "check the ", "sources."],
  text: ["I will ", "verify first."],
  toolCall: {
    id: "call-probe",
    name: "probe",
    argChunks: ['{"query":', '"alpha"}'],
  },
} satisfies Turn;

const SCRIPT: Turn[] = [
  FIRST_DECISION,
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

/** The gateway's per-chunk watchdog (B3); maps to MODEL_TIMEOUT like `timeout`. */
const idleTimeout = () =>
  new ModelGatewayError({
    code: "STREAM_IDLE_TIMEOUT",
    message: "No stream data for 120000 ms",
    provider: "deepseek",
  });

const SEGMENT_RESET_EMPTY = {
  type: "segment-reset",
  reason: "model_call_retry",
  attempt: 2,
  segmentIds: [],
  toolCallIds: [],
  keepTextChars: 0,
  keepReasoningChars: 0,
  dropTextChars: 0,
  dropReasoningChars: 0,
} as const;

type Observed = {
  /** Raw v3 `messages` protocol events, reduced to the fields the runner reads. */
  protocol: unknown[];
  /**
   * DeepAgentTurnEvents the production message + custom handlers yield from
   * them, with per-run ids normalised (see `observe`).
   */
  turn: unknown[];
  /** The same events, unnormalised. */
  raw: DeepAgentTurnEvent[];
  /** SSE frames `mapDeepAgentEventToSse` produced for `raw`. */
  sse: unknown[];
  argDeltas: unknown[];
  calls: number;
  assistantContent: string;
  modelReasoning: string;
  /** The runtime's reasoning segments once the stream drained. */
  segments: Array<{ id: string; text: string }>;
  renderBlocks: unknown[];
  /** Tool-call ids still held by the streamed tool-arg buffers. */
  pendingToolArgIds: Array<string | undefined>;
  /**
   * Every v3 event and every turn event in arrival order, as
   * `messages:<event>`, `custom:<type>`, `tools:<event>:<tool_call_id>` and
   * `turn:<type>`, so a test can assert what streams before what.
   */
  timeline: string[];
};

/**
 * The run-independent view two observations are compared on. Segment ids are
 * left out: the retry bundle itself closes the open segment at every model
 * call (`model-call-begin`), so a run without it numbers segments differently.
 */
function comparable(observed: Observed) {
  const { protocol, turn, argDeltas, assistantContent, modelReasoning } =
    observed;
  return {
    protocol,
    turn: turn.map((event) =>
      (event as { type: string }).type === "reasoning"
        ? { ...(event as object), segmentId: undefined }
        : event,
    ),
    argDeltas,
    assistantContent,
    modelReasoning,
  };
}

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
  const timeline: string[] = [];
  const emit = (events: DeepAgentTurnEvent[]) => {
    for (const event of events) {
      turn.push(event);
      timeline.push(`turn:${event.type}`);
    }
  };
  for await (const event of stream) {
    if (event.method === "custom") {
      const payload = unwrapCustomEvent(event.params?.data);
      timeline.push(`custom:${String((payload as { type?: unknown }).type)}`);
      emit(await collectCustomStreamEvents({ payload, runtime }));
      continue;
    }
    if (event.method === "tools") {
      const data = event.params?.data as Record<string, unknown>;
      timeline.push(`tools:${String(data.event)}:${String(data.tool_call_id)}`);
      continue;
    }
    if (event.method !== "messages") continue;
    const data = event.params?.data as Record<string, unknown>;
    timeline.push(`messages:${String(data.event)}`);
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
      emit(
        await collectMessageStreamEvents({
          payload,
          commandSuccessCriteria: { kind: "none" },
          runtime,
          suppressModelReasoning: false,
        }),
      );
    }
    // The runner feeds the same chunk to the tool-arg streamer right after the
    // message handler (runner.ts), which is what fills the pending buffers a
    // reset must clear.
    const argDelta = adaptToolArgDelta(data);
    if (argDelta) {
      argDeltas.push(argDelta);
      emit([...handleToolArgDeltaChunk({ delta: argDelta, runtime })]);
    }
  }
  await stream.output;
  const normaliseId = (id: string) => id.replace(input.thread, "<run>");
  return {
    protocol,
    // Segment ids/durations are per-run; compare the user-visible shape.
    turn: turn.map((event) =>
      event.type === "reasoning"
        ? {
            type: "reasoning",
            reasoning: event.reasoning,
            segmentId: normaliseId(event.segment.id),
          }
        : event.type === "segment-reset"
          ? { ...event, segmentIds: event.segmentIds.map(normaliseId) }
          : event,
    ),
    raw: turn,
    sse: turn.flatMap((event) => {
      if (event.type === "done") return [];
      const frame = mapDeepAgentEventToSse(event, "text-1");
      return frame === null ? [] : [JSON.parse(frame.replace(/^data: /, ""))];
    }),
    argDeltas,
    calls: model.calls,
    assistantContent: runtime.assistantContent,
    modelReasoning: runtime.modelReasoning ?? "",
    segments: runtime.reasoningSegments.map((segment) => ({
      id: normaliseId(segment.id),
      text: segment.text,
    })),
    // Reasoning block durations are wall-clock; ids are per-run.
    renderBlocks: runtime.renderBlocks.list().map((block) => {
      const { durationMs: _durationMs, ...rest } = block as {
        durationMs?: number;
      } & typeof block;
      return { ...rest, id: normaliseId(block.id) };
    }),
    pendingToolArgIds: [...runtime.partialToolArgsBySlot.values()].map(
      (state) => state.id,
    ),
    timeline,
  };
}

const spyWarn = () =>
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
let warn: ReturnType<typeof spyWarn>;
beforeEach(() => {
  warn = spyWarn();
  probeInvocations.length = 0;
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

  assert.deepEqual(comparable(withRetry), comparable(baseline));
  assert.ok(
    !baseline.turn.some(
      (event) => (event as { type: string }).type === "segment-reset",
    ),
  );
  assert.ok(
    !withRetry.turn.some(
      (event) => (event as { type: string }).type === "segment-reset",
    ),
  );
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
  // Nothing streamed before the failure, so the reset has nothing to withdraw;
  // it is still announced so the client can show the retry.
  assert.deepEqual(
    comparable({ ...retried, turn: retried.turn.slice(1) }),
    comparable(baseline),
  );
  assert.deepEqual(retried.turn[0], SEGMENT_RESET_EMPTY);
  assert.deepEqual(retried.segments, baseline.segments);
  assert.deepEqual(retried.renderBlocks, baseline.renderBlocks);
  const retries = warn.mock.calls.filter(
    (call) => call[0] === MODEL_CALL_RETRY_EVENT,
  );
  assert.equal(retries.length, 1);
  assert.equal(
    (retries[0]?.[1] as { errorCode?: string }).errorCode,
    "MODEL_TIMEOUT",
  );
});

test("an attempt that dies mid-stream is withdrawn by one segment-reset and the retried attempt streams under a fresh segment id", async () => {
  const clean = await observe({
    turns: SCRIPT,
    middleware: fastRetry(),
    thread: "seq-midstream-clean",
  });
  const retried = await observe({
    turns: [
      {
        reasoning: FIRST_DECISION.reasoning,
        text: ["I will "],
        // The failed attempt leaves a pending (never promoted) tool-arg buffer.
        toolCall: {
          id: "call-write",
          name: "write_file",
          argChunks: ['{"path":"notes.md",', '"content":"hel'],
        },
        // 3 reasoning + 1 text + 2 arg chunks, then the idle watchdog fires.
        failAfterChunks: 6,
      },
      ...SCRIPT,
    ],
    middleware: fastRetry(),
    thread: "seq-midstream-retried",
  });
  assert.equal(retried.calls, clean.calls + 1);

  const types = (events: unknown[]) =>
    events.map((event) => (event as { type: string }).type);
  assert.deepEqual(types(retried.turn), [
    "reasoning",
    "reasoning",
    "reasoning",
    "text-delta",
    "tool-input-delta",
    "segment-reset",
    ...types(clean.turn),
  ]);
  // Both write_file arg fragments reached the pending buffer before the
  // failure, the partial `content` streamed to the client as it was written,
  // and the reset names that call so the client can drop it.
  assert.deepEqual(
    retried.argDeltas.slice(0, 2).map((delta) => (delta as { id: string }).id),
    ["call-write", "call-write"],
  );
  const partial = retried.turn[4] as DeepAgentTurnEvent;
  assert.equal(partial.type, "tool-input-delta");
  if (partial.type === "tool-input-delta") {
    assert.equal(partial.id, "call-write");
    assert.equal(partial.input.content, "hel");
  }
  const resets = retried.turn.filter(
    (event) => (event as { type: string }).type === "segment-reset",
  );
  assert.equal(resets.length, 1);
  assert.deepEqual(resets[0], {
    type: "segment-reset",
    reason: "model_call_retry",
    attempt: 2,
    segmentIds: ["model-reasoning:<run>:1"],
    toolCallIds: ["call-write"],
    keepTextChars: 0,
    keepReasoningChars: 0,
    dropTextChars: "I will ".length,
    dropReasoningChars: "Let me check the sources.".length,
  });
  // The SSE frame carries the contract verbatim, beside the other frames.
  assert.deepEqual(
    retried.sse.filter(
      (frame) => (frame as { type: string }).type === "segment-reset",
    ),
    [
      {
        type: "segment-reset",
        reason: "model_call_retry",
        attempt: 2,
        segmentIds: ["model-reasoning:seq-midstream-retried:1"],
        toolCallIds: ["call-write"],
        keepTextChars: 0,
        keepReasoningChars: 0,
        dropTextChars: "I will ".length,
        dropReasoningChars: "Let me check the sources.".length,
      },
    ],
  );
  assert.equal(retried.sse.length, retried.turn.length);

  // The withdrawn fragment streamed under segment 1; the retried attempt opens
  // segment 2, which id 1 never reappears under, and the second model call
  // opens segment 3 (every model-call-begin closes the open segment).
  const segmentIds = (observed: Observed) =>
    observed.turn.flatMap((event) =>
      (event as { type: string }).type === "reasoning"
        ? [(event as { segmentId: string }).segmentId]
        : [],
    );
  assert.deepEqual(segmentIds(clean), [
    "model-reasoning:<run>:1",
    "model-reasoning:<run>:1",
    "model-reasoning:<run>:1",
    "model-reasoning:<run>:2",
  ]);
  assert.deepEqual(segmentIds(retried), [
    "model-reasoning:<run>:1",
    "model-reasoning:<run>:1",
    "model-reasoning:<run>:1",
    "model-reasoning:<run>:2",
    "model-reasoning:<run>:2",
    "model-reasoning:<run>:2",
    "model-reasoning:<run>:3",
  ]);

  // What the turn ends with is exactly what a clean run ends with: one
  // reasoning segment per decision, no duplicated text, no stray blocks, no
  // pending tool-arg buffer for the abandoned write_file.
  assert.equal(retried.assistantContent, clean.assistantContent);
  assert.equal(retried.modelReasoning, clean.modelReasoning);
  assert.deepEqual(
    retried.segments.map((segment) => segment.text),
    clean.segments.map((segment) => segment.text),
  );
  assert.deepEqual(
    retried.segments.map((segment) => segment.id),
    ["model-reasoning:<run>:2", "model-reasoning:<run>:3"],
  );
  assert.ok(!retried.pendingToolArgIds.includes("call-write"));
  assert.deepEqual(retried.pendingToolArgIds, clean.pendingToolArgIds);
  assert.deepEqual(
    retried.renderBlocks.map((block) => {
      const { id: _id, ...rest } = block as { id: string };
      return rest;
    }),
    clean.renderBlocks.map((block) => {
      const { id: _id, ...rest } = block as { id: string };
      return rest;
    }),
  );
  assert.equal(
    warn.mock.calls.filter((call) => call[0] === MODEL_CALL_RETRY_EVENT).length,
    1,
  );
});

test("a tool call cut by the output limit is withdrawn by a segment-reset, never executed, and the retried attempt streams clean (#338)", async () => {
  const clean = await observe({
    turns: SCRIPT,
    middleware: fastRetry(),
    thread: "seq-length-clean",
  });
  const cleanInvocations = [...probeInvocations];
  probeInvocations.length = 0;
  // Attempt 1 streams reasoning, a text fragment and a tool call whose args
  // stop mid-string; the provider closes the message with `length`. The
  // chunks aggregate into tool_calls=[{query:"al"}] (partial-JSON repair),
  // which the retry bundle's per-attempt observer rejects before the tools
  // node can see it. Attempt 2 is the clean first decision.
  const retried = await observe({
    turns: [
      {
        reasoning: FIRST_DECISION.reasoning,
        text: ["I will "],
        toolCall: {
          id: "call-cut",
          name: "probe",
          argChunks: ['{"query":', '"al'],
        },
        finishReason: "length",
      },
      ...SCRIPT,
    ],
    middleware: fastRetry(),
    thread: "seq-length-retried",
  });
  assert.equal(retried.calls, clean.calls + 1);

  // The truncated call never ran; only the clean decision's call did, once.
  assert.deepEqual(cleanInvocations, [{ query: "alpha" }]);
  assert.deepEqual(probeInvocations, cleanInvocations);

  const types = (events: unknown[]) =>
    events.map((event) => (event as { type: string }).type);
  assert.deepEqual(types(retried.turn), [
    "reasoning",
    "reasoning",
    "reasoning",
    "text-delta",
    "segment-reset",
    ...types(clean.turn),
  ]);
  // #334: the reset names the cut call so the client withdraws its streamed
  // arguments along with the attempt's reasoning and text.
  const resets = retried.turn.filter(
    (event) => (event as { type: string }).type === "segment-reset",
  );
  assert.deepEqual(resets, [
    {
      type: "segment-reset",
      reason: "model_call_retry",
      attempt: 2,
      segmentIds: ["model-reasoning:<run>:1"],
      toolCallIds: ["call-cut"],
      keepTextChars: 0,
      keepReasoningChars: 0,
      dropTextChars: "I will ".length,
      dropReasoningChars: "Let me check the sources.".length,
    },
  ]);
  assert.deepEqual(
    retried.argDeltas.slice(0, 2).map((delta) => (delta as { id: string }).id),
    ["call-cut", "call-cut"],
  );
  assert.ok(!retried.pendingToolArgIds.includes("call-cut"));
  assert.deepEqual(retried.pendingToolArgIds, clean.pendingToolArgIds);

  // What the turn ends with is exactly what a clean run ends with.
  assert.equal(retried.assistantContent, clean.assistantContent);
  assert.equal(retried.modelReasoning, clean.modelReasoning);
  assert.deepEqual(
    retried.segments.map((segment) => segment.text),
    clean.segments.map((segment) => segment.text),
  );
  assert.deepEqual(
    retried.segments.map((segment) => segment.id),
    ["model-reasoning:<run>:2", "model-reasoning:<run>:3"],
  );
  const retries = warn.mock.calls.filter(
    (call) => call[0] === MODEL_CALL_RETRY_EVENT,
  );
  assert.equal(retries.length, 1);
  assert.deepEqual(
    [
      (retries[0]?.[1] as { errorCode?: string }).errorCode,
      (retries[0]?.[1] as { gatewayCode?: string }).gatewayCode,
    ],
    ["MODEL_OUTPUT_TRUNCATED", "OUTPUT_TRUNCATED"],
  );
});

test("a length finish on a plain-text answer streams through untouched: no reset, no retry", async () => {
  const observed = await observe({
    turns: [
      {
        reasoning: ["Thinking."],
        text: ["A long answer cut sho"],
        finishReason: "length",
      },
    ],
    middleware: fastRetry(),
    thread: "seq-length-plain-text",
  });
  assert.equal(observed.calls, 1);
  assert.deepEqual(probeInvocations, []);
  assert.deepEqual(
    observed.turn.map((event) => (event as { type: string }).type),
    ["reasoning", "text-delta"],
  );
  assert.equal(observed.assistantContent, "A long answer cut sho");
  assert.equal(
    warn.mock.calls.filter((call) => call[0] === MODEL_CALL_RETRY_EVENT).length,
    0,
  );
});

test("a retry after a tool round-trip keeps everything streamed before the failed attempt", async () => {
  // Second decision: attempt 1 streams one reasoning fragment then dies;
  // attempt 2 answers in full. Only the fragment is withdrawn.
  const clean = await observe({
    turns: SCRIPT,
    middleware: fastRetry(),
    thread: "seq-second-decision-clean",
  });
  const retried = await observe({
    turns: [
      SCRIPT[0]!,
      { reasoning: ["Veri"], text: [], failAfterChunks: 1 },
      SCRIPT[1]!,
    ],
    middleware: fastRetry(),
    thread: "seq-second-decision-retried",
  });
  assert.equal(retried.calls, clean.calls + 1);

  const resetIndex = retried.turn.findIndex(
    (event) => (event as { type: string }).type === "segment-reset",
  );
  assert.ok(resetIndex > 0);
  assert.deepEqual(retried.turn[resetIndex], {
    type: "segment-reset",
    reason: "model_call_retry",
    attempt: 2,
    segmentIds: ["model-reasoning:<run>:2"],
    toolCallIds: [],
    keepTextChars: "I will verify first.".length,
    keepReasoningChars: "Let me check the sources.".length,
    dropTextChars: 0,
    dropReasoningChars: "Veri".length,
  });
  assert.deepEqual(retried.turn[resetIndex - 1], {
    type: "reasoning",
    reasoning: "Veri",
    segmentId: "model-reasoning:<run>:2",
  });
  assert.deepEqual(
    [
      ...retried.turn.slice(0, resetIndex - 1),
      ...retried.turn.slice(resetIndex + 1),
    ].map((event) =>
      (event as { type: string }).type === "reasoning"
        ? { ...(event as object), segmentId: undefined }
        : event,
    ),
    clean.turn.map((event) =>
      (event as { type: string }).type === "reasoning"
        ? { ...(event as object), segmentId: undefined }
        : event,
    ),
  );
  assert.equal(retried.assistantContent, clean.assistantContent);
  assert.equal(retried.modelReasoning, clean.modelReasoning);
  assert.deepEqual(retried.segments, [
    { id: "model-reasoning:<run>:1", text: "Let me check the sources." },
    { id: "model-reasoning:<run>:3", text: "Verified." },
  ]);
  assert.equal(
    retried.turn.filter(
      (event) => (event as { type: string }).type === "segment-reset",
    ).length,
    1,
  );
});

test("a sub-agent's retry never reaches the parent stream: no model-call events, no segment-reset", async () => {
  // Main agent: delegate once, then answer. Delegate: a streaming model whose
  // first attempt dies mid-reasoning and whose retry succeeds — with its own
  // retry bundle, so any model-call-* custom event here would be the child's.
  // A child's custom events surface under the parent's depth-1 `tools:`
  // namespace (its `messages` events are depth 2), which the runner would pass
  // through as main — so the middleware itself writes them for `main` only.
  let mainCalls = 0;
  const mainModel = new ScriptedChatModel(() => {
    mainCalls += 1;
    return mainCalls === 1
      ? new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "task-1",
              name: "task",
              args: { description: "verify alpha", subagent_type: "verifier" },
            },
          ],
        })
      : new AIMessage("Delegate confirmed.");
  });
  const childModel = new StreamingScriptedChatModel([
    { ...SCRIPT[0]!, failAfterChunks: 2 },
    ...SCRIPT,
  ]);
  const verifier: SubAgent = {
    name: "verifier",
    description: "Verifies a claim.",
    systemPrompt: "Verify the claim, then stop.",
    tools: [probe] as unknown as SubAgent["tools"],
    model: childModel,
    middleware: fastRetry(),
    interruptOn: {},
  };
  const agent = createDeepAgent({
    model: mainModel,
    tools: [],
    middleware: [],
    subagents: [verifier],
    checkpointer: new MemorySaver(),
  } as never) as unknown as {
    streamEvents(input: unknown, options: unknown): Promise<unknown>;
  };
  const runtime = createTurnRuntime({
    prepared: createPreparedThreadTurn({ runTraceId: "seq-subagent" }),
  });
  const stream = adoptV3RunStream(
    await agent.streamEvents(
      { messages: [new HumanMessage("Have the verifier check alpha.")] },
      {
        version: "v3",
        configurable: { thread_id: "seq-subagent" },
        recursionLimit: 25,
      },
    ),
  );

  const custom: Array<{ namespace: unknown[]; payload: unknown }> = [];
  const parentTurn: DeepAgentTurnEvent[] = [];
  for await (const event of stream) {
    if (event.method !== "custom") continue;
    const namespace = Array.isArray(event.params?.namespace)
      ? (event.params.namespace as unknown[])
      : [];
    const payload = unwrapCustomEvent(event.params?.data);
    custom.push({ namespace, payload });
    // The runner's rule (runner.ts): a sub-agent's non-tool events never reach
    // the parent's handlers — but see above, a child's custom events are not
    // classified as the child's, so this is the path they would take.
    if (isSubagentNamespace(namespace)) continue;
    parentTurn.push(...(await collectCustomStreamEvents({ payload, runtime })));
  }
  await stream.output;

  assert.equal(childModel.calls, 3);
  assert.deepEqual(
    custom.filter(({ payload }) =>
      String((payload as { type?: string }).type).startsWith("model-call-"),
    ),
    [],
  );
  assert.deepEqual(parentTurn, []);
  assert.equal(runtime.modelCallBoundary, null);
  assert.equal(
    warn.mock.calls.filter((call) => call[0] === MODEL_CALL_RETRY_EVENT).length,
    1,
  );
});

/**
 * What a client following the SSE sequence ends up holding: reasoning text per
 * segment id, with `segment-reset` dropping segments by id and cutting the
 * accumulated text/reasoning from the end.
 */
function replaySse(frames: unknown[]) {
  const segments = new Map<string, string>();
  let text = "";
  let reasoning = "";
  for (const raw of frames) {
    const frame = raw as Record<string, unknown>;
    if (frame.type === "text-delta") text += String(frame.delta);
    if (frame.type === "reasoning") {
      const id = (frame.segment as { id: string }).id;
      segments.set(id, (segments.get(id) ?? "") + String(frame.reasoning));
      reasoning += String(frame.reasoning);
    }
    if (frame.type === "segment-reset") {
      for (const id of frame.segmentIds as string[]) segments.delete(id);
      text = text.slice(0, text.length - Number(frame.dropTextChars));
      reasoning = reasoning.slice(
        0,
        reasoning.length - Number(frame.dropReasoningChars),
      );
    }
  }
  return { segments: [...segments.entries()], text, reasoning };
}

test("two consecutive model calls without a tool boundary: a retry in the second withdraws only its own segment", async () => {
  // Re-enter the model straight after the first call, the way the step
  // budget's `jumpTo: "model"` does (LangChain only honours the jump when the
  // decision carried tool calls, so call 1 issues one that never runs). Call 2
  // therefore begins with call 1's segment still open; its first attempt dies
  // mid-text and its retry answers.
  let reentered = false;
  const reenterOnce = createMiddleware({
    name: "ReenterModelOnce",
    afterModel: {
      canJumpTo: ["model"],
      hook: () => {
        if (reentered) return undefined;
        reentered = true;
        return { jumpTo: "model" };
      },
    },
  });
  const observed = await observe({
    turns: [
      { reasoning: ["A"], text: ["one"], toolCall: FIRST_DECISION.toolCall },
      { reasoning: ["B"], text: ["tw"], failAfterChunks: 2 },
      { reasoning: ["B2"], text: ["two"] },
    ],
    middleware: [reenterOnce, ...fastRetry()],
    thread: "seq-reenter",
  });
  assert.equal(observed.calls, 3);

  assert.deepEqual(observed.turn, [
    { type: "reasoning", reasoning: "A", segmentId: "model-reasoning:<run>:1" },
    { type: "text-delta", delta: "one" },
    { type: "reasoning", reasoning: "B", segmentId: "model-reasoning:<run>:2" },
    { type: "text-delta", delta: "tw" },
    {
      type: "segment-reset",
      reason: "model_call_retry",
      attempt: 2,
      segmentIds: ["model-reasoning:<run>:2"],
      toolCallIds: [],
      keepTextChars: "one".length,
      keepReasoningChars: "A".length,
      dropTextChars: "tw".length,
      dropReasoningChars: "B".length,
    },
    {
      type: "reasoning",
      reasoning: "B2",
      segmentId: "model-reasoning:<run>:3",
    },
    { type: "text-delta", delta: "two" },
  ]);

  // Runtime and a replaying client agree: call 1's segment intact, call 2's
  // failed segment gone, the retried one in its place.
  const expectedSegments = [
    ["model-reasoning:seq-reenter:1", "A"],
    ["model-reasoning:seq-reenter:3", "B2"],
  ];
  assert.deepEqual(
    observed.segments.map((segment) => [
      segment.id.replace("<run>", "seq-reenter"),
      segment.text,
    ]),
    expectedSegments,
  );
  assert.deepEqual(replaySse(observed.sse), {
    segments: expectedSegments,
    text: "onetwo",
    reasoning: "AB2",
  });
  assert.equal(observed.assistantContent, "onetwo");
  assert.equal(observed.modelReasoning, "AB2");
  assert.deepEqual(
    observed.renderBlocks.map((block) => {
      const { id, ...rest } = block as { id: string; type: string };
      return { ...rest, id: id.startsWith("text-") ? "text" : id };
    }),
    [
      { id: "model-reasoning:<run>:1", type: "reasoning", text: "A" },
      { id: "text", type: "text", text: "one" },
      { id: "model-reasoning:<run>:3", type: "reasoning", text: "B2" },
      { id: "text", type: "text", text: "two" },
    ],
  );
});

/** The `tool-input-delta` events of a turn, reduced to call id and content. */
function toolInputDeltas(observed: Observed) {
  return observed.raw.flatMap((event) =>
    event.type === "tool-input-delta"
      ? [{ id: event.id, content: event.input.content }]
      : [],
  );
}

const writeFileCall = (id: string, argChunks: string[]) => ({
  id,
  name: "write_file",
  argChunks,
});

test("a write_file call streams its growing content before the authoritative tool call (issue #335)", async () => {
  const observed = await observe({
    turns: [
      {
        reasoning: [],
        text: [],
        toolCall: writeFileCall("call-write", [
          '{"file_path":"/notes.md",',
          '"content":"hel',
          "lo wor",
          'ld"}',
        ]),
      },
      { reasoning: [], text: ["Done."] },
    ],
    middleware: fastRetry(),
    thread: "seq-write-stream",
  });

  // Core's v3 block-delta carries the call's ACCUMULATED args, with id and
  // name on every delta, keyed by the tool_call_chunk's index.
  assert.deepEqual(observed.argDeltas, [
    {
      index: 2,
      id: "call-write",
      name: "write_file",
      args: '{"file_path":"/notes.md",',
    },
    {
      index: 2,
      id: "call-write",
      name: "write_file",
      args: '{"file_path":"/notes.md","content":"hel',
    },
    {
      index: 2,
      id: "call-write",
      name: "write_file",
      args: '{"file_path":"/notes.md","content":"hello wor',
    },
    {
      index: 2,
      id: "call-write",
      name: "write_file",
      args: '{"file_path":"/notes.md","content":"hello world"}',
    },
  ]);

  assert.deepEqual(toolInputDeltas(observed), [
    { id: "call-write", content: "hel" },
    { id: "call-write", content: "hello wor" },
    { id: "call-write", content: "hello world" },
  ]);
  const lastPartial = observed.timeline.lastIndexOf("turn:tool-input-delta");
  const started = observed.timeline.indexOf("tools:tool-started:call-write");
  assert.ok(started > 0, "the write_file call ran");
  assert.ok(
    lastPartial >= 0 && lastPartial < started,
    "every partial streamed before the authoritative call",
  );
  // Each model call announces itself before its message stream opens.
  assert.deepEqual(
    observed.timeline.filter(
      (entry) =>
        entry === "custom:model-call-begin" ||
        entry === "messages:message-start",
    ),
    [
      "custom:model-call-begin",
      "messages:message-start",
      "custom:model-call-begin",
      "messages:message-start",
    ],
  );
});

test("successive model calls streaming write_file on the same slot each stream under their own call id (issue #335)", async () => {
  // Block indexes restart with every model call, so both calls' chunks land
  // on slot 2. With and without the retry bundle (which announces every
  // attempt), the second call must not stream under the first call's id.
  for (const [label, middleware] of [
    ["with-retry", fastRetry()],
    ["no-middleware", []],
  ] as const) {
    const observed = await observe({
      turns: [
        {
          reasoning: [],
          text: [],
          toolCall: writeFileCall("call-write-1", [
            '{"file_path":"/a.md",',
            '"content":"the first file body"}',
          ]),
        },
        {
          reasoning: [],
          text: [],
          toolCall: writeFileCall("call-write-2", [
            '{"file_path":"/b.md",',
            '"content":"sec',
            'ond"}',
          ]),
        },
        { reasoning: [], text: ["Done."] },
      ],
      middleware: [...middleware],
      thread: `seq-write-twice-${label}`,
    });
    assert.equal(observed.calls, 3, label);
    assert.deepEqual(
      toolInputDeltas(observed),
      [
        { id: "call-write-1", content: "the first file body" },
        { id: "call-write-2", content: "sec" },
        { id: "call-write-2", content: "second" },
      ],
      label,
    );
  }
});

test("a retry after a successful write_file names the failed attempt's own write_file in segment-reset (issue #335)", async () => {
  // Call 1 writes a file on slot 2 (longer args than the failed attempt
  // streams). Call 2's first attempt starts another write_file on slot 2 and
  // dies mid-args; the reset must name THAT call, not call 1's.
  const observed = await observe({
    turns: [
      {
        reasoning: ["A"],
        text: [],
        toolCall: writeFileCall("call-write-1", [
          '{"file_path":"/a.md",',
          '"content":"the first file body"}',
        ]),
      },
      {
        reasoning: ["B"],
        text: [],
        toolCall: writeFileCall("call-write-2", [
          '{"file_path":"/b.md",',
          '"content":"hel',
        ]),
        // 1 reasoning + 2 arg chunks, then the idle watchdog fires.
        failAfterChunks: 3,
      },
      { reasoning: ["B2"], text: ["Done."] },
    ],
    middleware: fastRetry(),
    thread: "seq-write-then-retry",
  });
  assert.equal(observed.calls, 3);

  const resets = observed.turn.filter(
    (event) => (event as { type: string }).type === "segment-reset",
  );
  assert.deepEqual(resets, [
    {
      type: "segment-reset",
      reason: "model_call_retry",
      attempt: 2,
      segmentIds: ["model-reasoning:<run>:2"],
      toolCallIds: ["call-write-2"],
      keepTextChars: 0,
      keepReasoningChars: "A".length,
      dropTextChars: 0,
      dropReasoningChars: "B".length,
    },
  ]);
  // The failed attempt's partial streamed under its own id before the reset.
  assert.deepEqual(toolInputDeltas(observed), [
    { id: "call-write-1", content: "the first file body" },
    { id: "call-write-2", content: "hel" },
  ]);
  assert.ok(
    observed.timeline.lastIndexOf("turn:tool-input-delta") <
      observed.timeline.indexOf("turn:segment-reset"),
  );
  // A failed attempt's message stream never finishes: no content-block-finish
  // or message-finish between its last delta and the retry.
  const retryAt = observed.timeline.indexOf("custom:model-call-retry");
  const secondStart = observed.timeline.indexOf(
    "messages:message-start",
    observed.timeline.indexOf("messages:message-start") + 1,
  );
  assert.ok(secondStart > 0 && secondStart < retryAt);
  assert.deepEqual(
    observed.timeline
      .slice(secondStart, retryAt)
      .filter((entry) => entry.endsWith("-finish")),
    [],
  );
  assert.ok(!observed.pendingToolArgIds.includes("call-write-2"));
});
