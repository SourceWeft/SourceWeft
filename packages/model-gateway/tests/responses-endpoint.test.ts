import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../src/index";

// LangChain's ChatOpenAI chooses between `chat/completions` and `responses`
// from the model name, and the list changes between releases. The gateway
// follows that choice, so the scripted provider answers whichever endpoint is
// called and the assertions cover what callers rely on either way.
const usage = { input: 20, output: 7, cached: 5, reasoning: 3 };
const toolArguments = ['{"city":', '"Singapore"}'];

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

function chatCompletionsStream(model: string) {
  const chunk = (delta: unknown, finish: string | null = null) => ({
    id: "chat-1",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return sse(
    [
      chunk({ role: "assistant", content: "ok " }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: toolArguments[0] },
          },
        ],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: toolArguments[1] } }],
      }),
      chunk({}, "tool_calls"),
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        model,
        choices: [],
        usage: {
          prompt_tokens: usage.input,
          completion_tokens: usage.output,
          total_tokens: usage.input + usage.output,
          prompt_tokens_details: { cached_tokens: usage.cached },
          completion_tokens_details: { reasoning_tokens: usage.reasoning },
        },
      },
      "[DONE]",
    ].map((data) => ({ data })),
  );
}

function responsesStream(model: string) {
  const message = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ok ", annotations: [] }],
  };
  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "lookup",
    arguments: toolArguments.join(""),
    status: "completed",
  };
  const base = { id: "resp_1", object: "response", model, output: [] };
  const item = { item_id: "msg_1", output_index: 0, content_index: 0 };
  return sse(
    [
      {
        type: "response.created",
        response: { ...base, status: "in_progress", usage: null },
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
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...call, arguments: "", status: "in_progress" },
      },
      ...toolArguments.map((delta) => ({
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 1,
        delta,
      })),
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        output_index: 1,
        arguments: call.arguments,
      },
      { type: "response.output_item.done", output_index: 1, item: call },
      {
        type: "response.completed",
        response: {
          ...base,
          status: "completed",
          output: [message, call],
          usage: {
            input_tokens: usage.input,
            output_tokens: usage.output,
            total_tokens: usage.input + usage.output,
            input_tokens_details: { cached_tokens: usage.cached },
            output_tokens_details: { reasoning_tokens: usage.reasoning },
          },
        },
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

for (const kind of ["openai", "openai-compatible", "openrouter"] as const) {
  for (const model of ["gpt-5.5", "gpt-5.6", "gpt-5.5-pro"]) {
    test(`${kind} streams text, tool-call arguments and usage for ${model} on the endpoint LangChain selects`, async () => {
      const paths: string[] = [];
      const gateway = createModelGateway({
        fetch: async (input, init) => {
          const { pathname } = new URL(new Request(input, init).url);
          paths.push(pathname);
          return pathname.endsWith("/responses")
            ? responsesStream(model)
            : chatCompletionsStream(model);
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
      });

      let content = "";
      let name = "";
      let args = "";
      let reported: Record<string, unknown> | undefined;
      for await (const event of gateway.chat.stream({
        model: "probe",
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 32,
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a city",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
      })) {
        if (event.type === "chunk") {
          content += text(event.chunk.content);
          for (const call of event.chunk.tool_call_chunks ?? []) {
            name += call.name ?? "";
            args += call.args ?? "";
          }
        } else if (event.type === "metadata") {
          reported = event.metadata.usage as Record<string, unknown>;
        }
      }

      assert.equal(paths.length, 1);
      assert.match(paths[0]!, /^\/v1\/(chat\/completions|responses)$/);
      assert.equal(content, "ok ");
      assert.equal(name, "lookup");
      assert.deepEqual(JSON.parse(args), { city: "Singapore" });
      assert.deepEqual(
        {
          inputTokens: reported?.inputTokens,
          outputTokens: reported?.outputTokens,
          cacheReadTokens: reported?.cacheReadTokens,
          reasoningTokens: reported?.reasoningTokens,
        },
        {
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cached,
          reasoningTokens: usage.reasoning,
        },
      );
    });
  }
}
