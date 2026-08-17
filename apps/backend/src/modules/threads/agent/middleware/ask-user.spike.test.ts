/**
 * Spike: prove the `askUser` mechanism end-to-end on the real installed stack
 * (deepagents + langchain + langgraph). The one unproven assumption was that
 * SourceWeft can `interrupt()` from *inside a tool body* and resume it with a
 * `Command`, since nothing in the app has ever done that before.
 *
 * These tests build a real deep agent with the ask-user middleware, a scripted
 * tool-calling model, and a MemorySaver checkpointer, then:
 *   1. stream until the turn pauses on an `ask_user` interrupt,
 *   2. resume with `Command({ resume: { status:"answered", answers } })`,
 *   3. assert the tool returns the Q:/A: transcript and the run completes.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import {
  modelRetryMiddleware,
  todoListMiddleware,
  toolCallLimitMiddleware,
  toolRetryMiddleware,
  type AgentMiddleware,
} from "langchain";
import {
  createAskUserMiddleware,
  isAskUserInterruptValue,
  parseAskUserAnswer,
  payloadHasAskUserInterrupt,
  ASK_USER_TOOL_NAME,
  type AskUserQuestion,
} from "./ask-user";
import { createSourceWeftToolObservabilityMiddleware } from "./tool-observability";
import {
  extractAskUserInterrupts,
  handleAskUserStreamChunk,
} from "../turn/ask-user-stream-handler";
import { createTurnRuntime } from "../turn/turn-runtime";
import type { DeepAgentTurnEvent } from "../turn/events";
import { commandResumeFromToolApprovalResume } from "../turn/hitl-handler";

/** Emits a scripted sequence of AI messages, one per model turn. */
class ScriptedChatModel extends BaseChatModel {
  private count = 0;

  constructor(
    private readonly script: Array<{ content: string; toolCalls?: unknown[] }>,
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }

  _llmType() {
    return "scripted";
  }

  bindTools() {
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const step = this.script[Math.min(this.count, this.script.length - 1)];
    this.count += 1;
    const message = new AIMessage({
      content: step?.content ?? "",
      tool_calls: (step?.toolCalls ?? []) as never,
    });
    return { generations: [{ text: step?.content ?? "", message }] };
  }
}

function buildAgent(
  script: Array<{ content: string; toolCalls?: unknown[] }>,
  extraMiddleware: AgentMiddleware[] = [],
) {
  return createDeepAgent({
    model: new ScriptedChatModel(script),
    tools: [],
    middleware: [createAskUserMiddleware(), ...extraMiddleware],
    backend: new StateBackend(),
    checkpointer: new MemorySaver(),
  });
}

async function drain(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function findAskUserInterrupt(chunks: unknown[]) {
  for (const chunk of chunks) {
    const interrupts = (chunk as { __interrupt__?: unknown[] })?.__interrupt__;
    if (Array.isArray(interrupts)) {
      const hit = interrupts.find((i) =>
        isAskUserInterruptValue((i as { value?: unknown })?.value),
      );
      if (hit) {
        return (hit as { value: unknown }).value;
      }
    }
  }
  return undefined;
}

const CONFIG = () => ({ configurable: { thread_id: `t_${Math.random()}` } });

test("askUser interrupts from the tool body and resumes with an answer", async () => {
  const agent = buildAgent([
    {
      content: "",
      toolCalls: [
        {
          id: "call_1",
          name: ASK_USER_TOOL_NAME,
          args: {
            questions: [
              {
                question: "Which format?",
                type: "multiple_choice",
                choices: [{ label: "PDF" }, { label: "Slides" }],
              },
            ],
          },
        },
      ],
    },
    { content: "Done — exporting as PDF." },
  ]);
  const config = CONFIG();

  // 1. First pass pauses on the ask_user interrupt.
  const first = await drain(
    (await agent.stream({ messages: [{ role: "user", content: "export it" }] }, {
      ...config,
      streamMode: "values",
    })) as AsyncGenerator<unknown>,
  );
  const value = findAskUserInterrupt(first) as
    | { type: string; questions: AskUserQuestion[]; toolCallId: string }
    | undefined;
  assert.ok(value, "expected an ask_user interrupt");
  assert.equal(value.type, "ask_user");
  assert.equal(value.questions[0]?.question, "Which format?");

  // 2. Resume with the user's answer.
  const resumed = await drain(
    (await agent.stream(
      new Command({ resume: { status: "answered", answers: ["PDF"] } }),
      { ...config, streamMode: "values" },
    )) as AsyncGenerator<unknown>,
  );

  // 3. The tool returned the Q:/A: transcript and the run completed.
  const lastState = resumed.at(-1) as { messages?: BaseMessage[] } | undefined;
  const messages = lastState?.messages ?? [];
  const toolMessage = messages.find(
    (m): m is ToolMessage =>
      m instanceof ToolMessage && m.name === ASK_USER_TOOL_NAME,
  );
  assert.ok(toolMessage, "expected an askUser ToolMessage after resume");
  assert.match(String(toolMessage.content), /Q: Which format\?\nA: PDF/);
  assert.equal(toolMessage.status, "success");

  const finalAi = messages.at(-1);
  assert.match(String(finalAi?.content), /exporting as PDF/);
});

test("interrupt survives the observability + retry middleware stack (fix #2)", async () => {
  const agent = buildAgent(
    [
      {
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: ASK_USER_TOOL_NAME,
            args: { questions: [{ question: "Proceed?", type: "text" }] },
          },
        ],
      },
      { content: "ok" },
    ],
    [
      createSourceWeftToolObservabilityMiddleware({}),
      toolRetryMiddleware({ tools: ["searchSources"] }),
    ],
  );
  const config = CONFIG();
  const first = await drain(
    (await agent.stream({ messages: [{ role: "user", content: "go" }] }, {
      ...config,
      streamMode: "values",
    })) as AsyncGenerator<unknown>,
  );
  // The pause must still surface — not be swallowed or logged as a tool failure.
  assert.ok(
    findAskUserInterrupt(first),
    "ask_user interrupt must survive observability + retry middleware",
  );
});

test("handleAskUserStreamChunk emits the question request + parks with finishReason", async () => {
  const runtime = createTurnRuntime({
    prepared: { traceContinuation: undefined } as never,
  });
  const agent = {
    getState: async () => ({
      config: { configurable: { thread_id: "t1", checkpoint_id: "ckpt-1" } },
      next: ["tools"],
    }),
  } as never;

  const gen = handleAskUserStreamChunk({
    agent,
    beforeInputCheckpoint: null,
    finalCheckpoint: null,
    payload: {
      __interrupt__: [
        {
          id: "int_1",
          value: {
            type: "ask_user",
            questions: [
              {
                question: "Which format?",
                type: "multiple_choice",
                choices: [{ label: "PDF" }],
              },
            ],
            toolCallId: "call_1",
          },
        },
      ],
    },
    runConfig: {} as never,
    runtime,
    threadId: "t1",
    userId: "u1",
    workspaceId: "w1",
  });

  const events: DeepAgentTurnEvent[] = [];
  let result: { kind: string } | undefined;
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }

  const resultEvent = events.find((e) => e.type === "tool-call-result");
  assert.ok(resultEvent && resultEvent.type === "tool-call-result");
  const request = resultEvent.output as {
    type: string;
    id: string;
    toolCallId: string;
    questions: Array<{ question: string }>;
  };
  assert.equal(request.type, "user_question_request");
  assert.equal(request.toolCallId, "call_1");
  assert.equal(request.id, "askq:int_1:call_1");
  assert.equal(
    (request as { interruptId?: string }).interruptId,
    "int_1",
    "interrupt id must be echoed for sub-agent/parallel resume keying",
  );
  assert.equal(request.questions[0]?.question, "Which format?");

  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.outcome.finishReason, "user_question_requested");
  assert.equal(done.outcome.agentCheckpoint.resume?.checkpointId, "ckpt-1");
  assert.equal(result?.kind, "done");
});

test("commandResumeFromToolApprovalResume keys askUser resume by interrupt id", () => {
  // With an interrupt id -> keyed map (targets a nested/parallel pending task).
  assert.deepEqual(
    commandResumeFromToolApprovalResume({
      decisions: [],
      askUser: { status: "answered", answers: ["PDF"], interruptId: "int_1" },
    } as never),
    { int_1: { status: "answered", answers: ["PDF"] } },
  );
  // Without one -> bare value (single pending interrupt).
  assert.deepEqual(
    commandResumeFromToolApprovalResume({
      decisions: [],
      askUser: { status: "cancelled" },
    } as never),
    { status: "cancelled" },
  );
});

test("askUser pauses + resumes under the full stable production middleware set", async () => {
  // Mirrors the wrapToolCall/wrapModelCall middleware the real root stack adds
  // (todos, observability, tool retry, tool-call limit, model retry) — proves
  // none of them swallow the askUser interrupt or block its rebinding on resume.
  const agent = buildAgent(
    [
      {
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: ASK_USER_TOOL_NAME,
            args: { questions: [{ question: "Which env?", type: "text" }] },
          },
        ],
      },
      { content: "deploying to staging" },
    ],
    [
      todoListMiddleware(),
      createSourceWeftToolObservabilityMiddleware({}),
      toolRetryMiddleware({ tools: ["searchSources"] }),
      toolCallLimitMiddleware({
        runLimit: 100,
        threadLimit: 100,
        exitBehavior: "continue",
      }),
      modelRetryMiddleware({ retryOn: () => false, onFailure: "error" }),
    ],
  );
  const config = CONFIG();

  const first = await drain(
    (await agent.stream({ messages: [{ role: "user", content: "deploy" }] }, {
      ...config,
      streamMode: "values",
    })) as AsyncGenerator<unknown>,
  );
  assert.ok(
    findAskUserInterrupt(first),
    "ask_user interrupt must survive the full middleware set",
  );

  const resumed = await drain(
    (await agent.stream(
      new Command({ resume: { status: "answered", answers: ["staging"] } }),
      { ...config, streamMode: "values" },
    )) as AsyncGenerator<unknown>,
  );
  const lastState = resumed.at(-1) as { messages?: BaseMessage[] } | undefined;
  const finalAi = (lastState?.messages ?? []).at(-1);
  assert.match(String(finalAi?.content), /deploying to staging/);
});

test("cancelled resume drives the run to a clean terminal state (no dangling)", async () => {
  // A-5: dismissing a question (per-question Cancel, or a Stop that resumes as
  // cancelled) must NOT strand the interrupt — the graph continues to completion
  // with a `(cancelled)` tool result and finishes with no pending checkpoint.
  const agent = buildAgent([
    {
      content: "",
      toolCalls: [
        {
          id: "call_1",
          name: ASK_USER_TOOL_NAME,
          args: { questions: [{ question: "Which region?", type: "text" }] },
        },
      ],
    },
    { content: "no problem, standing by" },
  ]);
  const config = CONFIG();

  await drain(
    (await agent.stream({ messages: [{ role: "user", content: "deploy" }] }, {
      ...config,
      streamMode: "values",
    })) as AsyncGenerator<unknown>,
  );

  const resumed = await drain(
    (await agent.stream(new Command({ resume: { status: "cancelled" } }), {
      ...config,
      streamMode: "values",
    })) as AsyncGenerator<unknown>,
  );

  const lastState = resumed.at(-1) as { messages?: BaseMessage[] } | undefined;
  const messages = lastState?.messages ?? [];
  const toolMessage = messages.find(
    (m): m is ToolMessage =>
      m instanceof ToolMessage && m.name === ASK_USER_TOOL_NAME,
  );
  assert.ok(toolMessage);
  assert.match(String(toolMessage.content), /A: \(cancelled\)/);
  assert.equal(toolMessage.status, "success");
  // Run reached a normal terminal message — the checkpoint is not left pending.
  assert.match(String(messages.at(-1)?.content), /standing by/);
  const state = await agent.getState(config);
  assert.equal(
    (state as { next?: unknown[] }).next?.length ?? 0,
    0,
    "no pending tasks after a cancelled resume",
  );
});

test("payloadHasAskUserInterrupt discriminates the interrupt shape", () => {
  assert.equal(
    payloadHasAskUserInterrupt({ __interrupt__: [{ value: { type: "ask_user" } }] }),
    true,
  );
  // an approval-shaped HITL interrupt must NOT be claimed by the ask-user branch
  assert.equal(
    payloadHasAskUserInterrupt({
      __interrupt__: [{ value: { actionRequests: [], reviewConfigs: [] } }],
    }),
    false,
  );
  assert.equal(payloadHasAskUserInterrupt({}), false);
});

test("extractAskUserInterrupts pulls ask_user values and their interrupt ids", () => {
  const extracted = extractAskUserInterrupts({
    __interrupt__: [
      {
        id: "int_1",
        value: {
          type: "ask_user",
          questions: [{ question: "A?", type: "text" }],
          toolCallId: "call_1",
        },
      },
      // an approval-shaped interrupt must be ignored by the ask-user extractor
      { id: "int_2", value: { actionRequests: [], reviewConfigs: [] } },
    ],
  });
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0]?.interruptId, "int_1");
  assert.equal(extracted[0]?.value.toolCallId, "call_1");
  assert.equal(extractAskUserInterrupts({}).length, 0);
});

test("parseAskUserAnswer enforces exact answer count", () => {
  const questions: AskUserQuestion[] = [
    { question: "A?", type: "text" },
    { question: "B?", type: "text" },
  ];
  // mismatch -> error, never mis-paired
  const bad = parseAskUserAnswer(
    { status: "answered", answers: ["only one"] },
    questions,
    "call_x",
  );
  const badMsg = (bad.update as { messages: ToolMessage[] }).messages[0];
  assert.ok(badMsg);
  assert.equal(badMsg.status, "error");
  assert.match(String(badMsg.content), /error: askUser answer count mismatch/);

  // cancelled -> success with placeholder answers, turn can continue
  const cancelled = parseAskUserAnswer({ status: "cancelled" }, questions, "call_y");
  const cancelMsg = (cancelled.update as { messages: ToolMessage[] }).messages[0];
  assert.ok(cancelMsg);
  assert.equal(cancelMsg.status, "success");
  assert.match(String(cancelMsg.content), /A: \(cancelled\)/);
});
