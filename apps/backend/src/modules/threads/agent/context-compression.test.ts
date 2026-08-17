import assert from "node:assert/strict";
import { test } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { StateBackend } from "deepagents";
import { ContentError } from "../../content/errors";
import {
  SOURCEWEFT_STRUCTURED_SUMMARY_PROMPT,
  SOURCEWEFT_SUMMARY_SECTIONS,
  SOURCEWEFT_TOOL_OUTPUT_PLACEHOLDER,
  assertSourceWeftCurrentUserMessageFits,
  createSourceWeftContextCompressionMiddleware,
  createSourceWeftSummarizationMiddleware,
  createSourceWeftToolOutputEdit,
  estimateSourceWeftMessageTokens,
  fallbackSourceWeftMessagesToRecentWindow,
  resolveSourceWeftContextCompressionBudget,
  sanitizeSourceWeftSummaryResponse,
  sanitizeSourceWeftSummaryText,
} from "./context-compression";

test("summary prompt requires the fixed SourceWeft sections", () => {
  let previousIndex = -1;
  for (const section of SOURCEWEFT_SUMMARY_SECTIONS) {
    const index = SOURCEWEFT_STRUCTURED_SUMMARY_PROMPT.indexOf(section);
    assert.ok(index > previousIndex, `${section} should appear in order`);
    previousIndex = index;
  }
  assert.match(SOURCEWEFT_STRUCTURED_SUMMARY_PROMPT, /not source evidence/i);
  assert.match(SOURCEWEFT_STRUCTURED_SUMMARY_PROMPT, /\{conversation\}/);
});

test("summary response sanitizer cleans text blocks before checkpointing", () => {
  const response = new AIMessage({
    content: [
      { type: "text", text: "Fact [citation:c12]" },
      { type: "reasoning", reasoning: "untouched" },
    ],
  });
  const sanitized = sanitizeSourceWeftSummaryResponse(response);

  assert.ok(AIMessage.isInstance(sanitized));
  assert.deepEqual(sanitized.content, [
    { type: "text", text: "Fact old citation marker c12 removed" },
    { type: "reasoning", reasoning: "untouched" },
  ]);
  assert.deepEqual(response.content, [
    { type: "text", text: "Fact [citation:c12]" },
    { type: "reasoning", reasoning: "untouched" },
  ]);
});

test("SourceWeft summarizer uses the native Deep Agents history flow and sanitizes only summaries", async () => {
  const prompts: string[] = [];
  const model = {
    profile: { maxInputTokens: 1_000 },
    invoke: async (messages: Array<{ content?: unknown }>) => {
      const prompt = String(messages[0]?.content ?? "");
      prompts.push(prompt);
      if (
        prompt.startsWith(
          "You are SourceWeft's conversation memory compressor.",
        )
      ) {
        return new AIMessage("Condensed fact [citation:old-1]");
      }
      return new AIMessage("Ordinary answer [citation:keep-1]");
    },
  };
  const middleware = createSourceWeftSummarizationMiddleware({
    backend: new StateBackend({ state: { files: {} } } as never),
    chatProfileConfig: { contextLength: 1_000 },
    model: model as never,
  });
  const wrapModelCall = middleware.wrapModelCall;
  if (typeof wrapModelCall !== "function") {
    throw new Error("Expected summarization wrapModelCall hook");
  }

  let forwardedMessages: Array<{ content?: unknown }> = [];
  let forwardedModel: unknown = null;
  let ordinaryContent: unknown = null;
  const handler: Parameters<typeof wrapModelCall>[1] = async (request) => {
    forwardedMessages = request.messages;
    forwardedModel = request.model;
    const ordinaryResponse = await request.model.invoke([
      new HumanMessage("ordinary request"),
    ]);
    ordinaryContent = (ordinaryResponse as { content?: unknown }).content;
    return ordinaryResponse as never;
  };
  const result = await wrapModelCall(
    {
      messages: Array.from(
        { length: 41 },
        (_, index) =>
          new HumanMessage(
            index === 0
              ? "old message 0 [citation:input-old]"
              : index === 40
                ? "recent message 40 [citation:current]"
                : `old message ${index}`,
          ),
      ),
      model: model as never,
      state: { files: {} },
      tools: [],
    } as never,
    handler,
  );

  assert.equal(prompts.length, 2);
  assert.strictEqual(forwardedModel, model);
  assert.match(prompts[0] ?? "", /old message 0/);
  assert.match(
    prompts[0] ?? "",
    /old citation marker input-old removed/,
  );
  assert.doesNotMatch(prompts[0] ?? "", /\[citation:input-old\]/);
  assert.doesNotMatch(prompts[0] ?? "", /\{conversation\}/);
  assert.equal(ordinaryContent, "Ordinary answer [citation:keep-1]");
  assert.equal(forwardedMessages.length, 21);
  assert.equal(
    forwardedMessages.at(-1)?.content,
    "recent message 40 [citation:current]",
  );
  assert.match(
    String(forwardedMessages[0]?.content ?? ""),
    /old citation marker old-1 removed/,
  );
  assert.doesNotMatch(
    String(forwardedMessages[0]?.content ?? ""),
    /\[citation:old-1\]/,
  );
  assert.equal(
    (result as { constructor?: { name?: string } }).constructor?.name,
    "Command",
  );
  assert.match(
    String(
      (
        result as {
          update?: {
            _summarizationEvent?: { filePath?: string | null };
          };
        }
      ).update?._summarizationEvent?.filePath ?? "",
    ),
    /^\/conversation_history\/session_[a-z0-9]+\.md$/,
  );
});

test("summary sanitizer removes reusable citation markers", () => {
  assert.equal(
    sanitizeSourceWeftSummaryText(
      "The old answer used [citation:c12] and citation:c7.",
    ),
    "The old answer used old citation marker c12 removed and old citation marker c7.",
  );
});

test("context budget uses active chat profile context length", () => {
  assert.deepEqual(
    resolveSourceWeftContextCompressionBudget({ contextLength: 20_000 }),
    {
      contextLength: 20_000,
      reservedOutputTokens: 5_000,
      usableInputTokens: 15_000,
      contextEditingTriggerTokens: 8_250,
      contextEditingClearAtLeastTokens: 2_250,
      summarizationTriggerTokens: 12_000,
      recentToolResultsToKeep: 5,
      recentMessagesToKeep: 20,
      summaryMessageTrigger: 40,
      historyPathPrefix: "/conversation_history",
    },
  );
});

test("context compression does not add a second summarization middleware", async () => {
  const previousCompaction = process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED;
  process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED = "1";

  try {
    const middleware = await createSourceWeftContextCompressionMiddleware({
      modelAlias: "chat-default",
    });
    const names = middleware.map((item) => item.name);

    assert.ok(names.includes("SourceWeftContextCompressionTrace"));
    assert.equal(names.includes("SummarizationMiddleware"), false);
  } finally {
    if (previousCompaction === undefined) {
      delete process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED;
    } else {
      process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED = previousCompaction;
    }
  }
});

test("tool output edit clears old tool outputs and keeps the recent five", async () => {
  const budget = resolveSourceWeftContextCompressionBudget({
    contextLength: 2_000,
  });
  const messages = [
    new HumanMessage("Find project facts"),
    ...Array.from({ length: 7 }, (_, index) => [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: `tool-${index}`,
            name: "search_sources",
            args: { query: `query ${index}` },
          },
        ],
      }),
      new ToolMessage({
        tool_call_id: `tool-${index}`,
        name: "search_sources",
        content: "large tool output ".repeat(80),
      }),
    ]).flat(),
    new HumanMessage("Current turn must stay untouched"),
  ];

  await createSourceWeftToolOutputEdit(budget).apply({
    messages,
    countTokens: estimateSourceWeftMessageTokens,
    model: {} as never,
  });

  const toolMessages = messages.filter((message) =>
    ToolMessage.isInstance(message),
  );
  const cleared = toolMessages.filter(
    (message) => message.content === SOURCEWEFT_TOOL_OUTPUT_PLACEHOLDER,
  );

  assert.equal(toolMessages.length, 7);
  assert.equal(cleared.length, 2);
  assert.equal(toolMessages.at(-1)?.content, "large tool output ".repeat(80));
});

test("tool output edit does not clear current turn tool output", async () => {
  const budget = resolveSourceWeftContextCompressionBudget({
    contextLength: 2_000,
  });
  const messages = [
    new HumanMessage("Old turn"),
    new AIMessage({
      content: "",
      tool_calls: [
        { id: "old-tool", name: "search_sources", args: { query: "old" } },
      ],
    }),
    new ToolMessage({
      tool_call_id: "old-tool",
      name: "search_sources",
      content: "old output ".repeat(400),
    }),
    new HumanMessage("Current turn"),
    new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "current-tool",
          name: "search_sources",
          args: { query: "current" },
        },
      ],
    }),
    new ToolMessage({
      tool_call_id: "current-tool",
      name: "search_sources",
      content: "current output ".repeat(400),
    }),
  ];

  await createSourceWeftToolOutputEdit(budget).apply({
    messages,
    countTokens: estimateSourceWeftMessageTokens,
    model: {} as never,
  });

  assert.equal(
    (messages.at(-1) as ToolMessage).content,
    "current output ".repeat(400),
  );
});

test("single current user message over the input budget returns MESSAGE_TOO_LARGE", () => {
  const budget = resolveSourceWeftContextCompressionBudget({
    contextLength: 100,
  });

  assert.throws(
    () =>
      assertSourceWeftCurrentUserMessageFits(
        [new HumanMessage("oversized ".repeat(300))],
        budget,
      ),
    (error) =>
      error instanceof ContentError && error.code === "MESSAGE_TOO_LARGE",
  );
});

test("overflow fallback keeps recent messages without splitting tool pairs", () => {
  const budget = resolveSourceWeftContextCompressionBudget({
    contextLength: 4_000,
  });
  const messages = [
    ...Array.from({ length: 30 }, (_, index) => [
      new HumanMessage(`Old user ${index}`),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: `old-tool-${index}`,
            name: "search_sources",
            args: { query: `old ${index}` },
          },
        ],
      }),
      new ToolMessage({
        tool_call_id: `old-tool-${index}`,
        name: "search_sources",
        content: `old output ${index}`,
      }),
    ]).flat(),
    new HumanMessage("Current turn"),
  ];

  fallbackSourceWeftMessagesToRecentWindow(messages, budget);

  assert.equal(messages.at(-1)?.content, "Current turn");
  assert.ok(messages.length <= budget.recentMessagesToKeep + 1);
  for (const [index, message] of messages.entries()) {
    if (!ToolMessage.isInstance(message)) {
      continue;
    }
    assert.ok(
      messages
        .slice(0, index)
        .some(
          (candidate) =>
            AIMessage.isInstance(candidate) &&
            candidate.tool_calls?.some(
              (toolCall) => toolCall.id === message.tool_call_id,
            ),
        ),
    );
  }
});
