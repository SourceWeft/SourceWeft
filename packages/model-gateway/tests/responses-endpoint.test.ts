import assert from "node:assert/strict";
import test from "node:test";
import { createLangChainChatModel } from "../src/bridge/utils";
import { createModelGateway, ModelGatewayError } from "../src/index";
import type { ModelGatewayConfig } from "../src/types";

// LangChain's ChatOpenAI chooses between `chat/completions` and `responses`
// from the model name, and the list changes between releases. The gateway
// follows that choice, so the scripted provider answers whichever endpoint is
// called and the assertions cover what callers rely on either way: the text,
// the tool call, the token usage and why the reply ended.
const usage = { input: 20, output: 7, cached: 5, reasoning: 3 };
const expectedUsage = {
  inputTokens: usage.input,
  outputTokens: usage.output,
  cacheReadTokens: usage.cached,
  reasoningTokens: usage.reasoning,
};
const toolArguments = ['{"city":', '"Singapore"}'];
const cutToolArguments = ['{"city":', '"Sing'];

/** What the scripted provider replies with. */
type Scenario = "text" | "tool-call" | "cut-text" | "cut-tool-call";
const withToolCall = (scenario: Scenario) =>
  scenario === "tool-call" || scenario === "cut-tool-call";
const isCut = (scenario: Scenario) =>
  scenario === "cut-text" || scenario === "cut-tool-call";
const argumentsOf = (scenario: Scenario) =>
  scenario === "cut-tool-call" ? cutToolArguments : toolArguments;

function sse(events: { event?: string; data: unknown }[]) {
  return new Response(
    events
      .map(
        ({ event, data }) =>
          `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const chatUsage = {
  prompt_tokens: usage.input,
  completion_tokens: usage.output,
  total_tokens: usage.input + usage.output,
  prompt_tokens_details: { cached_tokens: usage.cached },
  completion_tokens_details: { reasoning_tokens: usage.reasoning },
};
const chatFinishReason = (scenario: Scenario) =>
  isCut(scenario) ? "length" : withToolCall(scenario) ? "tool_calls" : "stop";

function chatCompletion(model: string, scenario: Scenario) {
  return Response.json({
    id: "chat-1",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "ok ",
          ...(withToolCall(scenario)
            ? {
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "lookup",
                      arguments: argumentsOf(scenario).join(""),
                    },
                  },
                ],
              }
            : {}),
        },
        finish_reason: chatFinishReason(scenario),
      },
    ],
    usage: chatUsage,
  });
}

function chatCompletionsStream(model: string, scenario: Scenario) {
  const chunk = (delta: unknown, finish: string | null = null) => ({
    id: "chat-1",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const [head, tail] = argumentsOf(scenario);
  return sse(
    [
      chunk({ role: "assistant", content: "ok " }),
      ...(withToolCall(scenario)
        ? [
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: head },
                },
              ],
            }),
            chunk({
              tool_calls: [{ index: 0, function: { arguments: tail } }],
            }),
          ]
        : []),
      chunk({}, chatFinishReason(scenario)),
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        model,
        choices: [],
        usage: chatUsage,
      },
      "[DONE]",
    ].map((data) => ({ data })),
  );
}

const responsesUsage = {
  input_tokens: usage.input,
  output_tokens: usage.output,
  total_tokens: usage.input + usage.output,
  input_tokens_details: { cached_tokens: usage.cached },
  output_tokens_details: { reasoning_tokens: usage.reasoning },
};

function responsesParts(model: string, scenario: Scenario) {
  const cut = isCut(scenario);
  const message = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: cut && !withToolCall(scenario) ? "incomplete" : "completed",
    content: [{ type: "output_text", text: "ok ", annotations: [] }],
  };
  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "lookup",
    arguments: argumentsOf(scenario).join(""),
    status: cut ? "incomplete" : "completed",
  };
  return {
    message,
    call,
    response: {
      id: "resp_1",
      object: "response",
      model,
      status: cut ? "incomplete" : "completed",
      incomplete_details: cut ? { reason: "max_output_tokens" } : null,
      output: withToolCall(scenario) ? [message, call] : [message],
      usage: responsesUsage,
    },
  };
}

function responsesReply(model: string, scenario: Scenario) {
  return Response.json(responsesParts(model, scenario).response);
}

function responsesStream(model: string, scenario: Scenario) {
  const { message, call, response } = responsesParts(model, scenario);
  const item = { item_id: "msg_1", output_index: 0, content_index: 0 };
  return sse(
    [
      {
        type: "response.created",
        response: {
          ...response,
          status: "in_progress",
          incomplete_details: null,
          output: [],
          usage: null,
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        ...item,
        part: { type: "output_text", text: "", annotations: [] },
      },
      { type: "response.output_text.delta", ...item, delta: "ok " },
      { type: "response.output_text.done", ...item, text: "ok " },
      { type: "response.content_part.done", ...item, part: message.content[0] },
      { type: "response.output_item.done", output_index: 0, item: message },
      ...(withToolCall(scenario)
        ? [
            {
              type: "response.output_item.added",
              output_index: 1,
              item: { ...call, arguments: "", status: "in_progress" },
            },
            ...argumentsOf(scenario).map((delta) => ({
              type: "response.function_call_arguments.delta",
              item_id: "fc_1",
              output_index: 1,
              delta,
            })),
            { type: "response.output_item.done", output_index: 1, item: call },
          ]
        : []),
      {
        type: isCut(scenario) ? "response.incomplete" : "response.completed",
        response,
      },
    ].map((data, index) => ({
      event: data.type,
      data: { ...data, sequence_number: index },
    })),
  );
}

function text(content: unknown) {
  if (typeof content === "string") return content;
  return (content as { type?: string; text?: string }[])
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
}

function tokenCounts(reported: unknown) {
  const record = (reported ?? {}) as Record<string, unknown>;
  return {
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    reasoningTokens: record.reasoningTokens,
  };
}

const lookupTool = {
  type: "function" as const,
  function: {
    name: "lookup",
    description: "Look up a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

function scriptedGateway(
  kind: "openai" | "openai-compatible" | "openrouter",
  model: string,
  scenario: Scenario,
) {
  const paths: string[] = [];
  const config: ModelGatewayConfig = {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      const body = (await request.json()) as { stream?: boolean };
      paths.push(pathname);
      if (pathname.endsWith("/responses")) {
        return body.stream
          ? responsesStream(model, scenario)
          : responsesReply(model, scenario);
      }
      return body.stream
        ? chatCompletionsStream(model, scenario)
        : chatCompletion(model, scenario);
    },
    maxRetries: 0,
    providers: {
      local: {
        kind,
        baseUrl: "http://models.internal:8080/v1",
        apiKey: "workspace-key",
      },
    },
    modelRoutes: {
      probe: {
        strategy: "priority",
        targets: [{ provider: "local", model, priority: 1 }],
      },
    },
  };
  const gateway = createModelGateway(config);
  const payload = {
    model: "probe",
    messages: [{ role: "user" as const, content: "hello" }],
    maxTokens: 32,
    tools: [lookupTool],
  };
  return { config, gateway, paths, payload };
}

async function collectStream(run: ReturnType<typeof scriptedGateway>): Promise<{
  content: string;
  name: string;
  args: string;
  usage?: unknown;
  finishReason?: string;
  errorCode?: string;
}> {
  const collected = { content: "", name: "", args: "" } as Awaited<
    ReturnType<typeof collectStream>
  >;
  for await (const event of run.gateway.chat.stream(run.payload, {
    maxRetries: 0,
  })) {
    if (event.type === "chunk") {
      collected.content += text(event.chunk.content);
      for (const call of event.chunk.tool_call_chunks ?? []) {
        collected.name += call.name ?? "";
        collected.args += call.args ?? "";
      }
    } else if (event.type === "metadata") {
      collected.usage = event.metadata.usage;
      collected.finishReason = event.metadata.finishReason;
    } else if (event.type === "error") {
      collected.errorCode = event.error.code;
    }
  }
  return collected;
}

/**
 * The finish reason a completed reply is recorded under. `chat/completions`
 * names a tool call; LangChain reads a Responses reply as `stop` whether or
 * not it called a tool, and the gateway follows it.
 */
const completedFinishReason = (path: string, scenario: Scenario) =>
  path.endsWith("/responses") ? "stop" : chatFinishReason(scenario);

for (const kind of ["openai", "openai-compatible", "openrouter"] as const) {
  for (const model of ["gpt-5.5", "gpt-5.6", "gpt-5.5-pro"]) {
    const subject = `${kind} ${model} on the endpoint LangChain selects`;

    test(`${subject}: streams text, tool-call arguments, usage and the finish reason`, async () => {
      const run = scriptedGateway(kind, model, "tool-call");
      const result = await collectStream(run);

      assert.equal(run.paths.length, 1);
      assert.match(run.paths[0]!, /^\/v1\/(chat\/completions|responses)$/);
      assert.equal(result.errorCode, undefined);
      assert.equal(result.content, "ok ");
      assert.equal(result.name, "lookup");
      assert.deepEqual(JSON.parse(result.args), { city: "Singapore" });
      assert.deepEqual(tokenCounts(result.usage), expectedUsage);
      assert.equal(
        result.finishReason,
        completedFinishReason(run.paths[0]!, "tool-call"),
      );
    });

    test(`${subject}: a non-streamed reply reports the same usage and finish reason`, async () => {
      const run = scriptedGateway(kind, model, "tool-call");
      const result = await run.gateway.chat.complete(run.payload, {
        maxRetries: 0,
      });

      assert.equal(run.paths.length, 1);
      assert.equal(text(result.raw?.content), "ok ");
      assert.deepEqual(result.raw?.tool_calls?.[0]?.args, {
        city: "Singapore",
      });
      assert.deepEqual(tokenCounts(result.usage), expectedUsage);
      assert.equal(
        result.finishReason,
        completedFinishReason(run.paths[0]!, "tool-call"),
      );
    });

    test(`${subject}: text cut at the output limit is delivered with finish reason length`, async () => {
      const streamed = await collectStream(
        scriptedGateway(kind, model, "cut-text"),
      );
      assert.equal(streamed.errorCode, undefined);
      assert.equal(streamed.content, "ok ");
      assert.equal(streamed.finishReason, "length");
      assert.deepEqual(tokenCounts(streamed.usage), expectedUsage);

      const run = scriptedGateway(kind, model, "cut-text");
      const complete = await run.gateway.chat.complete(run.payload, {
        maxRetries: 0,
      });
      assert.equal(text(complete.raw?.content), "ok ");
      assert.equal(complete.finishReason, "length");
      assert.deepEqual(tokenCounts(complete.usage), expectedUsage);
    });

    // The model the agent calls. LangChain repairs the cut arguments of a
    // streamed call into a valid-looking tool call, so the finish reason is
    // the only sign that it must not be executed.
    test(`${subject}: the agent model refuses a tool call cut at the output limit`, async () => {
      const truncated = (error: unknown) =>
        error instanceof ModelGatewayError && error.code === "OUTPUT_TRUNCATED";
      const messages = [{ role: "user", content: "hello" }];
      const agentModel = async () =>
        createLangChainChatModel({
          modelAlias: "probe",
          config: scriptedGateway(kind, model, "cut-tool-call").config,
        });

      await assert.rejects((await agentModel()).invoke(messages), truncated);
      await assert.rejects(async () => {
        const stream = (await (
          await agentModel()
        ).stream(messages)) as AsyncIterable<unknown>;
        for await (const chunk of stream) void chunk;
      }, truncated);
    });
  }
}
