import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { convertMessagesToCompletionsMessageParams } from "@langchain/openai";
import { ContextOverflowError } from "@langchain/core/errors";
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
} from "./middleware/context-compression";

// Validate the actual installed adapter's wire representation, including the
// contiguous 1:1 call/result contract enforced by OpenAI-compatible endpoints.
function assertValidToolExchangeOnWire(messages: BaseMessage[]) {
  const pending = new Set<string>();
  for (const message of convertMessagesToCompletionsMessageParams({
    messages,
  })) {
    if (message.role === "tool") {
      assert.ok(
        pending.delete(message.tool_call_id),
        "orphan or repeated tool result",
      );
      continue;
    }
    assert.equal(
      pending.size,
      0,
      "tool results must precede the next conversation message",
    );
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        assert.ok(
          call.id && !pending.has(call.id),
          "unique tool call id required",
        );
        pending.add(call.id);
      }
    }
  }
  assert.equal(pending.size, 0, "every retained call needs a result");
}

function toolExchange(prefix: string, count: number): BaseMessage[] {
  return [
    new AIMessage({
      content: "",
      tool_calls: Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`,
        name: "search_sources",
        args: { query: `${prefix} ${index}` },
      })),
    }),
    ...Array.from(
      { length: count },
      (_, index) =>
        new ToolMessage({
          tool_call_id: `${prefix}-${index}`,
          content: `${prefix} result ${index}`,
        }),
    ),
  ];
}

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
  assert.match(prompts[0] ?? "", /old citation marker input-old removed/);
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
  assertValidToolExchangeOnWire(messages);
});

test("every recent-window boundary keeps multi-tool exchanges atomic and protects the full current turn", () => {
  const system = new SystemMessage("Protected policy");
  const oldMessages = [
    new HumanMessage("Old request"),
    ...toolExchange("first", 2),
    new AIMessage("First findings"),
    ...toolExchange("second", 4),
    ...toolExchange("third", 1),
    new AIMessage("Old conclusion"),
  ];
  const currentTurn = [
    new HumanMessage("Current request"),
    ...toolExchange("current", 23),
  ];
  for (let limit = 0; limit <= oldMessages.length + 1; limit += 1) {
    const messages = [system, ...oldMessages, ...currentTurn];
    const budget = {
      ...resolveSourceWeftContextCompressionBudget(),
      recentMessagesToKeep: limit,
    };
    fallbackSourceWeftMessagesToRecentWindow(messages, budget);
    assert.strictEqual(messages[0], system);
    assert.deepEqual(messages.slice(-currentTurn.length), currentTurn);
    assert.ok(messages.length <= 1 + currentTurn.length + limit);
    assertValidToolExchangeOnWire(messages);
  }
});

test("overflow window discards malformed old groups without inventing tool results", () => {
  const messages = [
    new HumanMessage("Old request"),
    new ToolMessage({ tool_call_id: "missing-call", content: "orphan" }),
    ...toolExchange("partial", 2).slice(0, 2),
    new AIMessage("Boundary after incomplete old tools"),
    ...toolExchange("complete", 2),
    new ToolMessage({ tool_call_id: "unrelated", content: "another orphan" }),
    ...toolExchange("duplicate", 1),
    new ToolMessage({
      tool_call_id: "duplicate-0",
      content: "repeated result",
    }),
    new HumanMessage("Current request"),
  ];
  fallbackSourceWeftMessagesToRecentWindow(messages, {
    ...resolveSourceWeftContextCompressionBudget(),
    recentMessagesToKeep: 30,
  });
  assert.deepEqual(
    messages
      .filter(ToolMessage.isInstance)
      .map((message) => message.tool_call_id),
    ["complete-0", "complete-1"],
  );
  assert.deepEqual(
    messages
      .filter(AIMessage.isInstance)
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.id),
    ["complete-0", "complete-1"],
  );
  assertValidToolExchangeOnWire(messages);
});

test("overflow window fails incomplete current history without mutating it", () => {
  const invalidSuffixes = [
    [new ToolMessage({ tool_call_id: "orphan", content: "orphan" })],
    toolExchange("missing-result", 2).slice(0, 2),
    [
      ...toolExchange("duplicate", 1),
      new ToolMessage({ tool_call_id: "duplicate-0", content: "repeat" }),
    ],
    [
      toolExchange("late", 1)[0]!,
      new AIMessage("Results did not arrive before this response"),
      toolExchange("late", 1)[1]!,
    ],
  ];
  for (const suffix of invalidSuffixes) {
    const messages = [new HumanMessage("Current request"), ...suffix];
    const original = [...messages];
    assert.throws(
      () =>
        fallbackSourceWeftMessagesToRecentWindow(
          messages,
          resolveSourceWeftContextCompressionBudget(),
        ),
      (error) =>
        error instanceof ContentError && error.code === "INVALID_TOOL_HISTORY",
    );
    assert.deepEqual(messages, original);
  }
});

test("history without a human boundary uses one bounded window", () => {
  const messages = [
    new SystemMessage("Protected policy"),
    ...toolExchange("older", 4),
    ...toolExchange("newer", 2),
  ];
  fallbackSourceWeftMessagesToRecentWindow(messages, {
    ...resolveSourceWeftContextCompressionBudget(),
    recentMessagesToKeep: 4,
  });
  assert.equal(messages.length, 4);
  assert.equal((messages[1] as AIMessage).tool_calls?.[0]?.id, "newer-0");
  assertValidToolExchangeOnWire(messages);
});

test("native summarization boundaries never split a multi-tool exchange", async () => {
  // Move the normal 20-message cutoff across the assistant and each result.
  for (let trailing = 15; trailing <= 21; trailing += 1) {
    const prompts: string[] = [];
    const model = {
      invoke: async (messages: BaseMessage[]) => {
        prompts.push(String(messages[0]?.content));
        return new AIMessage("Older conversation summary");
      },
    };
    const middleware = createSourceWeftSummarizationMiddleware({
      backend: new StateBackend({ state: { files: {} } } as never),
      model: model as never,
    });
    const messages = [
      ...Array.from(
        { length: 30 },
        (_, index) => new HumanMessage(`Old ${index}`),
      ),
      ...toolExchange("boundary", 4),
      ...Array.from(
        { length: trailing },
        (_, index) => new HumanMessage(`Recent ${index}`),
      ),
    ];
    let forwarded: BaseMessage[] = [];
    await middleware.wrapModelCall(
      { messages, model, state: { files: {} }, tools: [] } as never,
      async (request) => {
        forwarded = request.messages;
        assertValidToolExchangeOnWire(forwarded);
        return new AIMessage("Next response") as never;
      },
    );
    assert.equal(prompts.length, 1);
    const retained = forwarded.filter(ToolMessage.isInstance);
    assert.ok(retained.length === 0 || retained.length === 4);
    assert.strictEqual(forwarded.at(-1), messages.at(-1));
  }
});

test("summarization keeps the entire long current turn and the original system message", async () => {
  const prompts: string[] = [];
  const model = {
    invoke: async (messages: BaseMessage[]) => {
      prompts.push(String(messages[0]?.content));
      return new AIMessage("Old summary");
    },
  };
  const middleware = createSourceWeftSummarizationMiddleware({
    backend: new StateBackend({ state: { files: {} } } as never),
    model: model as never,
  });
  const systemMessage = new SystemMessage(
    "Protected runtime system instructions",
  );
  const currentTurn = [
    new HumanMessage("CURRENT_USER_EVIDENCE"),
    ...toolExchange("CURRENT_TOOL_EVIDENCE", 44),
  ];
  const oldMessages = Array.from(
    { length: 41 },
    (_, index) => new HumanMessage(`Old ${index}`),
  );
  let event: { cutoffIndex?: number; summaryMessage?: BaseMessage } | undefined;
  const result = await middleware.wrapModelCall(
    {
      messages: [...oldMessages, ...currentTurn],
      model,
      systemMessage,
      state: { files: {} },
      tools: [],
    } as never,
    async (request) => {
      assert.strictEqual(request.systemMessage, systemMessage);
      assert.deepEqual(request.messages.slice(1), currentTurn);
      assertValidToolExchangeOnWire(request.messages);
      return new AIMessage("Next response") as never;
    },
  );
  event = (result as { update?: { _summarizationEvent?: typeof event } }).update
    ?._summarizationEvent;
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(
    prompts[0]!,
    /CURRENT_USER_EVIDENCE|CURRENT_TOOL_EVIDENCE|Protected runtime system instructions/,
  );
  assert.equal(event?.cutoffIndex, oldMessages.length);

  // Exercise native checkpoint replay rather than interpreting cutoff ourselves.
  await middleware.wrapModelCall(
    {
      messages: [...oldMessages, ...currentTurn],
      model,
      systemMessage,
      state: { files: {}, _summarizationEvent: event },
      tools: [],
    } as never,
    async (request) => {
      assert.deepEqual(request.messages.slice(1), currentTurn);
      assertValidToolExchangeOnWire(request.messages);
      return new AIMessage("Following response") as never;
    },
  );
  assert.equal(prompts.length, 1);
});

test("embedded system history remains unchanged when protecting it leaves nothing to summarize", async () => {
  let summaryCalls = 0;
  const model = {
    invoke: async () => {
      summaryCalls += 1;
      return new AIMessage("Unexpected summary");
    },
  };
  const middleware = createSourceWeftSummarizationMiddleware({
    backend: new StateBackend({ state: { files: {} } } as never),
    model: model as never,
  });
  const messages = [
    new SystemMessage("Do not summarize this system policy"),
    ...Array.from(
      { length: 42 },
      (_, index) => new HumanMessage(`User ${index}`),
    ),
  ];
  const overflow = new ContextOverflowError();
  await assert.rejects(
    async () =>
      middleware.wrapModelCall(
        { messages, model, state: { files: {} }, tools: [] } as never,
        async (request) => {
          assert.deepEqual(request.messages, messages);
          throw overflow;
        },
      ),
    (error) => error === overflow,
  );
  assert.equal(summaryCalls, 0);
});

test("a post-summary overflow preserves the original error and never summarizes the current turn", async () => {
  let summaryCalls = 0;
  const model = {
    invoke: async () => {
      summaryCalls += 1;
      return new AIMessage("Old summary");
    },
  };
  const middleware = createSourceWeftSummarizationMiddleware({
    backend: new StateBackend({ state: { files: {} } } as never),
    model: model as never,
  });
  const messages = [
    ...Array.from(
      { length: 41 },
      (_, index) => new HumanMessage(`Old ${index}`),
    ),
    new HumanMessage("Protected current request"),
    ...toolExchange("protected-current", 24),
  ];
  const overflow = new ContextOverflowError("Current context window exhausted");
  let handlerCalls = 0;
  await assert.rejects(
    async () =>
      middleware.wrapModelCall(
        { messages, model, state: { files: {} }, tools: [] } as never,
        async (request) => {
          handlerCalls += 1;
          assert.deepEqual(request.messages.slice(1), messages.slice(41));
          throw overflow;
        },
      ),
    (error) => error === overflow,
  );
  assert.equal(summaryCalls, 1);
  assert.equal(handlerCalls, 1);

  // The guard belongs to one call, not the reusable middleware or model.
  await middleware.wrapModelCall(
    { messages, model, state: { files: {} }, tools: [] } as never,
    async () => new AIMessage("Success on a separate request") as never,
  );
  assert.equal(summaryCalls, 2);
});
