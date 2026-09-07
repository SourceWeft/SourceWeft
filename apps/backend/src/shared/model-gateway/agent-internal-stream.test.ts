import assert from "node:assert/strict";
import { test } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import { createModelGateway } from "@sourceweft/model-gateway";
import { StateBackend } from "deepagents";
import {
  createSourceWeftSummarizationMiddleware,
  createSourceWeftSummaryModel,
} from "../../modules/threads/agent/middleware/context-compression";
import { adaptMessagesEvent } from "../../modules/threads/agent/turn/v3-protocol";
import { extractTextDeltasFromMessageChunk } from "../../modules/threads/agent/turn/content";
import { handleMessagesStreamChunk } from "../../modules/threads/agent/turn/message-stream-handler";

class SummaryModel extends BaseChatModel {
  summaries = 0;
  _llmType() {
    return "summary-stream-test";
  }
  bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const summary = String(messages[0]?.content).startsWith(
      "You are SourceWeft's conversation memory compressor.",
    );
    if (summary) this.summaries++;
    const content = summary
      ? "INTERNAL_SUMMARY_SECRET_MARKER"
      : "PUBLIC_ANSWER_ONLY";
    return {
      generations: [{ text: content, message: new AIMessage(content) }],
    };
  }
}

test("real graph compression keeps summary callbacks out of the user messages stream", async () => {
  const model = new SummaryModel({});
  const agent = createAgent({
    model,
    tools: [],
    middleware: [
      createSourceWeftSummarizationMiddleware({
        model,
        backend: new StateBackend({ state: { files: {} } } as never),
        chatProfileConfig: { contextLength: 100_000 },
      }),
    ],
  });
  const messages = Array.from({ length: 42 }, (_, i) =>
    i % 2
      ? new AIMessage(`older answer ${i}`)
      : new HumanMessage(`older question ${i}`),
  );
  messages.push(new HumanMessage("current question"));
  const events = await agent.streamEvents({ messages }, {
    version: "v3",
  } as never);
  let visible = "";
  for await (const raw of events as AsyncIterable<unknown>) {
    const event = raw as { method?: string; params?: { data?: unknown } };
    if (event.method !== "messages") continue;
    for (const payload of adaptMessagesEvent(event.params?.data)) {
      visible += extractTextDeltasFromMessageChunk(payload[0]).join("");
    }
  }
  assert.ok(model.summaries > 0, "must actually trigger history compression");
  assert.ok(visible.includes("PUBLIC_ANSWER_ONLY"));
  assert.ok(!visible.includes("INTERNAL_SUMMARY_SECRET_MARKER"), visible);
});

test("summary invocation preserves callback options without mutating the normal call config", async () => {
  const seen: unknown[] = [];
  const model = {
    invoke: async (_messages: unknown, options: unknown) => {
      seen.push(options);
      return new AIMessage("summary");
    },
  };
  const wrapped = createSourceWeftSummaryModel(model as never);
  const options = { tags: ["caller"], metadata: { existing: "value" } };
  await wrapped.invoke(
    [
      new HumanMessage(
        "You are SourceWeft's conversation memory compressor.\ninput",
      ),
    ],
    options,
  );
  const internal = seen[0] as typeof options;
  assert.ok(internal.tags.includes("langsmith:nostream"));
  assert.deepEqual(options, {
    tags: ["caller"],
    metadata: { existing: "value" },
  });
  await wrapped.invoke([new HumanMessage("ordinary")], options);
  assert.strictEqual(seen[1], options);
});

test("internal message events cannot enter render blocks, answer text or tool bookkeeping", async () => {
  for (const metadata of [
    { tags: ["sourceweft:internal-model"] },
    { sourceweftInternalModel: true },
    { tags: ["langsmith:nostream"] },
  ]) {
    const events = [];
    for await (const event of handleMessagesStreamChunk({
      payload: [new AIMessage("INTERNAL"), metadata],
      runtime: {} as never,
      commandSuccessCriteria: null as never,
      suppressModelReasoning: false,
    }))
      events.push(event);
    assert.deepEqual(events, []);
  }
});

test("a model completion inside a real agent tool never leaks its review JSON into the answer stream", async () => {
  class Judge extends BaseChatModel {
    _llmType() {
      return "private-judge";
    }
    async _generate() {
      const content = "INTERNAL_REVIEW_JSON_MARKER";
      return {
        generations: [{ text: content, message: new AIMessage(content) }],
      };
    }
  }
  class Author extends BaseChatModel {
    _llmType() {
      return "public-author";
    }
    bindTools() {
      return this;
    }
    async _generate(messages: BaseMessage[]) {
      const message =
        messages.at(-1) instanceof ToolMessage
          ? new AIMessage("PUBLIC_REVIEW_FINISHED")
          : new AIMessage({
              content: "",
              tool_calls: [{ id: "review-1", name: "review", args: {} }],
            });
      return { generations: [{ text: String(message.content), message }] };
    }
  }
  const gateway = createModelGateway({
    providers: {
      local: {
        kind: "openai-compatible",
        baseUrl: "https://fixture.invalid",
        apiKey: "test",
      },
    },
    modelRoutes: {
      judge: { targets: [{ provider: "local", model: "judge" }] },
    },
    langchainFactories: { createChatModel: () => new Judge({}) as never },
  });
  let reviews = 0;
  const review = tool(
    async () => {
      const result = await gateway.chat.complete({
        model: "judge",
        messages: [{ role: "user", content: "review" }],
      });
      assert.equal(result.raw.content, "INTERNAL_REVIEW_JSON_MARKER");
      reviews++;
      return "review complete";
    },
    { name: "review", schema: z.object({}) },
  );
  const agent = createAgent({ model: new Author({}), tools: [review] });
  const events = await agent.streamEvents(
    { messages: [new HumanMessage("Please review")] },
    { version: "v3" } as never,
  );
  let visible = "";
  for await (const raw of events as AsyncIterable<unknown>) {
    const event = raw as { method?: string; params?: { data?: unknown } };
    if (event.method === "messages")
      for (const payload of adaptMessagesEvent(event.params?.data))
        visible += extractTextDeltasFromMessageChunk(payload[0]).join("");
  }
  assert.equal(reviews, 1);
  assert.ok(visible.includes("PUBLIC_REVIEW_FINISHED"));
  assert.ok(!visible.includes("INTERNAL_REVIEW_JSON_MARKER"), visible);
});
